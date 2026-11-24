// main.ts is mend, the CLI SPEC.md specifies: Node 22 and its standard library, run as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none, printing what it changed or why
// it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Set by run() from --strict: match lines exactly (tier 0 only, SPEC section 5). */
let STRICT = false;

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under SPEC section 3: its line break, its lines, whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const firstNl = text.indexOf('\n');
  if (firstNl < 0) return { lines: [text], br: '\n', final: false };
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** Tier normalisation (SPEC section 5): 0 exact, 1 trailing ws, 2 both-side ws. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/**
 * The first tier at which O occurs in lines at or after `from`, with every position
 * at that tier; null when O occurs at no tier. O must be non-empty.
 */
function findOccurrences(O: string[], lines: string[], from = 0): { tier: number; positions: number[] } | null {
  const maxTier = STRICT ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const nO = O.map((l) => normLine(l, tier));
    const nL = lines.map((l) => normLine(l, tier));
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (nL[i + j] !== nO[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a replacement: its text, and the index into O when it is a context line. */
interface NLine {
  text: string;
  ctxO: number | null;
}

/**
 * Resolve the replacement lines for a match of O at `pos` in `fileLines` (SPEC section 5):
 * a context line is written as the file's own matched line; at tier 2 every other line
 * is re-indented from O's first line's leading whitespace to the file's; otherwise as-is.
 */
function resolveN(N: NLine[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) {
    return N.map((e) => (e.ctxO !== null ? fileLines[pos + e.ctxO]! : e.text));
  }
  const F = (fileLines[pos] ?? '').match(/^[ \t]*/)?.[0] ?? '';
  const P = (O[0] ?? '').match(/^[ \t]*/)?.[0] ?? '';
  return N.map((e) => {
    if (e.ctxO !== null) return fileLines[pos + e.ctxO]!;
    const t = e.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

function spliceLines(lines: string[], pos: number, remove: number, insert: string[]): string[] {
  return [...lines.slice(0, pos), ...insert, ...lines.slice(pos + remove)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A hunk body line: ' ' context, '-' old, '+' new, '\' the no-newline marker. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  /** Old start line, 1-based, from the header. */
  A: number;
  body: BodyLine[];
  /** True when a `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
}

interface UniSection {
  oldPath: string | undefined;
  newPath: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, spaces removed, a/ or b/ stripped. */
function uniPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function hunkNoNL(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === '\\';
}

/** O and N of a hunk body, in body order (SPEC section 6). */
function hunkON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      const idx = O.length;
      O.push(b.text);
      N.push({ text: b.text, ctxO: idx });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push({ text: b.text, ctxO: null });
    }
  }
  return { O, N };
}

/** Apply a section's hunks in order to a file's text (SPEC section 6). */
function applyUniHunks(before: string, hunks: Hunk[], path: string): string {
  let { lines, br, final } = splitFile(before);
  let d = 0;
  for (const hunk of hunks) {
    const { O, N } = hunkON(hunk.body);
    if (O.length === 0) {
      let idx = hunk.A + d;
      if (idx < 0) idx = 0;
      if (idx > lines.length) idx = lines.length;
      const atEnd = idx === lines.length;
      const resolved = resolveN(N, O, lines, idx, 0);
      lines = spliceLines(lines, idx, 0, resolved);
      if (atEnd) final = !hunk.noNL;
      d += N.length;
    } else {
      const found = findOccurrences(O, lines);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.A - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const resolved = resolveN(N, O, lines, pos, found.tier);
      const atEnd = pos + O.length === lines.length;
      lines = spliceLines(lines, pos, O.length, resolved);
      if (atEnd) final = !hunk.noNL;
      d += N.length - O.length;
    }
  }
  return joinFile(lines, br, final);
}

function uniSectionEdit(s: UniSection): Edit {
  const rawOld = s.oldPath ?? s.renameFrom ?? s.diffOld;
  const rawNew = s.newPath ?? s.renameTo ?? s.diffNew;
  const isCreate = rawOld === '/dev/null' || s.newFile;
  const isDelete = rawNew === '/dev/null' || s.delFile;
  const oldP = rawOld === '/dev/null' ? undefined : rawOld;
  const newP = rawNew === '/dev/null' ? undefined : rawNew;

  if (isCreate) {
    const p = newP;
    const plus: string[] = [];
    for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
    let finalBreak = true;
    let found = false;
    for (let hi = s.hunks.length - 1; hi >= 0 && !found; hi--) {
      const body = s.hunks[hi]!.body;
      for (let bi = body.length - 1; bi >= 0; bi--) {
        if (body[bi]!.kind === '+') {
          finalBreak = body[bi + 1]?.kind !== '\\';
          found = true;
          break;
        }
      }
    }
    return (tree) => {
      if (p === undefined) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
    };
  }
  if (isDelete) {
    const p = oldP;
    return (tree) => {
      if (p === undefined) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const oldPath = oldP;
  const newPath = newP;
  const isMove = oldPath !== undefined && newPath !== undefined && oldPath !== newPath;
  const path = oldPath ?? newPath;
  return (tree) => {
    if (path === undefined) return;
    if (oldPath !== undefined && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== undefined && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (isMove && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    const out = applyUniHunks(before, s.hunks, path);
    if (isMove) {
      tree.now.set(newPath!, out);
      tree.now.set(oldPath!, null);
      tree.moves.push({ old: oldPath!, new: newPath! });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let state: 'outside' | 'header' | 'body' | 'between' = 'outside';
  let curBody: BodyLine[] = [];
  let curHunkA = 0;

  const endBody = (): void => {
    if (state !== 'body') return;
    while (curBody.length > 0 && curBody[curBody.length - 1]!.kind === ' ' && curBody[curBody.length - 1]!.text === '') curBody.pop();
    cur!.hunks.push({ A: curHunkA, body: curBody, noNL: hunkNoNL(curBody) });
    curBody = [];
    state = 'between';
  };
  const startSection = (): UniSection => {
    const s: UniSection = {
      oldPath: undefined,
      newPath: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld: undefined,
      diffNew: undefined,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    state = 'header';
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const L = i + 1;
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        endBody();
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        curBody.push({ kind: line === '' ? ' ' : (line[0] as ' ' | '-' | '+' | '\\'), text: line === '' ? '' : line.slice(1) });
        i++;
        continue;
      } else {
        endBody();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${L}`);
      const s = startSection();
      s.diffOld = m[1];
      s.diffNew = m[2];
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && cur !== null && cur.oldPath === undefined && cur.newPath === undefined) {
        cur.oldPath = uniPath(line);
        cur.newPath = uniPath(lines[i + 1]!);
      } else {
        const s = startSection();
        s.oldPath = uniPath(line);
        s.newPath = uniPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (state === 'header') throw new Exit2(`error: parse ${L + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${L}`);
      if (cur === null) throw new Exit2(`error: parse ${L}`);
      curHunkA = Number(m[1]);
      curBody = [];
      state = 'body';
      i++;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i++;
  }
  if (state === 'body') endBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniSectionEdit(s));
}

/** SEARCH/REPLACE blocks (SPEC section 7). */
function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    const L = s + 1;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${L}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${L}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${L}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    if (oldLines.length === 0) {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      });
    } else {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const { lines: fl, br, final } = splitFile(before);
        const found = findOccurrences(oldLines, fl);
        if (found === null) throw new Fail('no-match', p);
        if (found.positions.length > 1) throw new Fail('ambiguous', p);
        const pos = found.positions[0]!;
        const N: NLine[] = newLines.map((t) => ({ text: t, ctxO: null }));
        const resolved = resolveN(N, oldLines, fl, pos, found.tier);
        const out = spliceLines(fl, pos, oldLines.length, resolved);
        tree.now.set(p, joinFile(out, br, final));
      });
    }
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** V4A patches (SPEC section 8). */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: V4aChunk[];
  /** 1-based line of the section header, for parse errors. */
  headerLine: number;
}

function v4aChunkON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  return hunkON(body);
}

function v4aSectionEdit(s: V4aSection): Edit {
  if (s.kind === 'delete') {
    const p = s.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = s.path;
  const moveTo = s.moveTo;
  const chunks = s.chunks;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { lines: origLines, br, final } = splitFile(before);
    let lines = [...origLines];
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findOccurrences([chunk.anchor], lines, cursor);
        if (found === null) throw new Fail('no-match', p);
        cursor = found.positions[0]! + 1;
      }
      const { O, N } = v4aChunkON(chunk.body);
      if (O.length === 0) {
        const idx = chunk.eof ? lines.length : cursor;
        const resolved = N.map((e) => e.text);
        lines = spliceLines(lines, idx, 0, resolved);
        cursor = idx + resolved.length;
      } else {
        const found = findOccurrences(O, lines, cursor);
        if (found === null) throw new Fail('no-match', p);
        let pos: number | null = null;
        for (const cand of found.positions) {
          if (chunk.eof && cand + O.length !== lines.length) continue;
          pos = cand;
          break;
        }
        if (pos === null) throw new Fail('no-match', p);
        const resolved = resolveN(N, O, lines, pos, found.tier);
        lines = spliceLines(lines, pos, O.length, resolved);
        cursor = pos + resolved.length;
      }
    }
    const out = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(p, null);
      tree.moves.push({ old: p, new: moveTo });
    } else {
      tree.now.set(p, out);
    }
  };
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.length - 1 - [...lines].reverse().findIndex((l) => !blank(l));
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    const L = i + 1;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice('*** Add File:'.length).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice('*** Delete File:'.length).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${L}`);
    }
    let j = i + 1;
    while (j < last && !lines[j]!.startsWith('*** Add File:') && !lines[j]!.startsWith('*** Delete File:') && !lines[j]!.startsWith('*** Update File:')) {
      j++;
    }
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const section: V4aSection = { kind, path, moveTo: null, chunks: [], headerLine: L };
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '' || l.startsWith('+')) continue;
        throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      // Store the file lines on the section for the edit closure.
      (section as unknown as { addLines: string[] }).addLines = raw.map((l) => (l === '' ? '' : l.slice(1)));
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${i + 2}`);
    } else {
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to:')) {
        section.moveTo = raw[0]!.slice('*** Move to:'.length).trim();
        k = 1;
      }
      let cur: V4aChunk | null = null;
      let chunkCount = 0;
      const pushChunk = (): void => {
        if (cur !== null) {
          section.chunks.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        const lineNo = i + 2 + k;
        if (l.startsWith('@@')) {
          pushChunk();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunkCount++;
        } else if (l === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            chunkCount++;
          } else {
            cur.eof = true;
          }
          pushChunk();
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunkCount > 0) throw new Exit2(`error: parse ${lineNo}`);
            cur = { anchor: null, eof: false, body: [] };
            chunkCount++;
          }
          cur.body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+' | '\\'), text: l === '' ? '' : l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      pushChunk();
      if (section.chunks.length === 0 && section.moveTo === null) throw new Exit2(`error: parse ${L}`);
    }
    sections.push(section);
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    if (s.kind === 'add') {
      const p = s.path;
      const fileLines = (s as unknown as { addLines: string[] }).addLines;
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      };
    }
    return v4aSectionEdit(s);
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  STRICT = strict;
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines)
          : kind === 'search-replace'
            ? parseSearchReplace(lines)
            : parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.has(m.old) ? tree.now.get(m.old)! : wasOld;
    const wasNew = tree.original(m.new);
    const nowNew = tree.now.has(m.new) ? tree.now.get(m.new)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
