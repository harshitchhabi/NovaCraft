import * as fs from 'fs';
import * as path from 'path';
import { Lexer } from '../src/lexer';
import { Parser } from '../src/parser';
import { SemanticAnalyzer } from '../src/semantic';
import { ErrorReporter } from '../src/errors';

function checkSource(source: string) {
  const reporter = new ErrorReporter();
  const tokens = new Lexer(source, reporter).tokenize();
  const program = new Parser(tokens, reporter).parseProgram();
  if (!reporter.hasErrors()) {
    new SemanticAnalyzer(reporter).analyze(program);
  }
  return reporter;
}

function readExample(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf-8');
}

describe('Semantic analysis', () => {
  test('rejects assigning a bool to an int variable', () => {
    const reporter = checkSource(`
      func main() -> int {
        let x: int = true;
        return 0;
      }
    `);
    expect(reporter.hasErrors()).toBe(true);
    expect(reporter.all().some((e) => e.message.startsWith('Semantic error'))).toBe(true);
  });

  test('rejects use of an undeclared identifier', () => {
    const reporter = checkSource(`
      func main() -> int {
        return y;
      }
    `);
    expect(reporter.hasErrors()).toBe(true);
    expect(reporter.all()[0].message).toMatch(/undeclared identifier 'y'/);
  });

  test('sumArray.min passes semantic analysis with no errors', () => {
    const reporter = checkSource(readExample('sumArray.min'));
    expect(reporter.hasErrors()).toBe(false);
  });

  test('fib.min passes semantic analysis with no errors', () => {
    const reporter = checkSource(readExample('fib.min'));
    expect(reporter.hasErrors()).toBe(false);
  });

  test('rejects a function missing a return on some path', () => {
    const reporter = checkSource(`
      func f(x: int) -> int {
        if (x < 0) {
          return 0;
        }
      }
      func main() -> int { return 0; }
    `);
    expect(reporter.hasErrors()).toBe(true);
    expect(reporter.all().some((e) => /missing a return/.test(e.message))).toBe(true);
  });
});
