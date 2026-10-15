// Mutation operators (docs/PREREGISTRATION.md, "Mutation corpus").
//
// Every operator is enumerated over the kernel's entry function on the
// original AST, recording a path to the node it changes; a variant is made by
// deep-cloning the program and replacing the node at that path. Each variant
// carries exactly one mutation.
import * as AST from '../../src/ast';

export type Path = Array<string | number>;

export interface Mutation {
  operator: string;
  path: Path; // from the FunctionDecl
  line: number;
  column: number;
  detail: string;
  replace: (node: unknown) => unknown; // new node for the one at `path`
}

const one = (pos: AST.Pos): AST.IntLiteral => ({ kind: 'IntLiteral', value: 1, pos });
const bin = (op: AST.BinaryExpr['op'], left: AST.Expression, right: AST.Expression, pos: AST.Pos): AST.BinaryExpr => ({
  kind: 'BinaryExpr',
  op,
  left,
  right,
  pos,
});
const ref = (name: string, pos: AST.Pos): AST.VarRef => ({ kind: 'VarRef', name, pos });

const RELATIONAL = new Set(['<', '<=', '>', '>=', '==', '!=']);

interface Scope {
  ints: string[]; // int variables (params and locals) visible here, in declaration order
}

export interface FnInfo {
  fn: AST.FunctionDecl;
  intParams: string[];
  lengthParams: string[]; // int parameter directly after an array parameter
  arrayLength: Map<string, string>;
  loopCondVars: Set<string>;
}

export function fnInfo(fn: AST.FunctionDecl): FnInfo {
  const intParams = fn.params.filter((p) => p.type.kind === 'primitive' && p.type.name === 'int').map((p) => p.name);
  const lengthParams: string[] = [];
  const arrayLength = new Map<string, string>();
  fn.params.forEach((p, k) => {
    const next = fn.params[k + 1];
    if (p.type.kind === 'array' && next && next.type.kind === 'primitive' && next.type.name === 'int') {
      lengthParams.push(next.name);
      arrayLength.set(p.name, next.name);
    }
  });
  const loopCondVars = new Set<string>();
  const collectVars = (e: AST.Expression) => walkExpr(e, (x) => x.kind === 'VarRef' && loopCondVars.add(x.name));
  const visit = (b: AST.Block) => {
    for (const s of b.statements) {
      if (s.kind === 'WhileStmt') {
        collectVars(s.cond);
        visit(s.body);
      } else if (s.kind === 'ForStmt') {
        collectVars(s.cond);
        visit(s.body);
      } else if (s.kind === 'IfStmt') {
        visit(s.thenBlock);
        if (s.elseBlock) visit(s.elseBlock);
      }
    }
  };
  visit(fn.body);
  return { fn, intParams, lengthParams, arrayLength, loopCondVars };
}

function walkExpr(e: AST.Expression, f: (e: AST.Expression) => void): void {
  f(e);
  switch (e.kind) {
    case 'IndexExpr':
      walkExpr(e.index, f);
      break;
    case 'CallExpr':
      e.args.forEach((a) => walkExpr(a, f));
      break;
    case 'UnaryExpr':
      walkExpr(e.operand, f);
      break;
    case 'BinaryExpr':
      walkExpr(e.left, f);
      walkExpr(e.right, f);
      break;
  }
}

function hasArrayAccess(b: AST.Block): boolean {
  let found = false;
  const ex = (e: AST.Expression | null) => e && walkExpr(e, (x) => x.kind === 'IndexExpr' && (found = true));
  const st = (s: AST.Statement): void => {
    switch (s.kind) {
      case 'VarDecl':
        ex(s.init);
        break;
      case 'AssignStmt':
        if (s.target.index) found = true;
        ex(s.value);
        break;
      case 'IfStmt':
        ex(s.cond);
        s.thenBlock.statements.forEach(st);
        s.elseBlock?.statements.forEach(st);
        break;
      case 'WhileStmt':
        ex(s.cond);
        s.body.statements.forEach(st);
        break;
      case 'ForStmt':
        if (s.init) st(s.init);
        ex(s.cond);
        if (s.update) st(s.update);
        s.body.statements.forEach(st);
        break;
      case 'ReturnStmt':
        ex(s.value);
        break;
      case 'PrintStmt':
        ex(s.value);
        break;
      case 'ExprStmt':
        ex(s.expr);
        break;
    }
  };
  b.statements.forEach(st);
  return found;
}

function isIntExpr(e: AST.Expression, scope: Scope): boolean {
  switch (e.kind) {
    case 'IntLiteral':
      return true;
    case 'VarRef':
      return scope.ints.includes(e.name);
    case 'IndexExpr':
      return true; // all kernels' arrays are int[]
    case 'UnaryExpr':
      return e.op === '-' && isIntExpr(e.operand, scope);
    case 'BinaryExpr':
      return ['+', '-', '*', '/', '%'].includes(e.op) && isIntExpr(e.left, scope) && isIntExpr(e.right, scope);
    default:
      return false;
  }
}

export interface EnumerateOptions {
  fallback: string[]; // fallback operators enabled: 'if-lt-to-le', 'index-is-length', 'minus-one-drop'
}

export function enumerate(info: FnInfo, opts: EnumerateOptions = { fallback: [] }): Mutation[] {
  const out: Mutation[] = [];
  const add = (operator: string, path: Path, pos: AST.Pos, detail: string, replace: Mutation['replace']) =>
    out.push({ operator, path, line: pos.line, column: pos.column, detail, replace });

  // Expressions in a loop condition: lt-to-le, bound-plus-one.
  const loopCond = (e: AST.Expression, path: Path) => {
    const rec = (x: AST.Expression, p: Path) => {
      if (x.kind === 'BinaryExpr') {
        if (x.op === '<') add('lt-to-le', p, x.pos, '< to <=', (n) => ({ ...(n as AST.BinaryExpr), op: '<=' }));
        rec(x.left, [...p, 'left']);
        rec(x.right, [...p, 'right']);
      } else if (x.kind === 'VarRef' && info.lengthParams.includes(x.name)) {
        add('bound-plus-one', p, x.pos, `${x.name} to ${x.name} + 1`, (n) => bin('+', n as AST.Expression, one(x.pos), x.pos));
      } else if (x.kind === 'UnaryExpr') rec(x.operand, [...p, 'operand']);
    };
    rec(e, path);
  };

  // An index expression: offsets and variable swaps.
  const indexExpr = (e: AST.Expression, path: Path, scope: Scope, isWrite: boolean, arrayName: string, pos: AST.Pos) => {
    add('index-plus-one', path, pos, `${arrayName}[e] to ${arrayName}[e + 1]`, (n) => bin('+', n as AST.Expression, one(pos), pos));
    add('index-minus-one', path, pos, `${arrayName}[e] to ${arrayName}[e - 1]`, (n) => bin('-', n as AST.Expression, one(pos), pos));
    // Variable occurrences in this index, not inside a nested index (those
    // are handled when the nested access is visited).
    const rec = (x: AST.Expression, p: Path) => {
      if (x.kind === 'VarRef' && scope.ints.includes(x.name)) {
        for (const other of scope.ints) {
          if (other === x.name) continue;
          add('swap-index-var', p, x.pos, `${x.name} to ${other} in ${arrayName}[...]`, () => ref(other, x.pos));
        }
      } else if (x.kind === 'BinaryExpr') {
        rec(x.left, [...p, 'left']);
        rec(x.right, [...p, 'right']);
      } else if (x.kind === 'UnaryExpr') rec(x.operand, [...p, 'operand']);
    };
    rec(e, path);
    if (isWrite) {
      for (const prm of info.intParams) {
        add('write-index-external', path, pos, `${arrayName}[e] = ... to ${arrayName}[${prm}] = ...`, () => ref(prm, pos));
      }
    }
    if (opts.fallback.includes('index-is-length')) {
      const len = info.arrayLength.get(arrayName);
      if (len) add('index-is-length', path, pos, `${arrayName}[e] to ${arrayName}[${len}]`, () => ref(len, pos));
    }
  };

  // Any expression: index sites, length swaps, minus-one-drop.
  const expr = (e: AST.Expression, path: Path, scope: Scope) => {
    switch (e.kind) {
      case 'VarRef':
        if (info.lengthParams.includes(e.name)) {
          for (const other of info.lengthParams) {
            if (other !== e.name) add('swap-length', path, e.pos, `${e.name} to ${other}`, () => ref(other, e.pos));
          }
        }
        break;
      case 'IndexExpr':
        indexExpr(e.index, [...path, 'index'], scope, false, e.arrayName, e.pos);
        expr(e.index, [...path, 'index'], scope);
        break;
      case 'CallExpr':
        e.args.forEach((a, k) => expr(a, [...path, 'args', k], scope));
        break;
      case 'UnaryExpr':
        expr(e.operand, [...path, 'operand'], scope);
        break;
      case 'BinaryExpr':
        if (opts.fallback.includes('minus-one-drop') && e.op === '-' && e.right.kind === 'IntLiteral' && e.right.value === 1) {
          add('minus-one-drop', path, e.pos, 'x - 1 to x', (n) => (n as AST.BinaryExpr).left);
        }
        expr(e.left, [...path, 'left'], scope);
        expr(e.right, [...path, 'right'], scope);
        break;
    }
  };

  const varDecl = (s: AST.VarDecl, path: Path, scope: Scope) => {
    if (s.init) expr(s.init, [...path, 'init'], scope);
    const isInt = s.type.kind === 'primitive' && s.type.name === 'int';
    if (isInt && s.init && s.init.kind === 'IntLiteral' && s.init.value === 0 && info.loopCondVars.has(s.name)) {
      add('start-minus-one', [...path, 'init'], s.pos, `${s.name} = 0 to ${s.name} = -1`, () => ({
        kind: 'UnaryExpr',
        op: '-',
        operand: one(s.pos),
        pos: s.pos,
      }));
    }
    if (isInt) scope.ints.push(s.name);
  };

  const assign = (s: AST.AssignStmt, path: Path, scope: Scope) => {
    expr(s.value, [...path, 'value'], scope);
    if (s.target.index) {
      indexExpr(s.target.index, [...path, 'target', 'index'], scope, true, s.target.name, s.target.pos);
      expr(s.target.index, [...path, 'target', 'index'], scope);
    }
  };

  const block = (b: AST.Block, path: Path, outer: Scope) => {
    const scope: Scope = { ints: [...outer.ints] };
    b.statements.forEach((s, k) => stmt(s, [...path, 'statements', k], scope));
  };

  const stmt = (s: AST.Statement, path: Path, scope: Scope) => {
    switch (s.kind) {
      case 'VarDecl':
        varDecl(s, path, scope);
        break;
      case 'AssignStmt':
        assign(s, path, scope);
        break;
      case 'IfStmt': {
        expr(s.cond, [...path, 'cond'], scope);
        const c = s.cond;
        if (c.kind === 'BinaryExpr' && RELATIONAL.has(c.op) && isIntExpr(c.left, scope) && isIntExpr(c.right, scope)) {
          const thenAcc = hasArrayAccess(s.thenBlock);
          const elseAcc = s.elseBlock ? hasArrayAccess(s.elseBlock) : false;
          const always = (b: AST.Block) => (n: unknown) => ({
            ...(n as AST.IfStmt),
            cond: { kind: 'BoolLiteral', value: true, pos: s.pos } as AST.BoolLiteral,
            thenBlock: JSON.parse(JSON.stringify(b)),
            elseBlock: null,
          });
          if (!s.elseBlock) add('remove-guard', path, s.pos, 'if (c) {A} to A', always(s.thenBlock));
          else if (thenAcc && !elseAcc) add('remove-guard', path, s.pos, 'if (c) {A} else {B} to A', always(s.thenBlock));
          else if (elseAcc && !thenAcc) add('remove-guard', path, s.pos, 'if (c) {A} else {B} to B', always(s.elseBlock));
          if (opts.fallback.includes('if-lt-to-le') && c.op === '<') {
            add('if-lt-to-le', [...path, 'cond'], c.pos, 'if < to <=', (n) => ({ ...(n as AST.BinaryExpr), op: '<=' }));
          }
        }
        block(s.thenBlock, [...path, 'thenBlock'], scope);
        if (s.elseBlock) block(s.elseBlock, [...path, 'elseBlock'], scope);
        break;
      }
      case 'WhileStmt':
        loopCond(s.cond, [...path, 'cond']);
        expr(s.cond, [...path, 'cond'], scope);
        block(s.body, [...path, 'body'], scope);
        break;
      case 'ForStmt': {
        const inner: Scope = { ints: [...scope.ints] };
        if (s.init) varDecl(s.init, [...path, 'init'], inner);
        loopCond(s.cond, [...path, 'cond']);
        expr(s.cond, [...path, 'cond'], inner);
        block(s.body, [...path, 'body'], inner);
        if (s.update) assign(s.update, [...path, 'update'], inner);
        break;
      }
      case 'ReturnStmt':
        if (s.value) expr(s.value, [...path, 'value'], scope);
        break;
      case 'PrintStmt':
        expr(s.value, [...path, 'value'], scope);
        break;
      case 'ExprStmt':
        expr(s.expr, [...path, 'expr'], scope);
        break;
    }
  };

  block(info.fn.body, ['body'], { ints: [...info.intParams] });
  return out;
}

export function apply(program: AST.Program, fnName: string, m: Mutation): AST.Program {
  const clone: AST.Program = JSON.parse(JSON.stringify(program));
  const fn = clone.functions.find((f) => f.name === fnName)!;
  let parent: Record<string | number, unknown> = fn as unknown as Record<string, unknown>;
  for (const key of m.path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  const last = m.path[m.path.length - 1];
  parent[last] = m.replace(parent[last]);
  return clone;
}
