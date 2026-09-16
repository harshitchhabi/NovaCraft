// Optimization pass 3: range analysis / bounds-check elimination.
//
// Two complementary facts are tracked forward through each function, as
// described in DEVLOG.md:
//   1. A numeric interval [lo, hi] (using -Infinity/+Infinity) per register,
//      with standard interval-arithmetic transfer functions, and a
//      fixed-point + widening loop for `while` bodies (re-analyze until the
//      ranges stop changing; after 2 rounds without stabilizing, widen any
//      still-growing bound to infinity) -- this proves facts like `i >= 0`.
//   2. A lightweight "less-than fact" map (condBound) that records, on entry
//      to a `while (x < y)` body, that `x < y` holds -- invalidated the
//      moment `x` or `y` is next redefined. This lets the analysis prove
//      `i < len` from the loop header even though `len` itself carries no
//      useful *numeric* upper bound (it's just an unconstrained parameter).
// A BoundsCheck is eliminated only when BOTH `index.lo >= 0` and either the
// numeric interval or the less-than fact prove `index < length`.
import { IRInstr, IRValue, IRFunction, IRProgram } from '../ir';

const NEG_INF = -Infinity;
const POS_INF = Infinity;

interface Range {
  lo: number;
  hi: number;
}
const UNKNOWN: Range = { lo: NEG_INF, hi: POS_INF };
const BOOL_RANGE: Range = { lo: 0, hi: 1 };

interface CondFact {
  ref: string;
  strict: boolean; // true: x < ref ; false: x <= ref
}

interface AState {
  ranges: Map<string, Range>;
  condBound: Map<string, CondFact>;
}

function cloneState(s: AState): AState {
  return { ranges: new Map(s.ranges), condBound: new Map(s.condBound) };
}

function rangeOf(v: IRValue, ranges: Map<string, Range>): Range {
  if (v.kind === 'imm') return { lo: v.value, hi: v.value };
  return ranges.get(v.name) ?? UNKNOWN;
}

function addRange(a: Range, b: Range): Range {
  const lo = a.lo === NEG_INF || b.lo === NEG_INF ? NEG_INF : a.lo + b.lo;
  const hi = a.hi === POS_INF || b.hi === POS_INF ? POS_INF : a.hi + b.hi;
  return { lo, hi };
}
function subRange(a: Range, b: Range): Range {
  const lo = a.lo === NEG_INF || b.hi === POS_INF ? NEG_INF : a.lo - b.hi;
  const hi = a.hi === POS_INF || b.lo === NEG_INF ? POS_INF : a.hi - b.lo;
  return { lo, hi };
}
function negRange(a: Range): Range {
  return { lo: a.hi === POS_INF ? NEG_INF : -a.hi, hi: a.lo === NEG_INF ? POS_INF : -a.lo };
}
function bothConst(a: Range, b: Range, fn: (x: number, y: number) => number): Range | null {
  if (a.lo === a.hi && b.lo === b.hi && isFinite(a.lo) && isFinite(b.lo)) {
    const v = fn(a.lo, b.lo);
    return { lo: v, hi: v };
  }
  return null;
}

function transferBinop(bop: string, l: Range, r: Range): Range {
  switch (bop) {
    case '+':
      return addRange(l, r);
    case '-':
      return subRange(l, r);
    case '*':
      return bothConst(l, r, (x, y) => x * y) ?? UNKNOWN;
    case '/':
      return bothConst(l, r, (x, y) => (y !== 0 ? Math.trunc(x / y) : 0)) ?? UNKNOWN;
    case '%':
      return bothConst(l, r, (x, y) => (y !== 0 ? x % y : 0)) ?? UNKNOWN;
    default:
      return BOOL_RANGE; // comparisons / logical ops
  }
}

// Collects every register a loop's own condInstrs/body defines (recursively
// through nested if/while), so a completed while loop can tell which
// condBound facts it might actually have invalidated from ones it never
// touched at all.
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

// A fact `x < ref` (or `<=`) that held on entry to a loop is still valid
// after it completes UNLESS the loop itself redefined `x` or `ref` -- e.g. a
// windowed inner loop that only touches its own index variable must not
// erase an outer loop's still-valid `i < len` fact just because *some*
// while loop finished.
function survivingCondBound(entryCondBound: Map<string, CondFact>, loopDefs: Set<string>): Map<string, CondFact> {
  const out = new Map<string, CondFact>();
  for (const [k, v] of entryCondBound) {
    if (loopDefs.has(k) || loopDefs.has(v.ref)) continue;
    out.set(k, v);
  }
  return out;
}

function clearCondFactsFor(name: string, state: AState): void {
  state.condBound.delete(name);
  for (const [k, v] of Array.from(state.condBound.entries())) {
    if (v.ref === name) state.condBound.delete(k);
  }
}

function defReg(state: AState, name: string, range: Range): void {
  state.ranges.set(name, range);
  clearCondFactsFor(name, state);
}

function joinRangeMaps(a: Map<string, Range>, b: Map<string, Range>): Map<string, Range> {
  const out = new Map<string, Range>();
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const ra = a.get(k) ?? UNKNOWN;
    const rb = b.get(k) ?? UNKNOWN;
    out.set(k, { lo: Math.min(ra.lo, rb.lo), hi: Math.max(ra.hi, rb.hi) });
  }
  return out;
}

function joinCondBound(a: Map<string, CondFact>, b: Map<string, CondFact>): Map<string, CondFact> {
  const out = new Map<string, CondFact>();
  for (const [k, v] of a) {
    const v2 = b.get(k);
    if (v2 && v2.ref === v.ref && v2.strict === v.strict) out.set(k, v);
  }
  return out;
}

function joinStates(a: AState, b: AState): AState {
  return { ranges: joinRangeMaps(a.ranges, b.ranges), condBound: joinCondBound(a.condBound, b.condBound) };
}

interface CondFactInfo {
  left: string;
  right: string;
  strict: boolean;
}

function extractCondFact(cond: IRValue, condInstrs: IRInstr[]): CondFactInfo | null {
  if (cond.kind !== 'reg') return null;
  const def = condInstrs.find(
    (i): i is Extract<IRInstr, { op: 'binop' }> =>
      i.op === 'binop' && i.dest === cond.name && (i.bop === '<' || i.bop === '<='),
  );
  if (!def) return null;
  if (def.left.kind !== 'reg' || def.right.kind !== 'reg') return null;
  return { left: def.left.name, right: def.right.name, strict: def.bop === '<' };
}

function applyCondRefinement(ranges: Map<string, Range>, fact: CondFactInfo | null): Map<string, Range> {
  if (!fact) return ranges;
  const out = new Map(ranges);
  const l = out.get(fact.left) ?? UNKNOWN;
  const r = out.get(fact.right) ?? UNKNOWN;
  const bound = fact.strict ? r.hi - 1 : r.hi;
  if (isFinite(bound)) {
    out.set(fact.left, { lo: l.lo, hi: Math.min(l.hi, bound) });
  }
  return out;
}

function analyzeList(instrs: IRInstr[], stateIn: AState): { instrs: IRInstr[]; stateOut: AState } {
  const state = cloneState(stateIn);
  const out: IRInstr[] = [];

  for (const instr of instrs) {
    switch (instr.op) {
      case 'const':
        defReg(state, instr.dest, { lo: instr.value, hi: instr.value });
        out.push(instr);
        break;
      case 'move':
        defReg(state, instr.dest, rangeOf(instr.src, state.ranges));
        out.push(instr);
        break;
      case 'binop': {
        const l = rangeOf(instr.left, state.ranges);
        const r = rangeOf(instr.right, state.ranges);
        defReg(state, instr.dest, transferBinop(instr.bop, l, r));
        out.push(instr);
        break;
      }
      case 'unop': {
        const range = instr.uop === '-' ? negRange(rangeOf(instr.src, state.ranges)) : BOOL_RANGE;
        defReg(state, instr.dest, range);
        out.push(instr);
        break;
      }
      case 'boundscheck': {
        const idx = rangeOf(instr.index, state.ranges);
        const len = rangeOf(instr.length, state.ranges);
        const loOk = idx.lo >= 0;
        const numericHiOk = isFinite(idx.hi) && idx.hi < len.lo;
        let symbolicHiOk = false;
        if (instr.index.kind === 'reg' && instr.length.kind === 'reg') {
          const fact = state.condBound.get(instr.index.name);
          if (fact && fact.strict && fact.ref === instr.length.name) symbolicHiOk = true;
        }
        const eliminated = loOk && (numericHiOk || symbolicHiOk);
        out.push({ ...instr, eliminated });
        break;
      }
      case 'arrload':
        defReg(state, instr.dest, UNKNOWN);
        out.push(instr);
        break;
      case 'arrstore':
        out.push(instr);
        break;
      case 'call':
        if (instr.dest) defReg(state, instr.dest, UNKNOWN);
        out.push(instr);
        break;
      case 'return':
      case 'print':
        out.push(instr);
        break;
      case 'if': {
        const thenR = analyzeList(instr.thenBody, state);
        const elseR = instr.elseBody ? analyzeList(instr.elseBody, state) : { instrs: null, stateOut: state };
        out.push({ ...instr, thenBody: thenR.instrs, elseBody: elseR.instrs as IRInstr[] | null });
        const merged = joinStates(thenR.stateOut, elseR.stateOut);
        state.ranges = merged.ranges;
        state.condBound = merged.condBound;
        break;
      }
      case 'while': {
        const result = analyzeWhile(instr, state);
        out.push(result.instr);
        state.ranges = result.stateOut.ranges;
        state.condBound = result.stateOut.condBound;
        break;
      }
    }
  }

  return { instrs: out, stateOut: state };
}

function analyzeWhile(
  instr: Extract<IRInstr, { op: 'while' }>,
  stateIn: AState,
): { instr: IRInstr; stateOut: AState } {
  const condFact = extractCondFact(instr.cond, instr.condInstrs);

  // Fixed-point iteration over the loop body's numeric ranges, with widening
  // after 2 rounds of non-stabilization (guarantees termination).
  let candidate = new Map(stateIn.ranges);
  for (let iter = 0; iter < 4; iter++) {
    const bodyEntry = applyCondRefinement(candidate, condFact);
    const trialState: AState = { ranges: bodyEntry, condBound: new Map() };
    const condPass = analyzeList(instr.condInstrs, trialState);
    const bodyPass = analyzeList(instr.body, condPass.stateOut);
    const merged = joinRangeMaps(candidate, bodyPass.stateOut.ranges);

    let changed = false;
    for (const [k, v] of merged) {
      const prev = candidate.get(k) ?? UNKNOWN;
      if (prev.lo !== v.lo || prev.hi !== v.hi) changed = true;
    }
    if (!changed) {
      candidate = merged;
      break;
    }
    if (iter >= 1) {
      // Widen: any bound still moving after 2 rounds is pushed to infinity.
      for (const [k, v] of merged) {
        const prev = candidate.get(k) ?? UNKNOWN;
        merged.set(k, {
          lo: v.lo < prev.lo ? NEG_INF : v.lo,
          hi: v.hi > prev.hi ? POS_INF : v.hi,
        });
      }
    }
    candidate = merged;
  }

  // Real pass: stabilized entry ranges, refined by the loop condition, plus
  // the condBound fact for the body -- this is where BoundsCheck.eliminated
  // is actually decided.
  const finalEntryRanges = applyCondRefinement(candidate, condFact);
  const finalCondBound = new Map(stateIn.condBound);
  if (condFact) {
    finalCondBound.set(condFact.left, { ref: condFact.right, strict: condFact.strict });
  }
  const bodyState: AState = { ranges: finalEntryRanges, condBound: finalCondBound };
  const condResult = analyzeList(instr.condInstrs, bodyState);
  const bodyResult = analyzeList(instr.body, condResult.stateOut);

  // After the loop: the condition may be false (including zero iterations),
  // so THIS loop's own condition-derived fact never survives -- but any
  // fact that was already valid on entry, about registers this loop never
  // touched, still is (see survivingCondBound above).
  const loopDefs = new Set<string>();
  collectDefRegs(instr.condInstrs, loopDefs);
  collectDefRegs(instr.body, loopDefs);
  const stateOut: AState = { ranges: candidate, condBound: survivingCondBound(stateIn.condBound, loopDefs) };

  return {
    instr: { ...instr, condInstrs: condResult.instrs, body: bodyResult.instrs },
    stateOut,
  };
}

function analyzeFunction(fn: IRFunction): IRFunction {
  const state: AState = { ranges: new Map(), condBound: new Map() };
  const result = analyzeList(fn.body, state);
  return { ...fn, body: result.instrs };
}

export function rangeAnalysis(program: IRProgram): IRProgram {
  return { functions: program.functions.map(analyzeFunction) };
}
