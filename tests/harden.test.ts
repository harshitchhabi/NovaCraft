// Milestone A1: provenance, proof gap, risk score, policies, report.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileProgram } from '../src/compile';
import { parsePolicy, parseWeights, DEFAULT_WEIGHTS } from '../src/harden/config';
import { SiteReport } from '../src/harden/harden';
import { compileAndRun } from '../src/cli';
import { listPrograms } from './differentialHarness';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'harden', name), 'utf-8');
const sites = (src: string, policy = 'strict', weights = DEFAULT_WEIGHTS): SiteReport[] =>
  compileProgram(src, { harden: policy, weights }).hardening.sites;
const site = (all: SiteReport[], fn: string, k = 0) => all.filter((s) => s.function === fn)[k];

describe('policy and weight parsing', () => {
  test('named policies, threshold:T and budget:F', () => {
    expect(parsePolicy('strict')).toEqual({ kind: 'threshold', name: 'strict', tau: 0 });
    expect(parsePolicy('balanced')).toMatchObject({ tau: 0.5 });
    expect(parsePolicy('performance')).toMatchObject({ tau: 0.8 });
    expect(parsePolicy('threshold:0.3')).toMatchObject({ kind: 'threshold', tau: 0.3 });
    expect(parsePolicy('budget:0.25')).toMatchObject({ kind: 'budget', fraction: 0.25 });
    for (const p of ['none', 'full', 'proof', 'chuang']) expect(parsePolicy(p).kind).toBe(p);
  });
  test('bad specs are rejected', () => {
    expect(() => parsePolicy('fast')).toThrow();
    expect(() => parsePolicy('threshold:x')).toThrow();
    expect(() => parsePolicy('budget:2')).toThrow();
    expect(() => parseWeights('1,2')).toThrow();
  });
  test('weights parse and default to 0.40/0.35/0.25', () => {
    expect(parseWeights('0.5,0.3,0.2')).toEqual({ wP: 0.5, wC: 0.3, wW: 0.2 });
    expect(DEFAULT_WEIGHTS).toEqual({ wP: 0.4, wC: 0.35, wW: 0.25 });
  });
});

describe('provenance (P)', () => {
  const all = sites(fixture('provenance.min'));
  test('entry points are the functions nobody else calls, plus main', () => {
    const report = compileProgram(fixture('provenance.min')).hardening;
    expect(report.entryPoints.sort()).toEqual(['driver', 'histogram', 'main']);
  });
  test('an internal loop counter is internal; an index loaded from external data is external', () => {
    expect(site(all, 'histogram', 0)).toMatchObject({ P: 0, proven: true }); // data[i]
    expect(site(all, 'histogram', 1)).toMatchObject({ P: 1, access: 'read' }); // hist[b] read
    expect(site(all, 'histogram', 2)).toMatchObject({ P: 1, access: 'write' }); // hist[b] write
  });
  test('parameters of internal functions inherit external-ness from call-site arguments', () => {
    expect(site(all, 'getInternal').P).toBe(0); // only called with the constant 2
    expect(site(all, 'getExternal').P).toBe(1); // called with driver's parameter k
  });
  test('context-insensitive: a function returning an external value taints every call result', () => {
    expect(site(all, 'driver', 0).P).toBe(1); // arr[passThrough(k)]
    expect(site(all, 'driver', 1).P).toBe(1); // arr[passThrough(0)]: over-approximation
  });
});

describe('proof gap (C), write flag (W), risk (R), depth (D)', () => {
  const src = `
func lowOnly(arr: int[], len: int, n: int) -> int {
    let i: int = 0;
    let s: int = 0;
    while (i < n) {
        s = s + arr[i];
        i = i + 1;
    }
    return s;
}
func highOnly(arr: int[], len: int, start: int) -> int {
    let i: int = start;
    let s: int = 0;
    while (i < len) {
        s = s + arr[i];
        i = i + 1;
    }
    return s;
}
func neither(arr: int[], len: int, k: int) -> int {
    arr[k] = 1;
    return 0;
}
func main() -> int {
    return 0;
}`;
  const all = sites(src);
  test('C = 0.5 when exactly one bound is proven, 1 when neither', () => {
    expect(site(all, 'lowOnly')).toMatchObject({ C: 0.5, proven: false });
    expect(site(all, 'highOnly')).toMatchObject({ C: 0.5, proven: false });
    expect(site(all, 'neither')).toMatchObject({ C: 1, W: 1 });
  });
  test('R = wP*P + wC*C + wW*W with the default weights', () => {
    expect(site(all, 'lowOnly').R).toBeCloseTo(0.4 * 0 + 0.35 * 0.5 + 0.25 * 0, 9);
    expect(site(all, 'highOnly').R).toBeCloseTo(0.4 * 1 + 0.35 * 0.5, 9);
    expect(site(all, 'neither').R).toBeCloseTo(0.4 + 0.35 + 0.25, 9);
  });
  test('weights can be overridden', () => {
    const w = { wP: 1, wC: 0, wW: 0 };
    expect(site(sites(src, 'strict', w), 'lowOnly').R).toBe(0);
    expect(site(sites(src, 'strict', w), 'neither').R).toBe(1);
  });
  test('proven sites are not scored', () => {
    const proven = sites(fs.readFileSync(path.join(__dirname, '..', 'examples', 'sumArray.min'), 'utf-8'));
    expect(proven[0]).toMatchObject({ proven: true, C: 0, R: null, decision: 'eliminate' });
  });
  test('D is the loop depth and only enters cost = 10^min(D,3)', () => {
    const v = sites(fixture('versioning.min'));
    expect(site(v, 'nested', 0)).toMatchObject({ D: 2, cost: 100 });
    expect(site(v, 'shift', 0)).toMatchObject({ D: 1, cost: 10 });
    expect(site(all, 'neither')).toMatchObject({ D: 0, cost: 1 });
  });
});

describe('policies', () => {
  const programs = listPrograms().map((f) => fs.readFileSync(f, 'utf-8'));
  const decisionsOf = (policy: string) => programs.flatMap((p) => sites(p, policy));

  test('none omits every check; full retains every check', () => {
    expect(decisionsOf('none').every((s) => s.decision === 'omit')).toBe(true);
    expect(decisionsOf('full').every((s) => s.decision === 'retain')).toBe(true);
  });

  test('proof eliminates exactly the proven sites and retains the rest', () => {
    for (const s of decisionsOf('proof')) expect(s.decision).toBe(s.proven ? 'eliminate' : 'retain');
  });

  test('threshold policies follow the decision order: proven, R < tau, versionable, retain', () => {
    for (const [policy, tau] of [['strict', 0], ['balanced', 0.5], ['performance', 0.8], ['threshold:0.6', 0.6]] as const) {
      for (const s of decisionsOf(policy)) {
        const expected = s.proven ? 'eliminate' : s.R! < tau ? 'omit' : s.versionable ? 'hoist' : 'retain';
        expect(s.decision).toBe(expected);
      }
    }
  });

  test('strict never omits', () => {
    expect(decisionsOf('strict').some((s) => s.decision === 'omit')).toBe(false);
  });

  test('chuang: proven eliminated, unproven writes retained, unproven reads omitted, no hoisting', () => {
    for (const s of decisionsOf('chuang')) {
      expect(s.decision).toBe(s.proven ? 'eliminate' : s.access === 'write' ? 'retain' : 'omit');
    }
  });

  test('budget: keeps a prefix by descending R/cost within the cost fraction', () => {
    for (const src of programs) {
      for (const F of [0, 0.1, 0.5, 1]) {
        const ss = sites(src, `budget:${F}`);
        const full = ss.reduce((a, s) => a + s.cost, 0);
        const kept = ss.filter((s) => s.decision === 'retain' || s.decision === 'hoist');
        expect(kept.reduce((a, s) => a + s.cost, 0)).toBeLessThanOrEqual(F * full + 1e-9);
        const order = ss.filter((s) => !s.proven).sort((a, b) => b.R! / b.cost - a.R! / a.cost || a.id - b.id);
        const firstOmit = order.findIndex((s) => s.decision === 'omit');
        if (firstOmit >= 0) expect(order.slice(firstOmit).every((s) => s.decision === 'omit')).toBe(true);
        if (F === 1) expect(ss.some((s) => s.decision === 'omit')).toBe(false);
      }
    }
  });

  test('monotonicity: raising tau only moves sites from retained/hoisted to omitted', () => {
    const taus = Array.from({ length: 21 }, (_, k) => k / 20);
    for (const src of programs) {
      const byTau = taus.map((t) => sites(src, `threshold:${t}`));
      for (let k = 0; k + 1 < taus.length; k++) {
        const kept = (ss: SiteReport[]) => new Set(ss.filter((s) => s.decision === 'retain' || s.decision === 'hoist').map((s) => s.id));
        const omitted = (ss: SiteReport[]) => new Set(ss.filter((s) => s.decision === 'omit').map((s) => s.id));
        for (const id of kept(byTau[k + 1])) expect(kept(byTau[k]).has(id)).toBe(true);
        for (const id of omitted(byTau[k])) expect(omitted(byTau[k + 1]).has(id)).toBe(true);
      }
    }
  });
});

describe('CLI', () => {
  const file = path.join(__dirname, 'fixtures', 'harden', 'versioning.min');
  test('--harden-report writes the per-site JSON report; --risk-weights is applied', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-')), 'report.json');
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await compileAndRun([file, '--harden=balanced', '--risk-weights=0.5,0.3,0.2', `--harden-report=${out}`])).toBe(0);
    } finally {
      log.mockRestore();
    }
    const report = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(report).toMatchObject({ policy: 'balanced', tau: 0.5, weights: { wP: 0.5, wC: 0.3, wW: 0.2 } });
    expect(Object.keys(report.sites[0]).sort()).toEqual(
      ['C', 'D', 'P', 'R', 'W', 'access', 'column', 'cost', 'decision', 'function', 'id', 'line', 'proven', 'versionable'].sort(),
    );
  });

  test('--stats prints the hardening table', async () => {
    const lines: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((m: string) => void lines.push(String(m)));
    try {
      await compileAndRun([file, '--stats', '--harden=strict']);
    } finally {
      log.mockRestore();
    }
    const text = lines.join('\n');
    expect(text).toContain('Hardening report (policy=strict, tau=0');
    expect(text).toMatch(/#1\s+22:17\s+read\s+0\s+0\.5\s+0\s+0\.17\s+1\s+hoist/);
  });

  test('an unknown policy is a clean error', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await compileAndRun([file, '--harden=fast'])).toBe(1);
    } finally {
      err.mockRestore();
    }
  });
});
