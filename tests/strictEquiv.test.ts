// A4 test 1: `--harden=strict` (proof elimination + loop versioning,
// nothing omitted) must be observably identical to `--harden=full` (every
// check retained) on every program in examples/, bench/, bench/bugs/ and
// the test fixtures: same result or the same trap (check id, index,
// length), same printed output, same final memory outside the spill stack.
//
// Inputs (tests/differentialHarness.ts, fuzzArgs): every int that is not a
// length argument (loop bounds n, rows, cols, k, alpha, indices, ...) takes
// 0, +-1, small values, INT_MAX, INT_MIN, INT_MAX - 1 and INT_MIN + 1, so
// lengths are both shorter and longer than loop bounds. A length argument
// takes the real array length, one less, 0, -1 or INT_MIN, but never MORE
// than the real array: every bounds check trusts the length argument, so a
// caller that passes a length larger than the array lets the program's
// checked accesses reach any address in linear memory (an index near
// INT_MAX wraps the byte address), including its own spill stack, after
// which no property can relate two builds with different register
// allocation. This is documented in docs/LIMITATIONS.md. Arrays are placed
// above the spill stack, as in the A3 evaluation.
import * as path from 'path';
import { ABOVE_STACK_BASE, compareBuilds, listAllPrograms } from './differentialHarness';
import { compileProgram } from '../src/compile';

jest.setTimeout(180000);

describe('differential fuzz: strict vs full', () => {
  for (const file of listAllPrograms()) {
    const name = path.relative(path.join(__dirname, '..'), file);
    test(`${name}: strict == full`, async () => {
      const report = await compareBuilds(
        file,
        [
          { name: 'full', compile: (src) => compileProgram(src, { harden: 'full' }) },
          { name: 'strict', compile: (src) => compileProgram(src, { harden: 'strict' }) },
        ],
        { casesPerFn: 100, arrayBase: ABOVE_STACK_BASE, inBoundsLengths: true },
      );
      expect(report.compileError).toBeUndefined();
      expect(report.cases).toBeGreaterThan(0);
      expect(report.mismatches.slice(0, 3)).toEqual([]);
    });
  }
});
