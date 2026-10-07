// Optimization pass: common-subexpression elimination.
//
// Runs last (after range analysis) so it never has to reason about the
// BoundsCheck.eliminated decision or the condBound symbolic-fact matching in
// rangeAnalysis.ts, which pattern-matches a `binop` instruction directly and
// would be defeated if this pass had already rewritten that instruction into
// a `move`.
//
// Within a single straight-line instruction list, if a `binop` computes the
// same (bop, left, right) as an earlier one whose result is still live
// (neither operand nor the earlier destination has been redefined since),
// it is rewritten into a `move` from that earlier destination instead of
// being recomputed. Like constantFold/deadCode, availability does not flow
// across if/while boundaries -- each nested body starts from an empty
// available-expression set, and any register it defines is invalidated in
// the enclosing list afterwards, since a branch or loop body may execute
// conditionally or repeatedly.
import { IRInstr, IRValue, IRProgram } from '../ir';

interface AvailEntry {
  key: string;
  dest: string;
  leftReg: string | null;
  rightReg: string | null;
}

function operandKey(v: IRValue): string {
  return v.kind === 'imm' ? `#${v.value}` : `%${v.name}`;
}

function exprKey(bop: string, left: IRValue, right: IRValue): string {
  return `${bop}|${operandKey(left)}|${operandKey(right)}`;
}

// Collects every register defined anywhere within `instrs` (recursively),
// mirroring constantFold.ts's collectDefs -- used to invalidate the
// enclosing list's available expressions after processing an if/while body.
function collectDefRegs(instrs: IRInstr[], out: Set<string>): void {
  for (const instr of instrs) {
    switch (instr.op) {
      case 'const':
      case 'move':
      case 'binop':
      case 'unop':
      case 'arrload':
        out.add(instr.dest);
        break;
      case 'call':
      case 'guard':
        if (instr.dest) out.add(instr.dest);
        break;
      case 'boundscheck':
      case 'arrstore':
      case 'return':
      case 'print':
        break;
      case 'if':
        collectDefRegs(instr.thenBody, out);
        if (instr.elseBody) collectDefRegs(instr.elseBody, out);
        break;
      case 'while':
        collectDefRegs(instr.condInstrs, out);
        collectDefRegs(instr.body, out);
        break;
    }
  }
}

function invalidate(avail: AvailEntry[], name: string): AvailEntry[] {
  return avail.filter((e) => e.dest !== name && e.leftReg !== name && e.rightReg !== name);
}

function cseList(instrs: IRInstr[]): IRInstr[] {
  let avail: AvailEntry[] = [];
  const out: IRInstr[] = [];

  for (const instr of instrs) {
    switch (instr.op) {
      case 'binop': {
        const key = exprKey(instr.bop, instr.left, instr.right);
        const hit = avail.find((e) => e.key === key);
        avail = invalidate(avail, instr.dest);
        if (hit) {
          out.push({ op: 'move', dest: instr.dest, src: { kind: 'reg', name: hit.dest, type: instr.type }, type: instr.type, pos: instr.pos });
        } else {
          out.push(instr);
          avail.push({
            key,
            dest: instr.dest,
            leftReg: instr.left.kind === 'reg' ? instr.left.name : null,
            rightReg: instr.right.kind === 'reg' ? instr.right.name : null,
          });
        }
        break;
      }
      case 'const':
      case 'move':
      case 'unop':
      case 'arrload':
        avail = invalidate(avail, instr.dest);
        out.push(instr);
        break;
      case 'call':
      case 'guard':
        if (instr.dest) avail = invalidate(avail, instr.dest);
        out.push(instr);
        break;
      case 'boundscheck':
      case 'arrstore':
      case 'return':
      case 'print':
        out.push(instr);
        break;
      case 'if': {
        const thenBody = cseList(instr.thenBody);
        const elseBody = instr.elseBody ? cseList(instr.elseBody) : null;
        out.push({ ...instr, thenBody, elseBody });
        const defs = new Set<string>();
        collectDefRegs(thenBody, defs);
        if (elseBody) collectDefRegs(elseBody, defs);
        for (const name of defs) avail = invalidate(avail, name);
        break;
      }
      case 'while': {
        const condInstrs = cseList(instr.condInstrs);
        const body = cseList(instr.body);
        out.push({ ...instr, condInstrs, body });
        const defs = new Set<string>();
        collectDefRegs(condInstrs, defs);
        collectDefRegs(body, defs);
        for (const name of defs) avail = invalidate(avail, name);
        break;
      }
    }
  }

  return out;
}

export function commonSubexprElimination(program: IRProgram): IRProgram {
  return { functions: program.functions.map((fn) => ({ ...fn, body: cseList(fn.body) })) };
}
