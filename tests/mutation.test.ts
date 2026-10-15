// A3b: mutation-corpus tooling (printer, operators, inputs, fuel, and the
// preregistered statistics).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Lexer } from '../src/lexer';
import { Parser } from '../src/parser';
import { ErrorReporter } from '../src/errors';
import { compileProgram } from '../src/compile';
import { BENCHMARKS } from '../eval/benchmarks';
import { printProgram } from '../eval/mutation/printer';
import { apply, enumerate, fnInfo } from '../eval/mutation/operators';
import { fuzzInputs, INPUTS_PER_KERNEL } from '../eval/mutation/inputs';
import { buildSource, runInput } from '../eval/mutation/execm';
import { checkOriginals } from '../eval/mutate';
import { auc, curve, interpolate, generateMutationReport } from '../eval/mutation/report';
import { FUEL_EXHAUSTED_CHECK_ID } from '../src/stackFrame';

jest.setTimeout(120000);

const parse = (src: string) => {
  const r = new ErrorReporter();
  return new Parser(new Lexer(src, r).tokenize(), r).parseProgram();
};

describe('AST printer', () => {
  test('every kernel round-trips to identical generated code', () => {
    for (const b of BENCHMARKS) {
      const src = fs.readFileSync(b.file, 'utf-8');
      expect(compileProgram(printProgram(parse(src))).codegen.wat).toBe(compileProgram(src).codegen.wat);
    }
  });
});

describe('mutation operators', () => {
  const src = `func k(a: int[], alen: int, b: int[], blen: int, n: int) -> int {
    let s: int = 0;
    for (let i: int = 0; i < alen; i = i + 1) {
        b[i] = a[i];
    }
    return s;
}
func main() -> int {
    return 0;
}`;
  const prog = parse(src);
  const muts = enumerate(fnInfo(prog.functions[0]));
  const byOp = (op: string) => muts.filter((m) => m.operator === op);

  test('each operator finds its sites', () => {
    expect(byOp('lt-to-le')).toHaveLength(1);
    expect(byOp('bound-plus-one')).toHaveLength(1);
    expect(byOp('start-minus-one')).toHaveLength(1);
    expect(byOp('index-plus-one')).toHaveLength(2);
    expect(byOp('index-minus-one')).toHaveLength(2);
    expect(byOp('write-index-external')).toHaveLength(3); // alen, blen, n
    expect(byOp('swap-length').length).toBeGreaterThan(0);
    // i in a[i] and b[i] can become alen, blen, n or s (4 others each)
    expect(byOp('swap-index-var')).toHaveLength(8);
  });

  test('a variant differs from the original in exactly the mutated place', () => {
    const m = byOp('lt-to-le')[0];
    const out = printProgram(apply(prog, 'k', m));
    expect(out).toContain('(i <= alen)');
    expect(printProgram(prog)).toContain('(i < alen)');
    const w = byOp('write-index-external').find((x) => x.detail.includes('[n]'))!;
    expect(printProgram(apply(prog, 'k', w))).toContain('b[n] = a[i]');
  });

  test('remove-guard replaces an if by its branch', () => {
    const g = parse(`func k(a: int[], len: int) -> int {
    if (len > 0) {
        a[0] = 1;
    }
    return 0;
}
func main() -> int {
    return 0;
}`);
    const m = enumerate(fnInfo(g.functions[0])).filter((x) => x.operator === 'remove-guard');
    expect(m).toHaveLength(1);
    expect(printProgram(apply(g, 'k', m[0]))).toContain('if (true) {');
  });
});

describe('fuzzed inputs and fuel', () => {
  test(`${INPUTS_PER_KERNEL} inputs per kernel, deterministic, and valid for every original kernel under full`, async () => {
    expect(fuzzInputs('dot')).toEqual(fuzzInputs('dot'));
    expect(fuzzInputs('dot')).toHaveLength(INPUTS_PER_KERNEL);
    await checkOriginals(() => undefined); // throws if any original kernel traps or corrupts
  });

  test('an unbounded loop ends deterministically when the fuel runs out', async () => {
    const b = await buildSource('func spin(n: int) -> int {\n    let i: int = 0;\n    while (i < 1) {\n        i = i * 1;\n    }\n    return i;\n}\nfunc main() -> int {\n    return 0;\n}\n', 'full');
    const o = runInput(b, 'spin', [0]);
    expect(o).toMatchObject({ cls: 'other', detail: 'fuel' });
    expect(FUEL_EXHAUSTED_CHECK_ID).toBe(-2);
  });
});

describe('preregistered statistics', () => {
  test('curve keeps the best detection per cost and interpolates linearly', () => {
    const c = curve([{ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.4 }, { x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(c).toEqual([{ x: 0, y: 0 }, { x: 0.5, y: 0.4 }, { x: 1, y: 1 }]);
    expect(interpolate(c, 0.25)).toBeCloseTo(0.2);
    expect(interpolate(c, 0.75)).toBeCloseTo(0.7);
    expect(interpolate(c, 1.5)).toBeNaN();
    expect(auc(c)).toBeCloseTo(0.5 * 0.2 + 0.5 * 0.7);
  });

  test('the committed mutation results regenerate a complete report', () => {
    const dir = path.join(__dirname, '..', 'results', 'mutation');
    if (!fs.existsSync(path.join(dir, 'raw', 'outcomes.csv'))) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-m-'));
    fs.mkdirSync(path.join(tmp, 'raw'));
    for (const f of ['cost.csv', 'outcomes.csv', 'silent.csv']) fs.copyFileSync(path.join(dir, 'raw', f), path.join(tmp, 'raw', f));
    fs.copyFileSync(path.join(dir, 'corpus.json'), path.join(tmp, 'corpus.json'));
    const md = generateMutationReport(tmp, 'x');
    expect(md).toContain('## H1');
    expect(md).toContain('## H2');
    expect(md).not.toMatch(/NaN|undefined/);
  });
});
