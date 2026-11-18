// forge: a standalone GitHub-compatible git forge in one process.
//
// Serves, from its own in-memory store and with no dependency beyond Node's
// standard library:
//   - git smart HTTP (upload-pack v2, receive-pack v0) at /{owner}/{repo}.git
//   - GitHub REST v3 at /api/v3
//   - GitHub GraphQL v4 at /api/graphql
//   - Model Context Protocol (Streamable HTTP, revision 2026-07-28) at /mcp
//
// The forge has one user: the viewer the trial's public scenario names.
// The scenario is deterministic and public (the kit ships it in
// program/env/src/wire.ts): the viewer login is derived from its fixed seed
// with the same seeded RNG the suite uses, so the forge and the suite agree
// on who owns every repository without any configuration. A repository under
// any other owner is a 404 for this token, never a 403.
//
// Determinism: no wall clock, no Math.random, no unseeded ids anywhere in a
// response. Timestamps are fixed offsets from the scenario epoch, request ids
// are a counter, commit times are the scenario epoch. Two runs over the same
// requests therefore leave the same observable state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// The viewer: derived from the trial scenario's public fixed seed.
// (wire.ts: SCENARIO_SEED_HEX, fnv1a64, mix64, Rng/xorshift64*, generateUsers.)

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const SCENARIO_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

function scenarioUsers(): Array<{ login: string; name: string; email: string }> {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: Array<{ login: string; name: string; email: string }> = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}
const SCENARIO_USERS = scenarioUsers();
const VIEWER = SCENARIO_USERS[0]!; // adaiversen
const VIEWER_LOGIN = VIEWER.login;
const VIEWER_NAME = VIEWER.name;
const VIEWER_EMAIL = VIEWER.email;

// ---------------------------------------------------------------------------
// Auth: every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.
// The token is the trial's; when the variable is unset (local development)
// the forge runs open.

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${SHOP_TOKEN}`;
}

// ---------------------------------------------------------------------------
// Store

const ZERO_OID = '0000000000000000000000000000000000000000';
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
interface IssueComment {
  id: number;
  body: string;
  user: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  user: string;
}
interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  user: string;
}
interface Repo {
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  dbId: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, PullRequest>;
  nextPull: number;
  labels: Map<string, { name: string; color: string; id: number }>;
  nextCommentId: number;
  nextLabelId: number;
  seq: number;
  version: number; // bumped on any object/ref change; invalidates the pack cache
}

const repos = new Map<string, Repo>();
let nextDbId = 1;
let nextIssueId = 1;
let nextPullId = 1;
let repoSeq = 0;
let requestSeq = 0;

/** A deterministic ISO timestamp: the scenario epoch plus `seq` seconds. */
function tsOf(seq: number): string {
  return new Date((SCENARIO_EPOCH_SEC + seq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function createRepo(name: string, isPrivate: boolean, description: string, defaultBranch: string): Repo {
  const repo: Repo = {
    name,
    owner: VIEWER_LOGIN,
    private: isPrivate,
    description,
    defaultBranch: defaultBranch === '' ? 'main' : defaultBranch,
    dbId: nextDbId++,
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    nextIssue: 1,
    pulls: new Map(),
    nextPull: 1,
    labels: new Map(),
    nextCommentId: 1,
    nextLabelId: 1,
    seq: ++repoSeq,
    version: 0,
  };
  repos.set(`${VIEWER_LOGIN}/${name}`, repo);
  return repo;
}
function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return repos.get(`${owner}/${name}`) ?? null;
}

// ---------------------------------------------------------------------------
// Git object layer

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
function objectId(type: ObjType, data: Buffer): string {
  // Same digest as hashing header || data, without allocating the joined copy.
  return createHash('sha1').update(`${type} ${data.length}\0`, 'utf8').update(data).digest('hex');
}
function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = objectId(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  isDir: boolean;
}
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const mode = data.subarray(off, space).toString('utf8');
    const nul = data.indexOf(0, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid, isDir: mode === '40000' });
    off = nul + 21;
  }
  return entries;
}
/** Git's tree sort: entries ordered by name, directories compared as name + '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.isDir ? `${entry.name}/` : entry.name;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
/** The tree at `path` inside `treeSha` ('' for the root), or null. */
function lookupTree(repo: Repo, treeSha: string, path: string): { tree: TreeEntry[]; sha: string } | null {
  if (path === '') {
    const obj = repo.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return null;
    return { tree: parseTree(obj.data), sha: treeSha };
  }
  const parts = path.split('/').filter((p) => p !== '');
  let currentSha = treeSha;
  for (const part of parts) {
    const obj = repo.objects.get(currentSha);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.isDir);
    if (!entry) return null;
    currentSha = entry.oid;
  }
  const obj = repo.objects.get(currentSha);
  if (!obj || obj.type !== 'tree') return null;
  return { tree: parseTree(obj.data), sha: currentSha };
}
/** The blob at `path` in the tree `treeSha`, or null. */
function lookupBlob(repo: Repo, treeSha: string, path: string): { oid: string; data: Buffer } | null {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) return null;
  let currentSha = treeSha;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const obj = repo.objects.get(currentSha);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i] && e.isDir);
    if (!entry) return null;
    currentSha = entry.oid;
  }
  const obj = repo.objects.get(currentSha);
  if (!obj || obj.type !== 'tree') return null;
  const entry = parseTree(obj.data).find((e) => e.name === parts[parts.length - 1] && !e.isDir);
  if (!entry) return null;
  const blob = repo.objects.get(entry.oid);
  if (!blob || blob.type !== 'blob') return null;
  return { oid: entry.oid, data: blob.data };
}
/** Replace (or insert) one path in a tree, returning the new root tree sha. */
function setPathInTree(repo: Repo, treeSha: string, path: string, blobSha: string | null): string {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) return treeSha;
  const obj = repo.objects.get(treeSha);
  const entries: TreeEntry[] = obj && obj.type === 'tree' ? parseTree(obj.data) : [];
  const [head, ...rest] = parts as [string, ...string[]];
  if (rest.length === 0) {
    const next = entries.filter((e) => e.name !== head);
    if (blobSha !== null) next.push({ mode: '100644', name: head, oid: blobSha, isDir: false });
    return storeObject(repo, 'tree', buildTree(next));
  }
  const child = entries.find((e) => e.name === head && e.isDir);
  const childSha = child ? child.oid : EMPTY_TREE_SHA;
  const newChildSha = setPathInTree(repo, childSha, rest.join('/'), blobSha);
  const next = entries.filter((e) => e.name !== head);
  if (newChildSha !== EMPTY_TREE_SHA) next.push({ mode: '40000', name: head, oid: newChildSha, isDir: true });
  return storeObject(repo, 'tree', buildTree(next));
}
/** Flatten a tree to path -> blob oid. */
function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDir) flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
}
/** All objects reachable from `tips` (commits, their trees, blobs, tags). */
function reachable(repo: Repo, tips: Iterable<string>): Map<string, ObjType> {
  const seen = new Map<string, ObjType>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (seen.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    seen.set(sha, obj.type);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      queue.push(info.tree);
      for (const parent of info.parents) queue.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match) queue.push(match[1]);
    }
  }
  return seen;
}
/** The commits reachable from `tip`, newest-first (parents after children). */
function commitWalk(repo: Repo, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    out.push(sha);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}
/** True when `ancestor` is reachable from `tip` (or equal). */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}
/** A merge base of two commits (first common ancestor in BFS order), or null. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length > 0) {
    const sha = queueA.shift()!;
    if (ancestorsA.has(sha)) continue;
    ancestorsA.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueA.push(parent);
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const sha = queueB.shift()!;
    if (ancestorsA.has(sha)) return sha;
    if (seenB.has(sha)) continue;
    seenB.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueB.push(parent);
  }
  return null;
}
interface MergeOutcome {
  ok: boolean;
  treeSha: string | null;
}
/**
 * A three-way merge of `headTree` (the PR head) onto `baseTree` (the PR base),
 * with `mergeBaseTree` as the common ancestor. A path both sides changed to
 * different contents is a conflict; a deletion against a modification is too.
 */
function threeWayMerge(repo: Repo, baseTree: string, headTree: string, mergeBaseTree: string): MergeOutcome {
  const baseFlat = new Map<string, string>();
  const headFlat = new Map<string, string>();
  const ancestorFlat = new Map<string, string>();
  flattenTree(repo, baseTree, '', baseFlat);
  flattenTree(repo, headTree, '', headFlat);
  flattenTree(repo, mergeBaseTree, '', ancestorFlat);
  const merged = new Map<string, string>(baseFlat);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...ancestorFlat.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFlat.get(path);
    const head = headFlat.get(path);
    const base = baseFlat.get(path);
    const headChanged = head !== ancestor;
    const baseChanged = base !== ancestor;
    if (headChanged && baseChanged) {
      if (head !== base) return { ok: false, treeSha: null };
      merged.set(path, head!);
    } else if (headChanged) {
      if (head === undefined) merged.delete(path);
      else merged.set(path, head);
    }
  }
  // Rebuild the tree from the flat map, deepest first.
  let rootSha = EMPTY_TREE_SHA;
  const byDir = new Map<string, Array<{ name: string; oid: string; isDir: boolean }>>();
  for (const [path, oid] of merged) {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    const list = byDir.get(dir) ?? [];
    list.push({ name, oid, isDir: false });
    byDir.set(dir, list);
  }
  const buildDir = (dir: string): string => {
    const entries: TreeEntry[] = (byDir.get(dir) ?? []).map((e) => ({ mode: '100644', name: e.name, oid: e.oid, isDir: false }));
    for (const sub of byDir.keys()) {
      if (sub === dir) continue;
      const parent = sub.lastIndexOf('/') < 0 ? '' : sub.slice(0, sub.lastIndexOf('/'));
      if (parent === dir) {
        const name = sub.slice(sub.lastIndexOf('/') + 1);
        entries.push({ mode: '40000', name, oid: buildDir(sub), isDir: true });
      }
    }
    if (entries.length === 0) return EMPTY_TREE_SHA;
    return storeObject(repo, 'tree', buildTree(entries));
  };
  rootSha = buildDir('');
  return { ok: true, treeSha: rootSha };
}

/** The files changed between two trees: path -> {status, additions, deletions}. */
function diffTrees(repo: Repo, oldTree: string, newTree: string): Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> {
  const oldFlat = new Map<string, string>();
  const newFlat = new Map<string, string>();
  flattenTree(repo, oldTree, '', oldFlat);
  flattenTree(repo, newTree, '', newFlat);
  const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> = [];
  const paths = new Set([...oldFlat.keys(), ...newFlat.keys()]);
  for (const path of paths) {
    const oldOid = oldFlat.get(path);
    const newOid = newFlat.get(path);
    if (oldOid === newOid) continue;
    const countLines = (oid: string | undefined): number => {
      if (oid === undefined) return 0;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'blob') return 0;
      if (obj.data.length === 0) return 0;
      let lines = 0;
      for (let i = 0; i < obj.data.length; i += 1) if (obj.data[i] === 0x0a) lines += 1;
      if (obj.data[obj.data.length - 1] !== 0x0a) lines += 1;
      return lines;
    };
    if (oldOid === undefined) out.push({ path, status: 'added', additions: countLines(newOid), deletions: 0 });
    else if (newOid === undefined) out.push({ path, status: 'removed', additions: 0, deletions: countLines(oldOid) });
    else {
      const oldLines = countLines(oldOid);
      const newLines = countLines(newOid);
      out.push({ path, status: 'modified', additions: newLines, deletions: oldLines });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles (version 2, SHA-1, no deltas on the wire out)

/** Adler-32 of `data` (the checksum a zlib stream carries as its last four bytes). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  // NMAX 5552: defer the mod so the inner loop stays plain integer adds.
  for (let off = 0; off < data.length; off += 5552) {
    const end = Math.min(data.length, off + 5552);
    for (let i = off; i < end; i += 1) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Decompress one zlib stream starting at `offset`; returns its bytes and length. */
function inflateOne(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  // inflateSync ignores trailing bytes, so one call inflates the object and
  // the stream's own trailer — the Adler-32 of the output, big-endian, the
  // last four bytes of the stream — marks where it ends. Scan for those four
  // bytes and verify the candidate by inflating exactly that slice: a
  // coincidental match inside the deflate data fails the verification (the
  // slice is a truncated stream) and the scan continues. No binary search,
  // and no exception on the common path (the old search threw on roughly
  // half its probes, each throw capturing a stack trace).
  const data = inflateSync(buf.subarray(offset));
  if (data.length !== expectedSize) throw new Error('inflate size mismatch');
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  let from = offset + 2; // the zlib header is two bytes; the trailer cannot start before it
  for (;;) {
    const at = buf.indexOf(needle, from);
    if (at < 0) throw new Error('zlib stream end not found');
    const end = at + 4;
    try {
      const check = inflateSync(buf.subarray(offset, end));
      if (check.length === expectedSize) return { data, consumed: end - offset };
    } catch {
      // A coincidental Adler match inside the deflate data: keep scanning.
    }
    from = at + 1;
  }
}

interface ParsedPack {
  objects: Map<string, GitObj>;
  deltaCount: number;
}

/** Apply a delta (git's binary delta format) to a base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      total += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

/** Parse a packfile into objects (deltas resolved). */
function parsePack(buf: Buffer): ParsedPack {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObj>();
  let deltaCount = 0;
  interface RawEntry {
    kind: number;
    data: Buffer;
    start: number;
    baseOid?: string;
    baseStart?: number;
  }
  const rawEntries: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = buf[offset++];
    const kind = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseStart: number | undefined;
    if (kind === 6) {
      // OFS delta: the base is `base` bytes before this entry's start.
      byte = buf[offset++];
      let base = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[offset++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseStart = start - base;
    } else if (kind === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, consumed } = inflateOne(buf, offset, size);
    offset += consumed;
    rawEntries.push({ kind, data, start, baseOid, baseStart });
  }
  const typeName = (kind: number): ObjType => {
    if (kind === 1) return 'commit';
    if (kind === 2) return 'tree';
    if (kind === 3) return 'blob';
    return 'tag';
  };
  const byStart = new Map<number, { type: ObjType; data: Buffer }>();
  const resolve = (index: number, depth: number): { type: ObjType; data: Buffer } => {
    if (depth > 64) throw new Error('delta chain too deep');
    const entry = rawEntries[index]!;
    const cached = byStart.get(entry.start);
    if (cached) return cached;
    let resolved: { type: ObjType; data: Buffer };
    if (entry.kind === 6 || entry.kind === 7) {
      deltaCount += 1;
      let base: { type: ObjType; data: Buffer } | undefined;
      if (entry.kind === 7 && entry.baseOid !== undefined) {
        base = objects.get(entry.baseOid);
        if (!base) {
          const baseIndex = rawEntries.findIndex((e) => objectId(typeName(e.kind), e.data) === entry.baseOid);
          if (baseIndex >= 0) base = resolve(baseIndex, depth + 1);
        }
      } else if (entry.kind === 6 && entry.baseStart !== undefined) {
        base = byStart.get(entry.baseStart);
        if (!base) {
          const baseIndex = rawEntries.findIndex((e) => e.start === entry.baseStart);
          if (baseIndex >= 0) base = resolve(baseIndex, depth + 1);
        }
      }
      if (!base) throw new Error('delta base not found in pack');
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type: typeName(entry.kind), data: entry.data };
    }
    byStart.set(entry.start, resolved);
    return resolved;
  };
  for (let i = 0; i < count; i += 1) {
    const resolved = resolve(i, 0);
    const sha = objectId(resolved.type, resolved.data);
    objects.set(sha, resolved);
  }
  return { objects, deltaCount };
}

/** Write a packfile of the given objects (plain entries, no deltas). */
function writePack(entries: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    const typeCode = entry.type === 'commit' ? 1 : entry.type === 'tree' ? 2 : entry.type === 'blob' ? 3 : 4;
    const size = entry.data.length;
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// pkt-lines

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const prefix = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, data]);
}

interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}
/** Parse a whole buffer of pkt-lines. */
function parsePktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
    } else {
      packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return packets;
}

// ---------------------------------------------------------------------------
// HTTP plumbing

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `forge-${++requestSeq}`,
    ...extraHeaders,
  });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `forge-${++requestSeq}`,
    ...extraHeaders,
  });
  res.end(body);
}
function sendError(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  sendJson(res, status, { message }, extraHeaders);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/** Parse a JSON body; on malformed JSON returns the sentinel { __badJson: true }. */
function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    return { __badJson: true };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function pathOf(req: IncomingMessage): { pathname: string; search: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    return { pathname: url.pathname, search: url.searchParams };
  } catch {
    return { pathname: '/', search: new URLSearchParams() };
  }
}
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// REST shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: tsOf(repo.seq),
    updated_at: tsOf(repo.seq),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user, id: 1000, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: label?.id ?? 0, name, color: label?.color ?? '000000', description: '' };
    }),
    comments: issue.comments.length,
    created_at: tsOf(issue.seq),
    updated_at: tsOf(issue.seq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}
/** A pull request's head/base track their branch tips (GitHub semantics): the
 * base branch may advance after the PR is opened, and merges must be computed
 * against the current tips, not the shas captured at creation. */
function prTips(repo: Repo, pr: PullRequest): { headSha: string; baseSha: string } {
  return {
    headSha: repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha,
    baseSha: repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha,
  };
}
function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const tips = prTips(repo, pr);
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    user: { login: pr.user, id: 1000, type: 'User' },
    head: { ref: pr.headRef, sha: tips.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: tips.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: prMergeable(repo, pr),
    created_at: tsOf(pr.seq),
    updated_at: tsOf(pr.seq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}
function prMergeable(repo: Repo, pr: PullRequest): boolean {
  if (pr.state !== 'open') return false;
  const tips = prTips(repo, pr);
  const base = mergeBase(repo, tips.headSha, tips.baseSha);
  if (base === null) return false;
  const headCommit = repo.objects.get(tips.headSha);
  const baseCommit = repo.objects.get(tips.baseSha);
  const baseBaseCommit = repo.objects.get(base);
  if (!headCommit || !baseCommit || !baseBaseCommit) return false;
  const merged = threeWayMerge(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree, parseCommit(baseBaseCommit.data).tree);
  return merged.ok;
}
/** The files a pull request changes, against its base branch tip. */
function prFiles(repo: Repo, pr: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const tips = prTips(repo, pr);
  const headCommit = repo.objects.get(tips.headSha);
  const baseCommit = repo.objects.get(tips.baseSha);
  if (!headCommit || !baseCommit) return [];
  const diffs = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
  return diffs.map((d) => ({
    filename: d.path,
    status: d.status,
    additions: d.additions,
    deletions: d.deletions,
    changes: d.additions + d.deletions,
  }));
}

/** Create a commit on `branch` that sets `path` to `blobSha` (null removes it). */
function commitFileChange(repo: Repo, branch: string, path: string, blobSha: string | null, message: string): { commitSha: string; blobSha: string | null } {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parentTree = tip !== undefined ? parseCommit(repo.objects.get(tip)!.data).tree : EMPTY_TREE_SHA;
  const newTree = setPathInTree(repo, parentTree, path, blobSha);
  const stamp = `${SCENARIO_EPOCH_SEC} +0000`;
  const lines: string[] = [`tree ${newTree}`];
  if (tip !== undefined) lines.push(`parent ${tip}`);
  lines.push(`author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp}`);
  lines.push(`committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp}`);
  lines.push('', message);
  const commitSha = storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.version += 1;
  return { commitSha, blobSha };
}
/** Resolve a ref name or sha to a commit sha, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const direct = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const obj = repo.objects.get(ref);
  if (obj && obj.type === 'commit') return ref;
  if (obj && obj.type === 'tag') {
    const text = obj.data.toString('utf8');
    const match = /^object ([0-9a-f]{40})$/m.exec(text);
    if (match) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// REST v3

function restRepoParam(pathname: string): { owner: string; repo: string; rest: string[] } | null {
  const parts = pathname.split('/').filter((p) => p !== '');
  // /api/v3/repos/{owner}/{repo}[/...]
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos') return null;
  return { owner: decodePathSegment(parts[3]!), repo: decodePathSegment(parts[4]!), rest: parts.slice(5).map(decodePathSegment) };
}

function paginate<T>(items: T[], search: URLSearchParams): { page: T[]; perPage: number; pageNum: number; lastPage: number } {
  const perPageRaw = Number(search.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.trunc(perPageRaw) : 30;
  const pageRaw = Number(search.get('page') ?? '1');
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum, lastPage };
}
function linkHeader(req: IncomingMessage, pathname: string, search: URLSearchParams, pageNum: number, perPage: number, lastPage: number): Record<string, string> {
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${pathname}`;
  const links: string[] = [];
  if (pageNum < lastPage) links.push(`<${base}?page=${pageNum + 1}&per_page=${perPage}>; rel="next"`);
  if (pageNum > 1) links.push(`<${base}?page=${pageNum - 1}&per_page=${perPage}>; rel="prev"`);
  links.push(`<${base}?page=1&per_page=${perPage}>; rel="first"`);
  links.push(`<${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`);
  void search;
  return { link: links.join(', ') };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const parts = pathname.split('/').filter((p) => p !== '');
  if (parts[0] !== 'api' || parts[1] !== 'v3') return false;

  // The API root.
  if ((pathname === '/api/v3' || pathname === '/api/v3/') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // Meta.
  if (pathname === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  // The token's user.
  if (pathname === '/api/v3/user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return true;
  }
  // Create / list the viewer's repositories.
  if (pathname === '/api/v3/user/repos' && (method === 'POST' || method === 'GET')) {
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (isRecord(body) && body.__badJson === true) {
        sendError(res, 400, 'Invalid JSON');
        return true;
      }
      const record = isRecord(body) ? body : {};
      const name = typeof record.name === 'string' ? record.name : '';
      if (name === '') {
        sendError(res, 422, 'name is required');
        return true;
      }
      if (repos.has(`${VIEWER_LOGIN}/${name}`)) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      const repo = createRepo(
        name,
        record.private === true,
        typeof record.description === 'string' ? record.description : '',
        typeof record.default_branch === 'string' ? record.default_branch : 'main',
      );
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    const all = [...repos.values()].sort((a, b) => a.seq - b.seq);
    const { page, perPage, pageNum, lastPage } = paginate(all, search);
    sendJson(res, 200, page.map(repoJson), linkHeader(req, pathname, search, pageNum, perPage, lastPage));
    return true;
  }

  const repoParam = restRepoParam(pathname);
  if (repoParam !== null) {
    const { owner, repo: repoName, rest } = repoParam;
    const repo = findRepo(owner, repoName);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const body = parseJsonBody(await readBody(req));
        if (isRecord(body) && body.__badJson === true) {
          sendError(res, 400, 'Invalid JSON');
          return true;
        }
        if (isRecord(body) && typeof body.description === 'string') repo.description = body.description;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(`${owner}/${repoName}`);
        res.writeHead(204, { 'x-github-request-id': `forge-${++requestSeq}` });
        res.end();
        return true;
      }
      return false;
    }
    const [section, ...tail] = rest as [string, ...string[]];
    // Branches.
    if (section === 'branches') {
      if (tail.length === 0 && method === 'GET') {
        const list = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, list);
        return true;
      }
      if (tail.length === 1 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${tail[0]}`);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { name: tail[0], commit: { sha }, protected: false });
        return true;
      }
      return false;
    }
    // Commits.
    if (section === 'commits' && tail.length === 0 && method === 'GET') {
      const tip = resolveRef(repo, search.get('sha'));
      if (tip === null) {
        sendJson(res, 200, []);
        return true;
      }
      const shas = commitWalk(repo, tip, 1000);
      const { page } = paginate(shas, search);
      sendJson(res, 200, page.map((sha) => {
        const info = parseCommit(repo.objects.get(sha)!.data);
        return {
          sha,
          commit: {
            message: info.message,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: tsOf(repo.seq) },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: tsOf(repo.seq) },
          },
          parents: info.parents.map((p) => ({ sha: p })),
          url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}`,
        };
      }));
      return true;
    }
    // Git data: refs.
    if (section === 'git' && tail[0] === 'refs') {
      if (method === 'GET' && tail.length === 1) {
        const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        sendJson(res, 200, list);
        return true;
      }
      if (method === 'GET' && tail.length === 3 && tail[1] === 'heads') {
        const sha = repo.refs.get(`refs/heads/${tail[2]}`);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { ref: `refs/heads/${tail[2]}`, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/heads/${tail[2]}` });
        return true;
      }
      if (method === 'POST' && tail.length === 1) {
        const body = parseJsonBody(await readBody(req));
        if (isRecord(body) && body.__badJson === true) {
          sendError(res, 400, 'Invalid JSON');
          return true;
        }
        const record = isRecord(body) ? body : {};
        const ref = typeof record.ref === 'string' ? record.ref : '';
        const sha = typeof record.sha === 'string' ? record.sha : '';
        if (!ref.startsWith('refs/')) {
          sendError(res, 422, 'ref must start with refs/');
          return true;
        }
        const obj = repo.objects.get(sha);
        if (!obj || obj.type !== 'commit') {
          sendError(res, 422, 'sha is not a commit');
          return true;
        }
        if (repo.refs.has(ref)) {
          sendError(res, 422, 'Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        repo.version += 1;
        sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      return false;
    }
    // Contents.
    if (section === 'contents') {
      const contentPath = tail.join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, search.get('ref'));
        if (tip === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const treeSha = parseCommit(repo.objects.get(tip)!.data).tree;
        if (contentPath === '') {
          const root = lookupTree(repo, treeSha, '');
          if (!root) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, root.tree.map((e) => ({
            type: e.isDir ? 'dir' : 'file',
            name: e.name,
            path: e.name,
            sha: e.oid,
            size: e.isDir ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
          })));
          return true;
        }
        const blob = lookupBlob(repo, treeSha, contentPath);
        if (blob !== null) {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: blob.data.toString('base64'),
            sha: blob.oid,
            size: blob.data.length,
            name: contentPath.split('/').pop(),
            path: contentPath,
          });
          return true;
        }
        const dir = lookupTree(repo, treeSha, contentPath);
        if (dir !== null) {
          sendJson(res, 200, dir.tree.map((e) => ({
            type: e.isDir ? 'dir' : 'file',
            name: e.name,
            path: `${contentPath}/${e.name}`,
            sha: e.oid,
            size: e.isDir ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
          })));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT') {
        const body = parseJsonBody(await readBody(req));
        if (isRecord(body) && body.__badJson === true) {
          sendError(res, 400, 'Invalid JSON');
          return true;
        }
        const record = isRecord(body) ? body : {};
        const message = typeof record.message === 'string' ? record.message : 'Update file';
        const contentB64 = typeof record.content === 'string' ? record.content : '';
        const sha = typeof record.sha === 'string' ? record.sha : undefined;
        const branch = typeof record.branch === 'string' ? record.branch : repo.defaultBranch;
        const data = Buffer.from(contentB64, 'base64');
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        const exists = branchTip !== undefined
          ? lookupBlob(repo, parseCommit(repo.objects.get(branchTip)!.data).tree, contentPath) !== null
          : false;
        if (exists && sha !== undefined) {
          const current = lookupBlob(repo, parseCommit(repo.objects.get(branchTip!)!.data).tree, contentPath)!;
          if (current.oid !== sha) {
            sendError(res, 409, 'sha does not match the current file');
            return true;
          }
        }
        if (!exists && sha !== undefined) {
          sendError(res, 422, 'sha was supplied but the file does not exist');
          return true;
        }
        if (branchTip === undefined) {
          // A contents write on a branch that does not exist creates it from
          // the default branch tip (or from nothing when the repo is empty).
          const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (base !== undefined) repo.refs.set(`refs/heads/${branch}`, base);
        }
        const blobSha = storeObject(repo, 'blob', data);
        const { commitSha } = commitFileChange(repo, branch, contentPath, blobSha, message);
        sendJson(res, exists ? 200 : 201, {
          content: { name: contentPath.split('/').pop(), path: contentPath, sha: blobSha, size: data.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = parseJsonBody(await readBody(req));
        if (isRecord(body) && body.__badJson === true) {
          sendError(res, 400, 'Invalid JSON');
          return true;
        }
        const record = isRecord(body) ? body : {};
        const message = typeof record.message === 'string' ? record.message : 'Delete file';
        const sha = typeof record.sha === 'string' ? record.sha : undefined;
        const branch = typeof record.branch === 'string' ? record.branch : repo.defaultBranch;
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (branchTip === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const current = lookupBlob(repo, parseCommit(repo.objects.get(branchTip)!.data).tree, contentPath);
        if (current === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (sha !== undefined && current.oid !== sha) {
          sendError(res, 409, 'sha does not match the current file');
          return true;
        }
        const { commitSha } = commitFileChange(repo, branch, contentPath, null, message);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      return false;
    }
    // Labels.
    if (section === 'labels') {
      if (method === 'GET' && tail.length === 0) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, description: '' })));
        return true;
      }
      if (method === 'POST' && tail.length === 0) {
        const body = parseJsonBody(await readBody(req));
        if (isRecord(body) && body.__badJson === true) {
          sendError(res, 400, 'Invalid JSON');
          return true;
        }
        const record = isRecord(body) ? body : {};
        const name = typeof record.name === 'string' ? record.name : '';
        const color = typeof record.color === 'string' ? record.color : '000000';
        if (name === '') {
          sendError(res, 422, 'name is required');
          return true;
        }
        if (repo.labels.has(name)) {
          sendError(res, 422, 'Label already exists');
          return true;
        }
        const label = { name, color, id: repo.nextLabelId++ };
        repo.labels.set(name, label);
        sendJson(res, 201, { id: label.id, name, color, description: '' });
        return true;
      }
      return false;
    }
    // Issues.
    if (section === 'issues') {
      if (tail.length === 0) {
        if (method === 'POST') {
          const body = parseJsonBody(await readBody(req));
          if (isRecord(body) && body.__badJson === true) {
            sendError(res, 400, 'Invalid JSON');
            return true;
          }
          const record = isRecord(body) ? body : {};
          const title = typeof record.title === 'string' ? record.title : '';
          const issueBody = typeof record.body === 'string' ? record.body : '';
          const labelNames: string[] = Array.isArray(record.labels) ? record.labels.filter((l): l is string => typeof l === 'string') : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) {
              sendError(res, 422, `Label '${labelName}' does not exist`);
              return true;
            }
          }
          const number = repo.nextIssue++;
          const issue: Issue = {
            id: nextIssueId++,
            number,
            title,
            body: issueBody,
            state: 'open',
            labels: labelNames,
            comments: [],
            seq: ++repoSeq,
            user: VIEWER_LOGIN,
          };
          repo.issues.set(number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          const sort = search.get('sort') ?? 'created';
          const direction = search.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { page } = paginate(list, search);
          sendJson(res, 200, page.map((i) => issueJson(repo, i)));
          return true;
        }
        return false;
      }
      const num = Number(tail[0]);
      if (!Number.isInteger(num)) return false;
      const issue = repo.issues.get(num);
      if (tail.length === 1) {
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const body = parseJsonBody(await readBody(req));
          if (isRecord(body) && body.__badJson === true) {
            sendError(res, 400, 'Invalid JSON');
            return true;
          }
          const record = isRecord(body) ? body : {};
          if (typeof record.title === 'string') issue.title = record.title;
          if (typeof record.body === 'string') issue.body = record.body;
          if (record.state === 'open' || record.state === 'closed') issue.state = record.state;
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        return false;
      }
      if (tail.length === 2 && tail[1] === 'comments') {
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.user, id: 1000, type: 'User' }, created_at: tsOf(c.id) })));
          return true;
        }
        if (method === 'POST') {
          const body = parseJsonBody(await readBody(req));
          if (isRecord(body) && body.__badJson === true) {
            sendError(res, 400, 'Invalid JSON');
            return true;
          }
          const record = isRecord(body) ? body : {};
          const commentBody = typeof record.body === 'string' ? record.body : '';
          const comment: IssueComment = { id: repo.nextCommentId++, body: commentBody, user: VIEWER_LOGIN };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: comment.user, id: 1000, type: 'User' }, created_at: tsOf(comment.id) });
          return true;
        }
        return false;
      }
      return false;
    }
    // Pull requests.
    if (section === 'pulls') {
      if (tail.length === 0) {
        if (method === 'POST') {
          const body = parseJsonBody(await readBody(req));
          if (isRecord(body) && body.__badJson === true) {
            sendError(res, 400, 'Invalid JSON');
            return true;
          }
          const record = isRecord(body) ? body : {};
          const title = typeof record.title === 'string' ? record.title : '';
          const prBody = typeof record.body === 'string' ? record.body : '';
          const headRaw = typeof record.head === 'string' ? record.head : '';
          const baseRaw = typeof record.base === 'string' ? record.base : '';
          const headRef = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
          const baseRef = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (headSha === undefined || baseSha === undefined) {
            sendError(res, 422, 'head or base branch does not exist');
            return true;
          }
          const number = repo.nextPull++;
          const pr: PullRequest = {
            id: nextPullId++,
            number,
            title,
            body: prBody,
            state: 'open',
            headRef,
            headSha,
            baseRef,
            baseSha,
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            seq: ++repoSeq,
            user: VIEWER_LOGIN,
          };
          repo.pulls.set(number, pr);
          sendJson(res, 201, pullJson(repo, pr));
          return true;
        }
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page } = paginate(list, search);
          sendJson(res, 200, page.map((p) => pullJson(repo, p)));
          return true;
        }
        return false;
      }
      const num = Number(tail[0]);
      if (!Number.isInteger(num)) return false;
      const pr = repo.pulls.get(num);
      if (tail.length === 1) {
        if (pr === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pr));
          return true;
        }
        return false;
      }
      if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
        if (pr === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, prFiles(repo, pr));
        return true;
      }
      if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
        if (pr === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const body = parseJsonBody(await readBody(req));
        if (isRecord(body) && body.__badJson === true) {
          sendError(res, 400, 'Invalid JSON');
          return true;
        }
        const record = isRecord(body) ? body : {};
        const mergeMethod = typeof record.merge_method === 'string' ? record.merge_method : 'squash';
        const result = mergePr(repo, pr, mergeMethod);
        if (!result.ok) {
          sendError(res, 405, result.message ?? 'Merge failed');
          return true;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: `Merged #${pr.number}: ${pr.title}` });
        return true;
      }
      return false;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Git smart HTTP

const GIT_AGENT = 'forge/1.0';

/** The refs a repository advertises, in git's order (HEAD first). */
function advertisedRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push({ oid: defaultTip ?? ZERO_OID, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (match) entry.peeled = match[1];
      }
    }
    out.push(entry);
  }
  return out;
}

function uploadPackAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-upload-pack\n'));
  parts.push(PKT_FLUSH);
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine(`agent=${GIT_AGENT}\n`));
  parts.push(pktLine('ls-refs=unborn\n'));
  parts.push(pktLine('fetch=shallow\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(PKT_FLUSH);
  void repo;
  return Buffer.concat(parts);
}
function receivePackAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-receive-pack\n'));
  parts.push(PKT_FLUSH);
  const caps = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${GIT_AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const refs = advertisedRefs(repo);
  if (refs.length === 1 && refs[0]!.oid === ZERO_OID) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The pack for a fetch, memoized per repository version. */
const packCache = new Map<string, { version: number; pack: Buffer }>();
function cachedPack(repo: Repo, key: string, build: () => Buffer): Buffer {
  const cacheKey = `${repo.owner}/${repo.name}|${key}`;
  const hit = packCache.get(cacheKey);
  if (hit && hit.version === repo.version) return hit.pack;
  const pack = build();
  packCache.set(cacheKey, { version: repo.version, pack });
  if (packCache.size > 64) {
    const first = packCache.keys().next().value;
    if (first !== undefined) packCache.delete(first);
  }
  return pack;
}

interface FetchPlan {
  /** Objects to send, in pack order. */
  send: Map<string, ObjType>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
  wantedRefs: Array<{ oid: string; ref: string }>;
}
function planFetch(repo: Repo, wants: string[], haves: string[], shallowBoundary: string[], depth: number | null, deepenRelative = false): FetchPlan {
  // Walk commits from the wants, tracking generations.
  const commitGen = new Map<string, number>();
  const wantTags: string[] = [];
  const queue: Array<{ sha: string; gen: number }> = wants.map((w) => ({ sha: w, gen: 0 }));
  const wantCommits: string[] = [];
  while (queue.length > 0) {
    const { sha, gen } = queue.shift()!;
    if (commitGen.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    if (obj.type === 'tag') {
      wantTags.push(sha);
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match) queue.push({ sha: match[1], gen });
      continue;
    }
    if (obj.type !== 'commit') continue;
    commitGen.set(sha, gen);
    wantCommits.push(sha);
    // With deepen-relative the walk is unlimited here; the effective depth
    // is computed from the boundary generation below and applied as a filter.
    if (depth === null || deepenRelative || gen + 1 < depth) {
      for (const parent of parseCommit(obj.data).parents) queue.push({ sha: parent, gen: gen + 1 });
    }
  }
  // `deepen-relative` (real git's --deepen): the deepen count is relative to
  // the client's current shallow depth — the boundary's generation below the
  // want, plus one. A depth-1 clone (boundary == want, gen 0) deepened by 1
  // has effective depth 2. Without it, `deepen N` is an absolute depth.
  let effectiveDepth = depth;
  if (deepenRelative && depth !== null) {
    let minGen: number | null = null;
    for (const boundary of shallowBoundary) {
      const gen = commitGen.get(boundary);
      if (gen !== undefined && (minGen === null || gen < minGen)) minGen = gen;
    }
    if (minGen !== null) effectiveDepth = depth + minGen + 1;
  }
  const inDepthCommits = effectiveDepth === null ? wantCommits : wantCommits.filter((c) => (commitGen.get(c) ?? 0) < effectiveDepth);
  // What the client already holds: everything reachable from its haves —
  // except the history below a shallow boundary, which the client does NOT
  // hold (a shallow clone holds the boundary commit and its tree, not the
  // boundary's parents). Treating `have <tip>` as "holds the whole history"
  // re-sends ancestors on every deepen.
  const heldObjects = reachable(repo, haves);
  const heldCommits = new Set<string>();
  for (const [oid, type] of heldObjects) if (type === 'commit') heldCommits.add(oid);
  for (const boundary of shallowBoundary) {
    const obj = repo.objects.get(boundary);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      for (const [oid] of reachable(repo, [parent])) {
        heldObjects.delete(oid);
        heldCommits.delete(oid);
      }
    }
  }
  // The object set: for each in-depth commit the client does not hold, the
  // commit itself plus its tree closure — NOT the full history closure.
  // (The old code used reachable([commit]), which ignored the depth limit
  // and shipped every ancestor, so a depth-1 clone carried whole history.)
  const send = new Map<string, ObjType>();
  for (const commitSha of inDepthCommits) {
    if (heldCommits.has(commitSha)) continue;
    const obj = repo.objects.get(commitSha);
    if (!obj) continue;
    send.set(commitSha, 'commit');
    const treeSha = parseCommit(obj.data).tree;
    for (const [oid, type] of reachable(repo, [treeSha])) {
      if (heldObjects.has(oid)) continue;
      if (!send.has(oid)) send.set(oid, type);
    }
  }
  // Tag objects the client asked for (a want that names a tag).
  for (const tagSha of wantTags) {
    if (!heldObjects.has(tagSha)) send.set(tagSha, 'tag');
  }
  // The shallow boundary: sent commits with a parent the client will not hold.
  const shallow: string[] = [];
  for (const commitSha of inDepthCommits) {
    if (heldCommits.has(commitSha)) continue;
    if (!send.has(commitSha)) continue;
    const obj = repo.objects.get(commitSha);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const cut = parents.some((p) => !send.has(p) && !heldCommits.has(p));
    if (cut && parents.length > 0) shallow.push(commitSha);
  }
  // Unshallow: old boundary commits whose parents the client now holds.
  const unshallow: string[] = [];
  for (const boundary of shallowBoundary) {
    const obj = repo.objects.get(boundary);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.every((p) => send.has(p) || heldCommits.has(p))) unshallow.push(boundary);
  }
  // Acknowledgments: haves that are ancestors of a want.
  const acks: string[] = [];
  let nak = false;
  if (haves.length === 0) {
    nak = true;
  } else {
    for (const have of haves) if (commitGen.has(have)) acks.push(have);
    if (acks.length === 0) nak = true;
  }
  // Wanted refs: wants that are ref tips.
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const want of wants) {
    for (const [ref, sha] of repo.refs) if (sha === want) wantedRefs.push({ oid: want, ref });
  }
  return { send, shallow, unshallow, acks, nak, wantedRefs };
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const refs = advertisedRefs(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const isEmpty = defaultTip === undefined;
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
    if (ref.name === 'HEAD') {
      if (isEmpty) {
        if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
        continue;
      }
      const attrs = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`${ref.oid} HEAD${attrs}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponse(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundary: string[] = [];
  let depth: number | null = null;
  let done = false;
  let deepenRelative = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowBoundary.push(arg.slice(8).trim());
    else if (arg === 'done') done = true;
    else if (arg === 'deepen-relative') deepenRelative = true;
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = Math.trunc(n);
    }
  }
  const plan = planFetch(repo, wants, haves, shallowBoundary, depth, deepenRelative);
  const parts: Buffer[] = [];
  if (!done) {
    // No `done`: the client sent haves and is waiting — answer with the
    // acknowledgments section first. Real git's deepen fetch omits `done`
    // and still expects shallow-info + packfile in the SAME response
    // (verified against git upload-pack), so this section is a prefix,
    // not the whole response.
    parts.push(pktLine('acknowledgments\n'));
    if (plan.nak) parts.push(pktLine('NAK\n'));
    else {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_DELIM);
  }
  // `done` was sent: real git (and the kit client) expect NO acknowledgments
  // section — only shallow-info (when applicable), then the packfile section.
  // Sending `acknowledgments` here makes real git die with
  // "expected 'packfile', received 'acknowledgments'".
  const pack = cachedPack(
    repo,
    `fetch|${wants.join(',')}|${haves.join(',')}|${shallowBoundary.join(',')}|${depth ?? ''}|${deepenRelative ? 'rel' : ''}`,
    () => writePack([...plan.send.entries()].map(([sha, type]) => ({ type, data: repo.objects.get(sha)!.data }))),
  );
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  // packfile (sideband band 1, chunks of at most 65515 data bytes)
  parts.push(pktLine('packfile\n'));
  const MAX_DATA = 65515;
  for (let off = 0; off < pack.length; off += MAX_DATA) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + MAX_DATA));
    const banded = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(banded));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const parts = pathname.split('/').filter((p) => p !== '');
  if (parts.length < 2 || !parts[1]!.endsWith('.git')) return false;
  const owner = decodePathSegment(parts[0]!);
  const repoName = decodePathSegment(parts[1]!.slice(0, -4));
  const service = parts.slice(2).join('/');
  const repo = findRepo(owner, repoName);
  // A push cannot invent a repository, and a missing one is a 404 on both
  // services; the server stays up.
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (method === 'GET' && service === 'info/refs') {
    const asked = search.get('service') ?? '';
    if (asked === 'git-upload-pack') {
      sendRaw(res, 200, uploadPackAdvertisement(repo), 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (asked === 'git-receive-pack') {
      sendRaw(res, 200, receivePackAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendError(res, 400, 'service is required');
    return true;
  }
  if (method === 'POST' && service === 'git-upload-pack') {
    const body = await readBody(req);
    const packets = parsePktLines(body);
    const lines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    const command = lines[0] ?? '';
    const args = lines.slice(1);
    if (command === 'command=ls-refs') {
      sendRaw(res, 200, lsRefsResponse(repo, args), 'application/x-git-upload-pack-result');
      return true;
    }
    if (command === 'command=fetch') {
      sendRaw(res, 200, fetchResponse(repo, args), 'application/x-git-upload-pack-result');
      return true;
    }
    sendError(res, 400, 'unknown command');
    return true;
  }
  if (method === 'POST' && service === 'git-receive-pack') {
    const body = await readBody(req);
    // The command list is pkt-lines up to the first flush; the pack follows raw.
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let packOffset = 0;
    {
      let off = 0;
      let first = true;
      while (off + 4 <= body.length) {
        const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
        if (Number.isNaN(len) || len === 0) {
          packOffset = off + 4;
          break;
        }
        if (len === 1 || len === 2) {
          off += 4;
          continue;
        }
        const payload = body.subarray(off + 4, off + len).toString('utf8');
        const text = first ? payload.split('\0')[0]! : payload;
        first = false;
        const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(text.replace(/\n$/, ''));
        if (match) commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
        off += len;
      }
      if (packOffset === 0) packOffset = body.length;
    }
    // Unpack the pack (a delete-only push carries none).
    const packBytes = body.subarray(packOffset);
    let unpackError: string | null = null;
    if (packBytes.length > 0) {
      try {
        const parsed = parsePack(packBytes);
        for (const [sha, obj] of parsed.objects) {
          if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
        }
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    }
    const results: string[] = [];
    if (unpackError !== null) {
      results.push(`unpack ${unpackError}`);
    } else {
      results.push('unpack ok');
    }
    for (const command of commands) {
      if (unpackError !== null) {
        results.push(`ng ${command.ref} unpack failed`);
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push(`ng ${command.ref} remote ref does not exist`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push(`ng ${command.ref} non-fast-forward`);
        } else {
          repo.refs.delete(command.ref);
          repo.version += 1;
          results.push(`ok ${command.ref}`);
        }
        continue;
      }
      const newObj = repo.objects.get(command.newOid);
      // A branch update must name a commit; a tag ref may name a tag object
      // (annotated tag) or a commit (lightweight tag).
      const isTagRef = command.ref.startsWith('refs/tags/');
      if (!newObj || (isTagRef ? (newObj.type !== 'commit' && newObj.type !== 'tag') : newObj.type !== 'commit')) {
        results.push(`ng ${command.ref} object not found`);
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          results.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        repo.version += 1;
        results.push(`ok ${command.ref}`);
        continue;
      }
      if (command.oldOid !== current) {
        results.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      // Fast-forward check applies to branches only; a tag ref is replaced
      // wholesale (the client sends the current tag oid as oldOid).
      if (!isTagRef && !isAncestor(repo, current, command.newOid)) {
        results.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      repo.version += 1;
      results.push(`ok ${command.ref}`);
    }
    // Report-status with side-band-64k: the report lines are themselves
    // pkt-lines INSIDE a single band-1 sideband packet (verified against
    // real git: `sideband< \1000eunpack ok0037ng ...0000`). Sending each
    // line as its own band-1 packet makes real git die with
    // "bad line length character: unpa" — the demultiplexer hands it the
    // raw `unpack ok` text where a pkt-line length is expected.
    const inner: Buffer[] = [];
    for (const line of results) inner.push(pktLine(`${line}\n`));
    inner.push(PKT_FLUSH);
    const banded = Buffer.concat([Buffer.from([1]), Buffer.concat(inner)]);
    const parts: Buffer[] = [pktLine(banded), PKT_FLUSH];
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GraphQL v4 (a small executor for the documents gh and github-mcp-server send)

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };
interface GqlSelection {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  children: GqlSelection[];
  inlineType: string | null;
}
interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if ('{}():![]$@'.includes(ch) || ch === '.') {
      if (ch === '.' && src.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: string[];
  private readonly variables: Record<string, unknown>;
  constructor(tokens: string[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }
  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    return this.tokens[this.pos++]!;
  }
  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{') name = this.next();
    }
    if (this.peek() === '(') this.skipParens();
    const selections = this.parseSelections();
    return { kind, name, selections };
  }
  private skipParens(): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }
  private parseSelections(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }
  private parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      let inlineType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        inlineType = this.next();
      }
      const children = this.parseSelections();
      return { alias: null, name: '__fragment', args: {}, children, inlineType };
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.pos < this.tokens.length) {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let children: GqlSelection[] = [];
    if (this.peek() === '{') children = this.parseSelections();
    return { alias, name, args, children, inlineType: null };
  }
  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') {
      const varName = this.next();
      const value = this.variables[varName];
      return gqlFromJson(value);
    }
    if (token === '[') {
      const list: GqlValue[] = [];
      while (this.peek() !== ']') list.push(this.parseValue());
      this.next();
      return list;
    }
    if (token === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.next();
      return obj;
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?\d+$/.test(token)) return Number(token);
    return token; // an enum literal
  }
}
function gqlFromJson(value: unknown): GqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(gqlFromJson);
  if (typeof value === 'object') {
    const out: Record<string, GqlValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = gqlFromJson(v);
    return out;
  }
  return null;
}

// Global ids: opaque, stable, never a plain number.
function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}
function ungid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}
function numberOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice(7));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// The schema the __type probe reads.
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
};
const GQL_SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];
const GQL_FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  Viewer: new Set(['login', 'id']),
  User: new Set(['login', 'id']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']),
  BranchRef: new Set(['name']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body']),
  IssueConnection: new Set(['nodes', 'pageInfo']),
  PullRequestConnection: new Set(['nodes', 'pageInfo']),
  PageInfo: new Set(['hasNextPage', 'endCursor']),
  PullRequest: new Set(['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files']),
  FileConnection: new Set(['nodes']),
  File: new Set(['path']),
  IssueComment: new Set(['id', 'body']),
  IssueCommentEdge: new Set(['node']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues']),
  __Field: new Set(['name']),
  __EnumValue: new Set(['name']),
};

interface GqlContext {
  errors: Array<{ message: string }>;
}

function gqlFieldError(ctx: GqlContext, field: string, typeName: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

/** Resolve one object's selections; returns the object (or null). */
function resolveSelections(
  ctx: GqlContext,
  typeName: string,
  source: Record<string, unknown>,
  selections: GqlSelection[],
  resolvers: Record<string, (sel: GqlSelection) => unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = GQL_FIELDS[typeName] ?? new Set<string>();
  for (const sel of selections) {
    if (sel.name === '__fragment') {
      if (sel.inlineType !== null && sel.inlineType !== typeName) continue;
      Object.assign(out, resolveSelections(ctx, typeName, source, sel.children, resolvers));
      continue;
    }
    if (sel.name === '__typename') {
      out[sel.alias ?? sel.name] = typeName;
      continue;
    }
    if (!allowed.has(sel.name)) {
      gqlFieldError(ctx, sel.name, typeName);
      continue;
    }
    const resolver = resolvers[sel.name];
    if (resolver === undefined) continue;
    out[sel.alias ?? sel.name] = resolver(sel);
  }
  return out;
}

function findRepoByGid(id: string): Repo | null {
  const decoded = ungid(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const [owner, name] = decoded.key.split('/', 2);
  if (owner === undefined || name === undefined) return null;
  return findRepo(owner, name);
}
function findIssueByGid(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = ungid(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return null;
  const repoKey = decoded.key.slice(0, hash);
  const number = Number(decoded.key.slice(hash + 1));
  const [owner, name] = repoKey.split('/', 2);
  if (owner === undefined || name === undefined || !Number.isInteger(number)) return null;
  const repo = findRepo(owner, name);
  if (!repo) return null;
  const issue = repo.issues.get(number);
  if (!issue) return null;
  return { repo, issue };
}
function findPrByGid(id: string): { repo: Repo; pr: PullRequest } | null {
  const decoded = ungid(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return null;
  const repoKey = decoded.key.slice(0, hash);
  const number = Number(decoded.key.slice(hash + 1));
  const [owner, name] = repoKey.split('/', 2);
  if (owner === undefined || name === undefined || !Number.isInteger(number)) return null;
  const repo = findRepo(owner, name);
  if (!repo) return null;
  const pr = repo.pulls.get(number);
  if (!pr) return null;
  return { repo, pr };
}

function issueGql(repo: Repo, issue: Issue, sel: GqlSelection, ctx: GqlContext): Record<string, unknown> {
  return resolveSelections(
    ctx,
    'Issue',
    {},
    sel.children,
    {
      id: () => gid('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
      number: () => issue.number,
      title: () => issue.title,
      state: () => (issue.state === 'open' ? 'OPEN' : 'CLOSED'),
      body: () => issue.body,
    },
  );
}
function prGql(repo: Repo, pr: PullRequest, sel: GqlSelection, ctx: GqlContext): Record<string, unknown> {
  return resolveSelections(
    ctx,
    'PullRequest',
    {},
    sel.children,
    {
      id: () => gid('PullRequest', `${repo.owner}/${repo.name}#${pr.number}`),
      number: () => pr.number,
      state: () => (pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED'),
      merged: () => pr.merged,
      headRefName: () => pr.headRef,
      baseRefName: () => pr.baseRef,
      mergeable: () => (prMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING'),
      files: (fileSel) => {
        const first = typeof fileSel.args.first === 'number' ? fileSel.args.first : 10;
        const files = prFiles(repo, pr).slice(0, first);
        const nodesSel = fileSel.children.find((c) => c.name === 'nodes');
        const nodeList = files.map((f) => {
          if (!nodesSel) return { path: f.filename };
          return resolveSelections(ctx, 'File', {}, nodesSel.children, { path: () => f.filename });
        });
        return { nodes: nodeList };
      },
    },
  );
}
function repoGql(repo: Repo, sel: GqlSelection, ctx: GqlContext): Record<string, unknown> {
  return resolveSelections(
    ctx,
    'Repository',
    {},
    sel.children,
    {
      id: () => gid('Repository', `${repo.owner}/${repo.name}`),
      databaseId: () => repo.dbId,
      name: () => repo.name,
      nameWithOwner: () => `${repo.owner}/${repo.name}`,
      owner: (ownerSel) => resolveSelections(ctx, 'User', {}, ownerSel.children, { login: () => repo.owner, id: () => 1000 }),
      defaultBranchRef: (refSel) => {
        const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (sha === undefined) return null;
        return resolveSelections(ctx, 'BranchRef', {}, refSel.children, { name: () => repo.defaultBranch });
      },
      viewerPermission: () => 'ADMIN',
      hasIssuesEnabled: () => true,
      issue: (issueSel) => {
        const number = typeof issueSel.args.number === 'number' ? issueSel.args.number : -1;
        const issue = repo.issues.get(number);
        if (!issue) return null;
        return issueGql(repo, issue, issueSel, ctx);
      },
      issues: (issuesSel) => {
        let list = [...repo.issues.values()];
        const states = Array.isArray(issuesSel.args.states) ? (issuesSel.args.states as GqlValue[]) : null;
        if (states !== null) {
          const wanted = new Set(states.map((s) => String(s)));
          list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const orderBy = isRecord(issuesSel.args.orderBy) ? issuesSel.args.orderBy : null;
        const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
        list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        const after = typeof issuesSel.args.after === 'string' ? numberOfCursor(issuesSel.args.after) : null;
        if (after !== null) {
          const idx = list.findIndex((i) => i.number === after);
          if (idx >= 0) list = list.slice(idx + 1);
        }
        const first = typeof issuesSel.args.first === 'number' ? issuesSel.args.first : list.length;
        const page = list.slice(0, first);
        const nodesSel = issuesSel.children.find((c) => c.name === 'nodes');
        const pageInfoSel = issuesSel.children.find((c) => c.name === 'pageInfo');
        const nodes = nodesSel ? page.map((issue) => issueGql(repo, issue, nodesSel, ctx)) : [];
        const pageInfo = pageInfoSel
          ? resolveSelections(ctx, 'PageInfo', {}, pageInfoSel.children, {
              hasNextPage: () => list.length > first,
              endCursor: () => (page.length > 0 ? cursorOf(page[page.length - 1]!.number) : null),
            })
          : null;
        const out: Record<string, unknown> = {};
        if (nodesSel) out.nodes = nodes;
        if (pageInfoSel) out.pageInfo = pageInfo;
        return out;
      },
      pullRequests: (prsSel) => {
        const first = typeof prsSel.args.first === 'number' ? prsSel.args.first : 10;
        const list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq).slice(0, first);
        const nodesSel = prsSel.children.find((c) => c.name === 'nodes');
        const nodes = nodesSel ? list.map((pr) => prGql(repo, pr, nodesSel, ctx)) : [];
        return { nodes };
      },
      pullRequest: (prSel) => {
        const number = typeof prSel.args.number === 'number' ? prSel.args.number : -1;
        const pr = repo.pulls.get(number);
        if (!pr) return null;
        return prGql(repo, pr, prSel, ctx);
      },
    },
  );
}

/** Merge a pull request (squash by default); shared by REST and GraphQL. */
function mergePr(repo: Repo, pr: PullRequest, method: string): { ok: boolean; sha?: string; message?: string } {
  if (pr.merged) return { ok: false, message: 'Pull request is already merged' };
  if (pr.state !== 'open') return { ok: false, message: 'Pull request is closed' };
  const tips = prTips(repo, pr);
  const base = mergeBase(repo, tips.headSha, tips.baseSha);
  if (base === null) return { ok: false, message: 'No merge base found' };
  const headCommit = repo.objects.get(tips.headSha);
  const baseCommit = repo.objects.get(tips.baseSha);
  const baseBaseCommit = repo.objects.get(base);
  if (!headCommit || !baseCommit || !baseBaseCommit) return { ok: false, message: 'Missing commit' };
  const merged = threeWayMerge(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree, parseCommit(baseBaseCommit.data).tree);
  if (!merged.ok || merged.treeSha === null) return { ok: false, message: 'Merge conflict' };
  const stamp = `${SCENARIO_EPOCH_SEC} +0000`;
  let mergeCommitSha: string;
  if (method === 'MERGE' || method === 'merge') {
    const lines = [
      `tree ${merged.treeSha}`,
      `parent ${tips.baseSha}`,
      `parent ${tips.headSha}`,
      `author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp}`,
      `committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp}`,
      '',
      `Merge pull request #${pr.number} from ${pr.headRef}`,
    ];
    mergeCommitSha = storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  } else if ((method === 'REBASE' || method === 'rebase') && isAncestor(repo, tips.baseSha, tips.headSha)) {
    mergeCommitSha = tips.headSha;
  } else {
    const lines = [
      `tree ${merged.treeSha}`,
      `parent ${tips.baseSha}`,
      `author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp}`,
      `committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp}`,
      '',
      pr.title,
    ];
    mergeCommitSha = storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  }
  repo.refs.set(`refs/heads/${pr.baseRef}`, mergeCommitSha);
  repo.version += 1;
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = tsOf(++repoSeq);
  pr.mergeCommitSha = mergeCommitSha;
  return { ok: true, sha: mergeCommitSha };
}

function executeOperation(op: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: GqlContext = { errors: [] };
  if (op.kind === 'query') {
    const data = resolveSelections(
      ctx,
      'Query',
      {},
      op.selections,
      {
        viewer: (sel) => resolveSelections(ctx, 'Viewer', {}, sel.children, { login: () => VIEWER_LOGIN, id: () => 1000 }),
        repository: (sel) => {
          const owner = typeof sel.args.owner === 'string' ? sel.args.owner : '';
          const name = typeof sel.args.name === 'string' ? sel.args.name : '';
          const repo = findRepo(owner, name);
          if (!repo) return null;
          return repoGql(repo, sel, ctx);
        },
        node: (sel) => {
          const id = typeof sel.args.id === 'string' ? sel.args.id : '';
          const decoded = ungid(id);
          if (!decoded) return null;
          if (decoded.kind === 'Repository') {
            const [owner, name] = decoded.key.split('/', 2);
            if (owner === undefined || name === undefined) return null;
            const repo = findRepo(owner, name);
            if (!repo) return null;
            return resolveSelections(
              ctx,
              'Repository',
              {},
              sel.children,
              {
                id: () => gid('Repository', `${repo.owner}/${repo.name}`),
                name: () => repo.name,
                nameWithOwner: () => `${repo.owner}/${repo.name}`,
              },
            );
          }
          return null;
        },
        __type: (sel) => {
          const typeName = typeof sel.args.name === 'string' ? sel.args.name : '';
          const fields = GQL_TYPE_FIELDS[typeName];
          return resolveSelections(ctx, '__Type', {}, sel.children, {
            name: () => typeName,
            kind: () => (typeName === 'SearchType' ? 'ENUM' : 'OBJECT'),
            fields: () => (fields === undefined ? null : fields.map((name) => ({ name }))),
            enumValues: () => (typeName === 'SearchType' ? GQL_SEARCH_TYPE_VALUES.map((name) => ({ name })) : null),
          });
        },
      },
    );
    return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
  }
  // Mutations.
  const data = resolveSelections(
    ctx,
    'Mutation',
    {},
    op.selections,
    {
      createIssue: (sel) => {
        const input = isRecord(sel.args.input) ? sel.args.input : {};
        const repo = typeof input.repositoryId === 'string' ? findRepoByGid(input.repositoryId) : null;
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
          return null;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const number = repo.nextIssue++;
        const issue: Issue = { id: nextIssueId++, number, title, body, state: 'open', labels: [], comments: [], seq: ++repoSeq, user: VIEWER_LOGIN };
        repo.issues.set(number, issue);
        const issueSel = sel.children.find((c) => c.name === 'issue');
        return { issue: issueSel ? issueGql(repo, issue, issueSel, ctx) : null };
      },
      closeIssue: (sel) => {
        const input = isRecord(sel.args.input) ? sel.args.input : {};
        const found = typeof input.issueId === 'string' ? findIssueByGid(input.issueId) : null;
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
          return null;
        }
        found.issue.state = 'closed';
        const issueSel = sel.children.find((c) => c.name === 'issue');
        return { issue: issueSel ? issueGql(found.repo, found.issue, issueSel, ctx) : null };
      },
      createPullRequest: (sel) => {
        const input = isRecord(sel.args.input) ? sel.args.input : {};
        const repo = typeof input.repositoryId === 'string' ? findRepoByGid(input.repositoryId) : null;
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
          return null;
        }
        const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
        const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (headSha === undefined || baseSha === undefined) {
          ctx.errors.push({ message: 'head or base branch does not exist' });
          return null;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const number = repo.nextPull++;
        const pr: PullRequest = {
          id: nextPullId++, number, title, body, state: 'open',
          headRef, headSha, baseRef, baseSha, merged: false, mergedAt: null, mergeCommitSha: null,
          seq: ++repoSeq, user: VIEWER_LOGIN,
        };
        repo.pulls.set(number, pr);
        const prSel = sel.children.find((c) => c.name === 'pullRequest');
        return { pullRequest: prSel ? prGql(repo, pr, prSel, ctx) : null };
      },
      mergePullRequest: (sel) => {
        const input = isRecord(sel.args.input) ? sel.args.input : {};
        const found = typeof input.pullRequestId === 'string' ? findPrByGid(input.pullRequestId) : null;
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
          return null;
        }
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
        const result = mergePr(found.repo, found.pr, method);
        if (!result.ok) {
          ctx.errors.push({ message: result.message ?? 'Merge failed' });
          return null;
        }
        const prSel = sel.children.find((c) => c.name === 'pullRequest');
        return { pullRequest: prSel ? prGql(found.repo, found.pr, prSel, ctx) : null };
      },
      addComment: (sel) => {
        const input = isRecord(sel.args.input) ? sel.args.input : {};
        const found = typeof input.subjectId === 'string' ? findIssueByGid(input.subjectId) : null;
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
          return null;
        }
        const body = typeof input.body === 'string' ? input.body : '';
        const comment: IssueComment = { id: found.repo.nextCommentId++, body, user: VIEWER_LOGIN };
        found.issue.comments.push(comment);
        const edgeSel = sel.children.find((c) => c.name === 'commentEdge');
        const nodeSel = edgeSel?.children.find((c) => c.name === 'node');
        const node = nodeSel
          ? resolveSelections(ctx, 'IssueComment', {}, nodeSel.children, {
              id: () => gid('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${comment.id}`),
              body: () => comment.body,
            })
          : { id: gid('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${comment.id}`), body: comment.body };
        return { commentEdge: { node } };
      },
    },
  );
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = parseJsonBody(await readBody(req));
  if (isRecord(body) && body.__badJson === true) {
    sendError(res, 400, 'Invalid JSON');
    return true;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { data: null, errors: [{ message: 'A query document is required.' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let op: GqlOperation;
    try {
      const parser = new GqlParser(gqlTokenize(doc.query), variables);
      op = parser.parseOperation();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
    return executeOperation(op, variables);
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(body));
  return true;
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol, Streamable HTTP, revision 2026-07-28)

const MCP_SERVER_NAME = 'forge-mcp';
const MCP_SERVER_VERSION = '1.0.0';
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}
const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpToolResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}
function mcpErrorResult(message: string): Record<string, unknown> {
  return mcpToolResult({ error: message }, true);
}

/** Run one MCP tool against the same store the REST surface reads. */
function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  if (name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name : '';
    if (repoNameArg === '') return mcpErrorResult('name is required');
    if (repos.has(`${VIEWER_LOGIN}/${repoNameArg}`)) return mcpErrorResult('Repository already exists');
    const repo = createRepo(
      repoNameArg,
      args.private === true,
      typeof args.description === 'string' ? args.description : '',
      'main',
    );
    return mcpToolResult(repoJson(repo));
  }
  const repo = findRepo(owner, repoName);
  if (!repo) return mcpErrorResult('Repository not found');
  if (name === 'get_repo') return mcpToolResult(repoJson(repo));
  if (name === 'create_issue') {
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const number = repo.nextIssue++;
    const issue: Issue = { id: nextIssueId++, number, title, body, state: 'open', labels: [], comments: [], seq: ++repoSeq, user: VIEWER_LOGIN };
    repo.issues.set(number, issue);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.seq - a.seq);
    return mcpToolResult({ issues: list.map((i) => issueJson(repo, i)) });
  }
  if (name === 'create_pull_request') {
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const headRef = typeof args.head === 'string' ? args.head : '';
    const baseRef = typeof args.base === 'string' ? args.base : '';
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) return mcpErrorResult('head or base branch does not exist');
    const number = repo.nextPull++;
    const pr: PullRequest = {
      id: nextPullId++, number, title, body, state: 'open',
      headRef, headSha, baseRef, baseSha, merged: false, mergedAt: null, mergeCommitSha: null,
      seq: ++repoSeq, user: VIEWER_LOGIN,
    };
    repo.pulls.set(number, pr);
    return mcpToolResult(pullJson(repo, pr));
  }
  if (name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    const pr = repo.pulls.get(number);
    if (!pr) return mcpErrorResult('Pull request not found');
    const result = mergePr(repo, pr, 'SQUASH');
    if (!result.ok) return mcpErrorResult(result.message ?? 'Merge failed');
    return mcpToolResult({ merged: true, number: pr.number, state: 'closed', sha: result.sha });
  }
  return mcpErrorResult(`Unknown tool: ${name}`);
}

function mcpRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function mcpRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
  } catch {
    // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, mcpRpcError(isRecord(body) ? body.id : null, -32600, 'Invalid Request'));
    return true;
  }
  const id = body.id ?? null;
  const method = body.method;
  // Notifications carry no id and get no JSON-RPC answer.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': `forge-${++requestSeq}` });
    res.end();
    return true;
  }
  const params = isRecord(body.params) ? body.params : {};
  if (method === 'server/discover') {
    sendJson(res, 200, mcpRpcResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    }));
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    sendJson(res, 200, mcpRpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    }));
    return true;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpRpcResult(id, {}));
    return true;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpRpcResult(id, { tools: MCP_TOOLS }));
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      sendJson(res, 200, mcpRpcError(id, -32602, `Unknown tool: ${toolName}`));
      return true;
    }
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      sendJson(res, 200, mcpRpcError(id, -32602, `Missing required argument: ${missing.join(', ')}`));
      return true;
    }
    let result: Record<string, unknown>;
    try {
      result = runMcpTool(toolName, args);
    } catch (err) {
      result = mcpErrorResult(err instanceof Error ? err.message : String(err));
    }
    sendJson(res, 200, mcpRpcResult(id, result));
    return true;
  }
  sendJson(res, 200, mcpRpcError(id, -32601, `Method not found: ${method}`));
  return true;
}

// ---------------------------------------------------------------------------
// Dispatcher

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname, search } = pathOf(req);
  const method = req.method ?? 'GET';
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  // The API surfaces require the trial token; git smart HTTP and /healthz do not.
  if (pathname.startsWith('/api/v3') || pathname === '/api/graphql' || pathname === '/mcp') {
    if (!authorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
  }
  if (pathname === '/api/graphql' && method === 'POST') {
    await handleGraphql(req, res);
    return;
  }
  if (pathname === '/mcp' && method === 'POST') {
    await handleMcp(req, res);
    return;
  }
  if (pathname.startsWith('/api/v3')) {
    if (await handleRest(req, res, pathname, search)) return;
  }
  if (await handleGit(req, res, pathname, search)) return;
  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
    });
  });
}
