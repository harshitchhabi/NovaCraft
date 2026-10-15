// Optimization pass 3: range analysis / bounds-check elimination.
//
// Three facts are tracked forward through each function, as described in
// DEVLOG.md:
//   1. A numeric interval [lo, hi] per int register, always a subset of the
//      i32 range [INT_MIN, INT_MAX]. Arithmetic is exact; any result that
//      could leave the i32 range (and therefore wrap at runtime) becomes the
//      full i32 range. `while` loops are analyzed to a verified fixed point
//      (widening any bound still moving after 2 rounds to INT_MIN/INT_MAX).
//      This proves facts like `i >= 0`.
//   2. A "less-than fact" map (condBound) recording that `x < y` (or
//      `x <= y`) holds symbolically, by register identity, established by a
//      `while` or `if` condition and invalidated the moment `x` or `y` is
//      redefined. This proves `i < len` even though `len` itself is an
//      unconstrained parameter.
//   3. A "linear definition" map (lin) recording `d == b + c` for a constant
//      c, only when the addition provably cannot wrap. Together with (2) this
//      proves `arr[i + 1]` under `while (i < len - 1)` when `len - 1` cannot
//      wrap.
// A BoundsCheck is eliminated only when BOTH `index.lo >= 0` and either the
// numeric interval or the symbolic facts prove `index < length`.
import { IRInstr, IRValue, IRFunction, IRProgram } from '../ir';

export const INT_MIN = -2147483648;
export const INT_MAX = 2147483647;

interface Range {
  lo: number;
  hi: number;
}
const TOP: Range = { lo: INT_MIN, hi: INT_MAX };
const BOOL_RANGE: Range = { lo: 0, hi: 1 };

interface CondFact {
  ref: string;
  strict: boolean; // true: x < ref ; false: x <= ref
}

interface LinDef {
  base: string;
  c: number; // dest == base + c, exactly (no wraparound possible)
}

interface AState {
  ranges: Map<string, Range>; // missing register => TOP
  condBound: Map<string, CondFact[]>; // x -> facts `x < ref` / `x <= ref`
  lin: Map<string, LinDef>;
  dead: boolean; // unreachable (after a return, or an infeasible branch)
}

function cloneState(s: AState): AState {
  return { ranges: new Map(s.ranges), condBound: new Map(s.condBound), lin: new Map(s.lin), dead: s.dead };
}

function addFact(state: AState, left: string, fact: CondFact): void {
  const existing = state.condBound.get(left) ?? [];
  if (existing.some((f) => f.ref === fact.ref && f.strict === fact.strict)) return;
  state.condBound.set(left, [...existing, fact]);
}

function rangeOf(v: IRValue, ranges: Map<string, Range>): Range {
  if (v.type === 'float') return TOP; // never an index; not tracked
  if (v.kind === 'imm') return { lo: v.value, hi: v.value };
  return ranges.get(v.name) ?? TOP;
}

// An exact result interval that may leave the i32 range could wrap to any
// value at runtime, so it carries no information.
function fit(lo: number, hi: number): Range {
  if (lo < INT_MIN || hi > INT_MAX) return TOP;
  return { lo, hi };
}

function constOf(r: Range): number | null {
  return r.lo === r.hi ? r.lo : null;
}

function transferBinop(bop: string, l: Range, r: Range): Range {
  switch (bop) {
    case '+':
      return fit(l.lo + r.lo, l.hi + r.hi);
    case '-':
      return fit(l.lo - r.hi, l.hi - r.lo);
    case '*': {
      const x = constOf(l);
      const y = constOf(r);
      if (x === null || y === null) return TOP;
      const v = Math.imul(x, y);
      return { lo: v, hi: v };
    }
    case '/': {
      const x = constOf(l);
      const y = constOf(r);
      // Division by zero and INT_MIN / -1 trap at runtime.
      if (x === null || y === null || y === 0 || (x === INT_MIN && y === -1)) return TOP;
      const v = Math.trunc(x / y);
      return { lo: v, hi: v };
    }
    case '%': {
      const x = constOf(l);
      const y = constOf(r);
      if (x === null || y === null || y === 0) return TOP;
      const v = (x % y) | 0;
      return { lo: v, hi: v };
    }
    default:
      return BOOL_RANGE; // comparisons / logical ops
  }
}

// Collects every register a loop's own condInstrs/body defines (recursively
// through nested if/while), so a while loop can tell which facts it might
// invalidate from ones it never touches at all.
function collectDefRegs(instrs: IRInstr[], out: Set<string>): void {
  for (const instr of instrs) {
    switch (instr.op) {
      case 'const':
      case 'move':
      case 'binop':
      case 'unop':
      case 'arrload':
        out.add(instr.dest);
        break;
      case 'call':
      case 'guard':
        if (instr.dest) out.add(instr.dest);
        break;
      case 'if':
        collectDefRegs(instr.thenBody, out);
        if (instr.elseBody) collectDefRegs(instr.elseBody, out);
        break;
      case 'while':
        collectDefRegs(instr.condInstrs, out);
        collectDefRegs(instr.body, out);
        break;
    }
  }
}

// A symbolic fact that held on entry to a loop holds at EVERY loop-head
// visit (first iteration, every back-edge, and the exit) only if the loop
// never redefines either register it mentions.
function survivingFacts(s: AState, loopDefs: Set<string>): Pick<AState, 'condBound' | 'lin'> {
  const condBound = new Map<string, CondFact[]>();
  for (const [k, fs] of s.condBound) {
    if (loopDefs.has(k)) continue;
    const kept = fs.filter((f) => !loopDefs.has(f.ref));
    if (kept.length > 0) condBound.set(k, kept);
  }
  const lin = new Map<string, LinDef>();
  for (const [k, v] of s.lin) {
    if (!loopDefs.has(k) && !loopDefs.has(v.base)) lin.set(k, v);
  }
  return { condBound, lin };
}

function clearFactsFor(name: string, state: AState): void {
  state.condBound.delete(name);
  for (const [k, fs] of Array.from(state.condBound.entries())) {
    const kept = fs.filter((f) => f.ref !== name);
    if (kept.length === fs.length) continue;
    if (kept.length > 0) state.condBound.set(k, kept);
    else state.condBound.delete(k);
  }
  state.lin.delete(name);
  for (const [k, v] of Array.from(state.lin.entries())) {
    if (v.base === name) state.lin.delete(k);
  }
}

function defReg(state: AState, name: string, range: Range): void {
  state.ranges.set(name, range);
  clearFactsFor(name, state);
}

function joinRangeMaps(a: Map<string, Range>, b: Map<string, Range>): Map<string, Range> {
  const out = new Map<string, Range>();
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const ra = a.get(k) ?? TOP;
    const rb = b.get(k) ?? TOP;
    out.set(k, { lo: Math.min(ra.lo, rb.lo), hi: Math.max(ra.hi, rb.hi) });
  }
  return out;
}

function joinStates(a: AState, b: AState): AState {
  if (a.dead) return cloneState(b);
  if (b.dead) return cloneState(a);
  const condBound = new Map<string, CondFact[]>();
  for (const [k, fa] of a.condBound) {
    const fb = b.condBound.get(k) ?? [];
    const both = fa.filter((f) => fb.some((g) => g.ref === f.ref && g.strict === f.strict));
    if (both.length > 0) condBound.set(k, both);
  }
  const lin = new Map<string, LinDef>();
  for (const [k, v] of a.lin) {
    const v2 = b.lin.get(k);
    if (v2 && v2.base === v.base && v2.c === v.c) lin.set(k, v);
  }
  return { ranges: joinRangeMaps(a.ranges, b.ranges), condBound, lin, dead: false };
}

function sameRanges(a: Map<string, Range>, b: Map<string, Range>): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const ra = a.get(k) ?? TOP;
    const rb = b.get(k) ?? TOP;
    if (ra.lo !== rb.lo || ra.hi !== rb.hi) return false;
  }
  return true;
}

// ---- conditions ----

type RelOp = '<' | '<=' | '>' | '>=' | '==' | '!=';
const NEGATE: Record<RelOp, RelOp> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' };

interface Comparison {
  left: IRValue;
  right: IRValue;
  op: RelOp;
}

// The comparison that defines `cond`, if it is the instruction immediately
// preceding the branch (so no operand can have been redefined in between)
// and compares two ints.
function comparisonFor(cond: IRValue, preceding: IRInstr | undefined): Comparison | null {
  if (cond.kind !== 'reg' || !preceding || preceding.op !== 'binop' || preceding.dest !== cond.name) return null;
  const op = preceding.bop;
  if (op !== '<' && op !== '<=' && op !== '>' && op !== '>=' && op !== '==' && op !== '!=') return null;
  if (preceding.left.type !== 'int' || preceding.right.type !== 'int') return null;
  const usesDest = (v: IRValue) => v.kind === 'reg' && v.name === cond.name;
  if (usesDest(preceding.left) || usesDest(preceding.right)) return null;
  return { left: preceding.left, right: preceding.right, op };
}

// Returns the state on the edge where the comparison evaluated to `truth`:
// ranges of both operands are narrowed, and a symbolic `a < b` / `a <= b`
// fact is recorded when both operands are registers. An empty range means
// the edge is infeasible.
function refine(state: AState, cmp: Comparison | null, truth: boolean): AState {
  const out = cloneState(state);
  if (!cmp || out.dead) return out;
  let { left, right } = cmp;
  let op = truth ? cmp.op : NEGATE[cmp.op];
  if (op === '>' || op === '>=') {
    [left, right] = [right, left];
    op = op === '>' ? '<' : '<=';
  }
  if (op === '!=') return out;
  const L = rangeOf(left, out.ranges);
  const R = rangeOf(right, out.ranges);
  let newL: Range;
  let newR: Range;
  if (op === '<') {
    newL = { lo: L.lo, hi: Math.min(L.hi, R.hi - 1) };
    newR = { lo: Math.max(R.lo, L.lo + 1), hi: R.hi };
  } else if (op === '<=') {
    newL = { lo: L.lo, hi: Math.min(L.hi, R.hi) };
    newR = { lo: Math.max(R.lo, L.lo), hi: R.hi };
  } else {
    // '=='
    newL = { lo: Math.max(L.lo, R.lo), hi: Math.min(L.hi, R.hi) };
    newR = newL;
  }
  if (newL.lo > newL.hi || newR.lo > newR.hi) {
    out.dead = true;
    return out;
  }
  if (left.kind === 'reg' && right.kind === 'reg' && left.name === right.name) return out;
  if (left.kind === 'reg') out.ranges.set(left.name, newL);
  if (right.kind === 'reg') out.ranges.set(right.name, newR);
  if ((op === '<' || op === '<=') && left.kind === 'reg' && right.kind === 'reg') {
    addFact(out, left.name, { ref: right.name, strict: op === '<' });
  }
  return out;
}

// ---- the check itself ----

// Every (reg, c) with `name == reg + c` exactly, following lin links (each
// link is exact, so their sum is too).
function linChain(name: string, state: AState): Array<{ reg: string; c: number }> {
  const out = [{ reg: name, c: 0 }];
  let cur = { reg: name, c: 0 };
  for (let depth = 0; depth < 8; depth++) {
    const l = state.lin.get(cur.reg);
    if (!l) break;
    cur = { reg: l.base, c: cur.c + l.c };
    out.push(cur);
  }
  return out;
}

// idx < len, proven symbolically: idx == A + c1, fact A < B (or A <= B), and
// B == len + c2, all exact (no wraparound), so idx < len + c1 + c2 <= len.
function symbolicBelow(index: IRValue, length: IRValue, state: AState): boolean {
  if (index.kind !== 'reg' || length.kind !== 'reg') return false;
  for (const { reg, c: c1 } of linChain(index.name, state)) {
    for (const fact of state.condBound.get(reg) ?? []) {
      const b = linChain(fact.ref, state).find((x) => x.reg === length.name);
      if (!b) continue;
      const c2 = b.c;
      if (fact.strict ? c1 + c2 <= 0 : c1 + c2 <= -1) return true;
    }
  }
  return false;
}

// ---- transfer over instruction lists ----

function analyzeList(instrs: IRInstr[], stateIn: AState): { instrs: IRInstr[]; stateOut: AState } {
  let state = cloneState(stateIn);
  const out: IRInstr[] = [];

  for (const instr of instrs) {
    switch (instr.op) {
      case 'const':
        defReg(state, instr.dest, instr.type === 'float' ? TOP : { lo: instr.value, hi: instr.value });
        out.push(instr);
        break;
      case 'move': {
        defReg(state, instr.dest, rangeOf(instr.src, state.ranges));
        if (instr.src.kind === 'reg' && instr.src.name !== instr.dest && instr.type === 'int') {
          state.lin.set(instr.dest, { base: instr.src.name, c: 0 });
        }
        out.push(instr);
        break;
      }
      case 'binop': {
        const l = rangeOf(instr.left, state.ranges);
        const r = rangeOf(instr.right, state.ranges);
        const range = instr.type === 'float' ? TOP : transferBinop(instr.bop, l, r);
        defReg(state, instr.dest, range);
        // dest == base + c exactly, when the addition provably cannot wrap.
        if (instr.type === 'int' && (instr.bop === '+' || instr.bop === '-')) {
          let lin: { base: string; c: number; range: Range } | null = null;
          if (instr.left.kind === 'reg' && instr.right.kind === 'imm') {
            const c = instr.bop === '+' ? instr.right.value : -instr.right.value;
            lin = { base: instr.left.name, c, range: l };
          } else if (instr.bop === '+' && instr.left.kind === 'imm' && instr.right.kind === 'reg') {
            lin = { base: instr.right.name, c: instr.left.value, range: r };
          }
          if (lin && lin.base !== instr.dest && lin.range.lo + lin.c >= INT_MIN && lin.range.hi + lin.c <= INT_MAX) {
            state.lin.set(instr.dest, { base: lin.base, c: lin.c });
          }
        }
        out.push(instr);
        break;
      }
      case 'unop': {
        let range = BOOL_RANGE;
        if (instr.uop === '-') {
          const s = rangeOf(instr.src, state.ranges);
          range = instr.type === 'float' ? TOP : fit(-s.hi, -s.lo);
        }
        defReg(state, instr.dest, range);
        out.push(instr);
        break;
      }
      case 'boundscheck': {
        const idx = rangeOf(instr.index, state.ranges);
        const len = rangeOf(instr.length, state.ranges);
        const loOk = idx.lo >= 0;
        const hiOk = idx.hi < len.lo || symbolicBelow(instr.index, instr.length, state);
        out.push({ ...instr, eliminated: loOk && hiOk, provenLo: loOk, provenHi: hiOk });
        break;
      }
      case 'arrload':
        defReg(state, instr.dest, TOP);
        out.push(instr);
        break;
      case 'arrstore':
        out.push(instr);
        break;
      case 'call':
        if (instr.dest) defReg(state, instr.dest, TOP);
        out.push(instr);
        break;
      case 'guard':
        defReg(state, instr.dest, BOOL_RANGE);
        out.push(instr);
        break;
      case 'return':
        out.push(instr);
        state.dead = true;
        break;
      case 'print':
        out.push(instr);
        break;
      case 'if': {
        const cmp = comparisonFor(instr.cond, out[out.length - 1]);
        const thenIn = refine(state, cmp, true);
        const elseIn = refine(state, cmp, false);
        // An infeasible branch is still analyzed (from the unrefined state)
        // so its instructions get decisions, but contributes nothing to the
        // join.
        const thenR = analyzeList(instr.thenBody, thenIn.dead ? state : thenIn);
        if (thenIn.dead) thenR.stateOut.dead = true;
        let elseOut: AState;
        let elseInstrs: IRInstr[] | null = null;
        if (instr.elseBody) {
          const elseR = analyzeList(instr.elseBody, elseIn.dead ? state : elseIn);
          if (elseIn.dead) elseR.stateOut.dead = true;
          elseOut = elseR.stateOut;
          elseInstrs = elseR.instrs;
        } else {
          elseOut = elseIn;
        }
        out.push({ ...instr, thenBody: thenR.instrs, elseBody: elseInstrs });
        state = joinStates(thenR.stateOut, elseOut);
        break;
      }
      case 'while': {
        const result = analyzeWhile(instr, state);
        out.push(result.instr);
        state = result.stateOut;
        break;
      }
    }
  }

  return { instrs: out, stateOut: state };
}

const MAX_LOOP_ITERATIONS = 1000;

function analyzeWhile(
  instr: Extract<IRInstr, { op: 'while' }>,
  stateIn: AState,
): { instr: IRInstr; stateOut: AState } {
  const loopDefs = new Set<string>();
  collectDefRegs(instr.condInstrs, loopDefs);
  collectDefRegs(instr.body, loopDefs);
  const facts = survivingFacts(stateIn, loopDefs);

  const evalHead = (ranges: Map<string, Range>, withFacts: boolean) => {
    const head: AState = {
      ranges,
      condBound: withFacts ? new Map(facts.condBound) : new Map(),
      lin: withFacts ? new Map(facts.lin) : new Map(),
      dead: stateIn.dead,
    };
    const condR = analyzeList(instr.condInstrs, head);
    const cmp = comparisonFor(instr.cond, condR.instrs[condR.instrs.length - 1]);
    return { condR, cmp };
  };

  // Fixed point over the loop-head ranges: head = entry JOIN back-edge,
  // with widening after 2 rounds of non-stabilization. Iteration stops only
  // once the head is verified stable.
  let head = new Map(stateIn.ranges);
  let converged = false;
  for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
    const { condR, cmp } = evalHead(head, false);
    const bodyIn = refine(condR.stateOut, cmp, true);
    let next = head;
    if (!bodyIn.dead) {
      const bodyR = analyzeList(instr.body, bodyIn);
      if (!bodyR.stateOut.dead) next = joinRangeMaps(head, bodyR.stateOut.ranges);
    }
    if (sameRanges(next, head)) {
      converged = true;
      break;
    }
    if (iter >= 1) {
      for (const [k, v] of next) {
        const prev = head.get(k) ?? TOP;
        next.set(k, { lo: v.lo < prev.lo ? INT_MIN : v.lo, hi: v.hi > prev.hi ? INT_MAX : v.hi });
      }
    }
    head = next;
  }
  if (!converged) {
    // Cannot happen with the widening above (each bound widens at most once
    // to an i32 extreme), but if it ever did, forget everything the loop
    // touches -- that state is trivially stable.
    head = new Map(head);
    for (const r of loopDefs) head.set(r, TOP);
  }

  // Real pass from the stable head, with the entry facts the loop cannot
  // invalidate plus the condition's own facts on the body edge -- this is
  // where BoundsCheck.eliminated is actually decided.
  const { condR, cmp } = evalHead(head, true);
  const bodyIn = refine(condR.stateOut, cmp, true);
  const bodyResult = analyzeList(instr.body, bodyIn.dead ? condR.stateOut : bodyIn);

  // Exit edge: the condition was false at a loop-head visit.
  const stateOut = refine(condR.stateOut, cmp, false);

  return {
    instr: { ...instr, condInstrs: condR.instrs, body: bodyResult.instrs },
    stateOut,
  };
}

function analyzeFunction(fn: IRFunction): IRFunction {
  const state: AState = { ranges: new Map(), condBound: new Map(), lin: new Map(), dead: false };
  const result = analyzeList(fn.body, state);
  return { ...fn, body: result.instrs };
}

export function rangeAnalysis(program: IRProgram): IRProgram {
  return { functions: program.functions.map(analyzeFunction) };
}
