import { compileExampleToModule } from './helpers';
import { assembleAndInstantiate, callFunction, writeIntArray } from '../runtime/harness';

// A JS reference implementation of the exact same algorithm as
// examples/anomalyDetect.min, used to check the compiled WebAssembly
// against an independent (interpreted) source of truth rather than just
// eyeballing output.
function jsReference(data: number[], window: number, threshold: number): number[] {
  const flagged: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < window || i >= data.length - window) continue;
    let sum = 0;
    for (let j = i - window; j <= i + window; j++) sum += data[j];
    const count = window * 2 + 1;
    const mean = Math.trunc(sum / count); // matches WASM i32.div_s truncation
    const diff = Math.abs(data[i] - mean);
    if (diff > threshold) flagged.push(i);
  }
  return flagged;
}

describe('anomalyDetect.min: moving-average anomaly detection', () => {
  test('flags a single injected spike and nothing else, against a JS reference implementation', async () => {
    const data = [10, 10, 10, 10, 50, 10, 10, 10, 10];
    const window = 2;
    const threshold = 15;

    const mod = compileExampleToModule('anomalyDetect.min');
    const h = await assembleAndInstantiate(mod.wat); // throws if wabt rejects the module
    writeIntArray(h.memory, 0, data);
    const count = callFunction(h, 'movingAvgFlag', [0, data.length, window, threshold]);

    const expected = jsReference(data, window, threshold);
    expect(count).toBe(expected.length);
    expect(h.printed).toEqual(expected);
  });

  test('a realistic latency series agrees with the JS reference implementation', async () => {
    // Baseline ~50 with four injected spikes/drops, matching the shape of
    // data/sample-latency-ms.csv (tools/anomaly-cli.ts's sample dataset).
    const data = [
      51, 50, 53, 52, 52, 52, 50, 47, 46, 48, 48, 54, 210, 195, 49, 48, 47, 53, 53, 53, 50, 48, 53, 46, 52, 54, 52,
      47, 49, 51, 4, 48, 50, 52, 48, 50, 46, 51, 50, 51, 52, 53, 53, 48, 53, 260, 53, 47, 53, 48, 46, 50, 46, 47, 53,
      48, 49, 51, 52, 51,
    ];
    const window = 3;
    const threshold = 30;

    const mod = compileExampleToModule('anomalyDetect.min');
    const h = await assembleAndInstantiate(mod.wat);
    writeIntArray(h.memory, 0, data);
    const count = callFunction(h, 'movingAvgFlag', [0, data.length, window, threshold]);

    const expected = jsReference(data, window, threshold);
    expect(count).toBe(expected.length);
    expect(h.printed).toEqual(expected);
    // The four genuinely injected spikes must be among what was flagged.
    expect(h.printed).toEqual(expect.arrayContaining([12, 13, 30, 45]));
  });
});
