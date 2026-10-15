// Three-address IR for NovaCraft.
//
// Design note (documented in DEVLOG.md): control flow (`if`/`while`) is kept
// *structured* in the IR -- an IfInstr carries nested thenBody/elseBody
// instruction lists, and a WhileInstr carries a nested body list -- rather
// than being flattened to labels/gotos. This is because (a) it maps losslessly
// onto WebAssembly's structured block/loop/br_if control flow, which is the
// codegen target, (b) the required range-analysis fixed-point iteration is
// naturally expressed as "iterate over this loop's body list", and (c) linear
// scan register allocation still applies: a separate flattening pass assigns
// each instruction a linear program-point index for computing live ranges,
// while the nested shape is preserved for codegen and optimization.
import * as AST from './ast';
import { NovaType } from './ast';

export type IRPrimType = 'int' | 'float' | 'bool';

export function toIRType(t: NovaType): IRPrimType {
  if (t.kind === 'array') return 'int'; // arrays are represented as an i32 base address
  return t.name;
}

export type IRValue =
  | { kind: 'reg'; name: string; type: IRPrimType }
  | { kind: 'imm'; value: number; type: IRPrimType };

export function reg(name: string, type: IRPrimType): IRValue {
  return { kind: 'reg', name, type };
}
export function imm(value: number, type: IRPrimType): IRValue {
  return { kind: 'imm', value, type };
}

export interface Pos {
  line: number;
  column: number;
}

export type BinOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';

// Per-site hardening decision (src/harden). Absent on IR that has not been
// through the hardening pass, in which case `eliminated` alone decides.
export type Decision = 'eliminate' | 'hoist' | 'retain' | 'omit';

// One conjunct of a loop-versioning guard: lhs + lhsAdd <= rhs + rhsAdd,
// evaluated in exact (64-bit) arithmetic so it cannot wrap.
export interface GuardTerm {
  lhs: IRValue;
  lhsAdd: number;
  rhs: IRValue;
  rhsAdd: number;
}

export type IRInstr =
  | { op: 'const'; dest: string; value: number; type: IRPrimType; pos: Pos }
  | { op: 'binop'; dest: string; bop: BinOp; left: IRValue; right: IRValue; type: IRPrimType; pos: Pos }
  | { op: 'unop'; dest: string; uop: '-' | '!'; src: IRValue; type: IRPrimType; pos: Pos }
  | { op: 'move'; dest: string; src: IRValue; type: IRPrimType; pos: Pos }
  | {
      op: 'boundscheck';
      id: number;
      index: IRValue;
      length: IRValue;
      arrayName: string;
      access: 'read' | 'write';
      pos: Pos;
      eliminated?: boolean; // range analysis proved both bounds
      provenLo?: boolean; // range analysis proved index >= 0
      provenHi?: boolean; // range analysis proved index < length
      decision?: Decision;
      fastPath?: boolean; // inside the fast copy of a versioned loop
    }
  | { op: 'arrload'; dest: string; base: IRValue; index: IRValue; type: IRPrimType; pos: Pos }
  | { op: 'arrstore'; base: IRValue; index: IRValue; value: IRValue; type: IRPrimType; pos: Pos }
  | { op: 'call'; dest: string | null; func: string; args: IRValue[]; type: IRPrimType | null; pos: Pos }
  | { op: 'return'; value: IRValue | null; pos: Pos }
  | { op: 'print'; value: IRValue; pos: Pos }
  | { op: 'if'; cond: IRValue; thenBody: IRInstr[]; elseBody: IRInstr[] | null; pos: Pos }
  | { op: 'while'; condInstrs: IRInstr[]; cond: IRValue; body: IRInstr[]; pos: Pos }
  | { op: 'guard'; dest: string; terms: GuardTerm[]; pos: Pos };

// Whether codegen emits a runtime test for this BoundsCheck.
export function checkEmitted(i: Extract<IRInstr, { op: 'boundscheck' }>): boolean {
  if (i.decision === undefined) return !i.eliminated;
  if (i.decision === 'retain') return true;
  if (i.decision === 'hoist') return !i.fastPath;
  return false;
}

export interface IRParam {
  name: string;
  type: IRPrimType;
  isArray: boolean;
}

export interface IRFunction {
  name: string;
  params: IRParam[];
  returnType: IRPrimType;
  body: IRInstr[];
  arrayLength: Map<string, string>; // array param name -> length param name (adjacent-param convention)
  boundsChecksInserted: number;
}

export interface IRProgram {
  functions: IRFunction[];
}

class FuncIRGen {
  private tempCounter = 0;
  private nameCounts = new Map<string, number>();
  private scopes: Array<Map<string, { irName: string; type: IRPrimType }>> = [];
  private arrayLength = new Map<string, string>();
  boundsChecksInserted = 0;

  constructor(private readonly fn: AST.FunctionDecl, private readonly idCounter: { next: number }) {}

  private pushScope(): void {
    this.scopes.push(new Map());
  }
  private popScope(): void {
    this.scopes.pop();
  }
  private declareVar(name: string, type: IRPrimType): string {
    const count = this.nameCounts.get(name) ?? 0;
    const irName = count === 0 ? name : `${name}_${count}`;
    this.nameCounts.set(name, count + 1);
    this.scopes[this.scopes.length - 1].set(name, { irName, type });
    return irName;
  }
  private resolveVar(name: string): { irName: string; type: IRPrimType } {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i].get(name);
      if (found) return found;
    }
    throw new Error(`internal error: unresolved variable '${name}' (semantic analysis should have caught this)`);
  }
  private freshTemp(): string {
    return `%t${this.tempCounter++}`;
  }

  generate(): IRFunction {
    // Establish the adjacent-param array-length convention (see §3 of the spec):
    // an `arr: T[]` parameter's length is the *next* parameter, when it is `int`.
    for (let i = 0; i < this.fn.params.length - 1; i++) {
      const p = this.fn.params[i];
      const next = this.fn.params[i + 1];
      if (p.type.kind === 'array' && next.type.kind === 'primitive' && next.type.name === 'int') {
        this.arrayLength.set(p.name, next.name);
      }
    }

    this.pushScope();
    const irParams: IRParam[] = this.fn.params.map((p) => {
      const type = toIRType(p.type);
      const irName = this.declareVar(p.name, type);
      return { name: irName, type, isArray: p.type.kind === 'array' };
    });

    const body = this.genBlock(this.fn.body);
    this.popScope();

    return {
      name: this.fn.name,
      params: irParams,
      returnType: toIRType(this.fn.returnType),
      body,
      arrayLength: this.arrayLength,
      boundsChecksInserted: this.boundsChecksInserted,
    };
  }

  private genBlock(block: AST.Block): IRInstr[] {
    this.pushScope();
    const instrs: IRInstr[] = [];
    for (const stmt of block.statements) {
      this.genStatement(stmt, instrs);
    }
    this.popScope();
    return instrs;
  }

  private genStatement(stmt: AST.Statement, out: IRInstr[]): void {
    switch (stmt.kind) {
      case 'VarDecl': {
        const type = toIRType(stmt.type);
        const irName = this.declareVar(stmt.name, type);
        if (stmt.init) {
          const val = this.genExpr(stmt.init, out);
          out.push({ op: 'move', dest: irName, src: val, type, pos: stmt.pos });
        } else {
          out.push({ op: 'const', dest: irName, value: 0, type, pos: stmt.pos });
        }
        return;
      }
      case 'AssignStmt': {
        const value = this.genExpr(stmt.value, out);
        if (stmt.target.index) {
          const info = this.resolveVar(stmt.target.name);
          const idx = this.genExpr(stmt.target.index, out);
          this.emitBoundsCheck(stmt.target.name, idx, stmt.target.pos, 'write', out);
          out.push({
            op: 'arrstore',
            base: reg(info.irName, info.type),
            index: idx,
            value,
            type: value.type,
            pos: stmt.pos,
          });
        } else {
          const info = this.resolveVar(stmt.target.name);
          out.push({ op: 'move', dest: info.irName, src: value, type: info.type, pos: stmt.pos });
        }
        return;
      }
      case 'IfStmt': {
        const cond = this.genExpr(stmt.cond, out);
        const thenBody = this.genBlock(stmt.thenBlock);
        const elseBody = stmt.elseBlock ? this.genBlock(stmt.elseBlock) : null;
        out.push({ op: 'if', cond, thenBody, elseBody, pos: stmt.pos });
        return;
      }
      case 'WhileStmt': {
        // condInstrs recomputes the condition each iteration (mirrors a wasm loop
        // re-checking its condition at the top); body is the loop body IR.
        const condInstrs: IRInstr[] = [];
        const cond = this.genExpr(stmt.cond, condInstrs);
        const body = this.genBlock(stmt.body);
        out.push({ op: 'while', condInstrs, cond, body, pos: stmt.pos });
        return;
      }
      case 'ForStmt': {
        // Desugars to the existing `while` IR node -- a for-loop is just a
        // while-loop with a scoped init and an update appended to the body,
        // so every downstream pass (range analysis, regalloc, codegen)
        // handles it for free with no new IR shape.
        this.pushScope();
        if (stmt.init) this.genStatement(stmt.init, out);
        const condInstrs: IRInstr[] = [];
        const cond = this.genExpr(stmt.cond, condInstrs);
        const body = this.genBlock(stmt.body);
        if (stmt.update) this.genStatement(stmt.update, body);
        out.push({ op: 'while', condInstrs, cond, body, pos: stmt.pos });
        this.popScope();
        return;
      }
      case 'ReturnStmt': {
        const value = stmt.value ? this.genExpr(stmt.value, out) : null;
        out.push({ op: 'return', value, pos: stmt.pos });
        return;
      }
      case 'PrintStmt': {
        const value = this.genExpr(stmt.value, out);
        out.push({ op: 'print', value, pos: stmt.pos });
        return;
      }
      case 'ExprStmt': {
        this.genExpr(stmt.expr, out);
        return;
      }
    }
  }

  private emitBoundsCheck(arrayName: string, index: IRValue, pos: AST.Pos, access: 'read' | 'write', out: IRInstr[]): void {
    const lengthParamName = this.arrayLength.get(arrayName);
    const lengthInfo = lengthParamName ? this.resolveVar(lengthParamName) : null;
    const length: IRValue = lengthInfo ? reg(lengthInfo.irName, lengthInfo.type) : imm(0, 'int');
    this.boundsChecksInserted++;
    out.push({
      op: 'boundscheck',
      id: this.idCounter.next++,
      index,
      length,
      arrayName,
      access,
      pos: { line: pos.line, column: pos.column },
    });
  }

  private genExpr(expr: AST.Expression, out: IRInstr[]): IRValue {
    switch (expr.kind) {
      case 'IntLiteral':
        return imm(expr.value, 'int');
      case 'FloatLiteral':
        return imm(expr.value, 'float');
      case 'BoolLiteral':
        return imm(expr.value ? 1 : 0, 'bool');
      case 'VarRef': {
        const info = this.resolveVar(expr.name);
        return reg(info.irName, info.type);
      }
      case 'IndexExpr': {
        const info = this.resolveVar(expr.arrayName);
        const idx = this.genExpr(expr.index, out);
        this.emitBoundsCheck(expr.arrayName, idx, expr.pos, 'read', out);
        const dest = this.freshTemp();
        const elemType = toIRType(expr.type!);
        out.push({
          op: 'arrload',
          dest,
          base: reg(info.irName, info.type),
          index: idx,
          type: elemType,
          pos: expr.pos,
        });
        return reg(dest, elemType);
      }
      case 'CallExpr': {
        const args = expr.args.map((a) => this.genExpr(a, out));
        const retType = expr.type ? toIRType(expr.type) : null;
        const dest = retType ? this.freshTemp() : null;
        out.push({ op: 'call', dest, func: expr.callee, args, type: retType, pos: expr.pos });
        return dest ? reg(dest, retType!) : imm(0, 'int');
      }
      case 'UnaryExpr': {
        const src = this.genExpr(expr.operand, out);
        const dest = this.freshTemp();
        const type = toIRType(expr.type!);
        out.push({ op: 'unop', dest, uop: expr.op, src, type, pos: expr.pos });
        return reg(dest, type);
      }
      case 'BinaryExpr': {
        const left = this.genExpr(expr.left, out);
        const right = this.genExpr(expr.right, out);
        const dest = this.freshTemp();
        const type = toIRType(expr.type!);
        out.push({ op: 'binop', dest, bop: expr.op, left, right, type, pos: expr.pos });
        return reg(dest, type);
      }
    }
  }
}

export function generateIR(program: AST.Program): IRProgram {
  const idCounter = { next: 0 };
  const functions = program.functions.map((fn) => new FuncIRGen(fn, idCounter).generate());
  return { functions };
}

// ---- pretty printer (used by --emit-ir) ----

function valStr(v: IRValue): string {
  return v.kind === 'reg' ? v.name : String(v.value);
}

export function printInstr(instr: IRInstr, indent: string, lines: string[]): void {
  switch (instr.op) {
    case 'const':
      lines.push(`${indent}${instr.dest} = const ${instr.value} : ${instr.type}`);
      return;
    case 'binop':
      lines.push(`${indent}${instr.dest} = ${valStr(instr.left)} ${instr.bop} ${valStr(instr.right)} : ${instr.type}`);
      return;
    case 'unop':
      lines.push(`${indent}${instr.dest} = ${instr.uop}${valStr(instr.src)} : ${instr.type}`);
      return;
    case 'move':
      lines.push(`${indent}${instr.dest} = ${valStr(instr.src)} : ${instr.type}`);
      return;
    case 'boundscheck': {
      let note = instr.eliminated ? ' ; ELIMINATED' : '';
      if (instr.decision) note = ` ; ${instr.decision.toUpperCase()}${instr.fastPath ? ' (fast path: no check)' : ''}`;
      lines.push(
        `${indent}BoundsCheck#${instr.id}(${valStr(instr.index)}, ${valStr(instr.length)}) [${instr.arrayName}, ${instr.access}]${note} @${instr.pos.line}:${instr.pos.column}`,
      );
      return;
    }
    case 'guard': {
      const t = instr.terms.map(
        (g) => `${valStr(g.lhs)}${g.lhsAdd ? ` + ${g.lhsAdd}` : ''} <= ${valStr(g.rhs)}${g.rhsAdd ? ` + ${g.rhsAdd}` : ''}`,
      );
      lines.push(`${indent}${instr.dest} = guard64(${t.join(' && ')})`);
      return;
    }
    case 'arrload':
      lines.push(`${indent}${instr.dest} = load ${valStr(instr.base)}[${valStr(instr.index)}] : ${instr.type}`);
      return;
    case 'arrstore':
      lines.push(`${indent}store ${valStr(instr.base)}[${valStr(instr.index)}] = ${valStr(instr.value)} : ${instr.type}`);
      return;
    case 'call':
      lines.push(
        `${indent}${instr.dest ? instr.dest + ' = ' : ''}call ${instr.func}(${instr.args.map(valStr).join(', ')})`,
      );
      return;
    case 'return':
      lines.push(`${indent}return${instr.value ? ' ' + valStr(instr.value) : ''}`);
      return;
    case 'print':
      lines.push(`${indent}print(${valStr(instr.value)})`);
      return;
    case 'if':
      lines.push(`${indent}if (${valStr(instr.cond)}) {`);
      for (const i of instr.thenBody) printInstr(i, indent + '  ', lines);
      if (instr.elseBody) {
        lines.push(`${indent}} else {`);
        for (const i of instr.elseBody) printInstr(i, indent + '  ', lines);
      }
      lines.push(`${indent}}`);
      return;
    case 'while':
      lines.push(`${indent}while {`);
      for (const i of instr.condInstrs) printInstr(i, indent + '  ', lines);
      lines.push(`${indent}  <cond = ${valStr(instr.cond)}>`);
      for (const i of instr.body) printInstr(i, indent + '  ', lines);
      lines.push(`${indent}}`);
      return;
  }
}

export function printFunction(fn: IRFunction): string {
  const lines: string[] = [];
  lines.push(`func ${fn.name}(${fn.params.map((p) => `${p.name}: ${p.type}${p.isArray ? '[]' : ''}`).join(', ')}) -> ${fn.returnType} {`);
  for (const i of fn.body) printInstr(i, '  ', lines);
  lines.push('}');
  return lines.join('\n');
}

export function printProgram(prog: IRProgram): string {
  return prog.functions.map(printFunction).join('\n\n');
}

// ---- bounds-check stats ----

export interface FunctionBoundsStats {
  name: string;
  inserted: number; // distinct BoundsCheck sites (a versioned loop's two copies count once)
  retained: number; // sites with a runtime check on every path (decision 'retain', or not eliminated)
  eliminated: number;
  hoisted: number;
  omitted: number;
}

export interface BoundsStats {
  perFunction: FunctionBoundsStats[];
  totalInserted: number;
  totalRetained: number;
  totalHoisted: number;
  totalOmitted: number;
}

function collectSites(instrs: IRInstr[], out: Map<number, Extract<IRInstr, { op: 'boundscheck' }>>): void {
  for (const instr of instrs) {
    if (instr.op === 'boundscheck') {
      if (!out.has(instr.id)) out.set(instr.id, instr);
    } else if (instr.op === 'if') {
      collectSites(instr.thenBody, out);
      if (instr.elseBody) collectSites(instr.elseBody, out);
    } else if (instr.op === 'while') {
      collectSites(instr.condInstrs, out);
      collectSites(instr.body, out);
    }
  }
}

export function computeBoundsStats(prog: IRProgram): BoundsStats {
  const perFunction = prog.functions.map((fn) => {
    const sites = new Map<number, Extract<IRInstr, { op: 'boundscheck' }>>();
    collectSites(fn.body, sites);
    const st: FunctionBoundsStats = { name: fn.name, inserted: 0, retained: 0, eliminated: 0, hoisted: 0, omitted: 0 };
    for (const s of sites.values()) {
      st.inserted++;
      const d: Decision = s.decision ?? (s.eliminated ? 'eliminate' : 'retain');
      if (d === 'retain') st.retained++;
      else if (d === 'eliminate') st.eliminated++;
      else if (d === 'hoist') st.hoisted++;
      else st.omitted++;
    }
    return st;
  });
  const sum = (k: keyof Omit<FunctionBoundsStats, 'name'>) => perFunction.reduce((a, f) => a + f[k], 0);
  return {
    perFunction,
    totalInserted: sum('inserted'),
    totalRetained: sum('retained'),
    totalHoisted: sum('hoisted'),
    totalOmitted: sum('omitted'),
  };
}

function statsLine(label: string, inserted: number, retained: number, hoisted: number, omitted: number): string {
  const pct = inserted === 0 ? 100 : Math.round(((inserted - retained - hoisted - omitted) / inserted) * 100);
  const extra = hoisted || omitted ? `, ${hoisted} hoisted, ${omitted} omitted` : '';
  return `Bounds checks [${label}]: ${inserted} inserted, ${retained} retained${extra} (${pct}% eliminated)`;
}

export function formatBoundsStats(stats: BoundsStats): string {
  const lines = stats.perFunction.map((f) => statsLine(f.name, f.inserted, f.retained, f.hoisted, f.omitted));
  lines.push(statsLine('total', stats.totalInserted, stats.totalRetained, stats.totalHoisted, stats.totalOmitted));
  return lines.join('\n');
}
