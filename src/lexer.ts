import { Token, TokenType, KEYWORDS } from './tokens';
import { CompilerError, ErrorReporter } from './errors';

const isDigit = (c: string) => c >= '0' && c <= '9';
const isAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isAlphaNumeric = (c: string) => isAlpha(c) || isDigit(c);

export class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;
  private tokens: Token[] = [];

  constructor(private readonly source: string, private readonly reporter: ErrorReporter) {}

  tokenize(): Token[] {
    while (!this.atEnd()) {
      this.scanToken();
    }
    this.tokens.push({ type: TokenType.EOF, lexeme: '', line: this.line, column: this.column });
    return this.tokens;
  }

  private atEnd(): boolean {
    return this.pos >= this.source.length;
  }

  private peek(offset = 0): string {
    const i = this.pos + offset;
    return i < this.source.length ? this.source[i] : '\0';
  }

  private advance(): string {
    const c = this.source[this.pos++];
    if (c === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return c;
  }

  private match(expected: string): boolean {
    if (this.atEnd() || this.source[this.pos] !== expected) return false;
    this.advance();
    return true;
  }

  private addToken(type: TokenType, lexeme: string, line: number, column: number): void {
    this.tokens.push({ type, lexeme, line, column });
  }

  private scanToken(): void {
    const c = this.peek();

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      this.advance();
      return;
    }

    // Comments
    if (c === '/' && this.peek(1) === '/') {
      while (!this.atEnd() && this.peek() !== '\n') this.advance();
      return;
    }

    const startLine = this.line;
    const startCol = this.column;

    if (isDigit(c)) {
      this.scanNumber(startLine, startCol);
      return;
    }

    if (isAlpha(c)) {
      this.scanIdentifier(startLine, startCol);
      return;
    }

    this.advance();
    switch (c) {
      case '(':
        this.addToken(TokenType.LPAREN, c, startLine, startCol);
        return;
      case ')':
        this.addToken(TokenType.RPAREN, c, startLine, startCol);
        return;
      case '{':
        this.addToken(TokenType.LBRACE, c, startLine, startCol);
        return;
      case '}':
        this.addToken(TokenType.RBRACE, c, startLine, startCol);
        return;
      case '[':
        this.addToken(TokenType.LBRACKET, c, startLine, startCol);
        return;
      case ']':
        this.addToken(TokenType.RBRACKET, c, startLine, startCol);
        return;
      case ',':
        this.addToken(TokenType.COMMA, c, startLine, startCol);
        return;
      case ';':
        this.addToken(TokenType.SEMI, c, startLine, startCol);
        return;
      case ':':
        this.addToken(TokenType.COLON, c, startLine, startCol);
        return;
      case '+':
        this.addToken(TokenType.PLUS, c, startLine, startCol);
        return;
      case '-':
        if (this.match('>')) {
          this.addToken(TokenType.ARROW, '->', startLine, startCol);
        } else {
          this.addToken(TokenType.MINUS, c, startLine, startCol);
        }
        return;
      case '*':
        this.addToken(TokenType.STAR, c, startLine, startCol);
        return;
      case '/':
        this.addToken(TokenType.SLASH, c, startLine, startCol);
        return;
      case '%':
        this.addToken(TokenType.PERCENT, c, startLine, startCol);
        return;
      case '=':
        if (this.match('=')) {
          this.addToken(TokenType.EQ_EQ, '==', startLine, startCol);
        } else {
          this.addToken(TokenType.EQ, c, startLine, startCol);
        }
        return;
      case '!':
        if (this.match('=')) {
          this.addToken(TokenType.BANG_EQ, '!=', startLine, startCol);
        } else {
          this.addToken(TokenType.BANG, c, startLine, startCol);
        }
        return;
      case '<':
        if (this.match('=')) {
          this.addToken(TokenType.LT_EQ, '<=', startLine, startCol);
        } else {
          this.addToken(TokenType.LT, c, startLine, startCol);
        }
        return;
      case '>':
        if (this.match('=')) {
          this.addToken(TokenType.GT_EQ, '>=', startLine, startCol);
        } else {
          this.addToken(TokenType.GT, c, startLine, startCol);
        }
        return;
      case '&':
        if (this.match('&')) {
          this.addToken(TokenType.AMP_AMP, '&&', startLine, startCol);
        } else {
          this.reporter.report(
            new CompilerError('Lexical', startLine, startCol, `unexpected character '${c}'`),
          );
        }
        return;
      case '|':
        if (this.match('|')) {
          this.addToken(TokenType.PIPE_PIPE, '||', startLine, startCol);
        } else {
          this.reporter.report(
            new CompilerError('Lexical', startLine, startCol, `unexpected character '${c}'`),
          );
        }
        return;
      default:
        this.reporter.report(
          new CompilerError('Lexical', startLine, startCol, `unexpected character '${c}'`),
        );
        return;
    }
  }

  private scanNumber(startLine: number, startCol: number): void {
    let text = '';
    while (isDigit(this.peek())) text += this.advance();
    let isFloat = false;
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      isFloat = true;
      text += this.advance(); // '.'
      while (isDigit(this.peek())) text += this.advance();
    }
    this.addToken(isFloat ? TokenType.FLOAT_LIT : TokenType.INT_LIT, text, startLine, startCol);
  }

  private scanIdentifier(startLine: number, startCol: number): void {
    let text = '';
    while (isAlphaNumeric(this.peek())) text += this.advance();
    const type = KEYWORDS[text] ?? TokenType.IDENT;
    this.addToken(type, text, startLine, startCol);
  }
}
