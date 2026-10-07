// Differential fuzz test (audit milestone A0, step 4): every program in
// examples/ and tests/fixtures/soundness/ is compiled with range analysis
// and without it (the --no-bounds-elim path) and run on the same fuzzed
// inputs (0, 1, -1, INT_MAX, INT_MIN, lengths shorter/longer than the real
// array, ...). Return value or trap (kind, check id, index, length), printed
// output and final memory must be identical; any difference means a check
// was removed that could fire.
import * as path from 'path';
import { differential, listPrograms } from './differentialHarness';
import { compileProgram } from '../src/compile';
import { generateModule } from '../src/codegen';
import { IRInstr } from '../src/ir';

const CASES_PER_FN = 120;

jest.setTimeout(120000);

describe('differential fuzz: range analysis vs. --no-bounds-elim', () => {
  for (const file of listPrograms()) {
    const name = path.relative(path.join(__dirname, '..'), file);
    test(`${name}: identical outcomes on fuzzed inputs`, async () => {
      const report = await differential(file, { casesPerFn: CASES_PER_FN });
      expect(report.compileError).toBeUndefined();
      expect(report.cases).toBeGreaterThan(0);
      const summary = report.mismatches.slice(0, 3).map((m) => ({ fn: m.fn, args: m.args, full: m.full, proof: m.proof }));
      expect(summary).toEqual([]);
    });
  }

  // The oracle must have teeth: a "proof" build that drops every check has
  // to be caught on the programs whose checks can actually fire.
  test('the fuzzer detects a deliberately unsound elimination', async () => {
    const dropAll = (instrs: IRInstr[]): IRInstr[] =>
      instrs.map((i) => {
        if (i.op === 'boundscheck') return { ...i, eliminated: true };
        if (i.op === 'if') return { ...i, thenBody: dropAll(i.thenBody), elseBody: i.elseBody ? dropAll(i.elseBody) : null };
        if (i.op === 'while') return { ...i, body: dropAll(i.body) };
        return i;
      });
    const compileProof = (src: string) => {
      const c = compileProgram(src, { skipRangeAnalysis: true });
      const ir = { functions: c.finalIR.functions.map((f) => ({ ...f, body: dropAll(f.body) })) };
      return { ...c, finalIR: ir, codegen: generateModule(ir, 4) };
    };
    for (const prog of ['unsafe_index.min', 'offByOne.min', 'nestedMatrix.min']) {
      const file = listPrograms().find((f) => f.endsWith(prog))!;
      const report = await differential(file, { casesPerFn: 60, compileProof });
      expect(report.mismatches.length).toBeGreaterThan(0);
    }
  });
});
