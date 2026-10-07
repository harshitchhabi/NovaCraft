// Mutation-corpus evaluation (milestone A3b, docs/PREREGISTRATION.md).
//
// Reads results/mutation/corpus.json (eval/mutate.ts), runs every kept
// variant under every frozen configuration on its triggering inputs, and
// measures each configuration's cost on the unmutated kernels. Writes raw
// CSVs into the given output directory:
//   cost.csv      kernel, config, checks, guards, full_checks
//   outcomes.csv  variant x config: per-input outcome counts, primary and
//                 secondary detection, silent corruption, and a digest of
//                 the per-input outcome and check-id sequence
//   silent.csv    silent-corruption runs grouped by (variant, config, site
//                 that fired under full on that input), with this config's
//                 decision for that site and the number of inputs
//
//   npx ts-node eval/mutation/evaluate.ts <outDir>
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BENCHMARKS } from '../benchmarks';
import { place } from '../layout';
import { Variant } from '../mutate';
import { fuzzInputs } from './inputs';
import { buildSource, MBuilt, MOutcome, runInput } from './execm';

const ROOT = path.join(__dirname, '..', '..');
export const MAIN = ['none', 'full', 'proof', 'strict', 'balanced', 'performance', 'budget:0.25', 'budget:0.5', 'chuang'];
const steps = Array.from({ length: 21 }, (_, k) => Math.round(k * 5) / 100);
export const TAU_SWEEP = steps.map((t) => `threshold:${t}`);
export const BUDGET_SWEEP = steps.map((f) => `budget:${f}`);
export const CONFIGS = [...new Set([...MAIN, ...TAU_SWEEP, ...BUDGET_SWEEP])];

type Row = Record<string, string | number>;

function csv(rows: Row[]): string {
  const cols = Object.keys(rows[0]);
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

async function measureCost(log: (s: string) => void): Promise<Row[]> {
  const rows: Row[] = [];
  for (const b of BENCHMARKS) {
    log(`cost: ${b.name}`);
    const source = fs.readFileSync(b.file, 'utf-8');
    const args = b.args(1);
    const counts = async (config: string) => {
      const built = await buildSource(source, config, true);
      const inst = new WebAssembly.Instance(built.module, { env: { print: () => undefined } });
      const memory = inst.exports.memory as WebAssembly.Memory;
      const arrays = args.filter((a): a is { array: number[] } => typeof a !== 'number').map((a) => a.array);
      const p = place(memory, arrays);
      let k = 0;
      (inst.exports[b.fn] as (...x: number[]) => number)(...args.map((a) => (typeof a === 'number' ? a : p.addresses[k++])));
      return {
        checks: (inst.exports.checkCount as WebAssembly.Global).value as number,
        guards: (inst.exports.guardCount as WebAssembly.Global).value as number,
      };
    };
    const full = (await counts('full')).checks;
    for (const c of CONFIGS) {
      const { checks, guards } = await counts(c);
      rows.push({ kernel: b.name, config: c, checks, guards, full_checks: full });
    }
  }
  return rows;
}

export async function evaluateCorpus(outDir: string, log: (s: string) => void): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const corpus: Variant[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', 'mutation', 'corpus.json'), 'utf-8'));
  const kept = corpus.filter((v) => v.status === 'kept');

  fs.writeFileSync(path.join(outDir, 'cost.csv'), csv(await measureCost(log)));

  const outcomeRows: Row[] = [];
  const silentRows: Row[] = [];
  const inputsByKernel = new Map<string, ReturnType<typeof fuzzInputs>>();
  for (const v of kept) {
    if (!inputsByKernel.has(v.kernel)) inputsByKernel.set(v.kernel, fuzzInputs(v.kernel));
    const inputs = inputsByKernel.get(v.kernel)!;
    const source = fs.readFileSync(path.join(ROOT, 'results', 'mutation', 'variants', `${v.id}.min`), 'utf-8');
    const cache = new Map<string, MOutcome[]>(); // identical wasm => identical outcomes
    let fullOutcomes: MOutcome[] | null = null;
    // `full` first: silent corruption is attributed to the check that fired
    // under full on the same input.
    for (const config of ['full', ...CONFIGS.filter((c) => c !== 'full')]) {
      const built: MBuilt = await buildSource(source, config);
      let outs = cache.get(built.key);
      if (!outs) {
        outs = v.triggering.map((k) => runInput(built, v.fn, inputs[k]));
        cache.set(built.key, outs);
      }
      if (config === 'full') fullOutcomes = outs;
      const n = (c: string) => outs!.filter((o) => o.cls === c).length;
      const digest = createHash('sha1')
        .update(outs.map((o) => `${o.cls}:${o.checkId ?? ''}`).join('|'))
        .digest('hex')
        .slice(0, 16);
      outcomeRows.push({
        variant: v.id,
        kernel: v.kernel,
        operator: v.operator,
        config,
        triggering: outs.length,
        detected: n('detected'),
        silent_corruption: n('silent_corruption'),
        missed_benign: n('missed_benign'),
        other: n('other'),
        detected_all: n('detected') === outs.length ? 1 : 0,
        detected_any: n('detected') > 0 ? 1 : 0,
        silent_any: n('silent_corruption') > 0 ? 1 : 0,
        digest,
      });
      if (config !== 'full' && fullOutcomes) {
        // One row per (variant, config, site that fired under full), with
        // the number of triggering inputs on which it silently corrupted.
        const bySite = new Map<string, { fired: number | null; inputs: number[] }>();
        outs.forEach((o, j) => {
          if (o.cls !== 'silent_corruption') return;
          const fired = fullOutcomes![j].checkId;
          const key = String(fired);
          if (!bySite.has(key)) bySite.set(key, { fired, inputs: [] });
          bySite.get(key)!.inputs.push(v.triggering[j]);
        });
        for (const { fired, inputs: ins } of bySite.values()) {
          const site = built.compiled.hardening.sites.find((x) => x.id === fired);
          silentRows.push({
            variant: v.id,
            kernel: v.kernel,
            operator: v.operator,
            config,
            full_check_id: fired ?? '',
            line: site?.line ?? '',
            column: site?.column ?? '',
            access: site?.access ?? '',
            P: site?.P ?? '',
            C: site?.C ?? '',
            W: site?.W ?? '',
            R: site?.R ?? '',
            decision: site?.decision ?? '',
            inputs: ins.length,
            first_input: ins[0],
            // Secondary attribution: the write sites this config omits in
            // this variant (the corrupting write is among them when the
            // site that fired first under full is a read).
            omitted_writes: built.compiled.hardening.sites
              .filter((x) => x.access === 'write' && x.decision === 'omit')
              .map((x) => `${x.line}:${x.column}`)
              .join(' '),
          });
        }
      }
    }
    log(`evaluated ${v.id}`);
  }
  fs.writeFileSync(path.join(outDir, 'outcomes.csv'), csv(outcomeRows));
  fs.writeFileSync(path.join(outDir, 'silent.csv'), silentRows.length ? csv(silentRows) : 'variant\n');
}

if (require.main === module) {
  const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'results', 'mutation', 'raw'));
  evaluateCorpus(out, () => undefined).then(
    () => console.log(`wrote ${out}`),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
