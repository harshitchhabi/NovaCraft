// Optimization pass 2: dead-code elimination.
//  (a) unreachable code after a `return` (including when both branches of an
//      `if` terminate, which makes code after the whole `if` unreachable too)
//  (b) assignments (const/move/binop/unop) to registers never read again,
//      iterated to a fixpoint so eliminating one dead assignment can expose
//      another (e.g. `let x = y + 1;` where `y` was itself dead).
import { IRInstr, IRValue, IRFunction, IRProgram } from '../ir';

function addUse(v: IRValue, used: Set<string>): void {
  if (v.kind === 'reg') used.add(v.name);
}

function collectUsed(instrs: IRInstr[], used: Set<string>): void {
  for (const instr of instrs) {
    switch (instr.op) {
      case 'const':
        break;
      case 'move':
        addUse(instr.src, used);
        break;
      case 'binop':
        addUse(instr.left, used);
        addUse(instr.right, used);
        break;
      case 'unop':
        addUse(instr.src, used);
        break;
      case 'boundscheck':
        addUse(instr.index, used);
        addUse(instr.length, used);
        break;
      case 'arrload':
        addUse(instr.base, used);
        addUse(instr.index, used);
        break;
      case 'arrstore':
        addUse(instr.base, used);
        addUse(instr.index, used);
        addUse(instr.value, used);
        break;
      case 'call':
        instr.args.forEach((a) => addUse(a, used));
        break;
      case 'return':
        if (instr.value) addUse(instr.value, used);
        break;
      case 'print':
        addUse(instr.value, used);
        break;
      case 'if':
        addUse(instr.cond, used);
        collectUsed(instr.thenBody, used);
        if (instr.elseBody) collectUsed(instr.elseBody, used);
        break;
      case 'while':
        collectUsed(instr.condInstrs, used);
        addUse(instr.cond, used);
        collectUsed(instr.body, used);
        break;
    }
  }
}

function pruneUnreachable(instrs: IRInstr[]): { instrs: IRInstr[]; terminates: boolean } {
  const out: IRInstr[] = [];
  let terminated = false;
  for (const instr of instrs) {
    if (terminated) break;
    if (instr.op === 'return') {
      out.push(instr);
      terminated = true;
      continue;
    }
    if (instr.op === 'if') {
      const thenR = pruneUnreachable(instr.thenBody);
      const elseR = instr.elseBody ? pruneUnreachable(instr.elseBody) : null;
      out.push({ ...instr, thenBody: thenR.instrs, elseBody: elseR ? elseR.instrs : null });
      if (thenR.terminates && elseR !== null && elseR.terminates) terminated = true;
      continue;
    }
    if (instr.op === 'while') {
      const bodyR = pruneUnreachable(instr.body);
      out.push({ ...instr, body: bodyR.instrs });
      continue;
    }
    out.push(instr);
  }
  return { instrs: out, terminates: terminated };
}

function filterDeadAssigns(instrs: IRInstr[], used: Set<string>): { instrs: IRInstr[]; changed: boolean } {
  const out: IRInstr[] = [];
  let changed = false;
  for (const instr of instrs) {
    if (
      (instr.op === 'const' || instr.op === 'move' || instr.op === 'binop' || instr.op === 'unop') &&
      !used.has(instr.dest)
    ) {
      changed = true;
      continue;
    }
    if (instr.op === 'if') {
      const t = filterDeadAssigns(instr.thenBody, used);
      const e = instr.elseBody ? filterDeadAssigns(instr.elseBody, used) : null;
      changed = changed || t.changed || (e ? e.changed : false);
      out.push({ ...instr, thenBody: t.instrs, elseBody: e ? e.instrs : null });
      continue;
    }
    if (instr.op === 'while') {
      const c = filterDeadAssigns(instr.condInstrs, used);
      const b = filterDeadAssigns(instr.body, used);
      changed = changed || c.changed || b.changed;
      out.push({ ...instr, condInstrs: c.instrs, body: b.instrs });
      continue;
    }
    out.push(instr);
  }
  return { instrs: out, changed };
}

function optimizeFunction(fn: IRFunction): IRFunction {
  let body = pruneUnreachable(fn.body).instrs;

  for (let iter = 0; iter < 10; iter++) {
    const used = new Set<string>();
    collectUsed(body, used);
    const result = filterDeadAssigns(body, used);
    body = result.instrs;
    if (!result.changed) break;
  }

  return { ...fn, body };
}

export function deadCodeElimination(program: IRProgram): IRProgram {
  return { functions: program.functions.map(optimizeFunction) };
}
