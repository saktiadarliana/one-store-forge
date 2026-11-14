// store.ts — the forge's whole state: users, repositories, git objects, refs,
// issues, pull requests, labels. In-memory, one process, no disk writes.
//
// A repository owns its objects (pushed bytes are stored verbatim) and its
// refs. Git history is derived by walking commit parents; file contents by
// flattening trees. Merges are three-way over flattened file maps, so a
// squash merge and its conflict check share one code path.

import { scenarioViewer, type Actor } from './scenario.ts';
import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type Identity,
  type TreeEntry,
} from './objects.ts';

export type { Actor };

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  createdSeq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  author: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

const ZERO = '0000000000000000000000000000000000000000';

export function nowIso(): string {
  return new Date().toISOString();
}

export function epochNow(): number {
  return Math.floor(Date.now() / 1000);
}

export class Store {
  readonly viewer: Actor;
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private nextSeq = 1;

  constructor() {
    this.viewer = scenarioViewer();
  }

  allocId(): number {
    return this.nextId++;
  }

  allocSeq(): number {
    return this.nextSeq++;
  }

  viewerIdentity(): Identity {
    return { name: this.viewer.name, email: this.viewer.email, timestamp: epochNow() };
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): Repo {
    const repo: Repo = {
      id: this.allocId(),
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.allocSeq(),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listUserRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Resolve a ref name, a 40-hex oid, or a branch name to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    const branch = `refs/heads/${ref}`;
    if (repo.refs.has(branch)) return repo.refs.get(branch) as string;
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = repo.objects.get(ref);
      if (object !== undefined && object.type === 'commit') return ref;
      if (object !== undefined && object.type === 'tag') return parseTag(object.data).object;
    }
    return null;
  }

  /** The commit oid a ref points at, peeling annotated tags. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 8; depth += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Commits reachable from `tips`, with their distance from the nearest tip. */
  reachableCommits(repo: Repo, tips: string[]): Map<string, number> {
    const seen = new Map<string, number>();
    const queue: Array<{ oid: string; dist: number }> = [];
    for (const tip of tips) {
      const commit = this.peelToCommit(repo, tip);
      if (commit !== null && !seen.has(commit)) {
        seen.set(commit, 0);
        queue.push({ oid: commit, dist: 0 });
      }
    }
    for (let head = 0; head < queue.length; head += 1) {
      const { oid, dist } = queue[head] as { oid: string; dist: number };
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent)) {
          seen.set(parent, dist + 1);
          queue.push({ oid: parent, dist: dist + 1 });
        }
      }
    }
    return seen;
  }

  /** Is `ancestor` reachable from `descendant` (inclusive)? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.reachableCommits(repo, [descendant]).has(ancestor);
  }

  /** All objects reachable from `tips`: commits, their trees (recursive), blobs, tags. */
  closureObjects(repo: Repo, tips: string[]): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const commits = this.reachableCommits(repo, tips);
    const visitTree = (treeOid: string): void => {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree' || out.has(treeOid)) return;
      out.set(treeOid, tree);
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000') visitTree(entry.oid);
        else {
          const blob = repo.objects.get(entry.oid);
          if (blob !== undefined) out.set(entry.oid, blob);
        }
      }
    };
    for (const tip of tips) {
      const object = repo.objects.get(tip);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        out.set(tip, object);
        const target = parseTag(object.data).object;
        const peeled = this.peelToCommit(repo, target);
        if (peeled !== null) {
          const targetObject = repo.objects.get(target);
          if (targetObject !== undefined) out.set(target, targetObject);
        }
      }
    }
    for (const commitOid of commits.keys()) {
      const commit = repo.objects.get(commitOid);
      if (commit === undefined) continue;
      out.set(commitOid, commit);
      visitTree(parseCommit(commit.data).tree);
    }
    return out;
  }

  /** Flatten a commit's tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return out;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** Flatten the tree of the commit `commitOid` (or an empty map for none). */
  filesAt(repo: Repo, commitOid: string | null): Map<string, { oid: string; mode: string }> {
    if (commitOid === null) return new Map();
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(commit.data).tree);
  }

  /**
   * Build nested trees for `files` (path -> {oid, mode}) and store them,
   * returning the root tree oid.
   */
  buildTreeForFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i] as string;
        let child = node.dirs.get(segment);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object, store it, return its oid. */
  createCommit(
    repo: Repo,
    opts: { tree: string; parents: string[]; message: string; author?: Identity; committer?: Identity },
  ): string {
    const who = this.viewerIdentity();
    const commit = buildCommit({
      tree: opts.tree,
      parents: opts.parents,
      author: opts.author ?? who,
      committer: opts.committer ?? who,
      message: opts.message,
    });
    return this.putObject(repo, 'commit', commit);
  }

  /** Commits reachable from `tip`, tip first, parents in order (depth-first). */
  listCommits(repo: Repo, tip: string, limit = 30): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [];
    const peeled = this.peelToCommit(repo, tip);
    if (peeled !== null) stack.push(peeled);
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  /** The merge base of two commits: the nearest common ancestor. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = this.reachableCommits(repo, [a]);
    const fromB = this.reachableCommits(repo, [b]);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, distA] of fromA) {
      const distB = fromB.get(oid);
      if (distB === undefined) continue;
      const score = distA + distB;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }

  /**
   * Three-way merge of file maps: `base` is the merge base, `ours` the base
   * branch tip, `theirs` the head tip. Returns the merged file map, or null
   * when the same path changed differently on both sides.
   */
  threeWayMerge(
    base: Map<string, { oid: string; mode: string }>,
    ours: Map<string, { oid: string; mode: string }>,
    theirs: Map<string, { oid: string; mode: string }>,
  ): Map<string, { oid: string; mode: string }> | null {
    const merged = new Map<string, { oid: string; mode: string }>(ours);
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const oursChanged = (o?.oid ?? null) !== (b?.oid ?? null);
      const theirsChanged = (t?.oid ?? null) !== (b?.oid ?? null);
      if (oursChanged && theirsChanged && (o?.oid ?? null) !== (t?.oid ?? null)) return null;
      if (theirsChanged) {
        if (t === undefined) merged.delete(path);
        else merged.set(path, t);
      }
    }
    return merged;
  }

  /** Diff two file maps: list of {path, status, oldOid, newOid}. */
  diffFiles(
    before: Map<string, { oid: string; mode: string }>,
    after: Map<string, { oid: string; mode: string }>,
  ): Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> {
    const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> = [];
    const paths = new Set<string>([...before.keys(), ...after.keys()]);
    for (const path of [...paths].sort()) {
      const b = before.get(path);
      const a = after.get(path);
      if (b === undefined && a !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: a.oid });
      else if (b !== undefined && a === undefined) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      else if (b !== undefined && a !== undefined && b.oid !== a.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: a.oid });
    }
    return out;
  }

  /** Count newlines in a blob (for pull file stats). */
  blobLineCount(repo: Repo, oid: string | null): number {
    if (oid === null) return 0;
    const object = repo.objects.get(oid);
    if (object === undefined) return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  // ------------------------------------------------------------ issues/pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.allocId(),
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      author: this.viewer.login,
      createdSeq: this.allocSeq(),
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, opts: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string }): Pull {
    const pull: Pull = {
      id: this.allocId(),
      number: repo.nextPullNumber++,
      title: opts.title,
      body: opts.body,
      state: 'open',
      merged: false,
      headRef: opts.headRef,
      baseRef: opts.baseRef,
      headSha: opts.headSha,
      baseSha: opts.baseSha,
      mergedAt: null,
      mergeCommitSha: null,
      author: this.viewer.login,
      createdSeq: this.allocSeq(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** Would a squash merge of `pull` conflict? (null = clean merge tree.) */
  squashMergeTree(repo: Repo, pull: Pull): Map<string, { oid: string; mode: string }> | null {
    const baseTip = this.resolveRef(repo, pull.baseRef);
    const headTip = this.resolveRef(repo, pull.headRef);
    if (baseTip === null || headTip === null) return null;
    const baseCommit = this.mergeBase(repo, baseTip, headTip);
    const baseFiles = baseCommit === null ? new Map<string, { oid: string; mode: string }>() : this.filesAt(repo, baseCommit);
    const oursFiles = this.filesAt(repo, baseTip);
    const theirsFiles = this.filesAt(repo, headTip);
    return this.threeWayMerge(baseFiles, oursFiles, theirsFiles);
  }

  /** Perform a squash merge; returns the merge commit oid, or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const merged = this.squashMergeTree(repo, pull);
    if (merged === null) return null;
    const baseTip = this.resolveRef(repo, pull.baseRef) as string;
    const tree = this.buildTreeForFiles(repo, merged);
    const message = `${pull.title}\n\n${pull.body}`.trimEnd();
    const sha = this.createCommit(repo, { tree, parents: [baseTip], message });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = sha;
    return sha;
  }
}

export { ZERO };
