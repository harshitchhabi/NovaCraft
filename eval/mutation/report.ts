// Mutation-corpus report (milestone A3b). Implements the analysis in
// docs/PREREGISTRATION.md exactly: detection / silent-corruption rates, cost
// (checks + guards on unmutated kernels), H1, H2, AUC, kernel-resampling
// bootstrap CIs, and the per-class silent-corruption sites. Every number is
// computed here from results/mutation/raw/*.csv and corpus.json.
//
//   npx ts-node eval/mutation/report.ts [mutationDir]
import * as fs from 'fs';
import * as path from 'path';
import { parseCsv } from '../report';
import { rng } from '../benchmarks';
import { Variant } from '../mutate';
import { BUDGET_SWEEP, MAIN, TAU_SWEEP } from './evaluate';

type Row = Record<string, string>;
const num = Number;
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : 'n/a');
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export const BOOTSTRAP_B = 2000;
export const BOOTSTRAP_SEED = 20261007;

function table(head: string[], rows: Array<Array<string | number>>): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

// Per-kernel aggregates; every statistic is a function of a multiset of kernels.
interface KernelAgg {
  kept: number;
  detAll: Map<string, number>;
  detAny: Map<string, number>;
  silent: Map<string, number>;
  cost: Map<string, number>; // checks + guards
  full: number; // full checks
}

export interface Stats {
  det: (c: string) => number;
  detAny: (c: string) => number;
  silent: (c: string) => number;
  cost: (c: string) => number;
}

function statsOf(kernels: KernelAgg[]): Stats {
  const kept = sum(kernels.map((k) => k.kept));
  const full = sum(kernels.map((k) => k.full));
  return {
    det: (c) => sum(kernels.map((k) => k.detAll.get(c) ?? 0)) / kept,
    detAny: (c) => sum(kernels.map((k) => k.detAny.get(c) ?? 0)) / kept,
    silent: (c) => sum(kernels.map((k) => k.silent.get(c) ?? 0)) / kept,
    cost: (c) => sum(kernels.map((k) => k.cost.get(c) ?? 0)) / full,
  };
}

// Detection-vs-cost curve: equal cost keeps the highest detection; sorted by cost.
export function curve(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const best = new Map<number, number>();
  for (const p of points) best.set(p.x, Math.max(best.get(p.x) ?? -Infinity, p.y));
  return [...best.entries()].map(([x, y]) => ({ x, y })).sort((a, b) => a.x - b.x);
}

export function interpolate(c: Array<{ x: number; y: number }>, x: number): number {
  if (c.length === 0 || x < c[0].x || x > c[c.length - 1].x) return NaN;
  for (let k = 0; k < c.length; k++) {
    if (c[k].x === x) return c[k].y;
    if (k + 1 < c.length && c[k].x < x && x < c[k + 1].x) {
      const t = (x - c[k].x) / (c[k + 1].x - c[k].x);
      return c[k].y + t * (c[k + 1].y - c[k].y);
    }
  }
  return NaN;
}

export function auc(c: Array<{ x: number; y: number }>): number {
  let a = 0;
  for (let k = 0; k + 1 < c.length; k++) a += ((c[k + 1].x - c[k].x) * (c[k].y + c[k + 1].y)) / 2;
  return a;
}

function familyCurve(s: Stats, family: string[], det: (c: string) => number) {
  return curve(family.map((c) => ({ x: s.cost(c), y: det(c) })));
}
function familyAuc(s: Stats, family: string[]) {
  return auc(curve([{ x: 0, y: s.det('none') }, ...family.map((c) => ({ x: s.cost(c), y: s.det(c) })), { x: 1, y: s.det('full') }]));
}
function delta(s: Stats, family: string[], det: (c: string) => number) {
  return interpolate(familyCurve(s, family, det), s.cost('chuang')) - det('chuang');
}

function percentile(sorted: number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

interface CI {
  est: number;
  lo: number;
  hi: number;
  dropped: number; // resamples where the statistic was undefined
}

function bootstrap(kernels: KernelAgg[], stat: (s: Stats) => number): CI {
  const r = rng(BOOTSTRAP_SEED);
  const vals: number[] = [];
  let dropped = 0;
  for (let b = 0; b < BOOTSTRAP_B; b++) {
    const sample = kernels.map(() => kernels[Math.floor(r() * kernels.length)]);
    const v = stat(statsOf(sample));
    if (Number.isFinite(v)) vals.push(v);
    else dropped++;
  }
  vals.sort((a, b) => a - b);
  return { est: stat(statsOf(kernels)), lo: percentile(vals, 0.025), hi: percentile(vals, 0.975), dropped };
}

const ci = (c: CI, f: (x: number) => string = (x) => pct(x)) => `${f(c.est)} [${f(c.lo)}, ${f(c.hi)}]`;

function svg(title: string, families: Array<{ name: string; color: string; pts: Array<{ x: number; y: number; lo: number; hi: number }> }>, singles: Array<{ label: string; x: number; y: number }>): string {
  const W = 700;
  const H = 460;
  const m = { l: 64, r: 170, t: 40, b: 56 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const X = (x: number) => m.l + Math.min(1, Math.max(0, x)) * pw;
  const Y = (y: number) => m.t + (1 - y) * ph;
  const o: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="11">`, `<rect width="${W}" height="${H}" fill="white"/>`, `<text x="${m.l}" y="22" font-size="14" font-weight="bold">${title}</text>`];
  for (let k = 0; k <= 5; k++) {
    const v = k / 5;
    o.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e5e5e5"/>`, `<text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`);
    o.push(`<line y1="${m.t}" y2="${m.t + ph}" x1="${X(v)}" x2="${X(v)}" stroke="#e5e5e5"/>`, `<text x="${X(v)}" y="${m.t + ph + 16}" text-anchor="middle">${(100 * v).toFixed(0)}%</text>`);
  }
  o.push(`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="#333"/>`);
  o.push(`<text x="${m.l + pw / 2}" y="${H - 14}" text-anchor="middle">cost: checks + guards on unmutated kernels (% of full's checks)</text>`);
  o.push(`<text transform="translate(16 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle">detection rate (all triggering inputs)</text>`);
  families.forEach((f, i) => {
    const pts = [...f.pts].sort((a, b) => a.x - b.x);
    const band = [...pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.hi).toFixed(1)}`), ...pts.reverse().map((p) => `${X(p.x).toFixed(1)},${Y(p.lo).toFixed(1)}`)].join(' ');
    o.push(`<polygon points="${band}" fill="${f.color}" fill-opacity="0.15" stroke="none"/>`);
    const line = [...f.pts].sort((a, b) => a.x - b.x).map((p, k) => `${k ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    o.push(`<path d="${line}" fill="none" stroke="${f.color}" stroke-width="1.5"/>`);
    for (const p of f.pts) o.push(`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="2" fill="${f.color}"/>`);
    const ly = m.t + 10 + i * 15;
    o.push(`<line x1="${m.l + pw + 12}" x2="${m.l + pw + 22}" y1="${ly - 3}" y2="${ly - 3}" stroke="${f.color}" stroke-width="2"/>`, `<text x="${m.l + pw + 26}" y="${ly}">${f.name} (95% CI band)</text>`);
  });
  singles.forEach((p, i) => {
    o.push(`<rect x="${X(p.x) - 3.5}" y="${Y(p.y) - 3.5}" width="7" height="7" fill="#333"><title>${p.label}</title></rect>`);
    const ly = m.t + 10 + (families.length + i) * 15;
    o.push(`<rect x="${m.l + pw + 13}" y="${ly - 7}" width="7" height="7" fill="#333"/>`, `<text x="${m.l + pw + 26}" y="${ly}">${p.label} (${pct(p.x, 0)}, ${p.y.toFixed(2)})</text>`);
  });
  o.push('</svg>');
  return o.join('\n') + '\n';
}

export function generateMutationReport(dir: string, determinism: string): string {
  const raw = path.join(dir, 'raw');
  const read = (f: string) => parseCsv(fs.readFileSync(path.join(raw, f), 'utf-8'));
  const corpus: Variant[] = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf-8'));
  const out = read('outcomes.csv');
  const cost = read('cost.csv');
  const silent = read('silent.csv');
  const kernelNames = [...new Set(cost.map((r) => r.kernel))];
  const kept = corpus.filter((v) => v.status === 'kept');

  const kernels: KernelAgg[] = kernelNames.map((k) => {
    const rows = out.filter((r) => r.kernel === k);
    const agg: KernelAgg = { kept: kept.filter((v) => v.kernel === k).length, detAll: new Map(), detAny: new Map(), silent: new Map(), cost: new Map(), full: 0 };
    for (const r of rows) {
      agg.detAll.set(r.config, (agg.detAll.get(r.config) ?? 0) + num(r.detected_all));
      agg.detAny.set(r.config, (agg.detAny.get(r.config) ?? 0) + num(r.detected_any));
      agg.silent.set(r.config, (agg.silent.get(r.config) ?? 0) + num(r.silent_any));
    }
    for (const r of cost.filter((x) => x.kernel === k)) {
      agg.cost.set(r.config, num(r.checks) + num(r.guards));
      agg.full = num(r.full_checks);
    }
    return agg;
  });
  const all = statsOf(kernels);

  const o: string[] = [];
  const P = (s = '') => o.push(s);
  P('# Mutation-corpus evaluation (A3b)');
  P();
  P('Generated by `eval/mutation/report.ts` from `results/mutation/raw/` and `results/mutation/corpus.json`; analysis as preregistered in `docs/PREREGISTRATION.md` (policies and weights frozen at `b1f11bc8eef0a8c822fdc004d615cf2e54750b2d`). Do not edit by hand; run `npm run eval:mutation`.');
  P();

  // ---- corpus
  P('## Corpus');
  P();
  const st = (vs: Variant[], s: string) => vs.filter((v) => v.status === s).length;
  P(`${corpus.length} variants generated from ${kernelNames.length} kernels: **${st(corpus, 'kept')} kept** (triggerable under \`full\`), ${st(corpus, 'not_triggerable')} dropped as not triggerable, ${st(corpus, 'not_compilable')} not compilable, ${st(corpus, 'duplicate')} duplicates of an earlier variant of the same kernel (identical program text) removed. ${kept.filter((v) => v.fullFuel > 0).length} kept variants also ran out of loop fuel under \`full\` on some input.`);
  P();
  const ops = [...new Set(corpus.map((v) => v.operator))];
  P(table(['operator', 'generated', 'duplicate', 'not compilable', 'not triggerable', 'kept'], [...ops.map((op) => {
    const vs = corpus.filter((v) => v.operator === op);
    return [op, vs.length, st(vs, 'duplicate'), st(vs, 'not_compilable'), st(vs, 'not_triggerable'), st(vs, 'kept')];
  }), ['**total**', corpus.length, st(corpus, 'duplicate'), st(corpus, 'not_compilable'), st(corpus, 'not_triggerable'), st(corpus, 'kept')]]));
  P();
  P(table(['kernel', 'generated', 'kept', 'not triggerable'], kernelNames.map((k) => {
    const vs = corpus.filter((v) => v.kernel === k);
    return [k, vs.length, st(vs, 'kept'), st(vs, 'not_triggerable')];
  })));
  P();

  // ---- main table
  P('## Detection, silent corruption and cost per configuration');
  P();
  P(`Rates are over the ${kept.length} kept variants; detection (primary) = the configuration traps at a bounds check on **every** triggering input; detected-any = on at least one. Cost = checks + guards executed by the unmutated kernels on their benchmark inputs at scale 1, as a fraction of \`full\`'s checks. Brackets: 95% bootstrap CI (B = ${BOOTSTRAP_B}, kernels resampled).`);
  P();
  P(table(['config', 'detection', 'detected-any', 'silent corruption', 'cost (checks+guards)'], MAIN.map((c) => [
    c,
    ci(bootstrap(kernels, (s) => s.det(c))),
    ci(bootstrap(kernels, (s) => s.detAny(c))),
    ci(bootstrap(kernels, (s) => s.silent(c))),
    ci(bootstrap(kernels, (s) => s.cost(c))),
  ])));
  P();

  // ---- H1
  P('## H1: strict (guards counted) costs less than proof with identical detection');
  P();
  const h1 = bootstrap(kernels, (s) => s.cost('proof') - s.cost('strict'));
  const digest = (c: string) => new Map(out.filter((r) => r.config === c).map((r) => [r.variant, r.digest]));
  const dp = digest('proof');
  const ds = digest('strict');
  const differing = [...dp.keys()].filter((v) => dp.get(v) !== ds.get(v));
  const h1a = h1.lo > 0;
  const h1b = differing.length === 0;
  P(`- (a) cost(proof) - cost(strict) = ${ci(h1, (x) => `${(100 * x).toFixed(1)} pp`)}; cost(proof) ${pct(all.cost('proof'))}, cost(strict) ${pct(all.cost('strict'))}. CI entirely above 0: **${h1a ? 'yes' : 'no'}**.`);
  P(`- (b) per-input outcome and check id identical between strict and proof on every kept variant: **${h1b ? 'yes' : `no (${differing.length} variants differ: ${differing.slice(0, 10).join(', ')})`}**.`);
  P(`- **H1 ${h1a && h1b ? 'supported' : 'not supported'}.**`);
  P();

  // ---- H2
  P('## H2: at matched cost, threshold and budget policies detect more than chuang');
  P();
  P(`chuang: cost ${pct(all.cost('chuang'))}, detection ${pct(all.det('chuang'))}, detected-any ${pct(all.detAny('chuang'))}.`);
  P();
  const verdict = (c: CI, testable: boolean) => (!testable ? 'untestable' : c.lo > 0 ? 'supported' : c.hi < 0 ? 'refuted' : 'inconclusive');
  const h2rows: Array<Array<string | number>> = [];
  const verdicts: string[] = [];
  for (const [name, fam] of [['threshold sweep', TAU_SWEEP], ['budget sweep', BUDGET_SWEEP]] as const) {
    for (const [label, det] of [['detection (primary)', (s: Stats) => (c: string) => s.det(c)], ['detected-any (secondary)', (s: Stats) => (c: string) => s.detAny(c)]] as const) {
      const curveAll = familyCurve(all, fam, det(all));
      const testable = Number.isFinite(interpolate(curveAll, all.cost('chuang')));
      const d = bootstrap(kernels, (s) => delta(s, fam, det(s)));
      const v = verdict(d, testable);
      if (label.startsWith('detection')) verdicts.push(`${name}: ${v}`);
      h2rows.push([name, label, testable ? pct(interpolate(curveAll, all.cost('chuang'))) : 'n/a', ci(d, (x) => `${(100 * x).toFixed(1)} pp`), d.dropped, v]);
    }
  }
  P(table(['family', 'metric', 'family detection at chuang cost', 'delta vs chuang [95% CI]', 'resamples with chuang outside range', 'verdict'], h2rows));
  P();
  const h2 = verdicts.every((v) => v.endsWith(': supported'));
  P(`Primary verdicts: ${verdicts.join('; ')}. **H2 ${h2 ? 'supported' : 'not supported'}** (requires both families supported on the primary metric).`);
  P();

  // ---- AUC
  P('## Area under the detection-vs-cost curve');
  P();
  P(table(['family', 'AUC [95% CI]'], [
    ['threshold sweep', ci(bootstrap(kernels, (s) => familyAuc(s, TAU_SWEEP)), (x) => x.toFixed(3))],
    ['budget sweep', ci(bootstrap(kernels, (s) => familyAuc(s, BUDGET_SWEEP)), (x) => x.toFixed(3))],
  ]));
  P();
  P('Curve extended with (0, detection of `none`) and (1, detection of `full`); equal-cost points keep the higher detection.');
  P();

  // ---- sweep tables and plot
  const famPts = (fam: string[]) =>
    fam.map((c) => {
      const b = bootstrap(kernels, (s) => s.det(c));
      return { c, x: all.cost(c), y: all.det(c), lo: b.lo, hi: b.hi };
    });
  const tauPts = famPts(TAU_SWEEP);
  const budPts = famPts(BUDGET_SWEEP);
  fs.writeFileSync(
    path.join(dir, 'detection_vs_cost.svg'),
    svg('Mutation corpus: detection vs. cost', [
      { name: 'threshold:tau', color: '#2a6fdb', pts: tauPts },
      { name: 'budget:F', color: '#d1495b', pts: budPts },
    ], ['proof', 'strict', 'chuang'].map((c) => ({ label: c, x: all.cost(c), y: all.det(c) }))),
  );
  P('## Sweeps');
  P();
  P('![detection vs cost](detection_vs_cost.svg)');
  P();
  P('Bands: per-point 95% bootstrap CI of the detection rate (cost plotted at its full-sample value).');
  P();
  for (const [name, pts] of [['Threshold sweep', tauPts], ['Budget sweep', budPts]] as const) {
    P(`**${name}**`);
    P();
    P(table(['config', 'cost', 'detection [95% CI]', 'detected-any', 'silent corruption'], pts.map((p) => [p.c, pct(p.x), `${pct(p.y)} [${pct(p.lo)}, ${pct(p.hi)}]`, pct(all.detAny(p.c)), pct(all.silent(p.c))])));
    P();
  }

  // ---- step 5
  P('## Silent corruption by mutation class: which omitted sites caused it');
  P();
  P('For each silent-corruption run, the site is the bounds check that fired under `full` on the same input (the preregistered attribution); the columns give that site\'s decision under the configuration, and its P, C, W, R. When that site is a **read**, omitting it does not corrupt anything by itself: execution continues past it and a later write corrupts memory. That write is among the "omitted writes in variant" column (secondary attribution, added after the first run; see the Deviations in docs/PREREGISTRATION.md). Counts are variants (and triggering inputs). Main configurations only; `results/mutation/raw/silent.csv` has every configuration.');
  P();
  const mainSilent = silent.filter((r) => MAIN.includes(r.config));
  const decisions = [...new Set(mainSilent.map((r) => r.decision))];
  P(`Decisions of the responsible sites over all silent-corruption cases in the main configurations: ${decisions.map((d) => `${d || '(no site)'} ${mainSilent.filter((r) => r.decision === d).length}`).join(', ')}. Of these cases, ${mainSilent.filter((r) => r.access === 'read').length} are attributed to a read site and ${mainSilent.filter((r) => r.access === 'write').length} to a write site.`);
  P();
  for (const op of ops) {
    const rows = mainSilent.filter((r) => r.operator === op);
    if (rows.length === 0) {
      P(`**${op}**: no silent corruption in any main configuration.`);
      P();
      continue;
    }
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = [r.config, r.kernel, `${r.line}:${r.column}`, r.access, r.P, r.C, r.W, r.R, r.decision, r.omitted_writes || '-'].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    P(`**${op}**`);
    P();
    P(table(
      ['config', 'kernel', 'site', 'access', 'P', 'C', 'W', 'R', 'decision', 'omitted writes in variant', 'variants (inputs)'],
      [...groups.entries()]
        .sort((a, b) => MAIN.indexOf(a[0].split('|')[0]) - MAIN.indexOf(b[0].split('|')[0]) || a[0].localeCompare(b[0]))
        .map(([k, rs]) => [...k.split('|'), `${new Set(rs.map((r) => r.variant)).size} (${sum(rs.map((r) => num(r.inputs)))})`]),
    ));
    P();
  }

  P('## Determinism');
  P();
  P(determinism);
  P();
  P('## Caveats');
  P();
  P('- Variants come from 16 small kernels written for this project; with only 16 clusters the kernel-resampling CIs are wide and approximate.');
  P('- Pooled rates weight kernels by their number of kept variants (matvec has the most).');
  P('- Cost is measured on the unmutated kernels on one benchmark input each.');
  P('- Fuzzed inputs are small (arrays of length 0-16); a variant that only misbehaves on larger inputs is counted as not triggerable.');
  P();
  return o.join('\n');
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', 'results', 'mutation'));
  const detFile = path.join(dir, 'raw', 'determinism.txt');
  const det = fs.existsSync(detFile) ? fs.readFileSync(detFile, 'utf-8').trim() : 'Determinism check not run.';
  fs.writeFileSync(path.join(dir, 'RESULTS.md'), generateMutationReport(dir, det));
  console.log(`wrote ${path.join(dir, 'RESULTS.md')}`);
}
