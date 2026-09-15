import { toIRFromExample } from './helpers';
import { computeBoundsStats } from '../src/ir';

describe('IR generation + BoundsCheck insertion', () => {
  test('sumArray.min has exactly one BoundsCheck inserted (for arr[i])', () => {
    const ir = toIRFromExample('sumArray.min');
    const stats = computeBoundsStats(ir);
    const sumArrayStats = stats.perFunction.find((f) => f.name === 'sumArray')!;
    expect(sumArrayStats.inserted).toBe(1);
  });

  test('unsafe_index.min has exactly one BoundsCheck inserted (for arr[k])', () => {
    const ir = toIRFromExample('unsafe_index.min');
    const stats = computeBoundsStats(ir);
    const fnStats = stats.perFunction.find((f) => f.name === 'unsafeGet')!;
    expect(fnStats.inserted).toBe(1);
  });
});
