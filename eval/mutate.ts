// Mutation corpus generator (milestone A3b, docs/PREREGISTRATION.md).
//
// For each of the 16 kernels in bench/: apply every mutation operator at
// every applicable site of the entry function (one mutation per variant),
// print each variant back to source, compile it under --harden=full, run it
// on the kernel's 200 seeded fuzzed inputs, and keep it only if some input
// traps at a bounds check or changes a sentinel. Writes
// results/mutation/corpus.json, corpus.csv and variants/*.min.
//
//   npx ts-node eval/mutate.ts
import * as fs from 'fs';
import * as path from 'path';
import { Lexer } from '../src/lexer';
import { Parser } from '../src/parser';
import { ErrorReporter } from '../src/errors';
import { BENCHMARKS } from './benchmarks';
import { fuzzInputs } from './mutation/inputs';
import { buildSource, runInput } from './mutation/execm';
import { apply, enumerate, fnInfo, Mutation } from './mutation/operators';
import { printProgram } from './mutation/printer';

export const MIN_KEPT = 300;
export const FALLBACK_ORDER = ['if-lt-to-le', 'index-is-length', 'minus-one-drop'];

export interface Variant {
  id: string;
  kernel: string;
  fn: string;
  operator: string;
  line: number;
  column: number;
  detail: string;
  status: 'kept' | 'not_triggerable' | 'not_compilable' | 'duplicate';
  triggering: number[]; // indices of the kernel's fuzzed inputs that trigger under full
  fullFuel: number; // inputs on which the full build ran out of fuel
}

function parse(source: string) {
  const r = new ErrorReporter();
  const p = new Parser(new Lexer(source, r).tokenize(), r).parseProgram();
  if (r.hasErrors()) throw new Error(r.all().map((e) => e.message).join('\n'));
  return p;
}

export async function checkOriginals(log: (s: string) => void): Promise<void> {
  for (const b of BENCHMARKS) {
    const built = await buildSource(fs.readFileSync(b.file, 'utf-8'), 'full');
    const bad = fuzzInputs(b.name)
      .map((args, k) => ({ k, o: runInput(built, b.fn, args) }))
      .filter(({ o }) => o.cls !== 'missed_benign');
    if (bad.length) throw new Error(`${b.name}: original kernel misbehaves on fuzzed input(s) ${bad.map((x) => `${x.k}:${x.o.cls}/${x.o.detail}`).join(', ')}`);
    log(`original ${b.name}: 200/200 inputs clean under full`);
  }
}

async function evaluateMutations(
  kernel: (typeof BENCHMARKS)[number],
  muts: Mutation[],
  seen: Set<string>,
  counter: { n: number },
  outDir: string,
): Promise<Variant[]> {
  const original = parse(fs.readFileSync(kernel.file, 'utf-8'));
  const inputs = fuzzInputs(kernel.name);
  const out: Variant[] = [];
  for (const m of muts) {
    const id = `${kernel.name}-${String(counter.n++).padStart(3, '0')}`;
    const v: Variant = { id, kernel: kernel.name, fn: kernel.fn, operator: m.operator, line: m.line, column: m.column, detail: m.detail, status: 'kept', triggering: [], fullFuel: 0 };
    const source = `// mutation ${id}: ${m.operator} at ${m.line}:${m.column} (${m.detail})\n` + printProgram(apply(original, kernel.fn, m));
    const body = source.slice(source.indexOf('\n') + 1);
    if (seen.has(body)) {
      v.status = 'duplicate';
      out.push(v);
      continue;
    }
    seen.add(body);
    fs.writeFileSync(path.join(outDir, `${id}.min`), source);
    let built;
    try {
      built = await buildSource(source, 'full');
    } catch {
      v.status = 'not_compilable';
      out.push(v);
      continue;
    }
    inputs.forEach((args, k) => {
      const o = runInput(built, kernel.fn, args);
      if (o.cls === 'detected' || o.cls === 'silent_corruption') v.triggering.push(k);
      if (o.detail === 'fuel') v.fullFuel++;
    });
    v.status = v.triggering.length ? 'kept' : 'not_triggerable';
    out.push(v);
  }
  return out;
}

export async function generateCorpus(outRoot: string, log: (s: string) => void): Promise<Variant[]> {
  const vdir = path.join(outRoot, 'variants');
  fs.rmSync(vdir, { recursive: true, force: true });
  fs.mkdirSync(vdir, { recursive: true });
  await checkOriginals(log);

  const all: Variant[] = [];
  const state = new Map(BENCHMARKS.map((b) => [b.name, { seen: new Set<string>([printProgram(parse(fs.readFileSync(b.file, 'utf-8')))]), counter: { n: 0 } }]));
  for (const b of BENCHMARKS) {
    const info = fnInfo(parse(fs.readFileSync(b.file, 'utf-8')).functions.find((f) => f.name === b.fn)!);
    const s = state.get(b.name)!;
    const vs = await evaluateMutations(b, enumerate(info), s.seen, s.counter, vdir);
    all.push(...vs);
    log(`${b.name}: ${vs.length} variants, ${vs.filter((v) => v.status === 'kept').length} kept`);
  }

  // Preregistered fallback operators, in order, only while fewer than
  // MIN_KEPT variants are kept.
  for (const op of FALLBACK_ORDER) {
    if (all.filter((v) => v.status === 'kept').length >= MIN_KEPT) break;
    log(`fewer than ${MIN_KEPT} kept: adding fallback operator ${op}`);
    for (const b of BENCHMARKS) {
      const info = fnInfo(parse(fs.readFileSync(b.file, 'utf-8')).functions.find((f) => f.name === b.fn)!);
      const muts = enumerate(info, { fallback: [op] }).filter((m) => m.operator === op);
      const s = state.get(b.name)!;
      all.push(...(await evaluateMutations(b, muts, s.seen, s.counter, vdir)));
    }
  }

  fs.writeFileSync(path.join(outRoot, 'corpus.json'), JSON.stringify(all, null, 1) + '\n');
  const cols = ['id', 'kernel', 'operator', 'line', 'column', 'detail', 'status', 'triggering_inputs', 'full_fuel_exhausted'];
  const esc = (x: string | number) => (/[",]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
  fs.writeFileSync(
    path.join(outRoot, 'corpus.csv'),
    [cols.join(','), ...all.map((v) => [v.id, v.kernel, v.operator, v.line, v.column, v.detail, v.status, v.triggering.length, v.fullFuel].map(esc).join(','))].join('\n') + '\n',
  );
  return all;
}

if (require.main === module) {
  const out = path.join(__dirname, '..', 'results', 'mutation');
  fs.mkdirSync(out, { recursive: true });
  generateCorpus(out, (s) => console.log(s)).then(
    (all) => {
      const n = (st: string) => all.filter((v) => v.status === st).length;
      console.log(`generated ${all.length}: kept ${n('kept')}, not triggerable ${n('not_triggerable')}, not compilable ${n('not_compilable')}, duplicate ${n('duplicate')}`);
    },
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
