// Worker for tests/differentialHarness.ts: runs one compiled function on one
// input in isolation, so the parent can kill a run that loops for too long
// (fuzzed INT_MAX loop bounds) without hanging the test process.
const { parentPort } = require('worker_threads');

const modules = new Map();

// FNV-1a over linear memory, skipping [skipFrom, skipTo) (the spill stack).
function hashBytes(bytes, skipFrom, skipTo) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    if (i === skipFrom) i = skipTo;
    if (i >= bytes.length) break;
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

parentPort.on('message', (m) => {
  if (m.type === 'load') {
    modules.set(m.key, new WebAssembly.Module(m.bytes));
    return;
  }
  const printed = [];
  const instance = new WebAssembly.Instance(modules.get(m.key), { env: { print: (v) => printed.push(v) } });
  const memory = instance.exports.memory;
  m.arrays.forEach((arr, k) => new Int32Array(memory.buffer, m.arrayBase + k * m.arrayStride, arr.length).set(arr));
  let o;
  try {
    o = { kind: 'ok', result: instance.exports[m.fn](...m.args) };
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) {
      const view = new DataView(memory.buffer);
      o = {
        kind: 'trap',
        trap: e.message,
        checkId: view.getInt32(m.trapOffsets.checkId, true),
        index: view.getInt32(m.trapOffsets.index, true),
        length: view.getInt32(m.trapOffsets.length, true),
      };
    } else {
      o = { kind: 'host-error', trap: e && e.constructor ? e.constructor.name : String(e) };
    }
  }
  o.printed = printed;
  o.memoryHash = hashBytes(new Uint8Array(memory.buffer), m.stackRegion[0], m.stackRegion[1]);
  parentPort.postMessage({ id: m.id, outcome: o });
});
