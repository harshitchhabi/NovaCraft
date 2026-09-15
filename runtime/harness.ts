// Runtime harness: assembles generated .wat via the `wabt` npm package,
// instantiates it with Node's built-in WebAssembly global, runs exported
// functions, and translates a caught trap back into a NovaCraft source
// location using the trap side-channel + source map.
import wabtInit from 'wabt';
import { SourceMap, findEntry } from '../src/sourcemap';
import { TRAP_INDEX_OFFSET, TRAP_LENGTH_OFFSET, TRAP_CHECK_ID_OFFSET } from '../src/stackFrame';

export interface HarnessInstance {
  instance: WebAssembly.Instance;
  memory: WebAssembly.Memory;
  printed: number[];
}

export async function assembleAndInstantiate(watText: string): Promise<HarnessInstance> {
  const wabt = await wabtInit();
  const parsed = wabt.parseWat('novacraft.wat', watText, { mutable_globals: true });
  parsed.resolveNames();
  parsed.validate();
  const { buffer } = parsed.toBinary({});
  parsed.destroy();

  const printed: number[] = [];
  const importObject = {
    env: {
      print: (v: number) => {
        printed.push(v);
      },
    },
  };

  const { instance } = await WebAssembly.instantiate(buffer.buffer as ArrayBuffer, importObject);
  const memory = instance.exports.memory as WebAssembly.Memory;
  return { instance, memory, printed };
}

export function writeIntArray(memory: WebAssembly.Memory, offset: number, values: number[]): void {
  const view = new Int32Array(memory.buffer, offset, values.length);
  view.set(values);
}

export function callFunction(h: HarnessInstance, name: string, args: number[]): number {
  const fn = h.instance.exports[name] as (...a: number[]) => number;
  if (typeof fn !== 'function') {
    throw new Error(`no exported function '${name}' in compiled module`);
  }
  return fn(...args);
}

export interface TrapSideChannel {
  index: number;
  length: number;
  checkId: number;
}

export function readTrapSideChannel(memory: WebAssembly.Memory): TrapSideChannel {
  const view = new DataView(memory.buffer);
  return {
    index: view.getInt32(TRAP_INDEX_OFFSET, true),
    length: view.getInt32(TRAP_LENGTH_OFFSET, true),
    checkId: view.getInt32(TRAP_CHECK_ID_OFFSET, true),
  };
}

export function formatTrapMessage(filename: string, sourceMap: SourceMap, sideChannel: TrapSideChannel): string {
  const entry = findEntry(sourceMap, sideChannel.checkId);
  const line = entry?.line ?? 0;
  const column = entry?.column ?? 0;
  return `Runtime error: array index out of bounds at ${filename}:${line}:${column} (index=${sideChannel.index}, length=${sideChannel.length})`;
}

// High-level convenience: run a function, and if it traps with a bounds
// violation, translate it into the standard diagnostic message rather than
// letting a bare WebAssembly.RuntimeError propagate.
export async function runWithTrapTranslation(
  watText: string,
  sourceMap: SourceMap,
  filename: string,
  fnName: string,
  args: number[],
): Promise<{ ok: true; result: number; printed: number[] } | { ok: false; message: string; printed: number[] }> {
  const h = await assembleAndInstantiate(watText);
  try {
    const result = callFunction(h, fnName, args);
    return { ok: true, result, printed: h.printed };
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) {
      const sideChannel = readTrapSideChannel(h.memory);
      return { ok: false, message: formatTrapMessage(filename, sourceMap, sideChannel), printed: h.printed };
    }
    throw e;
  }
}
