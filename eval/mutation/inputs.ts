// Fuzzed inputs for the mutation corpus: 200 per kernel from a fixed seed,
// valid for the ORIGINAL kernel (honest lengths and the kernel's own
// preconditions), so any trap or sentinel change under `full` is caused by
// the mutation. See docs/PREREGISTRATION.md.
import { rng } from '../benchmarks';
import { Arg } from '../exec';

export const INPUTS_PER_KERNEL = 200;

type Gen = (r: () => number) => Arg[];

const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const vals = (r: () => number, n: number, lo = -50, hi = 50) => Array.from({ length: n }, () => int(r, lo, hi));
const A = (a: number[]): Arg => ({ array: a });

const GENERATORS: Record<string, Gen> = {
  sumArray: (r) => {
    const n = int(r, 0, 16);
    return [A(vals(r, n)), n];
  },
  prefixSum: (r) => {
    const n = int(r, 0, 16);
    return [A(vals(r, n)), n];
  },
  dot: (r) => {
    const n = int(r, 0, 16);
    return [A(vals(r, n)), n, A(vals(r, n)), n];
  },
  axpy: (r) => {
    const len = int(r, 1, 16);
    const n = int(r, 0, len);
    return [A(vals(r, len)), len, A(vals(r, len)), len, int(r, -5, 5), n];
  },
  matvec: (r) => {
    const rows = int(r, 1, 4);
    const cols = int(r, 0, 4);
    return [A(vals(r, rows * cols)), rows * cols, A(vals(r, cols)), cols, A(new Array(rows).fill(0)), rows, rows, cols];
  },
  stencil: (r) => {
    const n = int(r, 2, 16);
    return [A(vals(r, n)), n, A(new Array(n).fill(0)), n];
  },
  stencilV: (r) => {
    const n = int(r, 2, 16);
    return [A(vals(r, n)), n, A(new Array(n).fill(0)), n];
  },
  smooth: (r) => {
    const k = int(r, 0, 3);
    const n = int(r, k + 1, 16);
    return [A(vals(r, n)), n, A(new Array(n).fill(0)), n, k];
  },
  smoothV: (r) => {
    const k = int(r, 0, 3);
    const n = int(r, k + 1, 16);
    return [A(vals(r, n)), n, A(new Array(n).fill(0)), n, k];
  },
  histogram: (r) => {
    const h = int(r, 1, 8);
    const n = int(r, 0, 16);
    return [A(vals(r, n, 0, h - 1)), n, A(new Array(h).fill(0)), h];
  },
  bubbleSort: (r) => {
    const n = int(r, 1, 16);
    return [A(vals(r, n)), n];
  },
  insertionSort: (r) => {
    const n = int(r, 1, 16);
    return [A(vals(r, n)), n];
  },
  binarySearch: (r) => {
    const n = int(r, 0, 16);
    const sorted: number[] = [];
    let v = int(r, -20, 0);
    for (let k = 0; k < n; k++) {
      v += int(r, 1, 4);
      sorted.push(v);
    }
    const q = int(r, 0, 8);
    return [A(sorted), n, A(vals(r, q, -25, 70)), q];
  },
  gather: (r) => {
    const alen = int(r, 1, 16);
    const n = int(r, 1, 16);
    return [A(vals(r, alen)), alen, A(vals(r, n, 0, alen - 1)), n, A(new Array(n).fill(0)), n];
  },
  scatter: (r) => {
    const olen = int(r, 1, 16);
    const n = int(r, 0, 16);
    return [A(vals(r, n)), n, A(vals(r, n, 0, olen - 1)), n, A(new Array(olen).fill(0)), olen];
  },
  reverse: (r) => {
    const n = int(r, 1, 16);
    return [A(vals(r, n)), n];
  },
};

function seedOf(name: string): number {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function fuzzInputs(kernel: string, count = INPUTS_PER_KERNEL): Arg[][] {
  const gen = GENERATORS[kernel];
  if (!gen) throw new Error(`no input generator for kernel ${kernel}`);
  const r = rng(seedOf(`mutation:${kernel}`));
  return Array.from({ length: count }, () => gen(r));
}
