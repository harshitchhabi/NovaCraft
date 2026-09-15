#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Lexer } from './lexer';
import { Parser } from './parser';
import { SemanticAnalyzer } from './semantic';
import { generateIR, printProgram, computeBoundsStats, formatBoundsStats, IRProgram, IRFunction } from './ir';
import { constantFold } from './optimize/constantFold';
import { deadCodeElimination } from './optimize/deadCode';
import { rangeAnalysis } from './optimize/rangeAnalysis';
import { generateModule } from './codegen';
import { formatAllocation } from './regalloc';
import { toJSON } from './sourcemap';
import { ErrorReporter } from './errors';
import { assembleAndInstantiate, callFunction, readTrapSideChannel, formatTrapMessage, writeIntArray } from '../runtime/harness';
import { TokenType } from './tokens';

interface CliOptions {
  file: string;
  emitTokens: boolean;
  emitAst: boolean;
  emitIr: boolean;
  emitAlloc: boolean;
  emitWat: boolean;
  run: boolean;
  regBudget: number;
  stats: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    file: '',
    emitTokens: false,
    emitAst: false,
    emitIr: false,
    emitAlloc: false,
    emitWat: false,
    run: false,
    regBudget: 4,
    stats: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--emit-tokens':
        opts.emitTokens = true;
        break;
      case '--emit-ast':
        opts.emitAst = true;
        break;
      case '--emit-ir':
        opts.emitIr = true;
        break;
      case '--emit-alloc':
        opts.emitAlloc = true;
        break;
      case '--emit-wat':
        opts.emitWat = true;
        break;
      case '--run':
        opts.run = true;
        break;
      case '--stats':
        opts.stats = true;
        break;
      case '--reg-budget':
        opts.regBudget = parseInt(argv[++i], 10);
        break;
      default:
        if (!arg.startsWith('--')) opts.file = arg;
        break;
    }
  }
  return opts;
}

// Default test data used to seed an array parameter of `main` when running
// via --run (NovaCraft has no array literals, so main cannot construct one
// itself -- see examples/sumArray.min and README.md).
const DEFAULT_TEST_ARRAY = [1, 2, 3, 4, 5];
const ARRAY_SEED_STRIDE = 256; // bytes between successive seeded test arrays

function buildRunArgs(mainFn: IRFunction, memory: WebAssembly.Memory): number[] {
  let nextOffset = 0;
  const offsetForArray = new Map<string, number>();
  for (const p of mainFn.params) {
    if (p.isArray) {
      const offset = nextOffset;
      nextOffset += ARRAY_SEED_STRIDE;
      offsetForArray.set(p.name, offset);
      writeIntArray(memory, offset, DEFAULT_TEST_ARRAY);
    }
  }
  const lengthParams = new Set(mainFn.arrayLength.values());
  return mainFn.params.map((p) => {
    if (p.isArray) return offsetForArray.get(p.name)!;
    if (lengthParams.has(p.name)) return DEFAULT_TEST_ARRAY.length;
    return 0;
  });
}

export async function compileAndRun(argvInput: string[]): Promise<number> {
  const opts = parseArgs(argvInput);
  if (!opts.file) {
    console.error('usage: novac <file.min> [options]');
    return 1;
  }

  const absPath = path.resolve(opts.file);
  if (!fs.existsSync(absPath)) {
    console.error(`error: file not found: ${opts.file}`);
    return 1;
  }
  const source = fs.readFileSync(absPath, 'utf-8');
  const displayName = path.basename(opts.file);

  const reporter = new ErrorReporter();

  const lexer = new Lexer(source, reporter);
  const tokens = lexer.tokenize();
  if (opts.emitTokens) {
    for (const t of tokens) {
      if (t.type === TokenType.EOF) continue;
      console.log(`${t.type} '${t.lexeme}' @${t.line}:${t.column}`);
    }
  }

  const parser = new Parser(tokens, reporter);
  const program = parser.parseProgram();
  if (opts.emitAst) {
    console.log(JSON.stringify(program, null, 2));
  }

  if (reporter.hasErrors()) {
    reporter.printAll();
    return 1;
  }

  const semantic = new SemanticAnalyzer(reporter);
  semantic.analyze(program);
  if (reporter.hasErrors()) {
    reporter.printAll();
    return 1;
  }

  let ir: IRProgram = generateIR(program);
  const irStages: Array<{ label: string; ir: IRProgram }> = [{ label: 'IR (initial, after BoundsCheck insertion)', ir }];

  ir = constantFold(ir);
  irStages.push({ label: 'after constant folding', ir });

  ir = deadCodeElimination(ir);
  irStages.push({ label: 'after dead-code elimination', ir });

  ir = rangeAnalysis(ir);
  irStages.push({ label: 'after range analysis (bounds-check elimination)', ir });

  if (opts.emitIr) {
    for (const stage of irStages) {
      console.log(`\n=== ${stage.label} ===`);
      console.log(printProgram(stage.ir));
    }
  }

  const stats = computeBoundsStats(ir);
  if (opts.emitIr || opts.stats) {
    console.log('\n' + formatBoundsStats(stats));
  }

  const codegenResult = generateModule(ir, opts.regBudget);

  if (opts.emitAlloc) {
    for (const fn of ir.functions) {
      console.log('\n' + formatAllocation(fn, codegenResult.allocations.get(fn.name)!));
    }
  }

  if (opts.emitWat) {
    console.log('\n' + codegenResult.wat);
    const watPath = absPath.replace(/\.min$/, '') + '.wat';
    fs.writeFileSync(watPath, codegenResult.wat, 'utf-8');
    const mapPath = absPath.replace(/\.min$/, '') + '.sourcemap.json';
    fs.writeFileSync(mapPath, toJSON(codegenResult.sourceMap), 'utf-8');
  }

  if (opts.run) {
    const mainFn = ir.functions.find((f) => f.name === 'main');
    if (!mainFn) {
      console.error("error: no 'main' function to run");
      return 1;
    }
    const h = await assembleAndInstantiate(codegenResult.wat);
    const args = buildRunArgs(mainFn, h.memory);
    try {
      const result = callFunction(h, 'main', args);
      for (const v of h.printed) console.log(v);
      return result === 0 ? 0 : result;
    } catch (e) {
      for (const v of h.printed) console.log(v);
      if (e instanceof WebAssembly.RuntimeError) {
        const sideChannel = readTrapSideChannel(h.memory);
        console.error(formatTrapMessage(displayName, codegenResult.sourceMap, sideChannel));
        return 1;
      }
      throw e;
    }
  }

  return 0;
}

if (require.main === module) {
  compileAndRun(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
