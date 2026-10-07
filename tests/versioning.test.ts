// Milestone A2: hoisting by loop versioning. Runtime behavior of the fast
// and slow copies, the guard (including i32 overflow of the bound and of
// the induction update), and strict == full on fixed input grids.
import * as fs from 'fs';
import * as path from 'path';
import wabtInit from 'wabt';
import { compileProgram, CompileResult } from '../src/compile';
import { generateModule } from '../src/codegen';
import { IRInstr, IRProgram } from '../src/ir';
import { TRAP_CHECK_ID_OFFSET, TRAP_INDEX_OFFSET, TRAP_LENGTH_OFFSET } from '../src/stackFrame';

const INT_MAX = 2147483647;
const INT_MIN = -2147483648;
const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'harden', 'versioning.min'), 'utf-8');

interface Run {
  kind: 'ok' | 'trap';
  value?: number;
  trap?: string;
  checkId?: number;
  index?: number;
  length?: number;
  checks: number;
  array: number[];
}

let wabt: Awaited<ReturnType<typeof wabtInit>>;
beforeAll(async () => {
  wabt = await wabtInit();
});

function moduleOf(c: CompileResult): WebAssembly.Module {
  const parsed = wabt.parseWat('t.wat', c.codegen.wat, { mutable_globals: true });
  parsed.resolveNames();
  parsed.validate();
  const { buffer } = parsed.toBinary({});
  parsed.destroy();
  return new WebAssembly.Module(buffer as Uint8Array<ArrayBuffer>);
}

// args[0] is always the array's base address.
function run(mod: WebAssembly.Module, fn: string, args: number[], array: number[]): Run {
  const inst = new WebAssembly.Instance(mod, { env: { print: () => undefined } });
  const mem = inst.exports.memory as WebAssembly.Memory;
  new Int32Array(mem.buffer, args[0], array.length).set(array);
  const count = () => (inst.exports.checkCount as WebAssembly.Global).value as number;
  const arr = () => Array.from(new Int32Array(mem.buffer, args[0], array.length));
  try {
    const value = (inst.exports[fn] as (...a: number[]) => number)(...args);
    return { kind: 'ok', value, checks: count(), array: arr() };
  } catch (e) {
    const v = new DataView(mem.buffer);
    return {
      kind: 'trap',
      trap: (e as Error).message,
      checkId: v.getInt32(TRAP_CHECK_ID_OFFSET, true),
      index: v.getInt32(TRAP_INDEX_OFFSET, true),
      length: v.getInt32(TRAP_LENGTH_OFFSET, true),
      checks: count(),
      array: arr(),
    };
  }
}

const build = (harden: string) => compileProgram(src, { harden, countChecks: true });
const without = ({ checks, ...rest }: Run) => rest;

describe('loop versioning: static decisions', () => {
  const strict = build('strict').hardening.sites;
  const byFn = (fn: string) => strict.filter((s) => s.function === fn).map((s) => s.decision);
  test('qualifying loops are hoisted', () => {
    expect(byFn('window')).toEqual(['hoist']);
    expect(byFn('shift')).toEqual(['hoist', 'hoist']);
    expect(byFn('strideAfter')).toEqual(['hoist']);
    expect(byFn('nested')).toEqual(['hoist', 'hoist']);
  });
  test('conditional update, a bound assigned in the loop, and a non-affine index are retained', () => {
    expect(byFn('condUpdate')).toEqual(['retain']);
    expect(byFn('movingBound')).toEqual(['retain']);
    expect(byFn('scaled')).toEqual(['retain']);
  });
  test('the guard includes the no-overflow term for the update (Nmax + s <= INT_MAX)', () => {
    const fn = build('strict').finalIR.functions.find((f) => f.name === 'window')!;
    const guard = fn.body.find((i): i is Extract<IRInstr, { op: 'guard' }> => i.op === 'guard')!;
    expect(guard.terms).toContainEqual({ lhs: { kind: 'reg', name: 'n', type: 'int' }, lhsAdd: 1, rhs: { kind: 'imm', value: INT_MAX, type: 'int' }, rhsAdd: 0 });
  });
});

describe('loop versioning: runtime', () => {
  let full: WebAssembly.Module;
  let strict: WebAssembly.Module;
  beforeAll(() => {
    full = moduleOf(build('full'));
    strict = moduleOf(build('strict'));
  });

  test('guard true: the fast loop runs (no hoisted check executes) and matches full', () => {
    const arr = [1, 2, 3, 4, 5, 6];
    const f = run(full, 'shift', [0, 6, 5], arr);
    const s = run(strict, 'shift', [0, 6, 5], arr);
    expect(f.kind).toBe('ok');
    expect(without(s)).toEqual(without(f));
    expect(f.checks).toBe(10); // 5 iterations x 2 checks
    expect(s.checks).toBe(0);
  });

  test('guard false: the slow loop runs every check and traps exactly like full', () => {
    const arr = [1, 2, 3, 4, 5, 6];
    const f = run(full, 'shift', [0, 6, 6], arr); // arr[i + 1] reaches arr[6]
    const s = run(strict, 'shift', [0, 6, 6], arr);
    expect(f).toMatchObject({ kind: 'trap', index: 6, length: 6 });
    expect(s).toEqual(f); // same trap, same check id, same check count, same memory
  });

  test('bound near INT_MAX: the update would wrap, so the guard picks the slow loop', () => {
    // i from INT_MAX - 2 while i <= INT_MAX: i = i + 1 wraps to INT_MIN and
    // the loop continues; the check on arr[i - 1] then sees INT_MAX >= len.
    // The array base is 1024 so the wrapped addresses of the first indices
    // (base + 4 * (INT_MAX - 3), ...) still land inside linear memory.
    const args = [1024, INT_MAX, INT_MAX - 2, INT_MAX];
    const f = run(full, 'window', args, [0, 0, 0, 0]);
    const s = run(strict, 'window', args, [0, 0, 0, 0]);
    expect(f).toMatchObject({ kind: 'trap', trap: 'unreachable', index: INT_MAX, length: INT_MAX });
    expect(s).toEqual(f);
    expect(s.checks).toBeGreaterThan(0);
  });

  test('without the overflow term the guard would be fooled (mutant check)', () => {
    const c = build('strict');
    const strip = (instrs: IRInstr[]): IRInstr[] =>
      instrs.map((i) =>
        i.op === 'guard'
          ? { ...i, terms: i.terms.filter((t) => !(t.rhs.kind === 'imm' && t.rhs.value === INT_MAX)) }
          : i,
      );
    const ir: IRProgram = { functions: c.finalIR.functions.map((fn) => ({ ...fn, body: strip(fn.body) })) };
    const mutant = moduleOf({ ...c, codegen: generateModule(ir, 4, { countChecks: true }) });
    const args = [1024, INT_MAX, INT_MAX - 2, INT_MAX];
    const f = run(full, 'window', args, [0, 0, 0, 0]);
    const m = run(mutant, 'window', args, [0, 0, 0, 0]);
    expect(without(m)).not.toEqual(without(f));
  });

  test('guard terms are evaluated in 64 bits: n + 2 <= len cannot wrap to true', () => {
    // n = INT_MAX, len = INT_MIN: in i32, INT_MAX + 1 wraps to INT_MIN <= INT_MIN.
    const f = run(full, 'shift', [0, INT_MIN, INT_MAX], [1, 2, 3]);
    const s = run(strict, 'shift', [0, INT_MIN, INT_MAX], [1, 2, 3]);
    expect(f).toMatchObject({ kind: 'trap', index: 1, length: INT_MIN });
    expect(s).toEqual(f);
  });

  test('strict and full agree on a grid of bounds, starts and lengths for every versioned function', () => {
    const arr = [3, 1, 4, 1, 5, 9, 2, 6];
    const vals = [INT_MIN, -2, -1, 0, 1, 2, 3, 5, 6, 7, 8, 9, INT_MAX - 1, INT_MAX];
    let fastRuns = 0;
    for (const len of [0, 1, 6, 8, INT_MAX, -1]) {
      for (const n of vals) {
        const cases: Array<[string, number[]]> = [
          ['shift', [0, len, n]],
          ['strideAfter', [0, len, n]],
          ['nested', [0, len, n, Math.max(0, Math.min(n, 4))]],
          ...vals.filter((st) => st > -5 && st < 12).map((st): [string, number[]] => ['window', [0, len, st, n]]),
          ['window', [0, len, INT_MAX - 2, n]],
        ];
        for (const [fn, args] of cases) {
          const f = run(full, fn, args, arr);
          const s = run(strict, fn, args, arr);
          if (f.kind === 'trap' && f.trap !== 'unreachable') continue; // out of memory: not a check outcome
          expect({ fn, args, ...without(s) }).toEqual({ fn, args, ...without(f) });
          if (s.checks < f.checks) fastRuns++;
        }
      }
    }
    expect(fastRuns).toBeGreaterThan(10); // the grid exercises the fast copies, not just the slow ones
  });
});

describe('omitted checks are really gone', () => {
  test('under none, an out-of-bounds read no longer traps; under full it does', () => {
    const u = fs.readFileSync(path.join(__dirname, '..', 'examples', 'unsafe_index.min'), 'utf-8');
    const f = run(moduleOf(compileProgram(u, { harden: 'full', countChecks: true })), 'unsafeGet', [0, 2, 5], [1, 2]);
    const n = run(moduleOf(compileProgram(u, { harden: 'none', countChecks: true })), 'unsafeGet', [0, 2, 5], [1, 2]);
    expect(f).toMatchObject({ kind: 'trap', index: 5, length: 2 });
    expect(n).toMatchObject({ kind: 'ok', checks: 0 });
  });
});
