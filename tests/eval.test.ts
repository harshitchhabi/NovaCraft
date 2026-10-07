// Milestone A3: benchmark corpus, bug corpus manifest, memory layout,
// and the eval/run.ts -> eval/report.ts pipeline (at a tiny scale).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BENCHMARKS } from '../eval/benchmarks';
import { build, runOnce } from '../eval/exec';
import { ARRAY_REGION_BASE, SENTINEL_BYTES, plan, place, sentinelsIntact } from '../eval/layout';
import { MAIN_CONFIGS, classify, loadBugs, runEval } from '../eval/run';
import { generateReport, parseCsv, paretoFront } from '../eval/report';
import { SP_INITIAL, STACK_LIMIT } from '../src/stackFrame';

jest.setTimeout(120000);

describe('memory layout for evaluation arrays', () => {
  test('arrays live above the stack region, with 16-byte sentinel gaps around each', () => {
    expect(ARRAY_REGION_BASE).toBeGreaterThanOrEqual(SP_INITIAL); // stack is [STACK_LIMIT, SP_INITIAL)
    expect(STACK_LIMIT).toBeLessThan(SP_INITIAL);
    const p = plan([3, 0, 5]);
    expect(p.gaps[0]).toBe(ARRAY_REGION_BASE);
    expect(p.addresses).toEqual([ARRAY_REGION_BASE + 16, ARRAY_REGION_BASE + 16 + 12 + 16, ARRAY_REGION_BASE + 16 + 12 + 16 + 0 + 16]);
    expect(p.gaps).toHaveLength(4);
    for (let k = 0; k < 3; k++) expect(p.gaps[k + 1] - p.addresses[k]).toBe([3, 0, 5][k] * 4);
    expect(SENTINEL_BYTES).toBe(16);
  });

  test('memory is grown to fit and a write into a gap is detected', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const big = new Array(40000).fill(1);
    const p = place(mem, [big, [1, 2]]);
    expect(mem.buffer.byteLength).toBeGreaterThanOrEqual(p.end);
    expect(sentinelsIntact(mem, p)).toBe(true);
    new Int32Array(mem.buffer)[p.addresses[0] / 4 + big.length] = 0; // one past the end
    expect(sentinelsIntact(mem, p)).toBe(false);
  });
});

describe('benchmark kernels', () => {
  test('there are 12-16 kernels, including ones fully proven and ones with nothing proven', async () => {
    expect(BENCHMARKS.length).toBeGreaterThanOrEqual(12);
    let allProven = 0;
    let noneProven = 0;
    for (const b of BENCHMARKS) {
      const sites = (await build(b.file, 'proof')).compiled.hardening.sites;
      if (sites.every((s) => s.proven)) allProven++;
      if (sites.every((s) => !s.proven)) noneProven++;
    }
    expect(allProven).toBeGreaterThan(0);
    expect(noneProven).toBeGreaterThan(0);
  });

  test('every configuration computes the same result and arrays as full on the benign inputs', async () => {
    for (const b of BENCHMARKS) {
      const args = b.args(0.01);
      const ref = runOnce(await build(b.file, 'full', { countChecks: true }), b.fn, args);
      expect(ref.kind).toBe('ok');
      expect(ref.sentinelsIntact).toBe(true);
      for (const c of MAIN_CONFIGS) {
        const o = runOnce(await build(b.file, c, { countChecks: true }), b.fn, args);
        expect({ b: b.name, c, r: o.result, a: o.arrays, s: o.sentinelsIntact }).toEqual({ b: b.name, c, r: ref.result, a: ref.arrays, s: true });
      }
    }
  });

  test('the versionable variants of stencil and smoothing hoist checks; the natural forms do not', async () => {
    const hoisted = async (name: string) =>
      (await build(path.join(__dirname, '..', 'bench', `${name}.min`), 'strict')).compiled.hardening.sites.filter((s) => s.decision === 'hoist').length;
    expect(await hoisted('stencil')).toBe(0);
    expect(await hoisted('stencilV')).toBeGreaterThan(0);
    expect(await hoisted('smooth')).toBe(0);
    expect(await hoisted('smoothV')).toBeGreaterThan(0);
  });
});

describe('bug corpus manifest', () => {
  const bugs = loadBugs();
  test('at least 12 programs, covering internal/external reads and writes', () => {
    expect(bugs.length).toBeGreaterThanOrEqual(12);
    for (const access of ['read', 'write']) {
      for (const index of ['internal', 'external']) {
        expect(bugs.some((b) => b.access === access && b.index === index)).toBe(true);
      }
    }
  });

  for (const bug of bugs) {
    test(`${bug.file}: manifest matches the compiler and the program misbehaves under full`, async () => {
      const b = await build(path.join(__dirname, '..', 'bench', 'bugs', bug.file), 'full');
      const site = b.compiled.hardening.sites.find((s) => s.id === bug.buggyCheck.id)!;
      expect(site).toBeDefined();
      expect({ line: site.line, column: site.column, access: site.access, external: site.P === 1 }).toEqual({
        line: bug.buggyCheck.line,
        column: bug.buggyCheck.column,
        access: bug.access,
        external: bug.index === 'external',
      });
      const o = runOnce(b, bug.function, bug.trigger);
      expect(o).toMatchObject({ kind: 'trap', trap: 'unreachable', checkId: bug.buggyCheck.id });
      expect(classify(o, bug.buggyCheck.id)).toBe('detected');
      // ...and the bug is real: with no checks at all it is not caught.
      const n = runOnce(await build(path.join(__dirname, '..', 'bench', 'bugs', bug.file), 'none'), bug.function, bug.trigger);
      expect(n.kind).toBe('ok');
      if (bug.access === 'write') expect(n.sentinelsIntact).toBe(false);
    });
  }
});

describe('eval pipeline', () => {
  test('run.ts writes the raw CSVs and report.ts turns them into RESULTS.md and two SVGs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-eval-'));
    await runEval({ outDir: dir, scale: 0.005, warmups: 0, timed: 3, timingPasses: 2, log: () => undefined });
    for (const f of ['static.csv', 'dynamic.csv', 'sweep.csv', 'ablation.csv', 'security.csv', 'timing.csv', 'timing_samples.csv', 'env.json']) {
      expect(fs.existsSync(path.join(dir, 'raw', f))).toBe(true);
    }
    const timing = parseCsv(fs.readFileSync(path.join(dir, 'raw', 'timing.csv'), 'utf-8'));
    expect(new Set(timing.map((r) => r.pass))).toEqual(new Set(['1', '2']));
    expect(fs.readdirSync(path.join(dir, 'hardening')).length).toBe(BENCHMARKS.length);
    const md = generateReport(dir);
    expect(md).toContain('## Cost: checks and guards executed');
    expect(md).toContain('## Security: bug corpus');
    expect(md).not.toMatch(/NaN|undefined/);
    expect(fs.readFileSync(path.join(dir, 'pareto.svg'), 'utf-8')).toMatch(/^<svg/);
  });

  test('paretoFront keeps exactly the non-dominated points', () => {
    const pts = [
      { label: 'a', x: 0.1, y: 0.5, kind: 'config' as const },
      { label: 'b', x: 0.2, y: 0.5, kind: 'config' as const }, // dominated by a
      { label: 'c', x: 0.3, y: 1, kind: 'config' as const },
    ];
    expect(paretoFront(pts).map((p) => p.label)).toEqual(['a', 'c']);
  });
});
