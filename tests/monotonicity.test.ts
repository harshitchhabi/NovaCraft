// A4 test 3: threshold monotonicity, as a fast-check property over
// programs, risk weights and threshold pairs: for tau1 < tau2, the sites
// retained or hoisted at tau2 are a subset of those at tau1, and the sites
// omitted at tau1 are a subset of those omitted at tau2.
import * as fs from 'fs';
import fc from 'fast-check';
import { compileProgram } from '../src/compile';
import { listAllPrograms } from './differentialHarness';

const sources = listAllPrograms().map((f) => fs.readFileSync(f, 'utf-8'));

describe('threshold monotonicity (fast-check)', () => {
  test('retained-or-hoisted(tau2) is a subset of retained-or-hoisted(tau1); omitted(tau1) of omitted(tau2)', () => {
    const weight = fc.double({ min: 0, max: 1, noNaN: true });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: sources.length - 1 }),
        weight,
        weight,
        weight,
        fc.double({ min: 0, max: 1.2, noNaN: true }),
        fc.double({ min: 0, max: 1.2, noNaN: true }),
        (k, wP, wC, wW, a, b) => {
          fc.pre(a !== b);
          const [tau1, tau2] = a < b ? [a, b] : [b, a];
          const sites = (tau: number) => compileProgram(sources[k], { harden: `threshold:${tau}`, weights: { wP, wC, wW } }).hardening.sites;
          const s1 = sites(tau1);
          const s2 = sites(tau2);
          const kept = (ss: typeof s1) => new Set(ss.filter((s) => s.decision === 'retain' || s.decision === 'hoist').map((s) => s.id));
          const omitted = (ss: typeof s1) => new Set(ss.filter((s) => s.decision === 'omit').map((s) => s.id));
          const k1 = kept(s1);
          const o2 = omitted(s2);
          for (const id of kept(s2)) if (!k1.has(id)) return false;
          for (const id of omitted(s1)) if (!o2.has(id)) return false;
          return true;
        },
      ),
      { numRuns: 300, seed: 20261007 },
    );
  });
});
