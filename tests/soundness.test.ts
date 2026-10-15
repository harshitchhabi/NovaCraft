// Soundness audit of the range analysis (milestone A0, step 3) and the
// required analysis outcomes (step 5). Each fixture in
// tests/fixtures/soundness/ documents the case it covers; here we pin down
// which checks are (and are not) eliminated by the full compile pipeline.
// tests/differential.test.ts runs the same fixtures dynamically.
import * as fs from 'fs';
import * as path from 'path';
import { compileProgram, CompileError } from '../src/compile';
import { IRInstr } from '../src/ir';
import { assembleAndInstantiate, callFunction, readTrapSideChannel, writeIntArray } from '../runtime/harness';

const INT_MIN = -2147483648;

function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'soundness', name), 'utf-8');
}
function example(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf-8');
}

// The eliminated flag of every BoundsCheck in `fn`, in source order, as
// `line:col=E` (eliminated) or `line:col=K` (kept).
function decisions(source: string, fn: string): string[] {
  const ir = compileProgram(source).finalIR;
  const out: Array<{ line: number; col: number; e: boolean }> = [];
  const walk = (instrs: IRInstr[]) => {
    for (const i of instrs) {
      if (i.op === 'boundscheck') out.push({ line: i.pos.line, col: i.pos.column, e: !!i.eliminated });
      else if (i.op === 'if') {
        walk(i.thenBody);
        if (i.elseBody) walk(i.elseBody);
      } else if (i.op === 'while') {
        walk(i.condInstrs);
        walk(i.body);
      }
    }
  };
  walk(ir.functions.find((f) => f.name === fn)!.body);
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out.map((d) => `${d.line}:${d.col}=${d.e ? 'E' : 'K'}`);
}

const allKept = (source: string, fn: string) => decisions(source, fn).every((d) => d.endsWith('=K'));
const allElim = (source: string, fn: string) => decisions(source, fn).every((d) => d.endsWith('=E'));

describe('required analysis outcomes', () => {
  test('sumArray: arr[i] under while (i < len) is proven', () => {
    expect(decisions(example('sumArray.min'), 'sumArray')).toEqual(['8:25=E']);
  });

  test('arr[i+1] under while (i < len - 1) is proven when len - 1 cannot wrap', () => {
    expect(decisions(fixture('plusOne.min'), 'plusOneGuarded')).toEqual(['22:21=E', '22:34=E']);
  });

  // Deviation from the literal requirement, documented in docs/AUDIT.md:
  // with no information about len, len == INT_MIN makes `len - 1` wrap to
  // INT_MAX and the full-check program traps at arr[1]; proving the check
  // would be unsound.
  test('arr[i+1] under while (i < len - 1) with unconstrained len is NOT proven (len - 1 may wrap)', () => {
    expect(decisions(fixture('plusOne.min'), 'plusOne')).toEqual(['11:17=K']);
  });

  test('while (i <= len) { arr[i] } is not proven', () => {
    expect(allKept(fixture('offByOne.min'), 'offByOne')).toBe(true);
  });

  test('arr[k] with an unrelated parameter is not proven', () => {
    expect(allKept(example('unsafe_index.min'), 'unsafeGet')).toBe(true);
  });

  test('arr[i*m + j] in a doubly nested loop with a separate len is not proven', () => {
    expect(allKept(fixture('nestedMatrix.min'), 'matSum')).toBe(true);
  });
});

describe('soundness audit cases', () => {
  test('(a) wraparound: i in [0,1], j = i + INT_MAX may be INT_MIN, so arr[j] keeps its check', () => {
    expect(allKept(fixture('wrapIndex.min'), 'wrapIndex')).toBe(true);
  });

  test('(a) wraparound at runtime: the kept check traps with index INT_MIN', async () => {
    const h = await assembleAndInstantiate(compileProgram(fixture('wrapIndex.min')).codegen.wat);
    writeIntArray(h.memory, 0, [7, 8, 9]);
    expect(() => callFunction(h, 'wrapIndex', [0, 3, 1])).toThrow(WebAssembly.RuntimeError);
    expect(readTrapSideChannel(h.memory).index).toBe(INT_MIN);
  });

  test('(b) off-by-one: i <= len keeps the check', () => {
    expect(allKept(fixture('offByOne.min'), 'offByOne')).toBe(true);
  });

  test('(c) len reassigned inside the loop before the access keeps the check', () => {
    expect(allKept(fixture('reassignInLoop.min'), 'shrinkLen')).toBe(true);
  });

  test('(c) index reassigned inside the loop before the access keeps the check', () => {
    expect(allKept(fixture('reassignInLoop.min'), 'bumpIndex')).toBe(true);
  });

  test('(c) len reassigned AFTER the access: the condition re-establishes the fact each iteration', () => {
    expect(allElim(fixture('reassignInLoop.min'), 'lenThenUse')).toBe(true);
  });

  test("(d) nested loops: the outer fact i < len does not hold on the inner loop's later iterations", () => {
    expect(allKept(fixture('nestedStale.min'), 'nestedStale')).toBe(true);
  });

  test('(d) nested loops: anomalyDetect keeps data[j], eliminates data[i] after the inner loop', () => {
    expect(decisions(example('anomalyDetect.min'), 'movingAvgFlag')).toEqual(['23:33=K', '28:33=E']);
  });

  test('(d) loop fixed point converges: a 4-deep delay chain is not under-approximated', () => {
    expect(allKept(fixture('delayChain.min'), 'delayChain')).toBe(true);
  });

  test('(e) a fact killed on one branch of an if does not survive the join', () => {
    expect(allKept(fixture('ifJoin.min'), 'ifJoin')).toBe(true);
  });

  test('(e) a fact preserved on both branches survives the join', () => {
    expect(allElim(fixture('ifJoin.min'), 'ifJoinSafe')).toBe(true);
  });

  test('(f) for-loop desugaring: body access proven, stride-2 i+1 and post-loop access kept', () => {
    expect(allElim(fixture('forDesugar.min'), 'forSum')).toBe(true);
    expect(allKept(fixture('forDesugar.min'), 'forStride')).toBe(true);
    expect(decisions(fixture('forDesugar.min'), 'forAfter')).toEqual(['25:17=E', '28:16=K']);
  });

  test('(g) CSE: duplicated i + 1 index expressions are both proven and stay correct', async () => {
    expect(allElim(fixture('cseFold.min'), 'cseDup')).toBe(true);
    const h = await assembleAndInstantiate(compileProgram(fixture('cseFold.min')).codegen.wat);
    writeIntArray(h.memory, 0, [1, 2, 3, 4]);
    expect(callFunction(h, 'cseDup', [0, 4])).toBe(2 * (2 + 3 + 4));
  });

  test('(g) constant-folded length: arr[0..3] with len = 4 proven, arr[3] proven, arr[4] kept', () => {
    expect(decisions(fixture('cseFold.min'), 'constLen')).toEqual(['23:17=E', '26:16=E', '26:25=K']);
  });
});

describe('constant folding and dead-code elimination use i32 semantics', () => {
  test('folded +, *, unary - wrap like i32 (and the module assembles)', async () => {
    const h = await assembleAndInstantiate(compileProgram(fixture('constWrap.min')).codegen.wat);
    expect(callFunction(h, 'addWrap', [])).toBe(INT_MIN);
    expect(callFunction(h, 'mulWrap', [])).toBe(0);
    expect(callFunction(h, 'negWrap', [])).toBe(INT_MIN);
  });

  test('a folded index that wraps negative still traps', async () => {
    const c = compileProgram(fixture('constWrap.min'));
    const h = await assembleAndInstantiate(c.codegen.wat);
    writeIntArray(h.memory, 0, [1, 2, 3]);
    expect(() => callFunction(h, 'foldedIndex', [0, 3])).toThrow(WebAssembly.RuntimeError);
    expect(readTrapSideChannel(h.memory).index).toBe(-2);
  });

  test('INT_MIN / -1 is not folded (it traps at runtime)', async () => {
    const src = 'func f() -> int { return (0 - 2147483647 - 1) / (0 - 1); }\nfunc main() -> int { return 0; }';
    const h = await assembleAndInstantiate(compileProgram(src).codegen.wat);
    expect(() => callFunction(h, 'f', [])).toThrow(WebAssembly.RuntimeError);
  });

  test('an unused division that can trap is not removed by dead-code elimination', async () => {
    const h = await assembleAndInstantiate(compileProgram(fixture('cseFold.min')).codegen.wat);
    expect(callFunction(h, 'divTrap', [5])).toBe(1);
    expect(() => callFunction(h, 'divTrap', [0])).toThrow(WebAssembly.RuntimeError);
  });

  test('float folding rounds to f32 like the f32.add it replaces', async () => {
    const src =
      'func folded() -> float { return 0.1 + 0.2; }\nfunc runtime(a: float, b: float) -> float { return a + b; }\nfunc main() -> int { return 0; }';
    const h = await assembleAndInstantiate(compileProgram(src).codegen.wat);
    expect(callFunction(h, 'folded', [])).toBe(callFunction(h, 'runtime', [0.1, 0.2]));
  });

  test('int literals: -2147483648 is INT_MIN, larger literals are rejected', async () => {
    const ok = 'func f() -> int { return -2147483648; }\nfunc main() -> int { return 0; }';
    const h = await assembleAndInstantiate(compileProgram(ok).codegen.wat);
    expect(callFunction(h, 'f', [])).toBe(INT_MIN);
    const bad = 'func f() -> int { return 4294967296; }\nfunc main() -> int { return 0; }';
    expect(() => compileProgram(bad)).toThrow(CompileError);
  });
});
