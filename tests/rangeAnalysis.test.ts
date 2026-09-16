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

  // Regression test for a bug found while building anomalyDetect.min: a
  // while loop's exit unconditionally reset the WHOLE condBound map to
  // empty, discarding not just its own condition-derived fact (which really
  // does go stale) but any *unrelated* fact from an enclosing loop that it
  // never touched. Here the outer `for` loop's `i < len` fact must survive
  // the inner windowed `while` loop (which only ever touches `j`, `sum`, and
  // its own temporaries) so the later direct `data[i]` access -- unlike the
  // windowed `data[j]` access, which genuinely cannot be proven safe -- gets
  // eliminated.
  test('anomalyDetect.min: an outer loop\'s condBound fact survives an unrelated inner loop', () => {
    const ir = optimize(toIRFromExample('anomalyDetect.min'));
    const stats = computeBoundsStats(ir);
    const fnStats = stats.perFunction.find((f) => f.name === 'movingAvgFlag')!;
    expect(fnStats.inserted).toBe(2);
    expect(fnStats.retained).toBe(1);
  });
});
