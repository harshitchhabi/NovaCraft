// Register allocation: linear scan (Poletto & Sarkar, 1999) over live ranges
// computed by flattening the (structurally nested) IR into a linear sequence
// of program points, with a fixed physical-register budget and spill-to-slot
// on overflow, using the "spill the interval with the furthest next use"
// heuristic.
import { IRFunction, IRInstr, IRValue } from './ir';

interface LivePoint {
  defs: string[];
  uses: string[];
}

function addUse(v: IRValue, p: LivePoint): void {
  if (v.kind === 'reg') p.uses.push(v.name);
}

function flattenList(instrs: IRInstr[], points: LivePoint[]): void {
  for (const instr of instrs) {
    switch (instr.op) {
      case 'const': {
        points.push({ defs: [instr.dest], uses: [] });
        break;
      }
      case 'move': {
        const p: LivePoint = { defs: [instr.dest], uses: [] };
        addUse(instr.src, p);
        points.push(p);
        break;
      }
      case 'binop': {
        const p: LivePoint = { defs: [instr.dest], uses: [] };
        addUse(instr.left, p);
        addUse(instr.right, p);
        points.push(p);
        break;
      }
      case 'unop': {
        const p: LivePoint = { defs: [instr.dest], uses: [] };
        addUse(instr.src, p);
        points.push(p);
        break;
      }
      case 'boundscheck': {
        const p: LivePoint = { defs: [], uses: [] };
        addUse(instr.index, p);
        addUse(instr.length, p);
        points.push(p);
        break;
      }
      case 'arrload': {
        const p: LivePoint = { defs: [instr.dest], uses: [] };
        addUse(instr.base, p);
        addUse(instr.index, p);
        points.push(p);
        break;
      }
      case 'arrstore': {
        const p: LivePoint = { defs: [], uses: [] };
        addUse(instr.base, p);
        addUse(instr.index, p);
        addUse(instr.value, p);
        points.push(p);
        break;
      }
      case 'call': {
        const p: LivePoint = { defs: instr.dest ? [instr.dest] : [], uses: [] };
        instr.args.forEach((a) => addUse(a, p));
        points.push(p);
        break;
      }
      case 'return': {
        const p: LivePoint = { defs: [], uses: [] };
        if (instr.value) addUse(instr.value, p);
        points.push(p);
        break;
      }
      case 'print': {
        const p: LivePoint = { defs: [], uses: [] };
        addUse(instr.value, p);
        points.push(p);
        break;
      }
      case 'if': {
        const p: LivePoint = { defs: [], uses: [] };
        addUse(instr.cond, p);
        points.push(p);
        flattenList(instr.thenBody, points);
        if (instr.elseBody) flattenList(instr.elseBody, points);
        break;
      }
      case 'while': {
        const loopStart = points.length;
        points.push({ defs: [], uses: [] });
        flattenList(instr.condInstrs, points);
        const p: LivePoint = { defs: [], uses: [] };
        addUse(instr.cond, p);
        points.push(p);
        flattenList(instr.body, points);
        // Loop-carried liveness: the back-edge means anything touched near
        // the top of the loop (e.g. a condition variable) can be needed
        // again on the next iteration, even if its last *textual* use in
        // this single flattened pass falls earlier than something else's.
        // Conservatively keep every register touched anywhere in the loop
        // live for the loop's entire span by adding a synthetic use of all
        // of them right after it.
        const touched = new Set<string>();
        for (let i = loopStart; i < points.length; i++) {
          for (const d of points[i].defs) touched.add(d);
          for (const u of points[i].uses) touched.add(u);
        }
        points.push({ defs: [], uses: Array.from(touched) });
        break;
      }
    }
  }
}

interface Interval {
  reg: string;
  start: number;
  end: number;
}

function computeIntervals(fn: IRFunction): Interval[] {
  const points: LivePoint[] = [];
  flattenList(fn.body, points);

  const first = new Map<string, number>();
  const last = new Map<string, number>();

  // Parameters are live from function entry (point -1, before the first
  // real instruction).
  for (const p of fn.params) {
    first.set(p.name, -1);
    last.set(p.name, -1);
  }

  points.forEach((point, i) => {
    for (const d of point.defs) {
      if (!first.has(d)) first.set(d, i);
      const prevLast = last.get(d) ?? i;
      last.set(d, Math.max(prevLast, i));
    }
    for (const u of point.uses) {
      if (!first.has(u)) first.set(u, i);
      last.set(u, Math.max(last.get(u) ?? i, i));
    }
  });

  const intervals: Interval[] = [];
  for (const [reg, start] of first) {
    intervals.push({ reg, start, end: last.get(reg) ?? start });
  }
  intervals.sort((a, b) => a.start - b.start || a.reg.localeCompare(b.reg));
  return intervals;
}

export interface AllocEntry {
  virtualReg: string;
  physicalReg: string | null; // e.g. "r1"
  spillSlot: number | null; // e.g. 2 => spill[2]
}

export interface AllocationResult {
  entries: Map<string, AllocEntry>;
  spillSlotCount: number;
  regBudget: number;
}

// Linear scan with spilling: when the active set exceeds the register
// budget, spill whichever interval (the new one, or the active one with the
// furthest-away end point) is needed furthest in the future -- freeing a
// register for the longest remaining stretch of the function.
export function allocateRegisters(fn: IRFunction, regBudget: number): AllocationResult {
  const intervals = computeIntervals(fn);
  const entries = new Map<string, AllocEntry>();
  let spillSlotCount = 0;

  const physRegs = Array.from({ length: regBudget }, (_, i) => `r${i}`);
  // active: intervals currently holding a physical register, sorted by end ascending.
  const active: Array<Interval & { physReg: string }> = [];

  function expireOld(current: Interval): void {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].end < current.start) {
        active.splice(i, 1);
      }
    }
  }

  function usedPhysRegs(): Set<string> {
    return new Set(active.map((a) => a.physReg));
  }

  function freePhysReg(): string | null {
    const used = usedPhysRegs();
    for (const r of physRegs) {
      if (!used.has(r)) return r;
    }
    return null;
  }

  for (const current of intervals) {
    expireOld(current);

    if (active.length < regBudget) {
      const physReg = freePhysReg()!;
      entries.set(current.reg, { virtualReg: current.reg, physicalReg: physReg, spillSlot: null });
      active.push({ ...current, physReg });
      active.sort((a, b) => a.end - b.end);
    } else {
      // active is full; spill the interval with the furthest next use.
      const spillCandidate = active[active.length - 1]; // largest end among active
      if (spillCandidate.end > current.end) {
        // spill spillCandidate, give its physical register to current
        entries.set(spillCandidate.reg, {
          virtualReg: spillCandidate.reg,
          physicalReg: null,
          spillSlot: spillSlotCount++,
        });
        active.pop();
        entries.set(current.reg, {
          virtualReg: current.reg,
          physicalReg: spillCandidate.physReg,
          spillSlot: null,
        });
        active.push({ ...current, physReg: spillCandidate.physReg });
        active.sort((a, b) => a.end - b.end);
      } else {
        entries.set(current.reg, { virtualReg: current.reg, spillSlot: spillSlotCount++, physicalReg: null });
      }
    }
  }

  return { entries, spillSlotCount, regBudget };
}

export function formatAllocation(fn: IRFunction, alloc: AllocationResult): string {
  const lines: string[] = [`Register allocation for ${fn.name} (budget=${alloc.regBudget}):`];
  const names = Array.from(alloc.entries.keys()).sort();
  for (const name of names) {
    const e = alloc.entries.get(name)!;
    lines.push(`  ${name} -> ${e.physicalReg ?? `spill[${e.spillSlot}]`}`);
  }
  return lines.join('\n');
}
