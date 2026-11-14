// rest.ts — the GitHub REST v3 surface: repositories, git data, contents,
// labels, issues, pull requests. One shared in-memory store, the same store
// the git, GraphQL and MCP surfaces read and write.
//
// Envelope rules: every reply is JSON with a non-empty X-GitHub-Request-Id,
// error bodies are {"message": ...}, unknown routes are JSON 404, malformed
// JSON bodies are 400. Lists honour per_page/page and carry a Link header
// with rel="next" while another page exists.

import type { Issue, Pull, Repo, Store } from './store.ts';
import { nowIso } from './store.ts';
import { parseCommit } from './objects.ts';

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  host: string;
}

function json(status: number, value: unknown, extra: Record<string, string> = {}): RestResponse {
  return { status, headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(value) };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

function noContent(): RestResponse {
  return { status: 204, headers: {}, body: '' };
}

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(items: T[], page: Page, baseUrl: string): { slice: T[]; link: string | null } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  let link: string | null = null;
  if (start + page.perPage < items.length) {
    const next = new URL(baseUrl);
    next.searchParams.set('per_page', String(page.perPage));
    next.searchParams.set('page', String(page.page + 1));
    const lastPage = Math.ceil(items.length / page.perPage);
    const last = new URL(baseUrl);
    last.searchParams.set('per_page', String(page.perPage));
    last.searchParams.set('page', String(lastPage));
    link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { slice, link };
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseIdentityLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: nowIso() };
  const timestamp = Number(match[3]);
  return { name: match[1] as string, email: match[2] as string, date: new Date(timestamp * 1000).toISOString() };
}

// ---------------------------------------------------------------- shapes

function repoJson(store: Store, repo: Repo, host: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    private: repo.private,
    html_url: `http://${host}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: nowIso(),
    updated_at: nowIso(),
    pushed_at: nowIso(),
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue, host: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.author, id: store.viewer.id, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    comments: issue.comments.length,
    created_at: nowIso(),
    updated_at: nowIso(),
    closed_at: issue.state === 'closed' ? nowIso() : null,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = store.resolveRef(repo, pull.headRef) ?? pull.headSha;
  const baseTip = store.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: pull.author, id: store.viewer.id, type: 'User' },
    labels: [],
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headTip },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseTip },
    merged: pull.merged,
    mergeable: pull.merged ? false : store.squashMergeTree(repo, pull) !== null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: nowIso(),
    updated_at: nowIso(),
    closed_at: pull.state === 'closed' ? nowIso() : null,
  };
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const author = parseIdentityLine(parsed.author);
  const committer = parseIdentityLine(parsed.committer);
  return {
    sha: oid,
    node_id: `C_${oid.slice(0, 12)}`,
    commit: {
      // GitHub's API answers the message without the trailing newline the
      // stored commit object carries.
      message: parsed.message.replace(/\n$/, ''),
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: parsed.tree },
    },
    author: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    committer: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    parents: parsed.parents.map((sha) => ({ sha })),
  };
}

// ---------------------------------------------------------------- the router

export function handleRest(store: Store, req: RestRequest): RestResponse {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ') || auth.slice(7).trim() === '') {
    return err(401, 'Requires authentication');
  }
  const seg = req.segments;
  const method = req.method;
  const viewer = store.viewer;

  // GET /api/v3/ and /api/v3/meta live outside the repos tree.
  if (seg.length === 0) {
    if (method === 'GET') return json(200, {}, { 'x-oauth-scopes': 'repo, user' });
    return err(404, 'Not Found');
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method === 'GET') return json(200, { installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method === 'GET') {
      return json(200, {
        login: viewer.login,
        id: viewer.id,
        name: viewer.name,
        email: viewer.email,
        type: 'User',
        html_url: `http://${req.host}/${viewer.login}`,
      });
    }
    return err(404, 'Not Found');
  }
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return err(400, 'Malformed JSON body');
      const name = asString(parsed.value.name);
      if (name === '') return err(422, 'Repository name is required');
      if (store.getRepo(viewer.login, name) !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(viewer.login, name, {
        description: asString(parsed.value.description),
        private: asBool(parsed.value.private, false),
      });
      return json(201, repoJson(store, repo, req.host));
    }
    if (method === 'GET') {
      const page = pageOf(req.query);
      const repos = store.listUserRepos(viewer.login);
      const { slice, link } = paginate(repos, page, `http://${req.host}/api/v3/user/repos`);
      const headers = link === null ? {} : { link };
      return json(200, slice.map((repo) => repoJson(store, repo, req.host)), headers);
    }
    return err(404, 'Not Found');
  }

  if (seg.length < 3 || seg[0] !== 'repos') return err(404, 'Not Found');
  const owner = seg[1] as string;
  const repoName = seg[2] as string;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return err(404, 'Not Found');
  const rest = seg.slice(3);

  // ---- repository itself
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(store, repo, req.host));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return err(400, 'Malformed JSON body');
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      return json(200, repoJson(store, repo, req.host));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return noContent();
    }
    return err(404, 'Not Found');
  }

  // ---- branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const page = pageOf(req.query);
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      const { slice, link } = paginate(branches, page, `http://${req.host}/api/v3/repos/${owner}/${repoName}/branches`);
      const headers = link === null ? {} : { link };
      return json(
        200,
        slice.map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) }, protected: false })),
        headers,
      );
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Branch not found');
      return json(200, { name: branch, commit: { sha }, protected: false });
    }
    return err(404, 'Not Found');
  }

  // ---- git data: refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return err(400, 'Malformed JSON body');
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (repo.objects.get(sha) === undefined) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: 'commit' } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) return err(404, 'Reference not found');
      return json(200, { ref, object: { sha, type: 'commit' } });
    }
    return err(404, 'Not Found');
  }

  // ---- commits
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const ref = req.query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === null) return json(200, []);
      const page = pageOf(req.query);
      const oids = store.listCommits(repo, tip, 1000);
      const { slice, link } = paginate(oids, page, `http://${req.host}/api/v3/repos/${owner}/${repoName}/commits`);
      const headers = link === null ? {} : { link };
      const items = slice.map((oid) => commitJson(store, repo, oid)).filter((item) => item !== null);
      return json(200, items, headers);
    }
    if (rest.length === 2 && method === 'GET') {
      const item = commitJson(store, repo, rest[1] as string);
      if (item === null) return err(404, 'Commit not found');
      return json(200, item);
    }
    return err(404, 'Not Found');
  }

  // ---- contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'PUT') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return err(400, 'Malformed JSON body');
      const message = asString(parsed.value.message);
      const content = asString(parsed.value.content);
      if (message === '' || content === '') return err(422, 'message and content are required');
      const branch = asString(parsed.value.branch) || repo.defaultBranch;
      const wantSha = asString(parsed.value.sha);
      let tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        // A write to a missing branch starts it from the default tip (or unborn).
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      const files = store.filesAt(repo, tip ?? null);
      const existing = files.get(path);
      if (wantSha !== '') {
        if (existing === undefined || existing.oid !== wantSha) return err(409, 'sha does not match the current file');
      }
      const isUpdate = existing !== undefined;
      const bytes = b64decode(content);
      const blobOid = store.putObject(repo, 'blob', bytes);
      files.set(path, { oid: blobOid, mode: '100644' });
      const tree = store.buildTreeForFiles(repo, files);
      const commitSha = store.createCommit(repo, { tree, parents: tip === undefined ? [] : [tip], message });
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      return json(isUpdate ? 200 : 201, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
    }
    if (method === 'GET') {
      const ref = req.query.get('ref') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === null) return err(404, 'Not Found');
      const files = store.filesAt(repo, tip);
      if (path === '') {
        const entries: Record<string, unknown>[] = [];
        const seen = new Map<string, { oid: string; mode: string; isDir: boolean }>();
        for (const [filePath, entry] of files) {
          const first = filePath.split('/')[0] as string;
          if (!seen.has(first)) {
            if (filePath === first) seen.set(first, { oid: entry.oid, mode: entry.mode, isDir: false });
            else {
              const dirTree = dirTreeOid(repo, tip, first);
              seen.set(first, { oid: dirTree ?? '', mode: '40000', isDir: true });
            }
          }
        }
        for (const [name, entry] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          entries.push({ type: entry.isDir ? 'dir' : 'file', name, path: name, sha: entry.oid, size: entry.isDir ? 0 : blobSize(repo, entry.oid) });
        }
        return json(200, entries);
      }
      const file = files.get(path);
      if (file !== undefined) {
        const object = repo.objects.get(file.oid);
        const data = object === undefined ? Buffer.alloc(0) : object.data;
        return json(200, {
          type: 'file',
          name: path.split('/').pop() ?? path,
          path,
          sha: file.oid,
          size: data.length,
          encoding: 'base64',
          content: data.toString('base64'),
        });
      }
      // Directory listing for a path prefix.
      const prefix = `${path}/`;
      const children = new Map<string, { oid: string; mode: string; isDir: boolean }>();
      for (const [filePath, entry] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const restPath = filePath.slice(prefix.length);
        const first = restPath.split('/')[0] as string;
        if (children.has(first)) continue;
        if (restPath === first) children.set(first, { oid: entry.oid, mode: entry.mode, isDir: false });
        else {
          const dirTree = dirTreeOid(repo, tip, `${path}/${first}`);
          children.set(first, { oid: dirTree ?? '', mode: '40000', isDir: true });
        }
      }
      if (children.size === 0) return err(404, 'Not Found');
      const entries = [...children.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, entry]) => ({
          type: entry.isDir ? 'dir' : 'file',
          name,
          path: `${path}/${name}`,
          sha: entry.oid,
          size: entry.isDir ? 0 : blobSize(repo, entry.oid),
        }));
      return json(200, entries);
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return err(400, 'Malformed JSON body');
      const message = asString(parsed.value.message);
      const wantSha = asString(parsed.value.sha);
      const branch = asString(parsed.value.branch) || repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return err(404, 'Not Found');
      const files = store.filesAt(repo, tip);
      const existing = files.get(path);
      if (existing === undefined) return err(404, 'Not Found');
      if (wantSha !== '' && existing.oid !== wantSha) return err(409, 'sha does not match the current file');
      files.delete(path);
      const tree = store.buildTreeForFiles(repo, files);
      const commitSha = store.createCommit(repo, { tree, parents: [tip], message });
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      return json(200, { commit: { sha: commitSha, message } });
    }
    return err(404, 'Not Found');
  }

  // ---- labels
  if (rest[0] === 'labels') {
    if (method === 'GET') return json(200, [...repo.labels.values()]);
    if (method === 'POST') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return err(400, 'Malformed JSON body');
      const name = asString(parsed.value.name);
      const color = asString(parsed.value.color) || '000000';
      if (name === '') return err(422, 'Label name is required');
      const existing = repo.labels.get(name);
      if (existing !== undefined) return json(201, existing);
      const label = { name, color };
      repo.labels.set(name, label);
      return json(201, label);
    }
    return err(404, 'Not Found');
  }

  // ---- issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return err(400, 'Malformed JSON body');
        const title = asString(parsed.value.title);
        if (title === '') return err(422, 'Issue title is required');
        const labels = Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]).filter((x) => typeof x === 'string') as string[] : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
        }
        const issue = store.createIssue(repo, title, asString(parsed.value.body), labels);
        return json(201, issueJson(store, repo, issue, req.host));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        const labelFilter = req.query.get('labels');
        let issues = [...repo.issues];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        if (labelFilter !== null && labelFilter !== '') {
          const wanted = new Set(labelFilter.split(','));
          issues = issues.filter((issue) => issue.labels.some((label) => wanted.has(label)));
        }
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const page = pageOf(req.query);
        const { slice, link } = paginate(issues, page, `http://${req.host}/api/v3/repos/${owner}/${repoName}/issues`);
        const headers = link === null ? {} : { link };
        return json(200, slice.map((issue) => issueJson(store, repo, issue, req.host)), headers);
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue === undefined) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return json(200, issueJson(store, repo, issue, req.host));
      if (method === 'PATCH') {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return err(400, 'Malformed JSON body');
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
        return json(200, issueJson(store, repo, issue, req.host));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        return json(
          200,
          issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: comment.author, id: store.viewer.id, type: 'User' },
            created_at: comment.createdAt,
          })),
        );
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return err(400, 'Malformed JSON body');
        const body = asString(parsed.value.body);
        if (body === '') return err(422, 'Comment body is required');
        const comment = { id: repo.nextCommentId++, body, author: viewer.login, createdAt: nowIso() };
        issue.comments.push(comment);
        return json(201, { id: comment.id, body: comment.body, user: { login: viewer.login, id: store.viewer.id, type: 'User' }, created_at: comment.createdAt });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // ---- pull requests
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return err(400, 'Malformed JSON body');
        const headRef = asString(parsed.value.head);
        const baseRef = asString(parsed.value.base);
        const title = asString(parsed.value.title);
        if (headRef === '' || baseRef === '' || title === '') return err(422, 'head, base and title are required');
        const headSha = store.resolveRef(repo, headRef);
        const baseSha = store.resolveRef(repo, baseRef);
        if (headSha === null || baseSha === null) return err(422, 'head or base ref does not exist');
        const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
        if (duplicate !== undefined) return err(422, 'A pull request already exists for these branches');
        const pull = store.createPull(repo, { title, body: asString(parsed.value.body), headRef, baseRef, headSha, baseSha });
        return json(201, pullJson(store, repo, pull));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const page = pageOf(req.query);
        const { slice, link } = paginate(pulls, page, `http://${req.host}/api/v3/repos/${owner}/${repoName}/pulls`);
        const headers = link === null ? {} : { link };
        return json(200, slice.map((pull) => pullJson(store, repo, pull)), headers);
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return json(200, pullJson(store, repo, pull));
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const baseTip = store.resolveRef(repo, pull.baseRef);
      const headTip = store.resolveRef(repo, pull.headRef);
      const before = store.filesAt(repo, baseTip);
      const after = store.filesAt(repo, headTip);
      const diffs = store.diffFiles(before, after);
      const files = diffs.map((diff) => {
        const additions = diff.status === 'removed' ? 0 : Math.max(1, store.blobLineCount(repo, diff.newOid));
        const deletions = diff.status === 'added' ? 0 : store.blobLineCount(repo, diff.oldOid);
        return {
          filename: diff.path,
          status: diff.status === 'removed' ? 'removed' : diff.status,
          additions,
          deletions,
          changes: additions + deletions,
        };
      });
      return json(200, files);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull.merged) return err(405, 'Pull request is already merged');
      if (pull.state !== 'open') return err(405, 'Pull request is closed');
      const sha = store.squashMerge(repo, pull);
      if (sha === null) return err(405, 'Merge conflict');
      return json(200, { sha, merged: true, message: `Merged pull request #${pull.number}` });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

/** The tree oid of a directory path at a commit, or null. */
function dirTreeOid(repo: Repo, commitOid: string, dirPath: string): string | null {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  for (const segment of dirPath.split('/')) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

function blobSize(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  return object === undefined ? 0 : object.data.length;
}
