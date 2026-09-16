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

  test('parses a `for` loop into a ForStmt with init/cond/update/body', () => {
    const source = `func main() -> int {
    let total: int = 0;
    for (let i: int = 0; i < 10; i = i + 1) {
        total = total + i;
    }
    return total;
}
`;
    const { program, reporter } = parseSource(source);
    expect(reporter.hasErrors()).toBe(false);
    const body = program.functions[0].body.statements;
    const forStmt = body.find((s) => s.kind === 'ForStmt');
    expect(forStmt).toBeDefined();
    if (forStmt?.kind === 'ForStmt') {
      expect(forStmt.init?.name).toBe('i');
      expect(forStmt.update?.target.name).toBe('i');
    }
  });

  test('parses `else if` as a nested IfStmt inside the elseBlock', () => {
    const source = `func classify(x: int) -> int {
    if (x < 0) {
        return 0;
    } else if (x == 0) {
        return 1;
    } else {
        return 2;
    }
}
`;
    const { program, reporter } = parseSource(source);
    expect(reporter.hasErrors()).toBe(false);
    const outer = program.functions[0].body.statements[0];
    expect(outer.kind).toBe('IfStmt');
    if (outer.kind === 'IfStmt') {
      const nested = outer.elseBlock?.statements[0];
      expect(nested?.kind).toBe('IfStmt');
    }
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
