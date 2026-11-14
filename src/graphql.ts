// graphql.ts — GitHub GraphQL v4, hand-written: a small lexer and parser
// plus an executor over the shared store. No library is available and none
// is needed: the suite sends a fixed set of documents (viewer, repository,
// issues with cursor pagination, mutations by global id, __type), so the
// executor covers exactly that surface, with unknown fields reported as
// GraphQL errors (HTTP 200, errors array naming the field) rather than 500s.
//
// Global ids are opaque base64 of `Kind:<keys>` and are stable across reads.

import type { Issue, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------- lexer

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < source.length && /[0-9.]/.test(source[i] as string)) {
        value += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: value.includes('.') ? 'float' : 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) {
        value += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, saw ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, saw ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, saw ${token.value}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArgs();
    }
  }

  parseDocument(): Array<OperationNode | FragmentNode> {
    const defs: Array<OperationNode | FragmentNode> = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        defs.push({ kind: 'operation', operation: 'query', name: null, variableDefs: [], selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefs = this.parseVariableDefs();
        this.skipDirectives();
        defs.push({ kind: 'operation', operation, name, variableDefs, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        defs.push({ kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value} in GraphQL document`);
      }
    }
    return defs;
  }

  private parseVariableDefs(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        defs.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') return { kind: 'spread', name: this.next().value };
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArgs();
    this.skipDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- values

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- global ids

export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

function ungid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '') return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- introspection data

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
  User: ['id', 'login', 'name', 'email'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

// ---------------------------------------------------------------- executor

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function repoObject(store: Store, repo: Repo): GqlObject {
  return { __typename: 'Repository', __repo: repo, __store: store };
}

function issueObject(store: Store, repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue, __store: store };
}

function pullObject(store: Store, repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull, __store: store };
}

function userObject(store: Store, login: string): GqlObject {
  return { __typename: 'User', __login: login, __store: store };
}

class Executor {
  errors: Array<{ message: string }> = [];
  private fragments = new Map<string, FragmentNode>();
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  executeOperation(operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const root: GqlObject = { __typename: rootType, __store: this.store };
    return this.executeSelections(rootType, root, operation.selections, variables);
  }

  registerFragments(defs: Array<OperationNode | FragmentNode>): void {
    for (const def of defs) if (def.kind === 'fragment') this.fragments.set(def.name, def);
  }

  private executeSelections(typeName: string, object: GqlObject, selections: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        const fragment = this.fragments.get(selection.name);
        if (fragment !== undefined) {
          Object.assign(out, this.executeSelections(typeName, object, fragment.selections, variables));
        }
        continue;
      }
      if (selection.kind === 'inline') {
        if (selection.typeCondition === null || selection.typeCondition === typeName) {
          Object.assign(out, this.executeSelections(typeName, object, selection.selections, variables));
        }
        continue;
      }
      const key = selection.alias ?? selection.name;
      out[key] = this.executeField(typeName, object, selection, variables);
    }
    return out;
  }

  private executeField(typeName: string, object: GqlObject, field: FieldNode, variables: Record<string, unknown>): unknown {
    const args = argsOf(field, variables);
    const value = this.resolve(typeName, object, field.name, args, field, variables);
    if (value === undefined) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
    if (field.selections.length === 0) return value;
    if (value === null) return null;
    if (Array.isArray(value)) {
      return value.map((item) =>
        item !== null && typeof item === 'object' && '__typename' in item
          ? this.executeSelections((item as GqlObject).__typename, item as GqlObject, field.selections, variables)
          : item,
      );
    }
    if (typeof value === 'object' && '__typename' in (value as GqlObject)) {
      const child = value as GqlObject;
      return this.executeSelections(child.__typename, child, field.selections, variables);
    }
    // Scalar with a sub-selection (e.g. a connection object built inline):
    // connection objects are plain records carrying __typename.
    if (typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>)) {
      const child = value as unknown as GqlObject;
      return this.executeSelections(child.__typename, child, field.selections, variables);
    }
    return value;
  }

  private resolve(
    typeName: string,
    object: GqlObject,
    fieldName: string,
    args: Record<string, unknown>,
    field: FieldNode,
    variables: Record<string, unknown>,
  ): unknown {
    const store = this.store;
    // Payloads, edges, connections and page info carry their children as
    // plain properties; resolve those before the typed branches.
    if (fieldName in object && !fieldName.startsWith('__')) return object[fieldName];
    // ---- root Query
    if (typeName === 'Query') {
      if (fieldName === 'viewer') return userObject(store, store.viewer.login);
      if (fieldName === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoObject(store, repo);
      }
      if (fieldName === 'node') {
        const decoded = ungid(String(args.id ?? ''));
        if (decoded === null) return null;
        return this.resolveNode(decoded);
      }
      if (fieldName === '__type') {
        const name = String(args.name ?? '');
        const fields = TYPE_FIELDS[name];
        if (fields === undefined && TYPE_ENUMS[name] === undefined) return null;
        return {
          __typename: '__Type',
          __typeName: name,
          __fields: (fields ?? []).map((entry) => ({ __typename: '__Field', __fieldName: entry })),
          __enumValues: (TYPE_ENUMS[name] ?? []).map((entry) => ({ __typename: '__EnumValue', __enumName: entry })),
        };
      }
      return undefined;
    }
    // ---- root Mutation
    if (typeName === 'Mutation') {
      if (fieldName === 'createIssue') return this.mutateCreateIssue(args);
      if (fieldName === 'closeIssue') return this.mutateCloseIssue(args);
      if (fieldName === 'createPullRequest') return this.mutateCreatePull(args);
      if (fieldName === 'mergePullRequest') return this.mutateMergePull(args);
      if (fieldName === 'addComment') return this.mutateAddComment(args);
      return undefined;
    }
    // ---- User
    if (typeName === 'User') {
      if (fieldName === 'login') return object.__login ?? null;
      if (fieldName === 'id') return gid('User', String(object.__login ?? ''));
      if (fieldName === 'name') return object.__login === store.viewer.login ? store.viewer.name : String(object.__login ?? '');
      return undefined;
    }
    // ---- Repository
    if (typeName === 'Repository') {
      const repo = object.__repo as Repo;
      if (fieldName === 'id') return gid('Repository', repo.id);
      if (fieldName === 'databaseId') return repo.id;
      if (fieldName === 'name') return repo.name;
      if (fieldName === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (fieldName === 'owner') return userObject(store, repo.owner);
      if (fieldName === 'defaultBranchRef') return { __typename: 'Ref', __refName: repo.defaultBranch };
      if (fieldName === 'viewerPermission') return 'ADMIN';
      if (fieldName === 'hasIssuesEnabled') return true;
      if (fieldName === 'issue') {
        const issue = repo.issues.find((entry) => entry.number === Number(args.number));
        return issue === undefined ? null : issueObject(store, repo, issue);
      }
      if (fieldName === 'issues') return this.issuesConnection(repo, args);
      if (fieldName === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const nodes = [...repo.pulls].sort((a, b) => a.number - b.number).slice(0, first);
        return {
          __typename: 'PullRequestConnection',
          nodes: nodes.map((pull) => pullObject(store, repo, pull)),
        };
      }
      if (fieldName === 'pullRequest') {
        const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
        return pull === undefined ? null : pullObject(store, repo, pull);
      }
      return undefined;
    }
    // ---- Issue
    if (typeName === 'Issue') {
      const issue = object.__issue as Issue;
      const repo = object.__repo as Repo;
      if (fieldName === 'id') return gid('Issue', repo.id, issue.number);
      if (fieldName === 'number') return issue.number;
      if (fieldName === 'title') return issue.title;
      if (fieldName === 'state') return issue.state.toUpperCase();
      if (fieldName === 'body') return issue.body;
      return undefined;
    }
    // ---- PullRequest
    if (typeName === 'PullRequest') {
      const pull = object.__pull as Pull;
      const repo = object.__repo as Repo;
      if (fieldName === 'id') return gid('PullRequest', repo.id, pull.number);
      if (fieldName === 'number') return pull.number;
      if (fieldName === 'title') return pull.title;
      if (fieldName === 'body') return pull.body;
      if (fieldName === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (fieldName === 'merged') return pull.merged;
      if (fieldName === 'headRefName') return pull.headRef;
      if (fieldName === 'baseRefName') return pull.baseRef;
      if (fieldName === 'mergeable') {
        if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
        return store.squashMergeTree(repo, pull) !== null ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (fieldName === 'files') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const baseTip = store.resolveRef(repo, pull.baseRef);
        const headTip = store.resolveRef(repo, pull.headRef);
        const diffs = store.diffFiles(store.filesAt(repo, baseTip), store.filesAt(repo, headTip));
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: diffs.slice(0, first).map((diff) => ({ __typename: 'PullRequestChangedFile', __path: diff.path })),
        };
      }
      return undefined;
    }
    // ---- connections / page info / introspection
    if (typeName === 'IssueConnection') {
      if (fieldName === 'nodes') return object.nodes as unknown[];
      if (fieldName === 'pageInfo') return object.pageInfo as GqlObject;
      return undefined;
    }
    if (typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
      if (fieldName === 'nodes') return object.nodes as unknown[];
      return undefined;
    }
    if (typeName === 'PageInfo') {
      if (fieldName === 'hasNextPage') return object.hasNextPage ?? false;
      if (fieldName === 'endCursor') return object.endCursor ?? null;
      return undefined;
    }
    if (typeName === 'Ref') {
      if (fieldName === 'name') return object.__refName ?? null;
      return undefined;
    }
    if (typeName === 'PullRequestChangedFile') {
      if (fieldName === 'path') return object.__path ?? null;
      return undefined;
    }
    if (typeName === '__Type') {
      if (fieldName === 'name') return object.__typeName ?? null;
      if (fieldName === 'fields') return object.__fields as unknown[];
      if (fieldName === 'enumValues') return object.__enumValues as unknown[];
      return undefined;
    }
    if (typeName === '__Field') {
      if (fieldName === 'name') return object.__fieldName ?? null;
      return undefined;
    }
    if (typeName === '__EnumValue') {
      if (fieldName === 'name') return object.__enumName ?? null;
      return undefined;
    }
    return undefined;
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    const store = this.store;
    const first = typeof args.first === 'number' ? args.first : 10;
    const after = typeof args.after === 'string' ? cursorNumber(args.after) : null;
    const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const descending = String(orderBy.direction ?? 'ASC').toUpperCase() === 'DESC';
    let issues = [...repo.issues];
    if (states !== null) {
      const wanted = new Set(states.map((state) => state.toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
    if (after !== null) {
      issues = issues.filter((issue) => (descending ? issue.number < after : issue.number > after));
    }
    const page = issues.slice(0, first);
    const hasNextPage = issues.length > first;
    const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null;
    return {
      __typename: 'IssueConnection',
      nodes: page.map((issue) => issueObject(store, repo, issue)),
      pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
    };
  }

  private resolveNode(decoded: { kind: string; parts: string[] }): GqlObject | null {
    const store = this.store;
    if (decoded.kind === 'Repository') {
      const id = Number(decoded.parts[0]);
      for (const repo of store.repos.values()) {
        if (repo.id === id) return repoObject(store, repo);
      }
      return null;
    }
    if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
      const repoId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      for (const repo of store.repos.values()) {
        if (repo.id !== repoId) continue;
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.find((entry) => entry.number === number);
          return issue === undefined ? null : issueObject(store, repo, issue);
        }
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : pullObject(store, repo, pull);
      }
      return null;
    }
    if (decoded.kind === 'User') {
      return userObject(store, decoded.parts[0] ?? '');
    }
    return null;
  }

  private findRepoByGid(id: string): Repo | null {
    const decoded = ungid(id);
    if (decoded === null || decoded.kind !== 'Repository') return null;
    const repoId = Number(decoded.parts[0]);
    for (const repo of this.store.repos.values()) if (repo.id === repoId) return repo;
    return null;
  }

  private findIssueByGid(id: string): { repo: Repo; issue: Issue } | null {
    const decoded = ungid(id);
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const repoId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of this.store.repos.values()) {
      if (repo.id !== repoId) continue;
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue !== undefined) return { repo, issue };
    }
    return null;
  }

  private findPullByGid(id: string): { repo: Repo; pull: Pull } | null {
    const decoded = ungid(id);
    if (decoded === null || decoded.kind !== 'PullRequest') return null;
    const repoId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of this.store.repos.values()) {
      if (repo.id !== repoId) continue;
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull !== undefined) return { repo, pull };
    }
    return null;
  }

  private mutateCreateIssue(args: Record<string, unknown>): GqlObject {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = this.findRepoByGid(String(input.repositoryId ?? ''));
    if (repo === null) {
      this.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return { __typename: 'CreateIssuePayload', issue: null };
    }
    const issue = this.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return { __typename: 'CreateIssuePayload', issue: issueObject(this.store, repo, issue) };
  }

  private mutateCloseIssue(args: Record<string, unknown>): GqlObject {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = this.findIssueByGid(String(input.issueId ?? ''));
    if (found === null) {
      this.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return { __typename: 'CloseIssuePayload', issue: null };
    }
    found.issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueObject(this.store, found.repo, found.issue) };
  }

  private mutateCreatePull(args: Record<string, unknown>): GqlObject {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = this.findRepoByGid(String(input.repositoryId ?? ''));
    if (repo === null) {
      this.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = this.store.resolveRef(repo, headRef);
    const baseSha = this.store.resolveRef(repo, baseRef);
    if (headSha === null || baseSha === null) {
      this.errors.push({ message: 'head or base ref does not exist.' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
    const pull =
      existing ??
      this.store.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        headRef,
        baseRef,
        headSha,
        baseSha,
      });
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(this.store, repo, pull) };
  }

  private mutateMergePull(args: Record<string, unknown>): GqlObject {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = this.findPullByGid(String(input.pullRequestId ?? ''));
    if (found === null) {
      this.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
      return { __typename: 'MergePullRequestPayload', pullRequest: null };
    }
    if (!found.pull.merged && found.pull.state === 'open') {
      const sha = this.store.squashMerge(found.repo, found.pull);
      if (sha === null) {
        this.errors.push({ message: 'Merge conflict.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(this.store, found.repo, found.pull) };
  }

  private mutateAddComment(args: Record<string, unknown>): GqlObject {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = this.findIssueByGid(String(input.subjectId ?? ''));
    if (found === null) {
      this.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return { __typename: 'AddCommentPayload', commentEdge: null };
    }
    const comment = {
      id: found.repo.nextCommentId++,
      body: String(input.body ?? ''),
      author: this.store.viewer.login,
      createdAt: new Date().toISOString(),
    };
    found.issue.comments.push(comment);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: gid('Comment', found.repo.id, found.issue.number, comment.id), body: comment.body },
      },
    };
  }
}

// ---------------------------------------------------------------- entry point

export interface GraphqlResponse {
  status: number;
  body: string;
}

export function handleGraphql(store: Store, bodyText: string, authed: boolean): GraphqlResponse {
  if (!authed) {
    return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Malformed JSON body' }] }) };
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const results = operations.map((operation) => runOne(store, operation));
  return { status: 200, body: JSON.stringify(Array.isArray(parsed) ? results : results[0]) };
}

function runOne(store: Store, operation: unknown): Record<string, unknown> {
  if (operation === null || typeof operation !== 'object') {
    return { errors: [{ message: 'Request body must be a JSON object.' }] };
  }
  const record = operation as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const executor = new Executor(store);
  try {
    const defs = new Parser(lex(query)).parseDocument();
    executor.registerFragments(defs);
    const ops = defs.filter((def): def is OperationNode => def.kind === 'operation');
    const chosen = operationName !== null ? ops.find((op) => op.name === operationName) ?? ops[0] : ops[0];
    if (chosen === undefined) return { errors: [{ message: 'No operation found in the document.' }] };
    // Seed declared variables with their defaults, then overlay provided ones.
    const merged: Record<string, unknown> = {};
    for (const def of chosen.variableDefs) {
      if (def.defaultValue !== null) merged[def.name] = valueOf(def.defaultValue, variables);
    }
    for (const [key, value] of Object.entries(variables)) merged[key] = value;
    const data = executor.executeOperation(chosen, merged);
    const out: Record<string, unknown> = { data };
    if (executor.errors.length > 0) out.errors = executor.errors;
    return out;
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}
