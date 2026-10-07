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
import { commonSubexprElimination } from './optimize/cse';
import { generateModule } from './codegen';
import { harden, HardeningReport } from './harden/harden';
import { DEFAULT_POLICY, DEFAULT_WEIGHTS, Policy, RiskWeights, parsePolicy } from './harden/config';
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
  // Hardening policy (--harden=); default `proof`, or `full` when
  // skipRangeAnalysis is set. An explicit policy wins.
  harden?: Policy | string;
  weights?: RiskWeights;
  // Counter-instrumented build (exports `checkCount`), see codegen.ts.
  countChecks?: boolean;
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
  hardening: HardeningReport;
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

  const policy: Policy =
    typeof opts.harden === 'string'
      ? parsePolicy(opts.harden)
      : opts.harden ?? (opts.skipRangeAnalysis ? { kind: 'full', name: 'full' } : DEFAULT_POLICY);

  // Range analysis only annotates checks (proven / which half proven); the
  // hardening pass turns that into decisions, so `full` (no elimination)
  // still gets proof-gap values in its report.
  ir = rangeAnalysis(ir);
  stages.push({ label: 'after range analysis (bounds-check elimination)', ir });

  const hardened = harden(ir, policy, opts.weights ?? DEFAULT_WEIGHTS);
  ir = hardened.program;
  stages.push({ label: `after hardening (policy ${policy.name})`, ir });

  ir = commonSubexprElimination(ir);
  stages.push({ label: 'after common-subexpression elimination', ir });

  ir = deadCodeElimination(ir);
  stages.push({ label: 'after final dead-code elimination', ir });

  const codegen = generateModule(ir, regBudget, { countChecks: opts.countChecks });
  return { program, stages, finalIR: ir, codegen, hardening: hardened.report };
}
