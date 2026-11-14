// gitproto.ts — git smart HTTP: info/refs advertisements (v0 + v2),
// upload-pack (v2 ls-refs / fetch, v0 fetch) and receive-pack (push).
//
// Protocol rules the implementation follows:
//  - v2 is honoured only for upload-pack when `Git-Protocol: version=2` is
//    sent; receive-pack is always v0.
//  - v2 advertisement: `version 2` + capability lines, no service preamble.
//  - v0 advertisement: `# service=...` preamble, a flush, then ref lines with
//    capabilities after a NUL on the first line; an empty repo advertises a
//    zero-oid `capabilities^{}` pseudo-ref.
//  - Fetch exclusion is at object level: nothing reachable from a `have` is
//    re-sent. A `have` that the client also names in a `shallow` line is a
//    shallow boundary, not a full-history hold: its ancestors are not held.
//  - `deepen N` cuts the commit walk at N generations; the cut commits are
//    named in `shallow-info`, and a held boundary whose parents are now
//    included is named in `unshallow`.
//  - Every fetch answers a packfile section with at least one sideband
//    packet, even when it carries zero objects (a 32-byte empty pack).
//  - Pushes are per-ref: a non-fast-forward update is refused with the exact
//    reason `non-fast-forward` while the other refs still apply, and unpack
//    still reports ok.

import type { Repo, Store } from './store.ts';
import {
  emptyPack,
  encodePktLines,
  hashObject,
  isOid,
  parseCommit,
  parsePktLines,
  parsePktLinesFull,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sidebandPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './objects.ts';

export const AGENT_NAME = 'one-store-forge/1.0.0';
const V2_CAPS = ['ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1', `agent=${AGENT_NAME}`];
const V0_UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main agent=${AGENT_NAME}`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT_NAME}`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function httpError(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function peeledCommit(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') return parseTag(object.data).object;
  return null;
}

// ---------------------------------------------------------------- advertisements

/** Whether the client asked for protocol v2 (`Git-Protocol: version=2`). */
function isProtocolV2(gitProtocolVersion: string | null): boolean {
  return gitProtocolVersion === 'version=2' || gitProtocolVersion === '2';
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocolVersion: string | null,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return httpError(404, 'Repository not found');
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main') ?? ZERO_OID;

  if (service === 'git-upload-pack' && isProtocolV2(gitProtocolVersion)) {
    const lines: Array<string | 'flush'> = ['version 2\n', ...V2_CAPS.map((cap) => `${cap}\n`), 'flush'];
    return ok('application/x-git-upload-pack-advertisement', encodePktLines(lines));
  }

  // v0 advertisement (upload-pack without version=2, and receive-pack always).
  const serviceName = service === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
  const contentType =
    service === 'git-receive-pack'
      ? 'application/x-git-receive-pack-advertisement'
      : 'application/x-git-upload-pack-advertisement';
  const caps = service === 'git-receive-pack' ? V0_RECEIVE_CAPS : V0_UPLOAD_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${serviceName}\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = `${mainTip} HEAD\0${caps}\n`;
    parts.push(pktLine(headLine));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const target = parseTag(object.data).object;
        const commit = peeledCommit(repo, target);
        if (commit !== null) parts.push(pktLine(`${commit} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return ok(contentType, Buffer.concat(parts));
}

// ---------------------------------------------------------------- upload-pack

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowHeld: string[];
  depth: number | null;
}

function parseFetchArgs(lines: string[]): FetchPlan {
  const plan: FetchPlan = { wants: [], haves: [], shallowHeld: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallowHeld.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) plan.depth = n;
    }
  }
  return plan;
}

/** Commit walk from `tips` capped at `maxDepth` generations (Infinity = all). */
function walkCommits(repo: Repo, tips: string[], maxDepth: number): Map<string, number> {
  const seen = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const tip of tips) {
    const commit = peeledCommit(repo, tip);
    if (commit !== null && !seen.has(commit)) {
      seen.set(commit, 0);
      queue.push({ oid: commit, dist: 0 });
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, dist } = queue[head] as { oid: string; dist: number };
    if (dist >= maxDepth) continue;
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

interface FetchResult {
  acks: string[];
  nak: boolean;
  shallow: string[];
  unshallow: string[];
  objects: GitObject[];
}

/** Work out exactly which objects a fetch must deliver. */
export function planFetch(repo: Repo, plan: FetchPlan): FetchResult {
  const depthLimit = plan.depth ?? Number.POSITIVE_INFINITY;
  const wantDistances = walkCommits(repo, plan.wants, depthLimit);
  const heldSet = new Set(plan.shallowHeld);
  const effectiveHaves = plan.haves.filter((oid) => !heldSet.has(oid));
  const haveClosure = walkCommits(repo, effectiveHaves, Number.POSITIVE_INFINITY);

  const sendCommits = new Map<string, number>();
  for (const [oid, dist] of wantDistances) {
    if (dist < depthLimit && !haveClosure.has(oid)) sendCommits.set(oid, dist);
  }

  // Shallow boundaries: a sent commit whose parent is not sent, not held via
  // a have, and not itself a held shallow boundary.
  const shallow: string[] = [];
  for (const oid of sendCommits.keys()) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (sendCommits.has(parent)) continue;
      if (haveClosure.has(parent)) continue;
      if (heldSet.has(parent)) continue;
      shallow.push(oid);
      break;
    }
  }
  // Unshallow: a held boundary that is now sent with all its parents sent.
  const unshallow: string[] = [];
  for (const boundary of plan.shallowHeld) {
    if (!sendCommits.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => sendCommits.has(parent) || haveClosure.has(parent))) unshallow.push(boundary);
  }

  // Objects: the trees and blobs of exactly the sent commits (never a
  // re-walk: a depth cap must not leak ancestors back in), minus everything
  // the client holds: the full closure of its haves, and — for a held
  // shallow boundary — only that boundary's own objects, since a shallow
  // clone holds the tip commit but none of its ancestors.
  // Tag objects named in `wants` are sent as well — a clone of a tag needs
  // the tag object itself, not just the commit it peels to.
  const exclude = closureOfCommits(repo, [...haveClosure.keys()]);
  for (const [oid, object] of objectsForCommits(repo, plan.shallowHeld)) exclude.set(oid, object);
  const included = objectsForCommits(repo, [...sendCommits.keys()]);
  for (const want of plan.wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag') included.set(want, object);
  }
  const objects: GitObject[] = [];
  for (const [oid, object] of included) {
    if (!exclude.has(oid)) objects.push(object);
  }
  objects.sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });

  const acks = plan.haves.filter((oid) => repo.objects.has(oid) && (haveClosure.has(oid) || wantDistances.has(oid)));
  return { acks, nak: plan.haves.length > 0 && acks.length === 0, shallow, unshallow, objects };
}

/** All objects reachable from `tips` (commits + trees + blobs + tags). */
function closureOfCommits(repo: Repo, tips: string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const commits = walkCommits(repo, tips, Number.POSITIVE_INFINITY);
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
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined) out.set(target, targetObject);
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

/**
 * The objects of exactly `commitOids` — each commit plus its own tree
 * closure — without walking to parents. A depth-limited fetch uses this so
 * the cap cannot leak ancestors back in through a closure re-walk.
 */
function objectsForCommits(repo: Repo, commitOids: string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
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
  for (const commitOid of commitOids) {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') continue;
    out.set(commitOid, commit);
    visitTree(parseCommit(commit.data).tree);
  }
  return out;
}

function handleLsRefs(repo: Repo, lines: string[]): GitResponse {
  let peel = false;
  let unborn = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'unborn') unborn = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const refs = sortedRefs(repo);
  const out: string[] = [];
  const include = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (unborn && include('HEAD')) out.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  } else {
    if (include('HEAD')) {
      const mainTip = repo.refs.get('refs/heads/main') ?? ZERO_OID;
      out.push(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    for (const ref of refs) {
      if (!include(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const object = repo.objects.get(ref.oid);
        if (object !== undefined && object.type === 'tag') {
          const commit = peeledCommit(repo, parseTag(object.data).object);
          if (commit !== null) line += ` peeled:${commit}`;
        }
      }
      out.push(`${line}\n`);
    }
  }
  const parts = out.map((line) => pktLine(line));
  parts.push(pktFlush());
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetch(repo: Repo, plan: FetchPlan, protocol: 2 | 0): GitResponse {
  const result = planFetch(repo, plan);
  const pack = result.objects.length === 0 ? emptyPack() : writePack(result.objects);
  if (protocol === 2) {
    const parts: Buffer[] = [];
    if (plan.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      if (result.nak) parts.push(pktLine('NAK\n'));
      else {
        for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
        parts.push(pktLine('ready\n'));
      }
      parts.push(pktDelim());
    }
    if (result.shallow.length > 0 || result.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(pktFlush());
    return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
  }
  // v0: plain NAK/ACK/shallow lines, then the sideband pack, then flush.
  const parts: Buffer[] = [];
  if (plan.haves.length > 0) {
    if (result.nak) parts.push(pktLine('NAK\n'));
    else {
      for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
    }
  }
  for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocolVersion: string | null,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return httpError(404, 'Repository not found');
  let packets;
  try {
    packets = parsePktLines(body).packets;
  } catch {
    return httpError(400, 'malformed pkt-line stream');
  }
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const first = (lines[0] ?? '').replace(/\n$/, '');

  if (isProtocolV2(gitProtocolVersion)) {
    if (first === 'command=ls-refs') {
      const delimAt = lines.indexOf('delim');
      const args = delimAt >= 0 ? lines.slice(delimAt + 1) : lines.slice(1);
      return handleLsRefs(repo, args);
    }
    if (first === 'command=fetch') {
      const delimAt = lines.indexOf('delim');
      const args = delimAt >= 0 ? lines.slice(delimAt + 1) : lines.slice(1);
      return handleFetch(repo, parseFetchArgs(args), 2);
    }
    return httpError(400, `unknown v2 command ${JSON.stringify(first)}`);
  }

  // v0 fetch: wants section, flush, haves section, flush.
  try {
    packets = parsePktLinesFull(body);
  } catch {
    return httpError(400, 'malformed pkt-line stream');
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowHeld: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    {
      const raw = packet.payload.toString('utf8');
      const line = raw.replace(/\n$/, '');
      const firstSpace = line.indexOf(' ');
      const word = firstSpace < 0 ? line : line.slice(0, firstSpace);
      const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
      if (word === 'want') wants.push(rest.split(' ')[0] as string);
      else if (word === 'have') haves.push(rest.trim());
      else if (word === 'shallow') shallowHeld.push(rest.trim());
      else if (word === 'deepen') {
        const n = Number.parseInt(rest.trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
  }
  if (wants.length === 0) return httpError(400, 'v0 fetch with no wants');
  return handleFetch(repo, { wants, haves, shallowHeld, depth }, 0);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return httpError(404, 'Repository not found');
  let packets;
  let restOffset = 0;
  try {
    const parsed = parsePktLines(body);
    packets = parsed.packets;
    restOffset = parsed.restOffset;
  } catch {
    return httpError(400, 'malformed pkt-line stream');
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.replace(/\n$/, '').split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isOid(oldOid) && isOid(newOid) && ref.startsWith('refs/')) commands.push({ oldOid, newOid, ref });
  }
  const packBytes = body.subarray(restOffset);
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : String(error);
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      let reason: string | null = null;
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reason = 'old oid does not match';
      } else if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) reason = 'ref does not exist';
        else repo.refs.delete(command.ref);
      } else if (command.oldOid === ZERO_OID) {
        if (current !== ZERO_OID) reason = 'already exists';
        else if (repo.objects.get(command.newOid) === undefined) reason = 'object not found';
        else repo.refs.set(command.ref, command.newOid);
      } else {
        const target = peeledCommit(repo, command.newOid);
        if (target === null) reason = 'object not found';
        else if (!command.ref.startsWith('refs/tags/') && !store.isAncestor(repo, current, target)) {
          reason = 'non-fast-forward';
        } else {
          repo.refs.set(command.ref, command.newOid);
        }
      }
      reportLines.push(reason === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  }
  const parts: Buffer[] = [];
  parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`, 'utf8')])));
  for (const line of reportLines) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')])));
  }
  parts.push(pktFlush());
  return ok('application/x-git-receive-pack-result', Buffer.concat(parts));
}
