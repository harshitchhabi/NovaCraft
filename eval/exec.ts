// Compiling and running NovaCraft programs for the evaluation.
import * as fs from 'fs';
import wabtInit from 'wabt';
import { compileProgram, CompileResult } from '../src/compile';
import { RiskWeights } from '../src/harden/config';
import { TRAP_CHECK_ID_OFFSET, TRAP_INDEX_OFFSET, TRAP_LENGTH_OFFSET } from '../src/stackFrame';
import { place, Placement, readArrays, rewrite, sentinelsIntact } from './layout';

// An argument: an int, or an array (placed in memory; the argument is its
// address). Length parameters are explicit ints.
export type Arg = number | { array: number[] };

export interface Built {
  compiled: CompileResult;
  module: WebAssembly.Module;
  codeSize: number; // bytes of the wasm binary
}

let wabt: Awaited<ReturnType<typeof wabtInit>> | null = null;

export async function build(file: string, policy: string, opts: { countChecks?: boolean; weights?: RiskWeights } = {}): Promise<Built> {
  if (!wabt) wabt = await wabtInit();
  const compiled = compileProgram(fs.readFileSync(file, 'utf-8'), { harden: policy, ...opts });
  const parsed = wabt.parseWat(file, compiled.codegen.wat, { mutable_globals: true });
  parsed.resolveNames();
  parsed.validate();
  const { buffer } = parsed.toBinary({});
  parsed.destroy();
  const bytes = buffer as Uint8Array<ArrayBuffer>;
  return { compiled, module: new WebAssembly.Module(bytes), codeSize: bytes.length };
}

export interface Instance {
  call: () => number;
  reset: () => void; // rewrite the input arrays
  memory: WebAssembly.Memory;
  placement: Placement;
  checkCount: () => number;
  guardCount: () => number;
  arrays: () => number[][];
}

export function instantiate(b: Built, fn: string, args: Arg[]): Instance {
  const inst = new WebAssembly.Instance(b.module, { env: { print: () => undefined } });
  const memory = inst.exports.memory as WebAssembly.Memory;
  const arrays = args.filter((a): a is { array: number[] } => typeof a !== 'number').map((a) => a.array);
  const placement = place(memory, arrays);
  let k = 0;
  const argv = args.map((a) => (typeof a === 'number' ? a : placement.addresses[k++]));
  const f = inst.exports[fn] as (...x: number[]) => number;
  if (typeof f !== 'function') throw new Error(`no function ${fn}`);
  const counter = inst.exports.checkCount as WebAssembly.Global | undefined;
  const guards = inst.exports.guardCount as WebAssembly.Global | undefined;
  return {
    call: () => f(...argv),
    reset: () => rewrite(memory, placement, arrays),
    memory,
    placement,
    checkCount: () => (counter ? (counter.value as number) : NaN),
    guardCount: () => (guards ? (guards.value as number) : NaN),
    arrays: () => readArrays(memory, placement, arrays.map((a) => a.length)),
  };
}

export interface Outcome {
  kind: 'ok' | 'trap';
  result?: number;
  trap?: string;
  checkId?: number;
  index?: number;
  length?: number;
  sentinelsIntact: boolean;
  checks: number;
  guards: number;
}

export function runOnce(b: Built, fn: string, args: Arg[]): Outcome & { arrays: number[][] } {
  const inst = instantiate(b, fn, args);
  try {
    const result = inst.call();
    return { kind: 'ok', result, sentinelsIntact: sentinelsIntact(inst.memory, inst.placement), checks: inst.checkCount(), guards: inst.guardCount(), arrays: inst.arrays() };
  } catch (e) {
    if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    const v = new DataView(inst.memory.buffer);
    return {
      kind: 'trap',
      trap: e.message,
      checkId: v.getInt32(TRAP_CHECK_ID_OFFSET, true),
      index: v.getInt32(TRAP_INDEX_OFFSET, true),
      length: v.getInt32(TRAP_LENGTH_OFFSET, true),
      sentinelsIntact: sentinelsIntact(inst.memory, inst.placement),
      checks: inst.checkCount(),
      guards: inst.guardCount(),
      arrays: inst.arrays(),
    };
  }
}
