// Optimization pass 1: constant folding.
// Rewrites binop/unop instructions whose operands are all immediates into a
// single `const` instruction, and folds immediate initializers through moves.
import { IRInstr, IRValue, IRProgram, imm } from '../ir';

function evalBinop(bop: string, l: number, r: number, type: string): number | null {
  switch (bop) {
    case '+':
      return l + r;
    case '-':
      return l - r;
    case '*':
      return l * r;
    case '/':
      if (r === 0) return null; // don't fold division by zero; let it fail at runtime
      return type === 'int' ? Math.trunc(l / r) : l / r;
    case '%':
      if (r === 0) return null;
      return type === 'int' ? l % r : l % r;
    case '==':
      return l === r ? 1 : 0;
    case '!=':
      return l !== r ? 1 : 0;
    case '<':
      return l < r ? 1 : 0;
    case '<=':
      return l <= r ? 1 : 0;
    case '>':
      return l > r ? 1 : 0;
    case '>=':
      return l >= r ? 1 : 0;
    case '&&':
      return l && r ? 1 : 0;
    case '||':
      return l || r ? 1 : 0;
    default:
      return null;
  }
}

// Removes from constMap any register defined anywhere within `instrs`
// (recursively), since a branch or loop body may reassign it and constant
// knowledge does not flow across conditional/repeated execution.
function collectDefs(instrs: IRInstr[], constMap: Map<string, number>): void {
  for (const instr of instrs) {
    switch (instr.op) {
      case 'const':
      case 'move':
      case 'binop':
      case 'unop':
      case 'arrload':
        constMap.delete(instr.dest);
        break;
      case 'call':
        if (instr.dest) constMap.delete(instr.dest);
        break;
      case 'if':
        collectDefs(instr.thenBody, constMap);
        if (instr.elseBody) collectDefs(instr.elseBody, constMap);
        break;
      case 'while':
        collectDefs(instr.condInstrs, constMap);
        collectDefs(instr.body, constMap);
        break;
    }
  }
}

function foldValue(v: IRValue, constMap: Map<string, number>): IRValue {
  if (v.kind === 'imm') return v;
  const c = constMap.get(v.name);
  return c !== undefined ? imm(c, v.type) : v;
}

// Folds within a single straight-line instruction list. Constant knowledge
// (constMap) does not cross into/out of if/while bodies, since those may
// execute conditionally or repeatedly -- keeping the pass conservative and simple.
function foldList(instrs: IRInstr[]): IRInstr[] {
  const constMap = new Map<string, number>();
  const out: IRInstr[] = [];

  for (const instr of instrs) {
    switch (instr.op) {
      case 'const':
        constMap.set(instr.dest, instr.value);
        out.push(instr);
        break;
      case 'move': {
        const src = foldValue(instr.src, constMap);
        if (src.kind === 'imm') {
          constMap.set(instr.dest, src.value);
          out.push({ op: 'const', dest: instr.dest, value: src.value, type: instr.type, pos: instr.pos });
        } else {
          constMap.delete(instr.dest);
          out.push({ ...instr, src });
        }
        break;
      }
      case 'binop': {
        const left = foldValue(instr.left, constMap);
        const right = foldValue(instr.right, constMap);
        if (left.kind === 'imm' && right.kind === 'imm') {
          const result = evalBinop(instr.bop, left.value, right.value, instr.type);
          if (result !== null) {
            constMap.set(instr.dest, result);
            out.push({ op: 'const', dest: instr.dest, value: result, type: instr.type, pos: instr.pos });
            break;
          }
        }
        constMap.delete(instr.dest);
        out.push({ ...instr, left, right });
        break;
      }
      case 'unop': {
        const src = foldValue(instr.src, constMap);
        if (src.kind === 'imm') {
          const result = instr.uop === '-' ? -src.value : src.value === 0 ? 1 : 0;
          constMap.set(instr.dest, result);
          out.push({ op: 'const', dest: instr.dest, value: result, type: instr.type, pos: instr.pos });
          break;
        }
        constMap.delete(instr.dest);
        out.push({ ...instr, src });
        break;
      }
      case 'boundscheck': {
        const index = foldValue(instr.index, constMap);
        const length = foldValue(instr.length, constMap);
        out.push({ ...instr, index, length });
        break;
      }
      case 'arrload': {
        const base = foldValue(instr.base, constMap);
        const index = foldValue(instr.index, constMap);
        constMap.delete(instr.dest);
        out.push({ ...instr, base, index });
        break;
      }
      case 'arrstore': {
        const base = foldValue(instr.base, constMap);
        const index = foldValue(instr.index, constMap);
        const value = foldValue(instr.value, constMap);
        out.push({ ...instr, base, index, value });
        break;
      }
      case 'call': {
        const args = instr.args.map((a) => foldValue(a, constMap));
        if (instr.dest) constMap.delete(instr.dest);
        out.push({ ...instr, args });
        break;
      }
      case 'return': {
        const value = instr.value ? foldValue(instr.value, constMap) : null;
        out.push({ ...instr, value });
        break;
      }
      case 'print': {
        out.push({ ...instr, value: foldValue(instr.value, constMap) });
        break;
      }
      case 'if': {
        const cond = foldValue(instr.cond, constMap);
        const thenBody = foldList(instr.thenBody);
        const elseBody = instr.elseBody ? foldList(instr.elseBody) : null;
        out.push({ ...instr, cond, thenBody, elseBody });
        collectDefs(instr.thenBody, constMap);
        if (instr.elseBody) collectDefs(instr.elseBody, constMap);
        break;
      }
      case 'while': {
        // The condition is (re-)evaluated on every iteration using values
        // the body may have just mutated, so it must not be folded using
        // the pre-loop constMap.
        collectDefs(instr.condInstrs, constMap);
        collectDefs(instr.body, constMap);
        const condInstrs = foldList(instr.condInstrs);
        const body = foldList(instr.body);
        out.push({ ...instr, condInstrs, body, cond: instr.cond });
        break;
      }
    }
  }
  return out;
}

export function constantFold(program: IRProgram): IRProgram {
  return {
    functions: program.functions.map((fn) => ({ ...fn, body: foldList(fn.body) })),
  };
}
