// Evaluation driver (milestone A3). Runs every benchmark under every
// --harden configuration and every bug program under every configuration,
// and writes raw CSVs to results/raw/ plus per-benchmark hardening reports
// to results/hardening/. results/RESULTS.md is produced from these files
// by eval/report.ts; nothing here interprets the numbers.
//
//   npx ts-node eval/run.ts [--quick]
//
// Inputs are scaled by 10 relative to the sizes in eval/benchmarks.ts so a
// single call takes milliseconds rather than a fraction of one (a first run
// at scale 1 had a median pass-to-pass timing difference of about 40%).
// --quick shrinks inputs and timing repetitions (for smoke tests only; its
// output is not a result).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { BENCHMARKS, Bench } from './benchmarks';
import { Arg, build, Built, instantiate, runOnce } from './exec';
import { DEFAULT_WEIGHTS, RiskWeights } from '../src/harden/config';
import { SiteReport } from '../src/harden/harden';

export const MAIN_CONFIGS = ['none', 'full', 'proof', 'strict', 'balanced', 'performance', 'budget:0.25', 'budget:0.5', 'chuang'];
export const TAUS = Array.from({ length: 21 }, (_, k) => Math.round(k * 5) / 100);
export const ABLATIONS: Array<{ name: string; weights: RiskWeights }> = [
  { name: 'default', weights: DEFAULT_WEIGHTS },
  { name: 'no_wP', weights: { ...DEFAULT_WEIGHTS, wP: 0 } },
  { name: 'no_wC', weights: { ...DEFAULT_WEIGHTS, wC: 0 } },
  { name: 'no_wW', weights: { ...DEFAULT_WEIGHTS, wW: 0 } },
];
export const ABLATION_TAU = 0.5;

const ROOT = path.join(__dirname, '..');

export interface RunOptions {
  outDir: string;
  scale: number;
  warmups: number;
  timed: number;
  timingPasses: number;
  log: (s: string) => void;
}

function csv(rows: Array<Record<string, string | number | boolean>>): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: string | number | boolean) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

export function percentile(sorted: number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function staticRow(bench: string, config: string, sites: SiteReport[], codeSize: number) {
  const count = (d: string) => sites.filter((s) => s.decision === d).length;
  const prot = (s: SiteReport) => s.proven || s.decision === 'hoist' || s.decision === 'retain';
  const extW = sites.filter((s) => s.P === 1 && s.access === 'write');
  return {
    bench,
    config,
    sites: sites.length,
    proven: sites.filter((s) => s.proven).length,
    eliminated: count('eliminate'),
    hoisted: count('hoist'),
    omitted: count('omit'),
    retained: count('retain'),
    protected: sites.filter(prot).length,
    coverage: sites.length ? sites.filter(prot).length / sites.length : 1,
    ext_write_sites: extW.length,
    ext_write_protected: extW.filter(prot).length,
    coverage_ext_write: extW.length ? extW.filter(prot).length / extW.length : '',
    code_size: codeSize,
  };
}

function sameOutput(a: ReturnType<typeof runOnce>, b: ReturnType<typeof runOnce>): boolean {
  return a.kind === b.kind && a.result === b.result && JSON.stringify(a.arrays) === JSON.stringify(b.arrays);
}

interface Bug {
  file: string;
  function: string;
  buggyCheck: { id: number; line: number; column: number };
  access: 'read' | 'write';
  index: 'external' | 'internal';
  trigger: Arg[];
}

export function loadBugs(): Bug[] {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'bugs', 'manifest.json'), 'utf-8')).programs;
}

export function classify(o: ReturnType<typeof runOnce>, expectedId: number): string {
  if (o.kind === 'trap' && o.trap === 'unreachable' && o.checkId === expectedId) return 'detected';
  if (!o.sentinelsIntact) return o.kind === 'trap' ? 'other_trap_after_corruption' : 'silent_corruption';
  if (o.kind === 'trap') return 'other_trap';
  return 'missed_benign';
}

function timeKernel(b: Built, bench: Bench, args: Arg[], opts: RunOptions): number[] {
  const inst = instantiate(b, bench.fn, args);
  const samples: number[] = [];
  for (let k = 0; k < opts.warmups + opts.timed; k++) {
    inst.reset();
    const t0 = performance.now();
    inst.call();
    const t1 = performance.now();
    if (k >= opts.warmups) samples.push(t1 - t0);
  }
  return samples;
}

export async function runEval(opts: RunOptions): Promise<void> {
  const raw = path.join(opts.outDir, 'raw');
  const hard = path.join(opts.outDir, 'hardening');
  fs.mkdirSync(raw, { recursive: true });
  fs.mkdirSync(hard, { recursive: true });

  const staticRows: Array<Record<string, string | number | boolean>> = [];
  const dynamicRows: Array<Record<string, string | number | boolean>> = [];
  const sweepRows: Array<Record<string, string | number | boolean>> = [];
  const ablationRows: Array<Record<string, string | number | boolean>> = [];
  const sitesRows: Array<Record<string, string | number | boolean>> = [];

  const timingBuilds = new Map<string, Built>();

  for (const bench of BENCHMARKS) {
    opts.log(`static/dynamic: ${bench.name}`);
    const args = bench.args(opts.scale);
    const reports: Record<string, unknown> = {};
    const ref = runOnce(await build(bench.file, 'full', { countChecks: true }), bench.fn, args);
    if (ref.kind !== 'ok') throw new Error(`${bench.name}: full build trapped on the benchmark input`);

    const measure = async (config: string, weights?: RiskWeights) => {
      const counted = await build(bench.file, config, { countChecks: true, weights });
      const o = runOnce(counted, bench.fn, args);
      return { counted, o };
    };

    for (const config of MAIN_CONFIGS) {
      const plain = await build(bench.file, config);
      timingBuilds.set(`${bench.name}|${config}`, plain);
      const { counted, o } = await measure(config);
      const sites = counted.compiled.hardening.sites;
      reports[config] = counted.compiled.hardening;
      staticRows.push(staticRow(bench.name, config, sites, plain.codeSize));
      dynamicRows.push({
        bench: bench.name,
        config,
        checks_executed: o.checks,
        guards_executed: o.guards,
        checks_full: ref.checks,
        output_matches_full: sameOutput(o, ref),
      });
      if (config === 'strict') {
        for (const s of sites) {
          sitesRows.push({ bench: bench.name, id: s.id, function: s.function, line: s.line, column: s.column, access: s.access, P: s.P, C: s.C, W: s.W, R: s.R ?? '', D: s.D, proven: s.proven, versionable: s.versionable });
        }
      }
    }
    fs.writeFileSync(path.join(hard, `${bench.name}.json`), JSON.stringify(reports, null, 2) + '\n');

    for (const tau of TAUS) {
      const { counted, o } = await measure(`threshold:${tau}`);
      const st = staticRow(bench.name, `threshold:${tau}`, counted.compiled.hardening.sites, 0);
      sweepRows.push({
        bench: bench.name,
        tau,
        checks_executed: o.checks,
        guards_executed: o.guards,
        checks_full: ref.checks,
        omitted: st.omitted,
        sites: st.sites,
        protected: st.protected,
        ext_write_sites: st.ext_write_sites,
        ext_write_protected: st.ext_write_protected,
        output_matches_full: sameOutput(o, ref),
      });
    }

    for (const ab of ABLATIONS) {
      const { counted, o } = await measure(`threshold:${ABLATION_TAU}`, ab.weights);
      const st = staticRow(bench.name, ab.name, counted.compiled.hardening.sites, 0);
      ablationRows.push({
        bench: bench.name,
        split: bench.split,
        variant: ab.name,
        tau: ABLATION_TAU,
        checks_executed: o.checks,
        checks_full: ref.checks,
        omitted: st.omitted,
        coverage: st.coverage,
        ext_write_sites: st.ext_write_sites,
        ext_write_protected: st.ext_write_protected,
      });
    }
  }

  // Security: every bug program under every main configuration and every
  // tau of the sweep, on its triggering input.
  const securityRows: Array<Record<string, string | number | boolean>> = [];
  const bugConfigs = [...MAIN_CONFIGS, ...TAUS.map((t) => `threshold:${t}`)];
  for (const bug of loadBugs()) {
    opts.log(`security: ${bug.file}`);
    const file = path.join(ROOT, 'bench', 'bugs', bug.file);
    for (const config of bugConfigs) {
      const b = await build(file, config);
      const o = runOnce(b, bug.function, bug.trigger);
      const site = b.compiled.hardening.sites.find((s) => s.id === bug.buggyCheck.id);
      securityRows.push({
        bug: bug.file.replace(/\.min$/, ''),
        config,
        access: bug.access,
        index: bug.index,
        buggy_check: bug.buggyCheck.id,
        decision: site ? site.decision : '',
        outcome: classify(o, bug.buggyCheck.id),
        trap: o.kind === 'trap' ? o.trap! : '',
        trap_check: o.kind === 'trap' ? o.checkId! : '',
        sentinels_intact: o.sentinelsIntact,
      });
    }
  }

  // Timing: the whole timing pass is run `timingPasses` times so the
  // report can state the run-to-run difference.
  const timingRows: Array<Record<string, string | number | boolean>> = [];
  const sampleRows: Array<Record<string, string | number | boolean>> = [];
  for (let pass = 1; pass <= opts.timingPasses; pass++) {
    for (const bench of BENCHMARKS) {
      opts.log(`timing pass ${pass}: ${bench.name}`);
      const args = bench.args(opts.scale);
      for (const config of MAIN_CONFIGS) {
        const samples = timeKernel(timingBuilds.get(`${bench.name}|${config}`)!, bench, args, opts);
        const sorted = [...samples].sort((a, b) => a - b);
        timingRows.push({
          pass,
          bench: bench.name,
          config,
          runs: samples.length,
          median_ms: percentile(sorted, 0.5),
          q1_ms: percentile(sorted, 0.25),
          q3_ms: percentile(sorted, 0.75),
        });
        samples.forEach((ms, k) => sampleRows.push({ pass, bench: bench.name, config, run: k, ms }));
      }
    }
  }

  fs.writeFileSync(path.join(raw, 'static.csv'), csv(staticRows));
  fs.writeFileSync(path.join(raw, 'dynamic.csv'), csv(dynamicRows));
  fs.writeFileSync(path.join(raw, 'sweep.csv'), csv(sweepRows));
  fs.writeFileSync(path.join(raw, 'ablation.csv'), csv(ablationRows));
  fs.writeFileSync(path.join(raw, 'sites.csv'), csv(sitesRows));
  fs.writeFileSync(path.join(raw, 'security.csv'), csv(securityRows));
  fs.writeFileSync(path.join(raw, 'timing.csv'), csv(timingRows));
  fs.writeFileSync(path.join(raw, 'timing_samples.csv'), csv(sampleRows));
  fs.writeFileSync(
    path.join(raw, 'env.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        node: process.version,
        v8: process.versions.v8,
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        cpus: os.cpus().length,
        scale: opts.scale,
        warmups: opts.warmups,
        timed: opts.timed,
        timingPasses: opts.timingPasses,
        weights: DEFAULT_WEIGHTS,
      },
      null,
      2,
    ) + '\n',
  );
}

if (require.main === module) {
  const quick = process.argv.includes('--quick');
  runEval({
    outDir: path.join(ROOT, 'results'),
    scale: quick ? 0.02 : 10,
    warmups: quick ? 1 : 5,
    timed: quick ? 3 : 30,
    timingPasses: 2,
    log: (s) => console.log(s),
  }).then(
    () => console.log('raw results written to results/raw/'),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
