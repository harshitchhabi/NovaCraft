import { Token, TokenType } from './tokens';
import { CompilerError, ErrorReporter } from './errors';
import * as AST from './ast';

class ParseError extends Error {}

export class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[], private readonly reporter: ErrorReporter) {}

  parseProgram(): AST.Program {
    const functions: AST.FunctionDecl[] = [];
    while (!this.check(TokenType.EOF)) {
      try {
        functions.push(this.parseFunctionDecl());
      } catch (e) {
        if (e instanceof ParseError) {
          this.synchronizeTopLevel();
        } else {
          throw e;
        }
      }
    }
    return { functions };
  }

  // ---- helpers ----

  private peek(offset = 0): Token {
    const i = Math.min(this.pos + offset, this.tokens.length - 1);
    return this.tokens[i];
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private match(...types: TokenType[]): boolean {
    if (types.includes(this.peek().type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    const tok = this.peek();
    this.error(tok, message);
    throw new ParseError(message);
  }

  private error(tok: Token, message: string): void {
    this.reporter.report(new CompilerError('Syntax', tok.line, tok.column, message));
  }

  private pos_(tok: Token): AST.Pos {
    return { line: tok.line, column: tok.column };
  }

  // Panic-mode recovery: skip tokens until past the next ';' or '}' (or EOF).
  private synchronize(): void {
    while (!this.check(TokenType.EOF)) {
      const prev = this.peek();
      if (prev.type === TokenType.SEMI) {
        this.advance();
        return;
      }
      if (prev.type === TokenType.RBRACE) {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  private synchronizeTopLevel(): void {
    while (!this.check(TokenType.EOF) && !this.check(TokenType.FUNC)) {
      this.advance();
    }
  }

  // ---- grammar ----

  private parseType(): AST.NovaType {
    let base: AST.NovaType;
    if (this.match(TokenType.INT)) {
      base = AST.primType('int');
    } else if (this.match(TokenType.FLOAT)) {
      base = AST.primType('float');
    } else if (this.match(TokenType.BOOL)) {
      base = AST.primType('bool');
    } else {
      const tok = this.peek();
      this.error(tok, `expected type, got '${tok.lexeme || tok.type}'`);
      throw new ParseError('expected type');
    }
    while (this.check(TokenType.LBRACKET) && this.peek(1).type === TokenType.RBRACKET) {
      this.advance();
      this.advance();
      base = AST.arrayType(base);
    }
    return base;
  }

  private parseFunctionDecl(): AST.FunctionDecl {
    const funcTok = this.expect(TokenType.FUNC, "expected 'func'");
    const nameTok = this.expect(TokenType.IDENT, 'expected function name');
    this.expect(TokenType.LPAREN, "expected '(' after function name");
    const params: AST.Param[] = [];
    if (!this.check(TokenType.RPAREN)) {
      params.push(this.parseParam());
      while (this.match(TokenType.COMMA)) {
        params.push(this.parseParam());
      }
    }
    this.expect(TokenType.RPAREN, "expected ')' after parameters");
    this.expect(TokenType.ARROW, "expected '->' before return type");
    const returnType = this.parseType();
    const body = this.parseBlock();
    return { name: nameTok.lexeme, params, returnType, body, pos: this.pos_(funcTok) };
  }

  private parseParam(): AST.Param {
    const nameTok = this.expect(TokenType.IDENT, 'expected parameter name');
    this.expect(TokenType.COLON, "expected ':' after parameter name");
    const type = this.parseType();
    return { name: nameTok.lexeme, type, pos: this.pos_(nameTok) };
  }

  private parseBlock(): AST.Block {
    this.expect(TokenType.LBRACE, "expected '{'");
    const statements: AST.Statement[] = [];
    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      try {
        statements.push(this.parseStatement());
      } catch (e) {
        if (e instanceof ParseError) {
          this.synchronize();
        } else {
          throw e;
        }
      }
    }
    this.expect(TokenType.RBRACE, "expected '}'");
    return { statements };
  }

  private parseStatement(): AST.Statement {
    switch (this.peek().type) {
      case TokenType.LET:
        return this.parseVarDecl();
      case TokenType.IF:
        return this.parseIfStmt();
      case TokenType.WHILE:
        return this.parseWhileStmt();
      case TokenType.RETURN:
        return this.parseReturnStmt();
      case TokenType.PRINT:
        return this.parsePrintStmt();
      case TokenType.IDENT:
        return this.parseAssignOrExprStmt();
      default:
        return this.parseExprStmt();
    }
  }

  private parseVarDecl(): AST.VarDecl {
    const letTok = this.expect(TokenType.LET, "expected 'let'");
    const nameTok = this.expect(TokenType.IDENT, 'expected variable name');
    this.expect(TokenType.COLON, "expected ':' after variable name");
    const type = this.parseType();
    let init: AST.Expression | null = null;
    if (this.match(TokenType.EQ)) {
      init = this.parseExpression();
    }
    this.expect(TokenType.SEMI, "expected ';' after variable declaration");
    return { kind: 'VarDecl', name: nameTok.lexeme, type, init, pos: this.pos_(letTok) };
  }

  // IDENT could start either an assignment (lvalue = expr;) or an expression statement (call).
  private parseAssignOrExprStmt(): AST.Statement {
    const startTok = this.peek();
    const nameTok = this.expect(TokenType.IDENT, 'expected identifier');

    // Function call as an expression statement.
    if (this.check(TokenType.LPAREN)) {
      const call = this.finishCall(nameTok);
      const expr = this.parseBinaryTail(call, 0);
      this.expect(TokenType.SEMI, "expected ';' after expression");
      return { kind: 'ExprStmt', expr, pos: this.pos_(startTok) };
    }

    let index: AST.Expression | null = null;
    if (this.check(TokenType.LBRACKET)) {
      this.advance();
      index = this.parseExpression();
      this.expect(TokenType.RBRACKET, "expected ']' after array index");
    }

    if (this.check(TokenType.EQ)) {
      this.advance();
      const value = this.parseExpression();
      this.expect(TokenType.SEMI, "expected ';' after assignment");
      const lvalue: AST.LValue = { name: nameTok.lexeme, index, pos: this.pos_(nameTok) };
      return { kind: 'AssignStmt', target: lvalue, value, pos: this.pos_(startTok) };
    }

    // Not an assignment: treat as expression statement (variable ref or indexed read).
    let expr: AST.Expression = index
      ? { kind: 'IndexExpr', arrayName: nameTok.lexeme, index, pos: this.pos_(nameTok) }
      : { kind: 'VarRef', name: nameTok.lexeme, pos: this.pos_(nameTok) };
    expr = this.parseBinaryTail(expr, 0);
    this.expect(TokenType.SEMI, "expected ';' after expression");
    return { kind: 'ExprStmt', expr, pos: this.pos_(startTok) };
  }

  private parseIfStmt(): AST.IfStmt {
    const ifTok = this.expect(TokenType.IF, "expected 'if'");
    this.expect(TokenType.LPAREN, "expected '(' after 'if'");
    const cond = this.parseExpression();
    this.expect(TokenType.RPAREN, "expected ')' after condition");
    const thenBlock = this.parseBlock();
    let elseBlock: AST.Block | null = null;
    if (this.match(TokenType.ELSE)) {
      elseBlock = this.parseBlock();
    }
    return { kind: 'IfStmt', cond, thenBlock, elseBlock, pos: this.pos_(ifTok) };
  }

  private parseWhileStmt(): AST.WhileStmt {
    const whileTok = this.expect(TokenType.WHILE, "expected 'while'");
    this.expect(TokenType.LPAREN, "expected '(' after 'while'");
    const cond = this.parseExpression();
    this.expect(TokenType.RPAREN, "expected ')' after condition");
    const body = this.parseBlock();
    return { kind: 'WhileStmt', cond, body, pos: this.pos_(whileTok) };
  }

  private parseReturnStmt(): AST.ReturnStmt {
    const retTok = this.expect(TokenType.RETURN, "expected 'return'");
    let value: AST.Expression | null = null;
    if (!this.check(TokenType.SEMI)) {
      value = this.parseExpression();
    }
    this.expect(TokenType.SEMI, "expected ';' after return statement");
    return { kind: 'ReturnStmt', value, pos: this.pos_(retTok) };
  }

  private parsePrintStmt(): AST.PrintStmt {
    const printTok = this.expect(TokenType.PRINT, "expected 'print'");
    this.expect(TokenType.LPAREN, "expected '(' after 'print'");
    const value = this.parseExpression();
    this.expect(TokenType.RPAREN, "expected ')' after print argument");
    this.expect(TokenType.SEMI, "expected ';' after print statement");
    return { kind: 'PrintStmt', value, pos: this.pos_(printTok) };
  }

  private parseExprStmt(): AST.ExprStmt {
    const startTok = this.peek();
    const expr = this.parseExpression();
    this.expect(TokenType.SEMI, "expected ';' after expression");
    return { kind: 'ExprStmt', expr, pos: this.pos_(startTok) };
  }

  // ---- expressions: precedence climbing ----

  private static readonly BIN_PRECEDENCE: Partial<Record<TokenType, number>> = {
    [TokenType.PIPE_PIPE]: 1,
    [TokenType.AMP_AMP]: 2,
    [TokenType.EQ_EQ]: 3,
    [TokenType.BANG_EQ]: 3,
    [TokenType.LT]: 4,
    [TokenType.LT_EQ]: 4,
    [TokenType.GT]: 4,
    [TokenType.GT_EQ]: 4,
    [TokenType.PLUS]: 5,
    [TokenType.MINUS]: 5,
    [TokenType.STAR]: 6,
    [TokenType.SLASH]: 6,
    [TokenType.PERCENT]: 6,
  };

  private static readonly TOKEN_TO_OP: Partial<Record<TokenType, AST.BinaryExpr['op']>> = {
    [TokenType.PIPE_PIPE]: '||',
    [TokenType.AMP_AMP]: '&&',
    [TokenType.EQ_EQ]: '==',
    [TokenType.BANG_EQ]: '!=',
    [TokenType.LT]: '<',
    [TokenType.LT_EQ]: '<=',
    [TokenType.GT]: '>',
    [TokenType.GT_EQ]: '>=',
    [TokenType.PLUS]: '+',
    [TokenType.MINUS]: '-',
    [TokenType.STAR]: '*',
    [TokenType.SLASH]: '/',
    [TokenType.PERCENT]: '%',
  };

  parseExpression(): AST.Expression {
    const left = this.parseUnary();
    return this.parseBinaryTail(left, 0);
  }

  private parseBinaryTail(left: AST.Expression, minPrec: number): AST.Expression {
    for (;;) {
      const tokType = this.peek().type;
      const prec = Parser.BIN_PRECEDENCE[tokType];
      if (prec === undefined || prec < minPrec) return left;
      const opTok = this.advance();
      const op = Parser.TOKEN_TO_OP[tokType]!;
      let right = this.parseUnary();
      for (;;) {
        const nextType = this.peek().type;
        const nextPrec = Parser.BIN_PRECEDENCE[nextType];
        if (nextPrec === undefined || nextPrec <= prec) break;
        right = this.parseBinaryTail(right, nextPrec);
      }
      left = { kind: 'BinaryExpr', op, left, right, pos: this.pos_(opTok) };
    }
  }

  private parseUnary(): AST.Expression {
    const tok = this.peek();
    if (tok.type === TokenType.MINUS || tok.type === TokenType.BANG) {
      this.advance();
      const operand = this.parseUnary();
      return { kind: 'UnaryExpr', op: tok.type === TokenType.MINUS ? '-' : '!', operand, pos: this.pos_(tok) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AST.Expression {
    const tok = this.peek();
    switch (tok.type) {
      case TokenType.INT_LIT:
        this.advance();
        return { kind: 'IntLiteral', value: parseInt(tok.lexeme, 10), pos: this.pos_(tok) };
      case TokenType.FLOAT_LIT:
        this.advance();
        return { kind: 'FloatLiteral', value: parseFloat(tok.lexeme), pos: this.pos_(tok) };
      case TokenType.TRUE:
        this.advance();
        return { kind: 'BoolLiteral', value: true, pos: this.pos_(tok) };
      case TokenType.FALSE:
        this.advance();
        return { kind: 'BoolLiteral', value: false, pos: this.pos_(tok) };
      case TokenType.IDENT: {
        this.advance();
        if (this.check(TokenType.LPAREN)) {
          return this.finishCall(tok);
        }
        if (this.check(TokenType.LBRACKET)) {
          this.advance();
          const index = this.parseExpression();
          this.expect(TokenType.RBRACKET, "expected ']' after array index");
          return { kind: 'IndexExpr', arrayName: tok.lexeme, index, pos: this.pos_(tok) };
        }
        return { kind: 'VarRef', name: tok.lexeme, pos: this.pos_(tok) };
      }
      case TokenType.LPAREN: {
        this.advance();
        const expr = this.parseExpression();
        this.expect(TokenType.RPAREN, "expected ')' after expression");
        return expr;
      }
      default:
        this.error(tok, `unexpected token '${tok.lexeme || tok.type}' in expression`);
        throw new ParseError('unexpected token in expression');
    }
  }

  private finishCall(nameTok: Token): AST.CallExpr {
    this.expect(TokenType.LPAREN, "expected '(' in call");
    const args: AST.Expression[] = [];
    if (!this.check(TokenType.RPAREN)) {
      args.push(this.parseExpression());
      while (this.match(TokenType.COMMA)) {
        args.push(this.parseExpression());
      }
    }
    this.expect(TokenType.RPAREN, "expected ')' after arguments");
    return { kind: 'CallExpr', callee: nameTok.lexeme, args, pos: this.pos_(nameTok) };
  }
}
