import { readExample } from './helpers';
import { compileProgram } from '../src/compile';
import { computeBoundsStats } from '../src/ir';
import { assembleAndInstantiate, callFunction, writeIntArray } from '../runtime/harness';

// Guards the shared compile.ts pipeline used by both the CLI and the
// benchmark script (benchmark/boundsCheckBenchmark.ts): skipRangeAnalysis
// must leave the BoundsCheck in place (and the compiled module must still
// execute correctly with it retained), while the default path eliminates it.
describe('compileProgram({ skipRangeAnalysis })', () => {
  test('sumArray.min: skipRangeAnalysis retains the BoundsCheck; default eliminates it', () => {
    const source = readExample('sumArray.min');
    const withElim = compileProgram(source);
    const withoutElim = compileProgram(source, { skipRangeAnalysis: true });

    const statsWith = computeBoundsStats(withElim.finalIR).perFunction.find((f) => f.name === 'sumArray')!;
    const statsWithout = computeBoundsStats(withoutElim.finalIR).perFunction.find((f) => f.name === 'sumArray')!;

    expect(statsWith.retained).toBe(0);
    expect(statsWithout.retained).toBe(1);
  });

  test('both variants execute correctly and agree on the result', async () => {
    const source = readExample('sumArray.min');
    for (const opts of [{}, { skipRangeAnalysis: true }]) {
      const compiled = compileProgram(source, opts);
      const h = await assembleAndInstantiate(compiled.codegen.wat);
      writeIntArray(h.memory, 0, [1, 2, 3, 4, 5]);
      expect(callFunction(h, 'sumArray', [0, 5])).toBe(15);
    }
  });
});
