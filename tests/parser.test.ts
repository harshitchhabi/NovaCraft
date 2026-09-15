import * as fs from 'fs';
import * as path from 'path';
import { Lexer } from '../src/lexer';
import { Parser } from '../src/parser';
import { ErrorReporter } from '../src/errors';

function parseSource(source: string) {
  const reporter = new ErrorReporter();
  const tokens = new Lexer(source, reporter).tokenize();
  const program = new Parser(tokens, reporter).parseProgram();
  return { program, reporter };
}

function readExample(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf-8');
}

describe('Parser', () => {
  test('parses sumArray.min into a well-formed AST with no errors', () => {
    const { program, reporter } = parseSource(readExample('sumArray.min'));
    expect(reporter.hasErrors()).toBe(false);
    expect(program.functions.map((f) => f.name)).toEqual(['sumArray', 'main']);
  });

  test('parses fib.min into a well-formed AST with no errors', () => {
    const { program, reporter } = parseSource(readExample('fib.min'));
    expect(reporter.hasErrors()).toBe(false);
    expect(program.functions.map((f) => f.name)).toEqual(['fib', 'main']);
  });

  test('reports a Syntax error at the correct location for a missing semicolon, and recovers', () => {
    const source = `func main() -> int {
    let x: int = 5
    let y: int = 6;
    return 0;
}
`;
    const { reporter } = parseSource(source);
    expect(reporter.hasErrors()).toBe(true);
    const first = reporter.all()[0];
    expect(first.message).toMatch(/^Syntax error at 3:5 -/);
  });

  test('recovers from a syntax error and keeps parsing the rest of the file', () => {
    const source = `func broken() -> int {
    let x: int = ;
}

func fine() -> int {
    return 1;
}
`;
    const { program, reporter } = parseSource(source);
    expect(reporter.hasErrors()).toBe(true);
    // Recovery should still reach and parse the second function.
    expect(program.functions.some((f) => f.name === 'fine')).toBe(true);
  });
});
