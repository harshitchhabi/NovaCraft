// Measures the real runtime cost the range-analysis bounds-check elimination
// pass removes, by compiling the SAME NovaCraft program twice -- once with
// the pass enabled (its one BoundsCheck proven safe and eliminated) and
// once with it disabled (the check runs on every single array access) --
// and timing actual WebAssembly execution of both over a large array.
//
// Run with: npm run benchmark
import * as fs from 'fs';
import * as path from 'path';
import { compileProgram } from '../src/compile';
import { assembleAndInstantiate, callFunction, writeIntArray } from '../runtime/harness';

const ARRAY_LENGTH = 4_000_000; // elements; large enough to make per-access overhead measurable
const CALLS = 20; // repetitions per variant, for a stable average
const WARMUP_CALLS = 3;

// The stack pointer $sp starts at 65536 and only ever grows *downward* from
// there (spill slots and stack frames occupy [sp, 65536)). A test array must
// therefore live entirely at or above 65536 -- offset 0..4095 (the reserved
// low region documented in the README) is only safe for small test data.
// This places the array well clear of that region.
const ARRAY_OFFSET = 1 << 20; // 1MiB

async function buildVariant(skipRangeAnalysis: boolean) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'examples', 'sumArray.min'), 'utf-8');
  const compiled = compileProgram(source, { skipRangeAnalysis });
  const h = await assembleAndInstantiate(compiled.codegen.wat);

  // Grow memory to fit the array past ARRAY_OFFSET; WebAssembly.Memory.grow
  // works directly from the host side, no wasm-level `memory.grow` needed.
  const bytesNeeded = ARRAY_OFFSET + ARRAY_LENGTH * 4;
  const pagesNeeded = Math.ceil(bytesNeeded / 65536);
  const currentPages = h.memory.buffer.byteLength / 65536;
  if (pagesNeeded > currentPages) h.memory.grow(pagesNeeded - currentPages);

  const data = new Array(ARRAY_LENGTH).fill(1); // sum should equal ARRAY_LENGTH
  writeIntArray(h.memory, ARRAY_OFFSET, data);

  return { h, retained: skipRangeAnalysis };
}

function timeCalls(h: Awaited<ReturnType<typeof buildVariant>>['h'], calls: number): { totalMs: number; result: number } {
  let result = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < calls; i++) {
    result = callFunction(h, 'sumArray', [ARRAY_OFFSET, ARRAY_LENGTH]);
  }
  const end = process.hrtime.bigint();
  return { totalMs: Number(end - start) / 1e6, result };
}

async function main() {
  console.log(`NovaCraft bounds-check elimination benchmark`);
  console.log(`Array length: ${ARRAY_LENGTH.toLocaleString('en-US')} elements, ${CALLS} timed calls per variant\n`);

  const eliminated = await buildVariant(false);
  const retained = await buildVariant(true);

  // Warm up the WASM engine's JIT for both variants before timing.
  timeCalls(eliminated.h, WARMUP_CALLS);
  timeCalls(retained.h, WARMUP_CALLS);

  const eliminatedRun = timeCalls(eliminated.h, CALLS);
  const retainedRun = timeCalls(retained.h, CALLS);

  if (eliminatedRun.result !== ARRAY_LENGTH || retainedRun.result !== ARRAY_LENGTH) {
    throw new Error(
      `correctness check failed: expected ${ARRAY_LENGTH}, got eliminated=${eliminatedRun.result} retained=${retainedRun.result}`,
    );
  }

  const eliminatedAvgMs = eliminatedRun.totalMs / CALLS;
  const retainedAvgMs = retainedRun.totalMs / CALLS;
  const speedup = retainedAvgMs / eliminatedAvgMs;
  const overheadPct = ((retainedAvgMs - eliminatedAvgMs) / eliminatedAvgMs) * 100;

  console.log(`Checks eliminated (range analysis ON):  ${eliminatedAvgMs.toFixed(2)} ms/call avg`);
  console.log(`Checks retained   (range analysis OFF): ${retainedAvgMs.toFixed(2)} ms/call avg`);
  console.log(`\nSpeedup from elimination: ${speedup.toFixed(2)}x  (${overheadPct.toFixed(1)}% overhead removed)`);
  console.log(`Both variants computed the correct sum: ${ARRAY_LENGTH}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
