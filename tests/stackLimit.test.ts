// The spill stack grows down from 65536 and must never reach the trap side
// channel (4096..4107) or the harness array region (0..4095) below it: a
// prologue that would cross STACK_LIMIT traps with a stack-overflow marker.
import * as fs from 'fs';
import * as path from 'path';
import { compileProgram } from '../src/compile';
import { assembleAndInstantiate, callFunction, readTrapSideChannel, formatTrapMessage } from '../runtime/harness';
import { STACK_LIMIT, STACK_OVERFLOW_CHECK_ID } from '../src/stackFrame';

const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'soundness', 'deepRecursion.min'), 'utf-8');

describe('stack limit', () => {
  test('deep recursion traps with a stack-overflow marker and leaves memory below the stack untouched', async () => {
    const c = compileProgram(src);
    expect(c.codegen.allocations.get('deep')!.spillSlotCount).toBeGreaterThan(0);
    const h = await assembleAndInstantiate(c.codegen.wat);
    const low = new Uint8Array(h.memory.buffer, 0, STACK_LIMIT);
    low.fill(0xab);
    const before = Buffer.from(low).toString('hex');
    expect(() => callFunction(h, 'deep', [0, 1, 100000])).toThrow(WebAssembly.RuntimeError);
    const side = readTrapSideChannel(h.memory);
    expect(side.checkId).toBe(STACK_OVERFLOW_CHECK_ID);
    expect(formatTrapMessage('deepRecursion.min', c.codegen.sourceMap, side)).toBe('Runtime error: stack overflow');
    // Everything below the stack except the check-id slot is unchanged.
    const after = new Uint8Array(h.memory.buffer, 0, STACK_LIMIT);
    after.set([0xab, 0xab, 0xab, 0xab], 4104);
    expect(Buffer.from(after).toString('hex')).toBe(before);
  });

  test('shallow recursion still works', async () => {
    const h = await assembleAndInstantiate(compileProgram(src).codegen.wat);
    new Int32Array(h.memory.buffer, 0, 1).set([7]);
    // sum over n = 1..3 of (5n + 15) = 5*6 + 45 = 75, plus arr[0] = 7
    expect(callFunction(h, 'deep', [0, 1, 3])).toBe(82);
  });
});
