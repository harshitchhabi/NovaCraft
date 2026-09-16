// Measures the real runtime cost the range-analysis bounds-check elimination
// pass removes, by compiling the SAME NovaCraft program twice per scenario --
// once with the pass enabled (its BoundsCheck(s) proven safe and eliminated)
// and once with it disabled (the check(s) run on every single array access)
// -- and timing actual WebAssembly execution of both over a large array.
//
// Two scenarios are run:
//   - sumArray.min:   one BoundsCheck per iteration (a read).
//   - scaleArray.min: two BoundsChecks per iteration (a read + a write to
//                      the same index), so elimination has twice the
//                      per-iteration overhead to remove.
//
// Run with: npm run benchmark
import * as fs from 'fs';
import * as path from 'path';
import { compileProgram } from '../src/compile';
import { assembleAndInstantiate, callFunction, writeIntArray, HarnessInstance } from '../runtime/harness';

const ARRAY_LENGTH = 4_000_000; // elements; large enough to make per-access overhead measurable
const CALLS = 20; // repetitions per variant, for a stable average
const WARMUP_CALLS = 3;

// The stack pointer $sp starts at 65536 and only ever grows *downward* from
// there (spill slots and stack frames occupy [sp, 65536)). A test array must
// therefore live entirely at or above 65536 -- offset 0..4095 (the reserved
// low region documented in the README) is only safe for small test data.
// This places the array well clear of that region.
const ARRAY_OFFSET = 1 << 20; // 1MiB

interface Scenario {
  name: string;
  file: string;
  functionName: string;
  checksPerIteration: number;
  // Reseeds the array before each timed measurement, so scenarios whose
  // function mutates the array (scaleArray.min) give a deterministic,
  // reproducible expected result regardless of how many calls preceded it.
  seed(): number[];
  expected(data: number[]): number;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'sumArray (1 check/iteration: read)',
    file: 'sumArray.min',
    functionName: 'sumArray',
    checksPerIteration: 1,
    seed: () => new Array(ARRAY_LENGTH).fill(1),
    expected: () => ARRAY_LENGTH,
  },
  {
    name: 'scaleArray (2 checks/iteration: read + write)',
    file: 'scaleArray.min',
    functionName: 'scaleArray',
    checksPerIteration: 2,
    seed: () => new Array(ARRAY_LENGTH).fill(1),
    // scaleArray.min doubles arr[0] in place on every call, and timeCalls
    // below issues CALLS calls in a row against the same reseeded array.
    expected: (data) => data[0] * 2 ** CALLS,
  },
];

async function buildVariant(file: string, skipRangeAnalysis: boolean) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'examples', file), 'utf-8');
  const compiled = compileProgram(source, { skipRangeAnalysis });
  const h = await assembleAndInstantiate(compiled.codegen.wat);

  // Grow memory to fit the array past ARRAY_OFFSET; WebAssembly.Memory.grow
  // works directly from the host side, no wasm-level `memory.grow` needed.
  const bytesNeeded = ARRAY_OFFSET + ARRAY_LENGTH * 4;
  const pagesNeeded = Math.ceil(bytesNeeded / 65536);
  const currentPages = h.memory.buffer.byteLength / 65536;
  if (pagesNeeded > currentPages) h.memory.grow(pagesNeeded - currentPages);

  return h;
}

function timeCalls(h: HarnessInstance, functionName: string, calls: number): { totalMs: number; result: number } {
  let result = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < calls; i++) {
    result = callFunction(h, functionName, [ARRAY_OFFSET, ARRAY_LENGTH]);
  }
  const end = process.hrtime.bigint();
  return { totalMs: Number(end - start) / 1e6, result };
}

async function runScenario(scenario: Scenario): Promise<void> {
  console.log(`--- ${scenario.name} ---`);

  const eliminated = await buildVariant(scenario.file, false);
  const retained = await buildVariant(scenario.file, true);

  const data = scenario.seed();
  const expected = scenario.expected(data);

  // Warm up the WASM engine's JIT for both variants before timing.
  writeIntArray(eliminated.memory, ARRAY_OFFSET, data);
  writeIntArray(retained.memory, ARRAY_OFFSET, data);
  timeCalls(eliminated, scenario.functionName, WARMUP_CALLS);
  timeCalls(retained, scenario.functionName, WARMUP_CALLS);

  // Reseed so the timed run's result is deterministic even though
  // scaleArray.min mutates the array in place.
  writeIntArray(eliminated.memory, ARRAY_OFFSET, data);
  writeIntArray(retained.memory, ARRAY_OFFSET, data);
  const eliminatedRun = timeCalls(eliminated, scenario.functionName, CALLS);
  const retainedRun = timeCalls(retained, scenario.functionName, CALLS);

  if (eliminatedRun.result !== expected || retainedRun.result !== expected) {
    throw new Error(
      `correctness check failed for ${scenario.name}: expected ${expected}, got eliminated=${eliminatedRun.result} retained=${retainedRun.result}`,
    );
  }

  const eliminatedAvgMs = eliminatedRun.totalMs / CALLS;
  const retainedAvgMs = retainedRun.totalMs / CALLS;
  const speedup = retainedAvgMs / eliminatedAvgMs;
  const overheadPct = ((retainedAvgMs - eliminatedAvgMs) / eliminatedAvgMs) * 100;

  console.log(`Checks eliminated (range analysis ON):  ${eliminatedAvgMs.toFixed(2)} ms/call avg`);
  console.log(`Checks retained   (range analysis OFF): ${retainedAvgMs.toFixed(2)} ms/call avg`);
  console.log(`Speedup from elimination: ${speedup.toFixed(2)}x  (${overheadPct.toFixed(1)}% overhead removed)`);
  console.log(`Both variants computed the correct result: ${expected}.\n`);
}

async function main() {
  console.log(`NovaCraft bounds-check elimination benchmark`);
  console.log(`Array length: ${ARRAY_LENGTH.toLocaleString('en-US')} elements, ${CALLS} timed calls per variant\n`);

  for (const scenario of SCENARIOS) {
    await runScenario(scenario);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
