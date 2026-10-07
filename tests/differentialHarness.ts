// Differential execution harness for the bounds-check elimination audit.
//
// Compiles one program twice -- with range analysis (`proof`) and without it
// (`full`, the `--no-bounds-elim` path) -- and runs every exported function
// of both builds on the same fuzzed inputs. The observable outcome of a run
// is: the return value or the trap (kind + side-channel check id, index,
// length), the printed values, and the final contents of linear memory.
// Removing a check is sound only if every outcome is identical.
import * as fs from 'fs';
import * as path from 'path';
import wabtInit from 'wabt';
import { compileProgram, CompileResult } from '../src/compile';
import { IRFunction } from '../src/ir';
import { Worker } from 'worker_threads';
import { TRAP_INDEX_OFFSET, TRAP_LENGTH_OFFSET, TRAP_CHECK_ID_OFFSET } from '../src/stackFrame';

export const INT_MAX = 2147483647;
export const INT_MIN = -2147483648;

// Arrays are placed in the low reserved region (below the trap side channel
// at 4096), ARRAY_STRIDE bytes apart, like the CLI's --run driver does.
const ARRAY_BASE = 0;
const ARRAY_STRIDE = 512;
const MAX_ARRAY_LEN = 24;

export interface Outcome {
  kind: 'ok' | 'trap' | 'host-error';
  result?: number;
  trap?: string;
  checkId?: number;
  index?: number;
  length?: number;
  printed: number[];
  memoryHash: string;
}

export interface CaseResult {
  fn: string;
  args: number[];
  arrays: number[][];
  full: Outcome;
  proof: Outcome;
}

// Small deterministic PRNG (mulberry32) so the fuzz cases are reproducible.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

let wabtPromise: ReturnType<typeof wabtInit> | null = null;
async function toBinary(wat: string): Promise<Uint8Array> {
  if (!wabtPromise) wabtPromise = wabtInit();
  const wabt = await wabtPromise;
  const parsed = wabt.parseWat('fuzz.wat', wat, { mutable_globals: true });
  parsed.resolveNames();
  parsed.validate();
  const { buffer } = parsed.toBinary({});
  parsed.destroy();
  return buffer;
}

// Runs cases in a worker thread so that a run which does not finish within
// its time budget (a fuzzed INT_MAX loop bound over a loop that never
// touches memory) can be killed. Killing the worker loses its compiled
// modules, so they are re-sent to the replacement worker.
class Runner {
  private worker: Worker | null = null;
  private modules = new Map<string, Uint8Array>();
  private nextId = 0;

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(path.join(__dirname, 'fuzzWorker.js'));
      for (const [key, bytes] of this.modules) this.worker.postMessage({ type: 'load', key, bytes });
    }
    return this.worker;
  }

  load(key: string, bytes: Uint8Array): void {
    this.modules.set(key, bytes);
    if (this.worker) this.worker.postMessage({ type: 'load', key, bytes });
  }

  run(key: string, fn: string, args: number[], arrays: number[][], timeoutMs: number): Promise<Outcome | 'timeout'> {
    const w = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        w.removeListener('message', onMsg);
        w.removeListener('error', onErr);
      };
      const timer = setTimeout(() => {
        cleanup();
        w.terminate();
        this.worker = null;
        resolve('timeout');
      }, timeoutMs);
      const onMsg = (msg: { id: number; outcome: Outcome }) => {
        if (msg.id !== id) return;
        cleanup();
        resolve(msg.outcome);
      };
      const onErr = (e: Error) => {
        cleanup();
        reject(e);
      };
      w.on('message', onMsg);
      w.on('error', onErr);
      w.postMessage({
        id,
        key,
        fn,
        args,
        arrays,
        arrayBase: ARRAY_BASE,
        arrayStride: ARRAY_STRIDE,
        trapOffsets: { index: TRAP_INDEX_OFFSET, length: TRAP_LENGTH_OFFSET, checkId: TRAP_CHECK_ID_OFFSET },
      });
    });
  }

  async close(): Promise<void> {
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  }
}

const SCALARS = [0, 1, -1, 2, 3, 4, 5, 7, 10, -2, INT_MAX, INT_MIN, INT_MAX - 1, INT_MIN + 1];
const ELEMS = [0, 1, -1, 2, 3, 5, 8, 100, -100, INT_MAX, INT_MIN];

// Builds one fuzzed argument vector for `fn`. Array parameters get a real
// array of random length; their adjacent length parameter is chosen to be
// sometimes the true length and sometimes shorter, longer, or extreme.
export function fuzzArgs(fn: IRFunction, r: () => number): { args: number[]; arrays: number[][] } {
  const arrays: number[][] = [];
  const arrayIndex = new Map<string, number>();
  for (const p of fn.params) {
    if (p.isArray) {
      const n = Math.floor(r() * (MAX_ARRAY_LEN + 1));
      const data = Array.from({ length: n }, () => (r() < 0.7 ? Math.floor(r() * 21) - 5 : pick(r, ELEMS)));
      arrayIndex.set(p.name, arrays.length);
      arrays.push(data);
    }
  }
  const lengthOf = new Map<string, number>();
  for (const [arr, lenParam] of fn.arrayLength) {
    const k = arrayIndex.get(arr);
    if (k !== undefined) lengthOf.set(lenParam, arrays[k].length);
  }
  const args = fn.params.map((p) => {
    if (p.isArray) return ARRAY_BASE + arrayIndex.get(p.name)! * ARRAY_STRIDE;
    if (p.type === 'float') return pick(r, [0, 1.5, -2.25, 1e9, -1e9]);
    if (p.type === 'bool') return r() < 0.5 ? 0 : 1;
    const actual = lengthOf.get(p.name);
    if (actual !== undefined) {
      return pick(r, [actual, actual, actual, actual - 1, actual + 1, 0, 1, -1, 2 * actual + 3, INT_MAX, INT_MIN]);
    }
    return r() < 0.6 ? pick(r, SCALARS) : Math.floor(r() * 41) - 10;
  });
  return { args, arrays };
}

export interface DiffReport {
  program: string;
  cases: number;
  // Cases where the full-check build itself did not finish within the time
  // budget; they are inconclusive and not compared.
  timeouts: number;
  mismatches: CaseResult[];
  compileError?: string;
}

export interface DiffOptions {
  casesPerFn: number;
  // Overrides how the `proof` build is compiled (used to check that the
  // fuzzer actually detects a deliberately unsound elimination).
  compileProof?: (source: string) => CompileResult;
  seed?: number;
  timeoutMs?: number;
}

export async function differential(file: string, opts: DiffOptions): Promise<DiffReport> {
  const source = fs.readFileSync(file, 'utf-8');
  const program = path.basename(file);
  const timeoutMs = opts.timeoutMs ?? 400;
  let fullC, proofC;
  try {
    fullC = compileProgram(source, { skipRangeAnalysis: true });
    proofC = opts.compileProof ? opts.compileProof(source) : compileProgram(source, {});
  } catch (e) {
    return { program, cases: 0, timeouts: 0, mismatches: [], compileError: String(e) };
  }
  const runner = new Runner();
  try {
    try {
      runner.load('full', await toBinary(fullC.codegen.wat));
      runner.load('proof', await toBinary(proofC.codegen.wat));
    } catch (e) {
      return { program, cases: 0, timeouts: 0, mismatches: [], compileError: `wasm assembly failed: ${String(e)}` };
    }

    const r = rng(opts.seed ?? 1);
    const mismatches: CaseResult[] = [];
    let cases = 0;
    let timeouts = 0;
    for (const fn of fullC.finalIR.functions) {
      const n = fn.params.length === 0 ? 1 : opts.casesPerFn;
      for (let c = 0; c < n; c++) {
        const { args, arrays } = fuzzArgs(fn, r);
        const t0 = Date.now();
        const full = await runner.run('full', fn.name, args, arrays, timeoutMs);
        if (full === 'timeout') {
          timeouts++;
          continue;
        }
        // The proof build must finish too; give it ample slack over the
        // full build's time so a slow machine does not produce a mismatch.
        const proofBudget = Math.max(timeoutMs, 10 * (Date.now() - t0) + 200);
        const proofRun = await runner.run('proof', fn.name, args, arrays, proofBudget);
        const proof: Outcome =
          proofRun === 'timeout' ? { kind: 'host-error', trap: 'timeout', printed: [], memoryHash: '' } : proofRun;
        cases++;
        if (JSON.stringify(full) !== JSON.stringify(proof)) {
          mismatches.push({ fn: fn.name, args, arrays, full, proof });
        }
      }
    }
    return { program, cases, timeouts, mismatches };
  } finally {
    await runner.close();
  }
}

export function listPrograms(): string[] {
  const root = path.join(__dirname, '..');
  const dirs = [path.join(root, 'examples'), path.join(__dirname, 'fixtures', 'soundness')];
  const out: string[] = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(d).sort()) if (f.endsWith('.min')) out.push(path.join(d, f));
  }
  return out;
}
