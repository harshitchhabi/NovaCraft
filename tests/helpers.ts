import * as fs from 'fs';
import * as path from 'path';
import { Lexer } from '../src/lexer';
import { Parser } from '../src/parser';
import { SemanticAnalyzer } from '../src/semantic';
import { generateIR, IRProgram } from '../src/ir';
import { constantFold } from '../src/optimize/constantFold';
import { deadCodeElimination } from '../src/optimize/deadCode';
import { rangeAnalysis } from '../src/optimize/rangeAnalysis';
import { generateModule } from '../src/codegen';
import { ErrorReporter } from '../src/errors';
import * as AST from '../src/ast';

export function readExample(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf-8');
}

// Compiles source through lexing -> parsing -> semantic analysis, throwing
// with all collected diagnostics if any stage fails. Returns the checked AST.
export function frontend(source: string): AST.Program {
  const reporter = new ErrorReporter();
  const tokens = new Lexer(source, reporter).tokenize();
  const program = new Parser(tokens, reporter).parseProgram();
  if (reporter.hasErrors()) {
    throw new Error('frontend errors:\n' + reporter.all().map((e) => e.message).join('\n'));
  }
  new SemanticAnalyzer(reporter).analyze(program);
  if (reporter.hasErrors()) {
    throw new Error('semantic errors:\n' + reporter.all().map((e) => e.message).join('\n'));
  }
  return program;
}

export function toIR(source: string): IRProgram {
  return generateIR(frontend(source));
}

export function toIRFromExample(name: string): IRProgram {
  return toIR(readExample(name));
}

export function optimizeIR(ir: IRProgram): IRProgram {
  return rangeAnalysis(deadCodeElimination(constantFold(ir)));
}

export function compileToModule(source: string, regBudget = 4) {
  const ir = optimizeIR(generateIR(frontend(source)));
  return generateModule(ir, regBudget);
}

export function compileExampleToModule(name: string, regBudget = 4) {
  return compileToModule(readExample(name), regBudget);
}
