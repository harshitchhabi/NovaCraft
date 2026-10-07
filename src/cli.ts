#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printProgram, computeBoundsStats, formatBoundsStats, IRFunction } from './ir';
import { formatAllocation } from './regalloc';
import { toJSON } from './sourcemap';
import { compileProgram, CompileError } from './compile';
import { assembleAndInstantiate, callFunction, readTrapSideChannel, formatTrapMessage, writeIntArray } from '../runtime/harness';
import { Lexer } from './lexer';
import { ErrorReporter } from './errors';
import { TokenType } from './tokens';
import { formatHardeningReport } from './harden/harden';
import { parsePolicy, parseWeights } from './harden/config';

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
  noBoundsElim: boolean;
  harden: string | null;
  riskWeights: string | null;
  hardenReport: string | null;
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
    noBoundsElim: false,
    harden: null,
    riskWeights: null,
    hardenReport: null,
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
      case '--no-bounds-elim':
        opts.noBoundsElim = true;
        break;
      default:
        if (arg.startsWith('--harden=')) opts.harden = arg.slice('--harden='.length);
        else if (arg.startsWith('--risk-weights=')) opts.riskWeights = arg.slice('--risk-weights='.length);
        else if (arg.startsWith('--harden-report=')) opts.hardenReport = arg.slice('--harden-report='.length);
        else if (!arg.startsWith('--')) opts.file = arg;
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

  if (opts.emitTokens) {
    const tokenReporter = new ErrorReporter();
    const tokens = new Lexer(source, tokenReporter).tokenize();
    for (const t of tokens) {
      if (t.type === TokenType.EOF) continue;
      console.log(`${t.type} '${t.lexeme}' @${t.line}:${t.column}`);
    }
  }

  let policy;
  let weights;
  try {
    policy = opts.harden ? parsePolicy(opts.harden) : undefined;
    weights = opts.riskWeights ? parseWeights(opts.riskWeights) : undefined;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }

  let compiled;
  try {
    compiled = compileProgram(source, {
      regBudget: opts.regBudget,
      skipRangeAnalysis: opts.noBoundsElim,
      harden: policy,
      weights,
    });
  } catch (e) {
    if (e instanceof CompileError) {
      for (const err of e.errors) console.error(err.message);
      return 1;
    }
    throw e;
  }

  if (opts.emitAst) {
    console.log(JSON.stringify(compiled.program, null, 2));
  }

  if (opts.emitIr) {
    for (const stage of compiled.stages) {
      console.log(`\n=== ${stage.label} ===`);
      console.log(printProgram(stage.ir));
    }
  }

  const stats = computeBoundsStats(compiled.finalIR);
  if (opts.emitIr || opts.stats) {
    console.log('\n' + formatBoundsStats(stats));
    console.log('\n' + formatHardeningReport(compiled.hardening));
  }
  if (opts.hardenReport) {
    fs.writeFileSync(opts.hardenReport, JSON.stringify(compiled.hardening, null, 2) + '\n', 'utf-8');
  }

  const codegenResult = compiled.codegen;

  if (opts.emitAlloc) {
    for (const fn of compiled.finalIR.functions) {
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
    const mainFn = compiled.finalIR.functions.find((f) => f.name === 'main');
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
