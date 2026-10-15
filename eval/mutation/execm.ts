// Fuel-limited execution for the mutation corpus. Separate from eval/exec.ts
// (used by the A3 results, left unchanged).
import { createHash } from 'crypto';
import wabtInit from 'wabt';
import { compileProgram, CompileResult } from '../../src/compile';
import {
  FUEL_EXHAUSTED_CHECK_ID,
  STACK_OVERFLOW_CHECK_ID,
  TRAP_CHECK_ID_OFFSET,
  TRAP_INDEX_OFFSET,
} from '../../src/stackFrame';
import { Arg } from '../exec';
import { place, sentinelsIntact } from '../layout';

export const FUEL = 1_000_000;

export interface MBuilt {
  compiled: CompileResult;
  module: WebAssembly.Module;
  key: string; // hash of the wasm binary: identical code => identical outcomes
}

let wabt: Awaited<ReturnType<typeof wabtInit>> | null = null;

export async function buildSource(source: string, policy: string, countChecks = false): Promise<MBuilt> {
  if (!wabt) wabt = await wabtInit();
  const compiled = compileProgram(source, { harden: policy, fuel: countChecks ? undefined : FUEL, countChecks });
  const parsed = wabt.parseWat('m.wat', compiled.codegen.wat, { mutable_globals: true });
  parsed.resolveNames();
  parsed.validate();
  const { buffer } = parsed.toBinary({});
  parsed.destroy();
  const bytes = buffer as Uint8Array<ArrayBuffer>;
  return { compiled, module: new WebAssembly.Module(bytes), key: createHash('sha1').update(bytes).digest('hex') };
}

export type OutcomeClass = 'detected' | 'silent_corruption' | 'missed_benign' | 'other';

export interface MOutcome {
  cls: OutcomeClass;
  checkId: number | null; // the bounds check that fired, for 'detected'
  index: number | null;
  detail: string; // trap message / fuel / stack, for the record
}

export function runInput(b: MBuilt, fn: string, args: Arg[]): MOutcome {
  const inst = new WebAssembly.Instance(b.module, { env: { print: () => undefined } });
  const memory = inst.exports.memory as WebAssembly.Memory;
  const arrays = args.filter((a): a is { array: number[] } => typeof a !== 'number').map((a) => a.array);
  const p = place(memory, arrays);
  let k = 0;
  const argv = args.map((a) => (typeof a === 'number' ? a : p.addresses[k++]));
  try {
    (inst.exports[fn] as (...x: number[]) => number)(...argv);
    const intact = sentinelsIntact(memory, p);
    return { cls: intact ? 'missed_benign' : 'silent_corruption', checkId: null, index: null, detail: 'returned' };
  } catch (e) {
    const intact = sentinelsIntact(memory, p);
    if (e instanceof WebAssembly.RuntimeError) {
      const v = new DataView(memory.buffer);
      const id = v.getInt32(TRAP_CHECK_ID_OFFSET, true);
      if (e.message === 'unreachable' && id >= 0) {
        return { cls: 'detected', checkId: id, index: v.getInt32(TRAP_INDEX_OFFSET, true), detail: 'bounds' };
      }
      const detail =
        e.message === 'unreachable' && id === FUEL_EXHAUSTED_CHECK_ID ? 'fuel' : e.message === 'unreachable' && id === STACK_OVERFLOW_CHECK_ID ? 'stack' : e.message;
      return { cls: intact ? 'other' : 'silent_corruption', checkId: null, index: null, detail };
    }
    if (e instanceof RangeError) return { cls: intact ? 'other' : 'silent_corruption', checkId: null, index: null, detail: 'host-stack' };
    throw e;
  }
}
