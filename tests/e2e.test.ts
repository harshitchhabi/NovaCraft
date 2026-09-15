import { compileExampleToModule } from './helpers';
import {
  assembleAndInstantiate,
  callFunction,
  writeIntArray,
  readTrapSideChannel,
  formatTrapMessage,
} from '../runtime/harness';
import { compileAndRun } from '../src/cli';
import * as path from 'path';

describe('Codegen + execution (end to end)', () => {
  test('sumArray.min compiles to valid .wat and running it against [1,2,3,4,5] returns 15', async () => {
    const mod = compileExampleToModule('sumArray.min');
    const h = await assembleAndInstantiate(mod.wat); // throws if wabt rejects the module
    writeIntArray(h.memory, 0, [1, 2, 3, 4, 5]);
    const result = callFunction(h, 'sumArray', [0, 5]);
    expect(result).toBe(15);
  });

  test('fib.min compiles and running fib(10) returns 55, exercising the call/stack-frame convention', async () => {
    const mod = compileExampleToModule('fib.min');
    const h = await assembleAndInstantiate(mod.wat);
    const result = callFunction(h, 'fib', [10]);
    expect(result).toBe(55);
  });

  test('a runtime bounds violation traps and produces the exact diagnostic message with correct line/col/index/length', async () => {
    const mod = compileExampleToModule('bounds_violation.min');
    const h = await assembleAndInstantiate(mod.wat);
    writeIntArray(h.memory, 0, [1, 2, 3, 4, 5]);

    let threw = false;
    try {
      callFunction(h, 'access', [0, 5]);
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(WebAssembly.RuntimeError);
      const sideChannel = readTrapSideChannel(h.memory);
      expect(sideChannel.index).toBe(100);
      expect(sideChannel.length).toBe(5);
      const message = formatTrapMessage('bounds_violation.min', mod.sourceMap, sideChannel);
      expect(message).toBe('Runtime error: array index out of bounds at bounds_violation.min:5:12 (index=100, length=5)');
    }
    expect(threw).toBe(true);
  });

  test('unsafe_index.min: an out-of-range k also traps with the correct diagnostic', async () => {
    const mod = compileExampleToModule('unsafe_index.min');
    const h = await assembleAndInstantiate(mod.wat);
    writeIntArray(h.memory, 0, [1, 2, 3, 4, 5]);
    expect(() => callFunction(h, 'unsafeGet', [0, 5, 99])).toThrow(WebAssembly.RuntimeError);
  });
});

describe('CLI smoke test', () => {
  test('novac examples/sumArray.min --run exits 0 and prints 15', async () => {
    const file = path.join(__dirname, '..', 'examples', 'sumArray.min');
    const logs: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(String(msg));
    });
    try {
      const code = await compileAndRun([file, '--run']);
      expect(code).toBe(0);
      expect(logs).toContain('15');
    } finally {
      logSpy.mockRestore();
    }
  });
});
