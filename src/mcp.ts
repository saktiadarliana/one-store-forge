// mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp.
//
// The modern era (revision 2026-07-28): no handshake, no session. Every
// request declares its revision in `_meta` and the `Mcp-Protocol-Version`
// header; `server/discover` answers identity, capabilities and the supported
// versions in one request. The legacy handshake (`initialize` +
// `notifications/initialized`) is answered too, so a pre-discover client
// still works. Tools act on the same store as REST, so an object created
// over MCP is the same object over REST.
//
// Errors: unknown method -> -32601, unknown tool / bad arguments -> -32602,
// a body that is not JSON -> HTTP 400 with -32700. No Authorization header
// -> HTTP 401.

import type { Store } from './store.ts';

export const MCP_REVISION = '2026-07-28';
export const SERVER_NAME = 'one-store-forge';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Issue state: open, closed or all.' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
  },
];

function toolJson(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  };
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

interface RpcResult {
  status: number;
  body: string;
}

function rpcOk(id: unknown, result: unknown): RpcResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcResult {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

function textResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function handleMcp(store: Store, rawBody: Buffer, authed: boolean): RpcResult {
  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const record = request as Record<string, unknown>;
  const id = record.id ?? null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and expect no JSON-RPC answer.
  if (id === null && record.id === undefined) {
    return { status: 202, body: '' };
  }
  if (!authed) {
    return rpcError(id, -32001, 'Unauthorized', 401);
  }

  if (method === 'server/discover') {
    const info = serverInfo();
    return rpcOk(id, {
      resultType: 'discover',
      supportedVersions: [MCP_REVISION],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
      serverInfo: info,
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    });
  }
  if (method === 'initialize') {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
    return rpcOk(id, {
      protocolVersion: asked,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }
  if (method === 'tools/list') {
    return rpcOk(id, { tools: TOOLS.map(toolJson) });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return rpcOk(id, toolError(`Missing required argument(s): ${missing.join(', ')}`));
    }
    return rpcOk(id, callTool(store, tool, args));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function callTool(store: Store, tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const viewer = store.viewer;
  if (tool.name === 'create_repo') {
    const name = String(args.name ?? '');
    if (store.getRepo(viewer.login, name) !== undefined) {
      return toolError(`Repository ${viewer.login}/${name} already exists`);
    }
    const repo = store.createRepo(viewer.login, name, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    return textResult({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    });
  }
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
  if (tool.name === 'get_repo') {
    return textResult({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    });
  }
  if (tool.name === 'create_issue') {
    const issue = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
    return textResult({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      repository: `${repo.owner}/${repo.name}`,
    });
  }
  if (tool.name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
    return textResult(
      issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      })),
    );
  }
  if (tool.name === 'create_pull_request') {
    const headRef = String(args.head ?? '');
    const baseRef = String(args.base ?? '');
    const headSha = store.resolveRef(repo, headRef);
    const baseSha = store.resolveRef(repo, baseRef);
    if (headSha === null || baseSha === null) return toolError('head or base ref does not exist');
    const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
    const pull =
      existing ??
      store.createPull(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        headRef,
        baseRef,
        headSha,
        baseSha,
      });
    return textResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      merged: pull.merged,
    });
  }
  if (tool.name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return toolError(`Pull request #${number} not found`);
    if (pull.merged) {
      return textResult({ id: pull.id, number: pull.number, merged: true, state: pull.state, merge_commit_sha: pull.mergeCommitSha });
    }
    if (pull.state !== 'open') return toolError(`Pull request #${number} is not open`);
    const sha = store.squashMerge(repo, pull);
    if (sha === null) return toolError('Merge conflict');
    return textResult({ id: pull.id, number: pull.number, merged: true, state: pull.state, merge_commit_sha: sha, merged_at: pull.mergedAt });
  }
  return toolError(`Tool ${tool.name} is not implemented`);
}
