// Token definitions for NovaCraft.

export enum TokenType {
  // Keywords
  FUNC = 'FUNC',
  LET = 'LET',
  IF = 'IF',
  ELSE = 'ELSE',
  WHILE = 'WHILE',
  FOR = 'FOR',
  RETURN = 'RETURN',
  PRINT = 'PRINT',
  INT = 'INT',
  FLOAT = 'FLOAT',
  BOOL = 'BOOL',
  TRUE = 'TRUE',
  FALSE = 'FALSE',

  // Literals / identifiers
  IDENT = 'IDENT',
  INT_LIT = 'INT_LIT',
  FLOAT_LIT = 'FLOAT_LIT',

  // Operators
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  STAR = 'STAR',
  SLASH = 'SLASH',
  PERCENT = 'PERCENT',
  EQ_EQ = 'EQ_EQ',
  BANG_EQ = 'BANG_EQ',
  LT = 'LT',
  LT_EQ = 'LT_EQ',
  GT = 'GT',
  GT_EQ = 'GT_EQ',
  AMP_AMP = 'AMP_AMP',
  PIPE_PIPE = 'PIPE_PIPE',
  BANG = 'BANG',
  EQ = 'EQ',
  ARROW = 'ARROW',
  COLON = 'COLON',

  // Punctuation
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  LBRACE = 'LBRACE',
  RBRACE = 'RBRACE',
  LBRACKET = 'LBRACKET',
  RBRACKET = 'RBRACKET',
  COMMA = 'COMMA',
  SEMI = 'SEMI',

  EOF = 'EOF',
}

export const KEYWORDS: Record<string, TokenType> = {
  func: TokenType.FUNC,
  let: TokenType.LET,
  if: TokenType.IF,
  else: TokenType.ELSE,
  while: TokenType.WHILE,
  for: TokenType.FOR,
  return: TokenType.RETURN,
  print: TokenType.PRINT,
  int: TokenType.INT,
  float: TokenType.FLOAT,
  bool: TokenType.BOOL,
  true: TokenType.TRUE,
  false: TokenType.FALSE,
};

export interface Token {
  type: TokenType;
  lexeme: string;
  line: number;
  column: number;
}
