// objects.ts — git object model: hashing, trees, commits, tags, packs, pkt-lines.
//
// Everything here is plain SHA-1 over `<type> <size>\0` + bytes, zlib for pack
// entries, and the pkt-line framing the smart-HTTP protocols use. Outgoing
// packs are plain (no deltas); incoming packs may carry OFS_DELTA / REF_DELTA
// entries (including thin packs against objects the store already holds), so
// the reader resolves both.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function deflate(data: Buffer): Buffer {
  return zlibDeflate(data);
}

export function inflate(data: Buffer): Buffer {
  return zlibInflate(data);
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Sort key for git tree order: directories compare as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(treeSortKey(a), 'utf8'), Buffer.from(treeSortKey(b), 'utf8')),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits and tags

export interface Identity {
  name: string;
  email: string;
  timestamp: number;
}

function identityLine(kind: 'author' | 'committer', who: Identity): string {
  return `${kind} ${who.name} <${who.email}> ${who.timestamp} +0000\n`;
}

export interface CommitInput {
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  message: string;
}

export function buildCommit(input: CommitInput): Buffer {
  let text = `tree ${input.tree}\n`;
  for (const parent of input.parents) text += `parent ${parent}\n`;
  text += identityLine('author', input.author);
  text += identityLine('committer', input.committer);
  text += '\n';
  text += input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(text, 'utf8');
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const commit: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

export interface TagInput {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: Identity;
  message: string;
}

export function buildTag(input: TagInput): Buffer {
  let text = `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\n`;
  text += identityLine('tagger', input.tagger);
  text += '\n';
  text += input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(text, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const tag: ParsedTag = { object: '', type: '', tag: '', tagger: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.tag = line.slice(4);
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

// ---------------------------------------------------------------- packs

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** A pack with only plain objects: PACK v2 header, zlib entries, SHA-1 trailer. */
export function writePack(objects: GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const object of objects) {
    const typeCode = PACK_TYPE_CODES[object.type];
    const size = object.data.length;
    const head: number[] = [];
    let remaining = size;
    let byte = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    while (remaining > 0) {
      head.push(byte | 0x80);
      byte = remaining & 0x7f;
      remaining >>= 7;
    }
    head.push(byte);
    chunks.push(Buffer.from(head));
    chunks.push(deflate(object.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git binary delta to `base`, returning the reconstructed object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) copyOffset |= (delta[offset++] as number) << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) copySize |= (delta[offset++] as number) << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackEntry {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/**
 * Inflate one zlib stream starting at `offset`. inflateSync ignores trailing
 * bytes, so the stream's end is found by binary search for the shortest
 * prefix that inflates (shorter prefixes throw as truncated).
 */
export function inflateAt(pack: Buffer, offset: number): { data: Buffer; consumed: number } {
  let lo = offset;
  let hi = pack.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflate(pack.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflate(pack.subarray(offset, lo)), consumed: lo - offset };
}

/**
 * Parse a pack, resolving OFS_DELTA and REF_DELTA entries. `resolveBase`
 * supplies objects the pack itself does not carry (thin packs against the
 * store). Throws on structural errors.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const expect = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!expect.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  let offset = 12;
  interface RawEntry {
    at: number;
    typeCode: number;
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
  }
  const raw: RawEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset++] as number;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint from this entry's start.
      let b = pack[offset++] as number;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++] as number;
        value = ((value + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, consumed } = inflateAt(pack, offset);
    offset += consumed;
    if (data.length !== size) throw new Error('pack entry size mismatch');
    raw.push({ at: start, typeCode, data, baseOid, baseOffset });
  }
  const byOid = new Map<string, GitObject>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.baseOid !== undefined) {
        base = byOid.get(entry.baseOid) ?? resolveBase?.(entry.baseOid);
      } else if (entry.baseOffset !== undefined) {
        const found = raw.find((candidate) => candidate.at === entry.baseOffset);
        base = found !== undefined ? resolve(found) : undefined;
      }
      if (base === undefined) throw new Error('delta base not found');
      return { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    const type = PACK_TYPES[entry.typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${entry.typeCode}`);
    return { type, data: entry.data };
  };
  for (const entry of raw) {
    const object = resolve(entry);
    byOid.set(hashObject(object.type, object.data), object);
  }
  return byOid;
}

/** An empty pack: 12-byte header (count 0) + 20-byte SHA-1 trailer. */
export function emptyPack(): Buffer {
  return writePack([]);
}

// ---------------------------------------------------------------- pkt-lines

export type PktKind = 'data' | 'flush' | 'delim';

export interface PktLine {
  kind: PktKind;
  payload: Buffer;
}

/** One pkt-line framing `payload` (a string is UTF-8, newlines included). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = data.length + 4;
  const header = Buffer.alloc(4);
  header.write(total.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed length prefix.
 * Returns the packets plus the byte offset where packet parsing stopped
 * (the first byte after the terminating flush, if any) — callers that expect
 * raw bytes after a flush (receive-pack's pack) use it.
 */
export function parsePktLines(buf: Buffer): { packets: PktLine[]; restOffset: number } {
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, restOffset: offset + 4 };
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buf.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buf.length) throw new Error('truncated pkt-line stream');
  return { packets, restOffset: offset };
}

/** Decode every pkt-line in a buffer, including past flush packets. */
export function parsePktLinesFull(buf: Buffer): PktLine[] {
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buf.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buf.length) throw new Error('truncated pkt-line stream');
  return packets;
}

/** Encode a list of lines / flush / delim markers into one buffer. */
export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Sideband-frame pack bytes: band-1 packets of at most ~64 KiB each. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}
