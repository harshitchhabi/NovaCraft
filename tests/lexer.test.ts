import * as fs from 'fs';
import * as path from 'path';
import { Lexer } from '../src/lexer';
import { TokenType } from '../src/tokens';
import { ErrorReporter } from '../src/errors';

function readExample(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf-8');
}

describe('Lexer', () => {
  test('tokenizes sumArray.min with correct bracket tokens for array type/index syntax', () => {
    const source = readExample('sumArray.min');
    const reporter = new ErrorReporter();
    const tokens = new Lexer(source, reporter).tokenize();
    expect(reporter.hasErrors()).toBe(false);

    const bracketTokens = tokens.filter((t) => t.type === TokenType.LBRACKET || t.type === TokenType.RBRACKET);
    expect(bracketTokens.length).toBeGreaterThan(0);
    // `arr: int[]` in the parameter list produces adjacent '[' ']'.
    const idx = tokens.findIndex((t) => t.type === TokenType.LBRACKET);
    expect(tokens[idx].lexeme).toBe('[');
    expect(tokens[idx + 1].type).toBe(TokenType.RBRACKET);
    expect(tokens[idx + 1].lexeme).toBe(']');

    // `arr[i]` inside the loop body also produces '[' ']' around an expression.
    const idxTokens = tokens.filter((t) => t.type === TokenType.LBRACKET);
    expect(idxTokens.length).toBeGreaterThanOrEqual(2);
  });

  test('reports a lexical error with exact location for an illegal character', () => {
    const source = 'let x: int = 5 @ 3;\n';
    const reporter = new ErrorReporter();
    new Lexer(source, reporter).tokenize();
    expect(reporter.hasErrors()).toBe(true);
    const messages = reporter.all().map((e) => e.message);
    expect(messages).toContain("Lexical error at 1:16 - unexpected character '@'");
  });
});
