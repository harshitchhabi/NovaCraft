// Register-allocation differential: every program is compiled with register
// budgets 2, 3, 4 and 8 (more or fewer values spilled to the stack) and run
// on the same fuzzed inputs. Results, traps (check id, index, length),
// printed output and final memory outside the spill stack must agree.
//
// Length arguments are kept <= the real array length: with a larger one a
// program can legitimately read and write past its array into the spill
// stack, whose layout is exactly what differs between budgets.
import * as path from 'path';
import { compareBuilds, listPrograms } from './differentialHarness';
import { compileProgram } from '../src/compile';

jest.setTimeout(120000);

const BUDGETS = [4, 2, 3, 8]; // the first is the reference

describe('differential fuzz: register budgets 2, 3, 4, 8', () => {
  for (const file of listPrograms()) {
    const name = path.relative(path.join(__dirname, '..'), file);
    test(`${name}: identical outcomes for every register budget`, async () => {
      const builds = BUDGETS.map((b) => ({ name: `r${b}`, compile: (src: string) => compileProgram(src, { regBudget: b }) }));
      const report = await compareBuilds(file, builds, { casesPerFn: 60, inBoundsLengths: true });
      expect(report.compileError).toBeUndefined();
      expect(report.cases).toBeGreaterThan(0);
      expect(report.mismatches.slice(0, 3)).toEqual([]);
    });
  }
});
