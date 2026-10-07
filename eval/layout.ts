// Memory layout for benchmark and bug-program arrays (see DEVLOG.md).
//
//   [0, 4096)        unused by the evaluation (the old test-array region)
//   [4096, 4108)     trap side channel
//   [8192, 65536)    spill stack, confined by the prologue stack-limit check;
//                    it grows down from 65536 and never writes at or above it
//   [65536, ...)     evaluation arrays: GAP, array 0, GAP, array 1, ..., GAP
//
// Every GAP is SENTINEL_BYTES (16) of a fixed sentinel pattern, so a write
// that runs off the end (or start) of an array changes a sentinel. Memory
// is grown from the host side to fit.
export const ARRAY_REGION_BASE = 65536;
export const SENTINEL_BYTES = 16;
export const SENTINEL_WORD = -559038737; // 0xDEADBEEF
const SENTINEL_WORDS = SENTINEL_BYTES / 4;
const PAGE = 65536;

export interface Placement {
  addresses: number[]; // byte address of each array
  gaps: number[]; // byte address of each sentinel gap (before, between, after)
  end: number;
}

export function plan(lengths: number[]): Placement {
  let at = ARRAY_REGION_BASE;
  const addresses: number[] = [];
  const gaps: number[] = [];
  for (const n of lengths) {
    gaps.push(at);
    at += SENTINEL_BYTES;
    addresses.push(at);
    at += n * 4;
  }
  gaps.push(at);
  at += SENTINEL_BYTES;
  return { addresses, gaps, end: at };
}

export function place(memory: WebAssembly.Memory, arrays: number[][]): Placement {
  const p = plan(arrays.map((a) => a.length));
  const pages = Math.ceil(p.end / PAGE);
  const have = memory.buffer.byteLength / PAGE;
  if (pages > have) memory.grow(pages - have);
  const view = new Int32Array(memory.buffer);
  for (const g of p.gaps) view.fill(SENTINEL_WORD, g / 4, g / 4 + SENTINEL_WORDS);
  arrays.forEach((a, k) => view.set(a, p.addresses[k] / 4));
  return p;
}

// Rewrites the arrays (not the gaps) in place, e.g. before each timed run of
// a kernel that mutates its input.
export function rewrite(memory: WebAssembly.Memory, p: Placement, arrays: number[][]): void {
  const view = new Int32Array(memory.buffer);
  arrays.forEach((a, k) => view.set(a, p.addresses[k] / 4));
}

export function sentinelsIntact(memory: WebAssembly.Memory, p: Placement): boolean {
  const view = new Int32Array(memory.buffer);
  return p.gaps.every((g) => {
    for (let k = 0; k < SENTINEL_WORDS; k++) if (view[g / 4 + k] !== SENTINEL_WORD) return false;
    return true;
  });
}

export function readArrays(memory: WebAssembly.Memory, p: Placement, lengths: number[]): number[][] {
  const view = new Int32Array(memory.buffer);
  return lengths.map((n, k) => Array.from(view.subarray(p.addresses[k] / 4, p.addresses[k] / 4 + n)));
}
