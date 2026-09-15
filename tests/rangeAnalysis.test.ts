import { toIRFromExample } from './helpers';
import { computeBoundsStats } from '../src/ir';
import { constantFold } from '../src/optimize/constantFold';
import { deadCodeElimination } from '../src/optimize/deadCode';
import { rangeAnalysis } from '../src/optimize/rangeAnalysis';

function optimize(ir: ReturnType<typeof toIRFromExample>) {
  return rangeAnalysis(deadCodeElimination(constantFold(ir)));
}

describe('Range analysis / bounds-check elimination', () => {
  test('sumArray.min: the provably-safe BoundsCheck on arr[i] is eliminated (0 retained)', () => {
    const ir = optimize(toIRFromExample('sumArray.min'));
    const stats = computeBoundsStats(ir);
    const sumArrayStats = stats.perFunction.find((f) => f.name === 'sumArray')!;
    expect(sumArrayStats.inserted).toBe(1);
    expect(sumArrayStats.retained).toBe(0);
  });

  test("unsafe_index.min: the BoundsCheck on arr[k] (unrelated parameter) is retained", () => {
    const ir = optimize(toIRFromExample('unsafe_index.min'));
    const stats = computeBoundsStats(ir);
    const fnStats = stats.perFunction.find((f) => f.name === 'unsafeGet')!;
    expect(fnStats.inserted).toBe(1);
    expect(fnStats.retained).toBe(1);
  });

  test('bounds_violation.min: the BoundsCheck on the out-of-range constant index is retained', () => {
    const ir = optimize(toIRFromExample('bounds_violation.min'));
    const stats = computeBoundsStats(ir);
    const fnStats = stats.perFunction.find((f) => f.name === 'access')!;
    expect(fnStats.inserted).toBe(1);
    expect(fnStats.retained).toBe(1);
  });
});
