// Report generator (milestone A3). Reads results/raw/*.csv written by
// eval/run.ts and writes results/RESULTS.md, results/pareto.svg and
// results/pareto_security.svg. Every number and every comparative sentence
// in the report is computed here from the raw files; nothing is typed in.
//
//   npx ts-node eval/report.ts [resultsDir]
import * as fs from 'fs';
import * as path from 'path';
import { BENCHMARKS } from './benchmarks';
import { ABLATIONS, ABLATION_TAU, MAIN_CONFIGS, TAUS } from './run';

type Row = Record<string, string>;

export function parseCsv(text: string): Row[] {
  const lines: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      lines.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    lines.push(row);
  }
  const [head, ...body] = lines;
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ''])));
}

const num = (s: string) => Number(s);
const pct = (x: number, digits = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(digits)}%` : 'n/a');
const fx = (x: number, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : 'n/a');
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function table(head: string[], rows: Array<Array<string | number>>): string {
  const out = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of rows) out.push(`| ${r.join(' | ')} |`);
  return out.join('\n');
}

interface Point {
  label: string;
  x: number; // (checks + guards executed) / full's checks
  y: number; // ext-write coverage, or detection rate
  kind: 'config' | 'sweep' | 'bench';
}

// Points not dominated by another (lower-or-equal x and higher-or-equal y,
// strictly better in one).
export function paretoFront(points: Point[]): Point[] {
  return points.filter(
    (p) => !points.some((q) => q !== p && q.x <= p.x && q.y >= p.y && (q.x < p.x || q.y > p.y)),
  );
}

function svgPlot(title: string, yLabel: string, points: Point[], sweep: Point[]): string {
  const W = 680;
  const H = 440;
  const m = { l: 64, r: 150, t: 40, b: 56 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const xMax = Math.max(1, ...points.map((p) => p.x), ...sweep.map((p) => p.x));
  const X = (x: number) => m.l + (x / xMax) * pw;
  const Y = (y: number) => m.t + (1 - y) * ph;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="11">`);
  parts.push(`<rect width="${W}" height="${H}" fill="white"/>`);
  parts.push(`<text x="${m.l}" y="22" font-size="14" font-weight="bold">${title}</text>`);
  for (let k = 0; k <= 5; k++) {
    const v = k / 5;
    parts.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e5e5e5"/>`);
    parts.push(`<text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`);
    const xv = (xMax * k) / 5;
    parts.push(`<line y1="${m.t}" y2="${m.t + ph}" x1="${X(xv)}" x2="${X(xv)}" stroke="#e5e5e5"/>`);
    parts.push(`<text x="${X(xv)}" y="${m.t + ph + 16}" text-anchor="middle">${(100 * xv).toFixed(0)}%</text>`);
  }
  parts.push(`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="#333"/>`);
  parts.push(`<text x="${m.l + pw / 2}" y="${H - 14}" text-anchor="middle">checks + guards executed (% of full's checks)</text>`);
  parts.push(`<text transform="translate(16 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle">${yLabel}</text>`);
  for (const p of points.filter((q) => q.kind === 'bench')) {
    parts.push(`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="2.5" fill="#999" fill-opacity="0.45"><title>${p.label}</title></circle>`);
  }
  if (sweep.length) {
    const d = sweep.map((p, k) => `${k ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="#2a6fdb" stroke-width="1.5"/>`);
    for (const p of sweep) parts.push(`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="2" fill="#2a6fdb"><title>${p.label}</title></circle>`);
  }
  const configs = points.filter((q) => q.kind === 'config');
  const front = new Set(paretoFront(configs).map((p) => p.label));
  configs.forEach((p, k) => {
    const color = front.has(p.label) ? '#d1495b' : '#333';
    parts.push(`<rect x="${X(p.x) - 4}" y="${Y(p.y) - 4}" width="8" height="8" fill="${color}"><title>${p.label}</title></rect>`);
    const ly = m.t + 10 + k * 15;
    parts.push(`<rect x="${m.l + pw + 12}" y="${ly - 7}" width="8" height="8" fill="${color}"/>`);
    parts.push(`<text x="${m.l + pw + 24}" y="${ly}">${p.label} (${pct(p.x, 0)}, ${p.y.toFixed(2)})</text>`);
  });
  const ly = m.t + 14 + configs.length * 15;
  parts.push(`<line x1="${m.l + pw + 12}" x2="${m.l + pw + 20}" y1="${ly}" y2="${ly}" stroke="#2a6fdb" stroke-width="1.5"/>`);
  parts.push(`<text x="${m.l + pw + 24}" y="${ly + 4}">threshold:tau sweep</text>`);
  parts.push(`<circle cx="${m.l + pw + 16}" cy="${ly + 16}" r="2.5" fill="#999"/>`);
  parts.push(`<text x="${m.l + pw + 24}" y="${ly + 20}">per benchmark</text>`);
  parts.push(`<text x="${m.l + pw + 12}" y="${ly + 38}" fill="#d1495b">red: Pareto-optimal</text>`);
  parts.push(`<text x="${m.l + pw + 12}" y="${ly + 52}" fill="#d1495b">among the configs</text>`);
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

export function generateReport(dir: string): string {
  const raw = path.join(dir, 'raw');
  const read = (f: string) => parseCsv(fs.readFileSync(path.join(raw, f), 'utf-8'));
  const env = JSON.parse(fs.readFileSync(path.join(raw, 'env.json'), 'utf-8'));
  const st = read('static.csv');
  const dyn = read('dynamic.csv');
  const sweep = read('sweep.csv');
  const abl = read('ablation.csv');
  const sec = read('security.csv');
  const timing = read('timing.csv');
  const benches = BENCHMARKS.map((b) => b.name);
  const get = (rows: Row[], bench: string, config: string) => rows.find((r) => r.bench === bench && r.config === config)!;

  const out: string[] = [];
  const P = (s = '') => out.push(s);

  P('# NovaCraft risk-adaptive bounds-check hardening: evaluation results');
  P();
  P('Generated by `eval/report.ts` from the raw files in `results/raw/` (written by `eval/run.ts`). Do not edit by hand; run `npm run eval`.');
  P();
  P(`Environment: Node ${env.node} (V8 ${env.v8}), ${env.platform}, ${env.cpu} x${env.cpus}. Run started ${env.date}. Input scale ${env.scale}; timing: ${env.warmups} warm-up + ${env.timed} timed calls per kernel and configuration, whole timing pass repeated ${env.timingPasses} times. Default weights wP=${env.weights.wP}, wC=${env.weights.wC}, wW=${env.weights.wW}.`);
  P();
  P('**What these benchmarks are.** The 16 kernels in `bench/` are small NovaCraft ports of PolyBench-style kernels written for this project, not PolyBench itself (NovaCraft cannot compile C). Arrays are flattened to 1D. All inputs are generated from fixed seeds, are identical across configurations, and keep every access in bounds. Timing is V8 only, on one machine.');
  P();
  P('Configurations: ' + MAIN_CONFIGS.map((c) => `\`${c}\``).join(', ') + '. The main cost metric is **checks + guard evaluations executed** (counter-instrumented build, deterministic); the A3 checks-only accounting is kept in labelled columns. Runtime is reported separately with its measured noise.');
  P();

  // ---- correctness
  const mismatches = dyn.filter((r) => r.output_matches_full !== 'true').length + sweep.filter((r) => r.output_matches_full !== 'true').length;
  P('## Correctness on benign inputs');
  P();
  P(mismatches === 0
    ? `Every configuration (main and tau sweep) produced the same return value and final array contents as \`full\` on every benchmark (${dyn.length + sweep.length} runs).`
    : `**${mismatches} benchmark runs did not match \`full\`** (see dynamic.csv / sweep.csv, column output_matches_full).`);
  P();

  // ---- static
  P('## Static decisions');
  P();
  P('Per benchmark under `strict` (proof elimination + loop versioning, nothing omitted). "versionable" counts unproven sites whose loop matches the versioning pattern.');
  P();
  P(table(
    ['benchmark', 'sites', 'proven', 'hoisted', 'retained', 'ext. writes', 'code size full / strict (bytes)'],
    benches.map((b) => {
      const s = get(st, b, 'strict');
      const f = get(st, b, 'full');
      return [b, s.sites, s.proven, s.hoisted, s.retained, s.ext_write_sites, `${f.code_size} / ${s.code_size}`];
    }),
  ));
  P();
  const totalSites = sum(benches.map((b) => num(get(st, b, 'strict').sites)));
  const totalProven = sum(benches.map((b) => num(get(st, b, 'strict').proven)));
  const totalHoisted = sum(benches.map((b) => num(get(st, b, 'strict').hoisted)));
  const allProven = benches.filter((b) => get(st, b, 'strict').proven === get(st, b, 'strict').sites);
  const noneProven = benches.filter((b) => num(get(st, b, 'strict').proven) === 0);
  P(`Across all kernels: ${totalSites} sites, ${totalProven} proven (${pct(totalProven / totalSites)}), ${totalHoisted} hoisted under strict (${pct(totalHoisted / totalSites)}). Analysis proves every site in: ${allProven.join(', ') || 'none'}; it proves no site in: ${noneProven.join(', ') || 'none'}.`);
  const nat = [['stencil', 'stencilV'], ['smooth', 'smoothV']];
  for (const [a, v] of nat) {
    P(`- \`${a}\` (natural form): ${get(st, a, 'strict').hoisted} of ${get(st, a, 'strict').sites} sites hoisted; \`${v}\` (versionable variant): ${get(st, v, 'strict').hoisted} of ${get(st, v, 'strict').sites}.`);
  }
  P();
  P('Decision counts summed over all kernels, per configuration:');
  P();
  P(table(
    ['config', 'eliminated', 'hoisted', 'retained', 'omitted', 'code size (sum, bytes)'],
    MAIN_CONFIGS.map((c) => {
      const rows = benches.map((b) => get(st, b, c));
      return [c, sum(rows.map((r) => num(r.eliminated))), sum(rows.map((r) => num(r.hoisted))), sum(rows.map((r) => num(r.retained))), sum(rows.map((r) => num(r.omitted))), sum(rows.map((r) => num(r.code_size)))];
    }),
  ));
  P();

  // ---- dynamic
  // Cost accounting (A3b): a loop-versioning guard evaluation is counted as
  // cost alongside bounds checks. The A3 report counted checks only; that
  // number is kept in columns labelled "checks only (A3 accounting)".
  P('## Cost: checks and guards executed (main cost metric)');
  P();
  P('Cost = dynamic bounds checks executed + loop-versioning guard evaluations (one per entry into a versioned loop), on the benchmark input, as a percentage of the checks `full` executes (`full` has no guards). Only configurations that hoist (strict, balanced, performance, budget:*) evaluate guards. The A3 version of this report counted checks only; that accounting is kept in the labelled columns.');
  P();
  const dynCols = MAIN_CONFIGS.filter((c) => c !== 'none' && c !== 'full');
  const cost = (b: string, c: string) => num(get(dyn, b, c).checks_executed) + num(get(dyn, b, c).guards_executed);
  P(table(
    ['benchmark', 'full checks (count)', ...dynCols.map((c) => `${c} checks+guards`), 'strict guards (count)', 'strict checks only (A3 accounting)'],
    benches.map((b) => {
      const full = num(get(dyn, b, 'full').checks_executed);
      return [
        b,
        full,
        ...dynCols.map((c) => (full ? pct(cost(b, c) / full) : '-')),
        get(dyn, b, 'strict').guards_executed,
        full ? pct(num(get(dyn, b, 'strict').checks_executed) / full) : '-',
      ];
    }),
  ));
  P();
  const totalChecks = (c: string) => sum(benches.map((b) => num(get(dyn, b, c).checks_executed)));
  const totalGuards = (c: string) => sum(benches.map((b) => num(get(dyn, b, c).guards_executed)));
  const totalCost = (c: string) => totalChecks(c) + totalGuards(c);
  const fullTotal = totalChecks('full');
  const codeSize = (c: string) => sum(benches.map((b) => num(get(st, b, c).code_size)));
  P(`Summed over all kernels (${fullTotal} checks under full):`);
  P();
  P(table(
    ['config', 'checks executed', 'guard evaluations', 'checks + guards', 'checks + guards (% of full)', 'checks only (% of full, A3 accounting)', 'code size (sum, bytes)'],
    MAIN_CONFIGS.map((c) => [c, totalChecks(c), totalGuards(c), totalCost(c), pct(totalCost(c) / fullTotal), pct(totalChecks(c) / fullTotal), codeSize(c)]),
  ));
  P();

  // ---- coverage
  P('## Coverage');
  P();
  P('protected(site) = proven, hoisted or retained. coverage = protected / all sites; coverage_ext_write = protected external-index writes / all external-index writes (static, summed over kernels).');
  P();
  const covOf = (c: string) => {
    const rows = benches.map((b) => get(st, b, c));
    return {
      cov: sum(rows.map((r) => num(r.protected))) / sum(rows.map((r) => num(r.sites))),
      ew: sum(rows.map((r) => num(r.ext_write_protected))) / sum(rows.map((r) => num(r.ext_write_sites))),
      ewSites: sum(rows.map((r) => num(r.ext_write_sites))),
    };
  };
  P(table(
    ['config', 'coverage', 'coverage_ext_write', 'checks + guards (% of full)', 'checks only (% of full, A3 accounting)', 'code size (sum, bytes)'],
    MAIN_CONFIGS.map((c) => [c, fx(covOf(c).cov), fx(covOf(c).ew), pct(totalCost(c) / fullTotal), pct(totalChecks(c) / fullTotal), codeSize(c)]),
  ));
  P();
  P(`There are ${covOf('full').ewSites} external-index write sites in total, in: ${benches.filter((b) => num(get(st, b, 'full').ext_write_sites) > 0).join(', ')}.`);
  P();

  // ---- security
  P('## Security: bug corpus');
  P();
  const bugs = [...new Set(sec.map((r) => r.bug))];
  P(`${bugs.length} programs in \`bench/bugs/\`, one injected out-of-bounds bug each (ground truth in \`bench/bugs/manifest.json\`). Each array is surrounded by 16-byte sentinel gaps. Outcomes: **detected** (trap at the manifest's check), **silent_corruption** (no trap, a sentinel changed), **missed_benign** (no trap, sentinels intact: an out-of-bounds read, or a write that stayed inside the gap pattern), **other_trap**.`);
  P();
  const outcomeShort: Record<string, string> = { detected: 'D', silent_corruption: 'C', missed_benign: 'm', other_trap: 'T', other_trap_after_corruption: 'TC' };
  P(table(
    ['bug', 'access', 'index', ...MAIN_CONFIGS],
    bugs.map((g) => {
      const r0 = sec.find((r) => r.bug === g)!;
      return [g, r0.access, r0.index, ...MAIN_CONFIGS.map((c) => outcomeShort[sec.find((r) => r.bug === g && r.config === c)!.outcome])];
    }),
  ));
  P();
  P('D = detected, C = silent corruption, m = missed (benign), T = trapped elsewhere, TC = trapped elsewhere after corrupting.');
  P();
  const secSummary = (c: string) => {
    const rows = sec.filter((r) => r.config === c);
    const n = (o: string) => rows.filter((r) => r.outcome === o).length;
    return { det: n('detected'), cor: n('silent_corruption') + n('other_trap_after_corruption'), ben: n('missed_benign'), oth: n('other_trap'), total: rows.length };
  };
  P(table(['config', 'detected', 'silent corruption', 'missed (benign)', 'other trap'], MAIN_CONFIGS.map((c) => {
    const s = secSummary(c);
    return [c, `${s.det}/${s.total}`, s.cor, s.ben, s.oth];
  })));
  P();
  const fullSec = secSummary('full');
  P(fullSec.det === fullSec.total
    ? `Under \`full\` every bug program is detected at its manifest check (${fullSec.det}/${fullSec.total}), confirming the manifest.`
    : `**Under \`full\` only ${fullSec.det}/${fullSec.total} bug programs are detected at the manifest check; the manifest does not match.**`);
  P();

  // ---- pareto
  P('## Overhead vs. protection (Pareto)');
  P();
  const configPts: Point[] = MAIN_CONFIGS.map((c) => ({ label: c, x: totalCost(c) / fullTotal, y: covOf(c).ew, kind: 'config' }));
  const sweepPts: Point[] = TAUS.map((t) => {
    const rows = sweep.filter((r) => num(r.tau) === t);
    return {
      label: `tau=${t}`,
      x: sum(rows.map((r) => num(r.checks_executed) + num(r.guards_executed))) / sum(rows.map((r) => num(r.checks_full))),
      y: sum(rows.map((r) => num(r.ext_write_protected))) / sum(rows.map((r) => num(r.ext_write_sites))),
      kind: 'sweep',
    };
  });
  const benchPts: Point[] = [];
  for (const b of benches) {
    const full = num(get(dyn, b, 'full').checks_executed);
    for (const c of MAIN_CONFIGS) {
      const s = get(st, b, c);
      if (num(s.ext_write_sites) === 0 || full === 0) continue;
      benchPts.push({ label: `${b} ${c}`, x: cost(b, c) / full, y: num(s.coverage_ext_write), kind: 'bench' });
    }
  }
  fs.writeFileSync(path.join(dir, 'pareto.svg'), svgPlot('Checks + guards executed vs. external-write coverage', 'coverage_ext_write', [...benchPts, ...configPts], sweepPts));
  const secPts: Point[] = MAIN_CONFIGS.map((c) => ({ label: c, x: totalCost(c) / fullTotal, y: secSummary(c).det / secSummary(c).total, kind: 'config' }));
  const secSweep: Point[] = TAUS.map((t, k) => {
    const rows = sec.filter((r) => r.config === `threshold:${t}`);
    return { label: `tau=${t}`, x: sweepPts[k].x, y: rows.filter((r) => r.outcome === 'detected').length / rows.length, kind: 'sweep' };
  });
  fs.writeFileSync(path.join(dir, 'pareto_security.svg'), svgPlot('Checks + guards executed vs. bugs detected', 'bug programs detected (fraction)', secPts, secSweep));

  P('![Pareto: checks + guards executed vs. coverage_ext_write](pareto.svg)');
  P();
  P('x: checks + guard evaluations summed over all kernels, as a fraction of the checks `full` executes; y: coverage_ext_write. Squares: the main configurations (red = not dominated by another configuration); blue line: `threshold:tau` for tau = 0, 0.05, ..., 1; grey dots: individual kernels with at least one external-index write.');
  P();
  const describeFront = (pts: Point[], what: string) => {
    const front = paretoFront(pts);
    const lines: string[] = [];
    lines.push(`Non-dominated configurations (${what}): ${front.map((p) => `\`${p.label}\``).join(', ')}.`);
    const adaptive = ['balanced', 'performance', 'budget:0.25', 'budget:0.5'];
    for (const a of adaptive) {
      const pa = pts.find((p) => p.label === a)!;
      const dominators = pts.filter((q) => q !== pa && q.x <= pa.x && q.y >= pa.y && (q.x < pa.x || q.y > pa.y)).map((q) => `\`${q.label}\``);
      const vs = ['proof', 'chuang'].map((base) => {
        const pb = pts.find((p) => p.label === base)!;
        return `vs \`${base}\`: ${pct(pa.x, 1)} vs ${pct(pb.x, 1)} checks+guards, ${fx(pa.y)} vs ${fx(pb.y)}`;
      });
      lines.push(`- \`${a}\`: ${dominators.length ? `dominated by ${dominators.join(', ')}` : 'not dominated'}; ${vs.join('; ')}.`);
    }
    return lines.join('\n');
  };
  P(describeFront(configPts, 'checks + guards vs. coverage_ext_write'));
  P();
  P('![Pareto: checks + guards executed vs. bugs detected](pareto_security.svg)');
  P();
  P(describeFront(secPts, 'checks + guards vs. fraction of bug programs detected'));
  P();

  // ---- tau sweep
  P('## Threshold sweep');
  P();
  P(table(
    ['tau', 'checks + guards (% of full)', 'checks only (A3 accounting)', 'sites omitted', 'coverage', 'coverage_ext_write', 'bugs detected', 'bugs with silent corruption'],
    TAUS.map((t, k) => {
      const rows = sweep.filter((r) => num(r.tau) === t);
      const srows = sec.filter((r) => r.config === `threshold:${t}`);
      return [
        t.toFixed(2),
        pct(sweepPts[k].x),
        pct(sum(rows.map((r) => num(r.checks_executed))) / sum(rows.map((r) => num(r.checks_full)))),
        sum(rows.map((r) => num(r.omitted))),
        fx(sum(rows.map((r) => num(r.protected))) / sum(rows.map((r) => num(r.sites)))),
        fx(sweepPts[k].y),
        `${srows.filter((r) => r.outcome === 'detected').length}/${srows.length}`,
        srows.filter((r) => r.outcome === 'silent_corruption' || r.outcome === 'other_trap_after_corruption').length,
      ];
    }),
  ));
  P();

  // ---- runtime
  P('## Runtime');
  P();
  const tm = (pass: number, b: string, c: string) => timing.find((r) => num(r.pass) === pass && r.bench === b && r.config === c)!;
  const passes = [...new Set(timing.map((r) => num(r.pass)))].sort();
  const noise = new Map<string, number>();
  for (const b of benches) {
    let worst = 0;
    for (const c of MAIN_CONFIGS) {
      const ms = passes.map((p) => num(tm(p, b, c).median_ms));
      const rel = (Math.max(...ms) - Math.min(...ms)) / (sum(ms) / ms.length);
      worst = Math.max(worst, rel);
    }
    noise.set(b, worst);
  }
  P(`Median and interquartile range (ms) of ${env.timed} timed calls, pass 1. "noise" is the largest relative difference between the pass-${passes.join('/pass-')} medians of the same kernel and configuration (over all configurations of that kernel). A difference between two configurations is reported as a result only if it exceeds that kernel's noise.`);
  P();
  const timeCols = ['none', 'full', 'proof', 'strict', 'balanced', 'chuang'];
  P(table(
    ['benchmark', ...timeCols.map((c) => `${c} median (IQR)`), 'noise'],
    benches.map((b) => [b, ...timeCols.map((c) => {
      const r = tm(1, b, c);
      return `${fx(num(r.median_ms), 3)} (${fx(num(r.q3_ms) - num(r.q1_ms), 3)})`;
    }), pct(noise.get(b)!)]),
  ));
  P();
  const noiseVals = [...noise.values()].sort((a, b) => a - b);
  P(`Run-to-run noise over kernels: median ${pct(noiseVals[Math.floor(noiseVals.length / 2)])}, max ${pct(noiseVals[noiseVals.length - 1])}.`);
  P();
  P('Overhead relative to `none` (pass-1 medians), and whether each configuration differs from `proof` by more than the kernel\'s noise:');
  P();
  const ovCols = ['full', 'proof', 'strict', 'balanced', 'performance', 'budget:0.25', 'budget:0.5', 'chuang'];
  let beyond = 0;
  let comparisons = 0;
  const beyondList: string[] = [];
  P(table(
    ['benchmark', ...ovCols],
    benches.map((b) => {
      const none = num(tm(1, b, 'none').median_ms);
      const proof = num(tm(1, b, 'proof').median_ms);
      return [b, ...ovCols.map((c) => {
        const m = num(tm(1, b, c).median_ms);
        let mark = '';
        if (c !== 'proof') {
          comparisons++;
          const rel = (m - proof) / proof;
          if (Math.abs(rel) > noise.get(b)!) {
            beyond++;
            mark = rel < 0 ? ' (faster than proof)' : ' (slower than proof)';
            beyondList.push(`${b}/${c} ${rel < 0 ? 'faster' : 'slower'} than proof by ${pct(Math.abs(rel))} (noise ${pct(noise.get(b)!)})`);
          }
        }
        return `${pct(m / none - 1)}${mark}`;
      })];
    }),
  ));
  P();
  P(`${beyond} of ${comparisons} configuration-vs-proof runtime differences exceed the kernel's run-to-run noise${beyond ? ': ' + beyondList.join('; ') : ''}. All other runtime differences are within noise and are not claimed as results.`);
  P();

  // ---- ablation
  P('## Weight ablation (sensitivity, not tuning)');
  P();
  P(`\`threshold:${ABLATION_TAU}\` with each weight set to zero in turn. The kernels were split into a tuning half and a held-out half before any results existed (\`eval/benchmarks.ts\`); the default weights were not changed in response to this table.`);
  P();
  for (const split of ['heldout', 'tuning']) {
    const names = BENCHMARKS.filter((b) => b.split === split).map((b) => b.name);
    P(`**${split === 'heldout' ? 'Held-out' : 'Tuning'} kernels** (${names.join(', ')}):`);
    P();
    P(table(
      ['weights', 'checks executed (% of full)', 'sites omitted', 'coverage_ext_write'],
      ABLATIONS.map((a) => {
        const rows = abl.filter((r) => r.variant === a.name && names.includes(r.bench));
        const ew = sum(rows.map((r) => num(r.ext_write_sites)));
        return [
          `${a.name} (wP=${a.weights.wP}, wC=${a.weights.wC}, wW=${a.weights.wW})`,
          pct(sum(rows.map((r) => num(r.checks_executed))) / sum(rows.map((r) => num(r.checks_full)))),
          sum(rows.map((r) => num(r.omitted))),
          ew ? fx(sum(rows.map((r) => num(r.ext_write_protected))) / ew) : 'n/a (no ext. writes)',
        ];
      }),
    ));
    P();
  }

  P('## Caveats');
  P();
  P('- Kernels are NovaCraft ports written for this project, small and few; they are not PolyBench and results may not transfer.');
  P('- Coverage metrics are static (sites), not weighted by execution frequency.');
  P('- The bug corpus is hand-written, one bug per program, with one triggering input each.');
  P('- `chuang` is an approximation of Chuang et al. 2007 (writes kept, reads dropped), not a reimplementation.');
  P('- Runtime is measured on V8 only, on one machine, in one process.');
  P();
  return out.join('\n');
}

if (require.main === module) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'results');
  fs.writeFileSync(path.join(dir, 'RESULTS.md'), generateReport(dir));
  console.log(`wrote ${path.join(dir, 'RESULTS.md')}`);
}
