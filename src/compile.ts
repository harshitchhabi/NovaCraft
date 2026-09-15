// Shared compile pipeline, factored out of cli.ts so both the CLI and other
// consumers (the benchmark script, tests) can run the same stages without
// duplicating them.
import { Lexer } from './lexer';
import { Parser } from './parser';
import { SemanticAnalyzer } from './semantic';
import { generateIR, IRProgram } from './ir';
import { constantFold } from './optimize/constantFold';
import { deadCodeElimination } from './optimize/deadCode';
import { rangeAnalysis } from './optimize/rangeAnalysis';
import { generateModule } from './codegen';
import { CodegenResult } from './codegen';
import { ErrorReporter, CompilerError } from './errors';
import * as AST from './ast';

export interface CompileOptions {
  regBudget?: number;
  // Skips the range-analysis (bounds-check elimination) pass, leaving every
  // inserted BoundsCheck in place. Exists so the benchmark script can
  // measure the elimination pass's real impact by compiling the same
  // program both with and without it.
  skipRangeAnalysis?: boolean;
}

export interface IRStage {
  label: string;
  ir: IRProgram;
}

export interface CompileResult {
  program: AST.Program;
  stages: IRStage[];
  finalIR: IRProgram;
  codegen: CodegenResult;
}

export class CompileError extends Error {
  constructor(public readonly errors: CompilerError[]) {
    super(errors.map((e) => e.message).join('\n'));
  }
}

export function compileProgram(source: string, opts: CompileOptions = {}): CompileResult {
  const regBudget = opts.regBudget ?? 4;
  const reporter = new ErrorReporter();

  const tokens = new Lexer(source, reporter).tokenize();
  const program = new Parser(tokens, reporter).parseProgram();
  if (reporter.hasErrors()) throw new CompileError(reporter.all());

  new SemanticAnalyzer(reporter).analyze(program);
  if (reporter.hasErrors()) throw new CompileError(reporter.all());

  let ir = generateIR(program);
  const stages: IRStage[] = [{ label: 'IR (initial, after BoundsCheck insertion)', ir }];

  ir = constantFold(ir);
  stages.push({ label: 'after constant folding', ir });

  ir = deadCodeElimination(ir);
  stages.push({ label: 'after dead-code elimination', ir });

  if (!opts.skipRangeAnalysis) {
    ir = rangeAnalysis(ir);
    stages.push({ label: 'after range analysis (bounds-check elimination)', ir });
  }

  const codegen = generateModule(ir, regBudget);
  return { program, stages, finalIR: ir, codegen };
}
