// AST node definitions for NovaCraft.

export type PrimType = 'int' | 'float' | 'bool';

export interface ArrayType {
  kind: 'array';
  elem: NovaType;
}

export interface PrimitiveType {
  kind: 'primitive';
  name: PrimType;
}

export type NovaType = PrimitiveType | ArrayType;

export function primType(name: PrimType): PrimitiveType {
  return { kind: 'primitive', name };
}

export function arrayType(elem: NovaType): ArrayType {
  return { kind: 'array', elem };
}

export function typeToString(t: NovaType): string {
  if (t.kind === 'primitive') return t.name;
  return `${typeToString(t.elem)}[]`;
}

export function typesEqual(a: NovaType, b: NovaType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'primitive' && b.kind === 'primitive') return a.name === b.name;
  if (a.kind === 'array' && b.kind === 'array') return typesEqual(a.elem, b.elem);
  return false;
}

export interface Pos {
  line: number;
  column: number;
}

export interface Program {
  functions: FunctionDecl[];
}

export interface Param {
  name: string;
  type: NovaType;
  pos: Pos;
}

export interface FunctionDecl {
  name: string;
  params: Param[];
  returnType: NovaType;
  body: Block;
  pos: Pos;
}

export interface Block {
  statements: Statement[];
}

export type Statement =
  | VarDecl
  | AssignStmt
  | IfStmt
  | WhileStmt
  | ReturnStmt
  | PrintStmt
  | ExprStmt;

export interface VarDecl {
  kind: 'VarDecl';
  name: string;
  type: NovaType;
  init: Expression | null;
  pos: Pos;
}

export interface LValue {
  name: string;
  index: Expression | null; // non-null for arr[i]
  pos: Pos;
}

export interface AssignStmt {
  kind: 'AssignStmt';
  target: LValue;
  value: Expression;
  pos: Pos;
}

export interface IfStmt {
  kind: 'IfStmt';
  cond: Expression;
  thenBlock: Block;
  elseBlock: Block | null;
  pos: Pos;
}

export interface WhileStmt {
  kind: 'WhileStmt';
  cond: Expression;
  body: Block;
  pos: Pos;
}

export interface ReturnStmt {
  kind: 'ReturnStmt';
  value: Expression | null;
  pos: Pos;
}

export interface PrintStmt {
  kind: 'PrintStmt';
  value: Expression;
  pos: Pos;
}

export interface ExprStmt {
  kind: 'ExprStmt';
  expr: Expression;
  pos: Pos;
}

export type Expression =
  | IntLiteral
  | FloatLiteral
  | BoolLiteral
  | VarRef
  | IndexExpr
  | CallExpr
  | UnaryExpr
  | BinaryExpr;

export interface IntLiteral {
  kind: 'IntLiteral';
  value: number;
  pos: Pos;
  type?: NovaType;
}

export interface FloatLiteral {
  kind: 'FloatLiteral';
  value: number;
  pos: Pos;
  type?: NovaType;
}

export interface BoolLiteral {
  kind: 'BoolLiteral';
  value: boolean;
  pos: Pos;
  type?: NovaType;
}

export interface VarRef {
  kind: 'VarRef';
  name: string;
  pos: Pos;
  type?: NovaType;
}

export interface IndexExpr {
  kind: 'IndexExpr';
  arrayName: string;
  index: Expression;
  pos: Pos;
  type?: NovaType;
}

export interface CallExpr {
  kind: 'CallExpr';
  callee: string;
  args: Expression[];
  pos: Pos;
  type?: NovaType;
}

export interface UnaryExpr {
  kind: 'UnaryExpr';
  op: '-' | '!';
  operand: Expression;
  pos: Pos;
  type?: NovaType;
}

export interface BinaryExpr {
  kind: 'BinaryExpr';
  op: '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';
  left: Expression;
  right: Expression;
  pos: Pos;
  type?: NovaType;
}
