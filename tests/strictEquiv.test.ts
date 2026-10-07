// `--harden=strict` (proof elimination + loop versioning, nothing omitted)
// must be observably identical to `--harden=full` (every check retained):
// same result or the same trap (check id, index, length), same printed
// output, same final memory, on fuzzed extreme inputs.
import * as path from 'path';
import { compareBuilds, listPrograms } from './differentialHarness';
import { compileProgram } from '../src/compile';

jest.setTimeout(120000);

describe('differential fuzz: strict vs full', () => {
  for (const file of listPrograms()) {
    const name = path.relative(path.join(__dirname, '..'), file);
    test(`${name}: strict == full`, async () => {
      const report = await compareBuilds(
        file,
        [
          { name: 'full', compile: (src) => compileProgram(src, { harden: 'full' }) },
          { name: 'strict', compile: (src) => compileProgram(src, { harden: 'strict' }) },
        ],
        { casesPerFn: 100 },
      );
      expect(report.compileError).toBeUndefined();
      expect(report.cases).toBeGreaterThan(0);
      expect(report.mismatches.slice(0, 3)).toEqual([]);
    });
  }
});
