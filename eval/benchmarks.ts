// Benchmark kernels (bench/*.min) and their inputs. These are NovaCraft
// ports of PolyBench-style kernels, NOT PolyBench itself (NovaCraft cannot
// compile C). Inputs are generated from a fixed seed, are identical for
// every configuration, and keep every access in bounds (the benign case).
//
// `split` is fixed here, before any results were produced: weight
// exploration (the ablation) is reported separately for the tuning and the
// held-out kernels, and the default weights are never changed from it.
import * as path from 'path';
import { Arg } from './exec';

export interface Bench {
  name: string;
  file: string;
  fn: string;
  split: 'tuning' | 'heldout';
  args: (scale: number) => Arg[];
}

const ROOT = path.join(__dirname, '..');

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ints = (n: number, seed: number, lo = -100, hi = 100) => {
  const r = rng(seed);
  return Array.from({ length: n }, () => lo + Math.floor(r() * (hi - lo + 1)));
};
const perm = (n: number, seed: number) => {
  const r = rng(seed);
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
};
const arr = (a: number[]): Arg => ({ array: a });
const zeros = (n: number) => new Array(n).fill(0);
const sz = (n: number, scale: number) => Math.max(4, Math.round(n * scale));

const b = (name: string, fn: string, split: Bench['split'], args: Bench['args']): Bench => ({
  name,
  file: path.join(ROOT, 'bench', `${name}.min`),
  fn,
  split,
  args,
});

export const BENCHMARKS: Bench[] = [
  b('sumArray', 'sumArray', 'heldout', (s) => {
    const n = sz(200000, s);
    return [arr(ints(n, 1)), n];
  }),
  b('prefixSum', 'prefixSum', 'tuning', (s) => {
    const n = sz(200000, s);
    return [arr(ints(n, 2)), n];
  }),
  b('dot', 'dot', 'heldout', (s) => {
    const n = sz(200000, s);
    return [arr(ints(n, 3)), n, arr(ints(n, 4)), n];
  }),
  b('axpy', 'axpy', 'tuning', (s) => {
    const n = sz(200000, s);
    return [arr(ints(n, 5)), n, arr(ints(n, 6)), n, 3, n];
  }),
  b('matvec', 'matvec', 'heldout', (s) => {
    const r = sz(400, Math.sqrt(s));
    return [arr(ints(r * r, 7)), r * r, arr(ints(r, 8)), r, arr(zeros(r)), r, r, r];
  }),
  b('stencil', 'stencil', 'heldout', (s) => {
    const n = sz(200000, s);
    return [arr(ints(n, 9)), n, arr(zeros(n)), n];
  }),
  b('stencilV', 'stencilV', 'tuning', (s) => {
    const n = sz(200000, s);
    return [arr(ints(n, 9)), n, arr(zeros(n)), n];
  }),
  b('smooth', 'smooth', 'tuning', (s) => {
    const n = sz(50000, s);
    return [arr(ints(n, 10)), n, arr(zeros(n)), n, 4];
  }),
  b('smoothV', 'smoothV', 'heldout', (s) => {
    const n = sz(50000, s);
    return [arr(ints(n, 10)), n, arr(zeros(n)), n, 4];
  }),
  b('histogram', 'histogram', 'tuning', (s) => {
    const n = sz(200000, s);
    return [arr(ints(n, 11, 0, 255)), n, arr(zeros(256)), 256];
  }),
  b('bubbleSort', 'bubbleSort', 'tuning', (s) => {
    const n = sz(600, Math.sqrt(s));
    return [arr(ints(n, 12, -1000, 1000)), n];
  }),
  b('insertionSort', 'insertionSort', 'heldout', (s) => {
    const n = sz(800, Math.sqrt(s));
    return [arr(ints(n, 13, -1000, 1000)), n];
  }),
  b('binarySearch', 'binarySearch', 'heldout', (s) => {
    const n = 4096;
    const sorted = Array.from({ length: n }, (_, i) => 2 * i);
    const q = sz(20000, s);
    return [arr(sorted), n, arr(ints(q, 14, 0, 2 * n)), q];
  }),
  b('gather', 'gather', 'tuning', (s) => {
    const n = sz(200000, s);
    return [arr(ints(n, 15)), n, arr(perm(n, 16)), n, arr(zeros(n)), n];
  }),
  b('scatter', 'scatter', 'heldout', (s) => {
    const n = sz(200000, s);
    return [arr(ints(n, 17)), n, arr(perm(n, 18)), n, arr(zeros(n)), n];
  }),
  b('reverse', 'reverse', 'tuning', (s) => {
    const n = sz(200000, s);
    return [arr(ints(n, 19)), n];
  }),
];
