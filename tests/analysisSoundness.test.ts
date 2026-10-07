// A4 test 2: analysis soundness. Under `full` (every check retained), run
// every program on fuzzed extreme inputs; whenever a bounds check fires
// (an out-of-bounds access), that check must not be one that `proof` or
// `strict` marked proven (eliminated).
//
// Hoisted checks are different by design: hoisting removes a check only
// from the fast copy of a versioned loop, which runs only when the guard
// proves every hoisted check passes. A hoisted check CAN fire under `full`
// (the guard is then false and `strict` runs the slow copy, which keeps the
// check). For hoisted sites the test therefore asserts the property that
// does hold: whenever one fires under `full`, `strict` traps at the same
// check with the same index and length. Inputs and array placement are as
// in tests/strictEquiv.test.ts (length arguments never exceed the real
// array; see the comment there and docs/LIMITATIONS.md).
import * as path from 'path';
import { ABOVE_STACK_BASE, listAllPrograms, runCases } from './differentialHarness';
import { compileProgram } from '../src/compile';
import * as fs from 'fs';

jest.setTimeout(180000);

const CASES = 100;
let hoistedFiredSomewhere = 0;

describe('analysis soundness under full', () => {
  for (const file of listAllPrograms()) {
    const name = path.relative(path.join(__dirname, '..'), file);
    test(`${name}: no out-of-bounds access at a proven site; hoisted sites trap identically in strict`, async () => {
      const src = fs.readFileSync(file, 'utf-8');
      const proofSites = compileProgram(src, { harden: 'proof' }).hardening.sites;
      const strictSites = compileProgram(src, { harden: 'strict' }).hardening.sites;
      const proven = new Set([...proofSites, ...strictSites].filter((s) => s.decision === 'eliminate').map((s) => s.id));
      const hoisted = new Set(strictSites.filter((s) => s.decision === 'hoist').map((s) => s.id));

      const full = await runCases(file, { name: 'full', compile: (x) => compileProgram(x, { harden: 'full' }) }, { casesPerFn: CASES, arrayBase: ABOVE_STACK_BASE, inBoundsLengths: true });
      const strict = await runCases(file, { name: 'strict', compile: (x) => compileProgram(x, { harden: 'strict' }) }, { casesPerFn: CASES, arrayBase: ABOVE_STACK_BASE, inBoundsLengths: true });
      expect(full.compileError).toBeUndefined();
      const fired = full.cases.filter((c) => c.outcome.kind === 'trap' && c.outcome.trap === 'unreachable' && (c.outcome.checkId ?? -1) >= 0);
      const atProven = fired.filter((c) => proven.has(c.outcome.checkId!)).map((c) => ({ fn: c.fn, args: c.args, check: c.outcome.checkId }));
      expect(atProven).toEqual([]);

      // Same fuzz seed => same input sequence; pair the runs by input.
      const key = (c: { fn: string; args: number[]; arrays: number[][] }) => JSON.stringify([c.fn, c.args, c.arrays]);
      const strictBy = new Map(strict.cases.map((c) => [key(c), c.outcome]));
      for (const c of fired.filter((x) => hoisted.has(x.outcome.checkId!))) {
        hoistedFiredSomewhere++;
        const s = strictBy.get(key(c));
        if (!s) continue; // strict run timed out; covered by strictEquiv
        expect({ checkId: s.checkId, index: s.index, length: s.length }).toEqual({
          checkId: c.outcome.checkId,
          index: c.outcome.index,
          length: c.outcome.length,
        });
      }
    });
  }

  test('hoisted sites do fire under full on some inputs (so "never fires" would be the wrong property)', () => {
    expect(hoistedFiredSomewhere).toBeGreaterThan(0);
  });
});

// The documented limitation behind the input restriction above: bounds
// checks trust the length argument. With a length larger than the real
// array, a fully checked program writes outside its array without trapping.
describe('limitation: a length argument larger than the array is trusted', () => {
  test('reverse with len = INT_MAX under full writes outside the array without a bounds trap there', async () => {
    const { build, runOnce } = await import('../eval/exec');
    const b = await build(path.join(__dirname, '..', 'bench', 'reverse.min'), 'full');
    const o = runOnce(b, 'reverse', [{ array: [1, 2, 3, 4, 5, 6] }, 2147483647]);
    expect(o.sentinelsIntact).toBe(false);
  });
});
