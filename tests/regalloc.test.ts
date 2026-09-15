import { toIR } from './helpers';
import { constantFold } from '../src/optimize/constantFold';
import { deadCodeElimination } from '../src/optimize/deadCode';
import { rangeAnalysis } from '../src/optimize/rangeAnalysis';
import { allocateRegisters } from '../src/regalloc';

describe('Register allocation (linear scan)', () => {
  test('a function with more than 4 simultaneously-live values produces at least one spill', () => {
    const source = `
      func manyLive(a: int, b: int, c: int, d: int, e: int) -> int {
        return a + b + c + d + e;
      }
      func main() -> int { return 0; }
    `;
    let ir = toIR(source);
    ir = rangeAnalysis(deadCodeElimination(constantFold(ir)));
    const fn = ir.functions.find((f) => f.name === 'manyLive')!;

    const alloc = allocateRegisters(fn, 4);
    const spilled = Array.from(alloc.entries.values()).filter((e) => e.spillSlot !== null);
    expect(spilled.length).toBeGreaterThanOrEqual(1);
    expect(alloc.spillSlotCount).toBeGreaterThanOrEqual(1);

    // Every non-spilled entry must fit within the 4-register budget.
    const usedRegs = new Set(
      Array.from(alloc.entries.values())
        .filter((e) => e.physicalReg !== null)
        .map((e) => e.physicalReg),
    );
    expect(usedRegs.size).toBeLessThanOrEqual(4);
  });

  test('a small function with few live values needs no spills', () => {
    const source = `
      func add(a: int, b: int) -> int { return a + b; }
      func main() -> int { return 0; }
    `;
    let ir = toIR(source);
    ir = rangeAnalysis(deadCodeElimination(constantFold(ir)));
    const fn = ir.functions.find((f) => f.name === 'add')!;
    const alloc = allocateRegisters(fn, 4);
    const spilled = Array.from(alloc.entries.values()).filter((e) => e.spillSlot !== null);
    expect(spilled.length).toBe(0);
  });
});
