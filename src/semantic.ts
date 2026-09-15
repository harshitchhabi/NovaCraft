import * as AST from './ast';
import { CompilerError, ErrorReporter } from './errors';
import { typesEqual, typeToString, primType, NovaType } from './ast';

interface VarInfo {
  type: NovaType;
}

class Scope {
  private vars = new Map<string, VarInfo>();
  constructor(public readonly parent: Scope | null) {}

  declare(name: string, info: VarInfo): boolean {
    if (this.vars.has(name)) return false;
    this.vars.set(name, info);
    return true;
  }

  declaredHere(name: string): boolean {
    return this.vars.has(name);
  }

  lookup(name: string): VarInfo | null {
    if (this.vars.has(name)) return this.vars.get(name)!;
    return this.parent ? this.parent.lookup(name) : null;
  }
}

export interface FunctionSig {
  name: string;
  params: AST.Param[];
  returnType: NovaType;
}

export class SemanticAnalyzer {
  private functions = new Map<string, FunctionSig>();
  private currentReturnType: NovaType | null = null;

  constructor(private readonly reporter: ErrorReporter) {}

  analyze(program: AST.Program): void {
    // First pass: register function signatures (allows forward reference / recursion).
    for (const fn of program.functions) {
      if (this.functions.has(fn.name)) {
        this.err(fn.pos, `function '${fn.name}' is already declared`);
        continue;
      }
      this.functions.set(fn.name, { name: fn.name, params: fn.params, returnType: fn.returnType });
    }

    if (!this.functions.has('main')) {
      this.err({ line: 1, column: 1 }, "missing required 'main' function");
    }

    for (const fn of program.functions) {
      this.checkFunction(fn);
    }
  }

  private err(pos: AST.Pos, message: string): void {
    this.reporter.report(new CompilerError('Semantic', pos.line, pos.column, message));
  }

  private checkFunction(fn: AST.FunctionDecl): void {
    const scope = new Scope(null);
    for (const p of fn.params) {
      if (!scope.declare(p.name, { type: p.type })) {
        this.err(p.pos, `parameter '${p.name}' is already declared`);
      }
    }
    this.currentReturnType = fn.returnType;
    const returns = this.checkBlock(fn.body, scope);
    if (fn.returnType.kind !== 'primitive' || true) {
      // any return type (including non-void) requires all paths to return
      if (!returns) {
        this.err(fn.pos, `function '${fn.name}' is missing a return on some path`);
      }
    }
    this.currentReturnType = null;
  }

  // Returns true if the block is guaranteed to return on every path.
  private checkBlock(block: AST.Block, parentScope: Scope): boolean {
    const scope = new Scope(parentScope);
    let returns = false;
    for (const stmt of block.statements) {
      if (this.checkStatement(stmt, scope)) {
        returns = true;
      }
    }
    return returns;
  }

  private checkStatement(stmt: AST.Statement, scope: Scope): boolean {
    switch (stmt.kind) {
      case 'VarDecl':
        return this.checkVarDecl(stmt, scope);
      case 'AssignStmt':
        return this.checkAssignStmt(stmt, scope);
      case 'IfStmt':
        return this.checkIfStmt(stmt, scope);
      case 'WhileStmt':
        return this.checkWhileStmt(stmt, scope);
      case 'ReturnStmt':
        return this.checkReturnStmt(stmt, scope);
      case 'PrintStmt':
        this.checkExpr(stmt.value, scope);
        return false;
      case 'ExprStmt':
        this.checkExpr(stmt.expr, scope);
        return false;
    }
  }

  private checkVarDecl(stmt: AST.VarDecl, scope: Scope): boolean {
    if (scope.declaredHere(stmt.name)) {
      this.err(stmt.pos, `variable '${stmt.name}' is already declared in this scope`);
    } else {
      scope.declare(stmt.name, { type: stmt.type });
    }
    if (stmt.init) {
      const initType = this.checkExpr(stmt.init, scope);
      if (initType && !typesEqual(initType, stmt.type)) {
        this.err(
          stmt.pos,
          `cannot assign value of type '${typeToString(initType)}' to variable '${stmt.name}' of type '${typeToString(stmt.type)}'`,
        );
      }
    }
    return false;
  }

  private checkAssignStmt(stmt: AST.AssignStmt, scope: Scope): boolean {
    const info = scope.lookup(stmt.target.name);
    if (!info) {
      this.err(stmt.target.pos, `undeclared identifier '${stmt.target.name}'`);
      this.checkExpr(stmt.value, scope);
      if (stmt.target.index) this.checkExpr(stmt.target.index, scope);
      return false;
    }
    let targetType: NovaType | null = info.type;
    if (stmt.target.index) {
      if (info.type.kind !== 'array') {
        this.err(stmt.target.pos, `cannot index non-array variable '${stmt.target.name}'`);
        targetType = null;
      } else {
        targetType = info.type.elem;
      }
      const idxType = this.checkExpr(stmt.target.index, scope);
      if (idxType && !typesEqual(idxType, primType('int'))) {
        this.err(stmt.target.pos, `array index must be of type 'int', got '${typeToString(idxType)}'`);
      }
    } else if (info.type.kind === 'array') {
      this.err(stmt.target.pos, `cannot assign directly to array variable '${stmt.target.name}'`);
      targetType = null;
    }
    const valueType = this.checkExpr(stmt.value, scope);
    if (targetType && valueType && !typesEqual(targetType, valueType)) {
      this.err(
        stmt.pos,
        `cannot assign value of type '${typeToString(valueType)}' to target of type '${typeToString(targetType)}'`,
      );
    }
    return false;
  }

  private checkIfStmt(stmt: AST.IfStmt, scope: Scope): boolean {
    const condType = this.checkExpr(stmt.cond, scope);
    if (condType && !typesEqual(condType, primType('bool'))) {
      this.err(stmt.pos, `'if' condition must be of type 'bool', got '${typeToString(condType)}'`);
    }
    const thenReturns = this.checkBlock(stmt.thenBlock, scope);
    const elseReturns = stmt.elseBlock ? this.checkBlock(stmt.elseBlock, scope) : false;
    return thenReturns && elseReturns && stmt.elseBlock !== null;
  }

  private checkWhileStmt(stmt: AST.WhileStmt, scope: Scope): boolean {
    const condType = this.checkExpr(stmt.cond, scope);
    if (condType && !typesEqual(condType, primType('bool'))) {
      this.err(stmt.pos, `'while' condition must be of type 'bool', got '${typeToString(condType)}'`);
    }
    this.checkBlock(stmt.body, scope);
    // A while loop cannot statically guarantee a return (may not execute).
    return false;
  }

  private checkReturnStmt(stmt: AST.ReturnStmt, scope: Scope): boolean {
    const expected = this.currentReturnType!;
    if (stmt.value === null) {
      this.err(stmt.pos, `missing return value, expected type '${typeToString(expected)}'`);
      return true;
    }
    const actual = this.checkExpr(stmt.value, scope);
    if (actual && !typesEqual(actual, expected)) {
      this.err(
        stmt.pos,
        `return type mismatch: expected '${typeToString(expected)}', got '${typeToString(actual)}'`,
      );
    }
    return true;
  }

  private checkExpr(expr: AST.Expression, scope: Scope): NovaType | null {
    switch (expr.kind) {
      case 'IntLiteral':
        expr.type = primType('int');
        return expr.type;
      case 'FloatLiteral':
        expr.type = primType('float');
        return expr.type;
      case 'BoolLiteral':
        expr.type = primType('bool');
        return expr.type;
      case 'VarRef': {
        const info = scope.lookup(expr.name);
        if (!info) {
          this.err(expr.pos, `undeclared identifier '${expr.name}'`);
          return null;
        }
        expr.type = info.type;
        return info.type;
      }
      case 'IndexExpr': {
        const info = scope.lookup(expr.arrayName);
        const idxType = this.checkExpr(expr.index, scope);
        if (idxType && !typesEqual(idxType, primType('int'))) {
          this.err(expr.pos, `array index must be of type 'int', got '${typeToString(idxType)}'`);
        }
        if (!info) {
          this.err(expr.pos, `undeclared identifier '${expr.arrayName}'`);
          return null;
        }
        if (info.type.kind !== 'array') {
          this.err(expr.pos, `cannot index non-array variable '${expr.arrayName}'`);
          return null;
        }
        expr.type = info.type.elem;
        return info.type.elem;
      }
      case 'CallExpr': {
        const sig = this.functions.get(expr.callee);
        if (!sig) {
          this.err(expr.pos, `call to undeclared function '${expr.callee}'`);
          for (const a of expr.args) this.checkExpr(a, scope);
          return null;
        }
        if (expr.args.length !== sig.params.length) {
          this.err(
            expr.pos,
            `function '${expr.callee}' expects ${sig.params.length} argument(s), got ${expr.args.length}`,
          );
        }
        const n = Math.min(expr.args.length, sig.params.length);
        for (let i = 0; i < n; i++) {
          const argType = this.checkExpr(expr.args[i], scope);
          if (argType && !typesEqual(argType, sig.params[i].type)) {
            this.err(
              expr.args[i].pos,
              `argument ${i + 1} to '${expr.callee}' has type '${typeToString(argType)}', expected '${typeToString(sig.params[i].type)}'`,
            );
          }
        }
        for (let i = n; i < expr.args.length; i++) this.checkExpr(expr.args[i], scope);
        expr.type = sig.returnType;
        return sig.returnType;
      }
      case 'UnaryExpr': {
        const operandType = this.checkExpr(expr.operand, scope);
        if (!operandType) return null;
        if (expr.op === '-') {
          if (!typesEqual(operandType, primType('int')) && !typesEqual(operandType, primType('float'))) {
            this.err(expr.pos, `unary '-' requires numeric operand, got '${typeToString(operandType)}'`);
            return null;
          }
          expr.type = operandType;
          return operandType;
        } else {
          if (!typesEqual(operandType, primType('bool'))) {
            this.err(expr.pos, `unary '!' requires 'bool' operand, got '${typeToString(operandType)}'`);
            return null;
          }
          expr.type = primType('bool');
          return expr.type;
        }
      }
      case 'BinaryExpr':
        return this.checkBinary(expr, scope);
    }
  }

  private checkBinary(expr: AST.BinaryExpr, scope: Scope): NovaType | null {
    const leftType = this.checkExpr(expr.left, scope);
    const rightType = this.checkExpr(expr.right, scope);
    if (!leftType || !rightType) return null;

    const arithmetic = ['+', '-', '*', '/', '%'];
    const comparison = ['<', '<=', '>', '>='];
    const equality = ['==', '!='];
    const logical = ['&&', '||'];

    if (arithmetic.includes(expr.op)) {
      if (expr.op === '%') {
        if (!typesEqual(leftType, primType('int')) || !typesEqual(rightType, primType('int'))) {
          this.err(expr.pos, `operator '%' requires 'int' operands, got '${typeToString(leftType)}' and '${typeToString(rightType)}'`);
          return null;
        }
        expr.type = primType('int');
        return expr.type;
      }
      const numeric = (t: NovaType) => typesEqual(t, primType('int')) || typesEqual(t, primType('float'));
      if (!numeric(leftType) || !numeric(rightType)) {
        this.err(expr.pos, `operator '${expr.op}' requires numeric operands, got '${typeToString(leftType)}' and '${typeToString(rightType)}'`);
        return null;
      }
      if (!typesEqual(leftType, rightType)) {
        this.err(expr.pos, `operator '${expr.op}' operand type mismatch: '${typeToString(leftType)}' vs '${typeToString(rightType)}'`);
        return null;
      }
      expr.type = leftType;
      return leftType;
    }

    if (comparison.includes(expr.op)) {
      const numeric = (t: NovaType) => typesEqual(t, primType('int')) || typesEqual(t, primType('float'));
      if (!numeric(leftType) || !numeric(rightType) || !typesEqual(leftType, rightType)) {
        this.err(expr.pos, `operator '${expr.op}' requires matching numeric operands, got '${typeToString(leftType)}' and '${typeToString(rightType)}'`);
        return null;
      }
      expr.type = primType('bool');
      return expr.type;
    }

    if (equality.includes(expr.op)) {
      if (!typesEqual(leftType, rightType)) {
        this.err(expr.pos, `operator '${expr.op}' requires operands of the same type, got '${typeToString(leftType)}' and '${typeToString(rightType)}'`);
        return null;
      }
      expr.type = primType('bool');
      return expr.type;
    }

    if (logical.includes(expr.op)) {
      if (!typesEqual(leftType, primType('bool')) || !typesEqual(rightType, primType('bool'))) {
        this.err(expr.pos, `operator '${expr.op}' requires 'bool' operands, got '${typeToString(leftType)}' and '${typeToString(rightType)}'`);
        return null;
      }
      expr.type = primType('bool');
      return expr.type;
    }

    return null;
  }
}
