// Prints a NovaCraft AST back to source. Binary and unary expressions are
// fully parenthesized, so the printed program parses to the same tree
// regardless of operator precedence.
import * as AST from '../../src/ast';

function typeStr(t: AST.NovaType): string {
  return AST.typeToString(t);
}

export function printExpr(e: AST.Expression): string {
  switch (e.kind) {
    case 'IntLiteral':
      return String(e.value);
    case 'FloatLiteral':
      return Number.isInteger(e.value) ? `${e.value}.0` : String(e.value);
    case 'BoolLiteral':
      return e.value ? 'true' : 'false';
    case 'VarRef':
      return e.name;
    case 'IndexExpr':
      return `${e.arrayName}[${printExpr(e.index)}]`;
    case 'CallExpr':
      return `${e.callee}(${e.args.map(printExpr).join(', ')})`;
    case 'UnaryExpr':
      return `(${e.op}${printExpr(e.operand)})`;
    case 'BinaryExpr':
      return `(${printExpr(e.left)} ${e.op} ${printExpr(e.right)})`;
  }
}

function printVarDecl(s: AST.VarDecl): string {
  return `let ${s.name}: ${typeStr(s.type)}${s.init ? ` = ${printExpr(s.init)}` : ''}`;
}

function printAssign(s: AST.AssignStmt): string {
  const target = s.target.index ? `${s.target.name}[${printExpr(s.target.index)}]` : s.target.name;
  return `${target} = ${printExpr(s.value)}`;
}

function printBlock(b: AST.Block, indent: string, out: string[]): void {
  for (const s of b.statements) printStmt(s, indent, out);
}

function printStmt(s: AST.Statement, indent: string, out: string[]): void {
  switch (s.kind) {
    case 'VarDecl':
      out.push(`${indent}${printVarDecl(s)};`);
      return;
    case 'AssignStmt':
      out.push(`${indent}${printAssign(s)};`);
      return;
    case 'IfStmt':
      out.push(`${indent}if (${printExpr(s.cond)}) {`);
      printBlock(s.thenBlock, indent + '    ', out);
      if (s.elseBlock) {
        out.push(`${indent}} else {`);
        printBlock(s.elseBlock, indent + '    ', out);
      }
      out.push(`${indent}}`);
      return;
    case 'WhileStmt':
      out.push(`${indent}while (${printExpr(s.cond)}) {`);
      printBlock(s.body, indent + '    ', out);
      out.push(`${indent}}`);
      return;
    case 'ForStmt':
      out.push(
        `${indent}for (${s.init ? printVarDecl(s.init) : ''}; ${printExpr(s.cond)}; ${s.update ? printAssign(s.update) : ''}) {`,
      );
      printBlock(s.body, indent + '    ', out);
      out.push(`${indent}}`);
      return;
    case 'ReturnStmt':
      out.push(`${indent}return${s.value ? ' ' + printExpr(s.value) : ''};`);
      return;
    case 'PrintStmt':
      out.push(`${indent}print(${printExpr(s.value)});`);
      return;
    case 'ExprStmt':
      out.push(`${indent}${printExpr(s.expr)};`);
      return;
  }
}

export function printProgram(p: AST.Program): string {
  const out: string[] = [];
  for (const f of p.functions) {
    const params = f.params.map((x) => `${x.name}: ${typeStr(x.type)}`).join(', ');
    out.push(`func ${f.name}(${params}) -> ${typeStr(f.returnType)} {`);
    printBlock(f.body, '    ', out);
    out.push('}', '');
  }
  return out.join('\n');
}
