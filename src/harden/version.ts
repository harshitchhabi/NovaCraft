// Loop versioning (milestone A2): which unproven BoundsCheck sites can be
// "hoisted" out of a loop without changing behavior.
//
// A check is never moved before the loop (it would trap earlier than the
// original). Instead the loop is duplicated: a guard evaluated before the
// loop selects a fast copy with the qualifying checks removed, or the
// original slow copy with every check. The guard is true only when every
// qualifying check provably passes on every iteration, so both copies
// behave identically whenever the fast one runs.
//
// Qualifying loop: `while (i < N)` or `while (i <= N)` where
//   - the condition is a single signed int comparison of a register `i`
//     with a register or constant `N`;
//   - `i` is assigned exactly once in the loop, by a top-level (not
//     conditional) update `i = i + s` with a constant s > 0;
//   - `N` is not assigned in the loop.
// Qualifying site in that loop (possibly inside nested ifs/loops): index
// `i + c` or `i - c` (or `i` itself) with constant c, the index register
// defined once in the loop; the length operand not assigned in the loop.
// A site after the update sees i + s, so its effective offset is c + s.
//
// Guard, all in exact 64-bit arithmetic (GuardTerm), with Nmax = N - 1 for
// `<` and N for `<=`:
//   for each site:  0 <= i_entry + c          (lowest index >= 0)
//                   Nmax + c + 1 <= len       (highest index < len)
//   per loop:       Nmax + s <= INT_MAX       (the update i = i + s never
//                                              wraps, so i only increases)
// The values i takes at the top of the body are i_entry, i_entry + s, ...,
// all <= Nmax, so the site's index lies in [i_entry + c, Nmax + c].
import { GuardTerm, IRInstr, IRValue, imm } from '../ir';

export const INT_MAX = 2147483647;

type WhileInstr = Extract<IRInstr, { op: 'while' }>;
type CheckInstr = Extract<IRInstr, { op: 'boundscheck' }>;

export interface LoopPattern {
  loop: WhileInstr;
  ivar: string;
  bound: IRValue;
  adj: number; // Nmax = N + adj
  step: number;
  updateIndex: number; // top-level body index of the instruction assigning i
  defCount: Map<string, number>;
  defInstr: Map<string, IRInstr>;
  topIndex: Map<IRInstr, number>; // body instr (at any depth) -> index of its top-level ancestor
}

export interface HoistSite {
  pattern: LoopPattern;
  offset: number; // effective c
  length: IRValue;
}

function destOf(i: IRInstr): string | null {
  switch (i.op) {
    case 'const':
    case 'move':
    case 'binop':
    case 'unop':
    case 'arrload':
    case 'guard':
      return i.dest;
    case 'call':
      return i.dest;
    default:
      return null;
  }
}

function visit(instrs: IRInstr[], f: (i: IRInstr) => void): void {
  for (const i of instrs) {
    f(i);
    if (i.op === 'if') {
      visit(i.thenBody, f);
      if (i.elseBody) visit(i.elseBody, f);
    } else if (i.op === 'while') {
      visit(i.condInstrs, f);
      visit(i.body, f);
    }
  }
}

// `dest = base + c` for a binop of the form base + imm, imm + base, base - imm.
function affineOf(i: IRInstr): { base: string; c: number } | null {
  if (i.op !== 'binop' || i.type !== 'int') return null;
  if (i.bop === '+' && i.left.kind === 'reg' && i.right.kind === 'imm') return { base: i.left.name, c: i.right.value };
  if (i.bop === '+' && i.left.kind === 'imm' && i.right.kind === 'reg') return { base: i.right.name, c: i.left.value };
  if (i.bop === '-' && i.left.kind === 'reg' && i.right.kind === 'imm') return { base: i.left.name, c: -i.right.value };
  return null;
}

const SMALL = 1 << 30;

export function matchLoop(loop: WhileInstr): LoopPattern | null {
  const { cond, condInstrs, body } = loop;
  if (cond.kind !== 'reg' || condInstrs.length === 0) return null;
  const cmp = condInstrs[condInstrs.length - 1];
  if (cmp.op !== 'binop' || cmp.dest !== cond.name || (cmp.bop !== '<' && cmp.bop !== '<=')) return null;
  if (cmp.left.kind !== 'reg' || cmp.left.type !== 'int' || cmp.right.type !== 'int') return null;
  const ivar = cmp.left.name;
  const bound = cmp.right;
  if (bound.kind === 'reg' && bound.name === ivar) return null;

  const defCount = new Map<string, number>();
  const defInstr = new Map<string, IRInstr>();
  const count = (i: IRInstr) => {
    const d = destOf(i);
    if (d) {
      defCount.set(d, (defCount.get(d) ?? 0) + 1);
      defInstr.set(d, i);
    }
  };
  visit(condInstrs, count);
  visit(body, count);
  if (defCount.get(ivar) !== 1) return null;
  if (bound.kind === 'reg' && defCount.has(bound.name)) return null;

  const topIndex = new Map<IRInstr, number>();
  body.forEach((top, k) => visit([top], (i) => topIndex.set(i, k)));

  // The single assignment to i must be a top-level `i = i + s`, either
  // directly or as `u = i + s; i = u` (what IR generation produces).
  const upd = defInstr.get(ivar)!;
  if (!body.includes(upd)) return null;
  let aff = affineOf(upd);
  if (!aff && upd.op === 'move' && upd.src.kind === 'reg' && defCount.get(upd.src.name) === 1) {
    const u = defInstr.get(upd.src.name)!;
    if (body.includes(u) && body.indexOf(u) < body.indexOf(upd)) aff = affineOf(u);
  }
  if (!aff || aff.base !== ivar || aff.c <= 0 || aff.c >= SMALL) return null;

  return {
    loop,
    ivar,
    bound,
    adj: cmp.bop === '<' ? -1 : 0,
    step: aff.c,
    updateIndex: body.indexOf(upd),
    defCount,
    defInstr,
    topIndex,
  };
}

// Whether `check` (somewhere in p.loop's body) qualifies for hoisting out of p.loop.
export function hoistSite(p: LoopPattern, check: CheckInstr): HoistSite | null {
  const length = check.length;
  if (length.kind === 'reg' && p.defCount.has(length.name)) return null;
  const top = p.topIndex.get(check);
  if (top === undefined || check.index.kind !== 'reg') return null;
  const after = (k: number) => k > p.updateIndex;
  let c: number;
  if (check.index.name === p.ivar) {
    c = 0;
  } else {
    if (p.defCount.get(check.index.name) !== 1) return null;
    const def = p.defInstr.get(check.index.name)!;
    const aff = affineOf(def);
    const defTop = p.topIndex.get(def);
    if (!aff || aff.base !== p.ivar || defTop === undefined) return null;
    // i must have the same value at the index's definition and at the check.
    if (after(defTop) !== after(top) || defTop === p.updateIndex) return null;
    if (Math.abs(aff.c) >= SMALL) return null;
    c = aff.c;
  }
  return { pattern: p, offset: c + (after(top) ? p.step : 0), length };
}

export function guardTerms(p: LoopPattern, sites: HoistSite[]): GuardTerm[] {
  const terms: GuardTerm[] = [{ lhs: p.bound, lhsAdd: p.adj + p.step, rhs: imm(INT_MAX, 'int'), rhsAdd: 0 }];
  const iv: IRValue = { kind: 'reg', name: p.ivar, type: 'int' };
  for (const s of sites) {
    terms.push({ lhs: imm(0, 'int'), lhsAdd: 0, rhs: iv, rhsAdd: s.offset });
    terms.push({ lhs: p.bound, lhsAdd: p.adj + s.offset + 1, rhs: s.length, rhsAdd: 0 });
  }
  const seen = new Set<string>();
  return terms.filter((t) => {
    const k = JSON.stringify(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// The fast copy of a loop: the given sites carry fastPath (no runtime test).
export function markFastPath(instrs: IRInstr[], ids: Set<number>): IRInstr[] {
  return instrs.map((i) => {
    switch (i.op) {
      case 'boundscheck':
        return ids.has(i.id) ? { ...i, fastPath: true } : { ...i };
      case 'if':
        return { ...i, thenBody: markFastPath(i.thenBody, ids), elseBody: i.elseBody ? markFastPath(i.elseBody, ids) : null };
      case 'while':
        return { ...i, condInstrs: markFastPath(i.condInstrs, ids), body: markFastPath(i.body, ids) };
      default:
        return { ...i };
    }
  });
}
