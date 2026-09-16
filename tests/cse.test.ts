import { compileProgram } from '../src/compile';
import { IRInstr } from '../src/ir';
import { assembleAndInstantiate, callFunction } from '../runtime/harness';

const SOURCE = `
func redundant(a: int, b: int) -> int {
    let x: int = a + b;
    let y: int = a + b;
    return x + y;
}

func main() -> int {
    let r: int = redundant(3, 4);
    print(r);
    return 0;
}
`;

function isAPlusB(i: IRInstr): i is Extract<IRInstr, { op: 'binop' }> {
  return (
    i.op === 'binop' &&
    i.bop === '+' &&
    i.left.kind === 'reg' &&
    i.left.name === 'a' &&
    i.right.kind === 'reg' &&
    i.right.name === 'b'
  );
}

describe('Common-subexpression elimination', () => {
  test('a duplicate a+b binop is folded into a move from the first computation', () => {
    const result = compileProgram(SOURCE);
    const beforeCSE = result.stages.find((s) => s.label === 'after dead-code elimination')!;
    const afterCSE = result.stages.find((s) => s.label === 'after common-subexpression elimination')!;

    const fnBefore = beforeCSE.ir.functions.find((f) => f.name === 'redundant')!;
    const fnAfter = afterCSE.ir.functions.find((f) => f.name === 'redundant')!;

    expect(fnBefore.body.filter(isAPlusB).length).toBe(2);
    expect(fnAfter.body.filter(isAPlusB).length).toBe(1);
  });

  test('the eliminated duplicate does not change the computed result', async () => {
    const compiled = compileProgram(SOURCE);
    const h = await assembleAndInstantiate(compiled.codegen.wat); // throws if wabt rejects the module
    expect(callFunction(h, 'redundant', [3, 4])).toBe(14);
  });
});
