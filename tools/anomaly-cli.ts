#!/usr/bin/env node
// A real, runnable application built on top of the NovaCraft compiler:
// moving-average anomaly detection over a numeric time series (e.g. request
// latency, sensor readings, queue depth -- anything a monitoring pipeline
// watches for spikes). It reads a file of integers, compiles
// examples/anomalyDetect.min to actual WebAssembly, runs it, and reports
// which points look anomalous relative to their local neighborhood.
//
// Usage: npm run anomaly -- <data-file> [--window N] [--threshold N]
import * as fs from 'fs';
import * as path from 'path';
import { compileProgram } from '../src/compile';
import { assembleAndInstantiate, callFunction, writeIntArray } from '../runtime/harness';
import { computeBoundsStats, formatBoundsStats } from '../src/ir';

interface Args {
  file: string;
  window: number;
  threshold: number;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npm run anomaly -- <data-file> [--window N] [--threshold N]');
    process.exit(1);
  }
  const file = args[0];
  let window = 3;
  let threshold = 30;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--window') window = parseInt(args[++i], 10);
    else if (args[i] === '--threshold') threshold = parseInt(args[++i], 10);
    else {
      console.error(`unrecognized argument '${args[i]}'`);
      process.exit(1);
    }
  }
  return { file, window, threshold };
}

function readSeries(file: string): number[] {
  const text = fs.readFileSync(file, 'utf-8');
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = parseInt(s, 10);
      if (Number.isNaN(n)) throw new Error(`not an integer: '${s}'`);
      return n;
    });
}

async function main(): Promise<void> {
  const { file, window, threshold } = parseArgs(process.argv);
  const data = readSeries(file);

  const source = fs.readFileSync(path.join(__dirname, '..', 'examples', 'anomalyDetect.min'), 'utf-8');
  const compiled = compileProgram(source);

  console.log(formatBoundsStats(computeBoundsStats(compiled.finalIR)));
  console.log();

  const h = await assembleAndInstantiate(compiled.codegen.wat); // throws if wabt rejects the module
  writeIntArray(h.memory, 0, data);

  const anomalyCount = callFunction(h, 'movingAvgFlag', [0, data.length, window, threshold]);

  console.log(`${data.length} points, window=${window}, threshold=${threshold}`);
  console.log(`${anomalyCount} anomal${anomalyCount === 1 ? 'y' : 'ies'} flagged:\n`);
  // movingAvgFlag prints each flagged index as it finds it (see
  // examples/anomalyDetect.min); h.printed collects everything the compiled
  // module passed to `print` during that call.
  for (const i of h.printed) {
    console.log(`  [${i}] value=${data[i]}`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
