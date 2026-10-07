// Provenance: which IR values are *external* (attacker/caller controlled).
//
// A value is external if it is a parameter of an entry-point function (one
// that no other function calls; `main` always counts) or depends on one
// through IR data flow: move, binop, unop, an array load whose base or index
// is external, or the result of a call to a function that can return an
// external value. Parameters of internally-called functions are external if
// the matching argument is external at any call site (context-insensitive).
// Everything is computed to a fixed point over the call graph.
//
// The analysis is flow-insensitive per register: a variable assigned
// several times is external if any assignment is. That over-approximates P,
// which can only raise a site's risk.
import { IRFunction, IRInstr, IRProgram, IRValue } from '../ir';

export interface Provenance {
  entryPoints: Set<string>;
  external: Map<string, Set<string>>; // function -> external registers
  returnsExternal: Set<string>;
}

function walk(instrs: IRInstr[], f: (i: IRInstr) => void): void {
  for (const i of instrs) {
    f(i);
    if (i.op === 'if') {
      walk(i.thenBody, f);
      if (i.elseBody) walk(i.elseBody, f);
    } else if (i.op === 'while') {
      walk(i.condInstrs, f);
      walk(i.body, f);
    }
  }
}

export function entryPoints(program: IRProgram): Set<string> {
  const calledByOthers = new Set<string>();
  for (const fn of program.functions) {
    walk(fn.body, (i) => {
      if (i.op === 'call' && i.func !== fn.name) calledByOthers.add(i.func);
    });
  }
  const out = new Set<string>();
  for (const fn of program.functions) {
    if (fn.name === 'main' || !calledByOthers.has(fn.name)) out.add(fn.name);
  }
  return out;
}

export function computeProvenance(program: IRProgram): Provenance {
  const entries = entryPoints(program);
  const byName = new Map<string, IRFunction>(program.functions.map((f) => [f.name, f]));
  const external = new Map<string, Set<string>>();
  for (const fn of program.functions) {
    external.set(fn.name, new Set(entries.has(fn.name) ? fn.params.map((p) => p.name) : []));
  }
  const returnsExternal = new Set<string>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of program.functions) {
      const ext = external.get(fn.name)!;
      const isExt = (v: IRValue) => v.kind === 'reg' && ext.has(v.name);
      const mark = (name: string) => {
        if (!ext.has(name)) {
          ext.add(name);
          changed = true;
        }
      };
      walk(fn.body, (i) => {
        switch (i.op) {
          case 'move':
            if (isExt(i.src)) mark(i.dest);
            break;
          case 'binop':
            if (isExt(i.left) || isExt(i.right)) mark(i.dest);
            break;
          case 'unop':
            if (isExt(i.src)) mark(i.dest);
            break;
          case 'arrload':
            if (isExt(i.base) || isExt(i.index)) mark(i.dest);
            break;
          case 'call': {
            if (i.dest && returnsExternal.has(i.func)) mark(i.dest);
            const callee = byName.get(i.func);
            if (callee) {
              const calleeExt = external.get(callee.name)!;
              i.args.forEach((a, k) => {
                const p = callee.params[k];
                if (p && isExt(a) && !calleeExt.has(p.name)) {
                  calleeExt.add(p.name);
                  changed = true;
                }
              });
            }
            break;
          }
          case 'return':
            if (i.value && isExt(i.value) && !returnsExternal.has(fn.name)) {
              returnsExternal.add(fn.name);
              changed = true;
            }
            break;
        }
      });
    }
  }
  return { entryPoints: entries, external, returnsExternal };
}

export function isExternal(prov: Provenance, fn: string, v: IRValue): boolean {
  return v.kind === 'reg' && (prov.external.get(fn)?.has(v.name) ?? false);
}
