# Limitations

Every number below is read from a file in `results/`, named next to it.
`results/RESULTS.md` is the A3 benchmark and bug-corpus report;
`results/mutation/RESULTS.md` is the A3b mutation-corpus report.

## Evaluation scope

- **Not PolyBench.** The 16 kernels in `bench/` are small NovaCraft ports of
  PolyBench-style kernels, written for this project with arrays flattened to
  1D. NovaCraft cannot compile C. Results may not transfer to real
  programs.
- **Few kernels, wide confidence intervals.** All mutation-corpus results
  come from 305 kept mutants of the same 16 kernels. The 95% CIs resample
  kernels, so there are only 16 clusters and the intervals are wide. For
  example:
  - `balanced` detection is 74.8% [66.4%, 82.2%];
  - cost(proof) - cost(strict) is 35.1 pp [14.7 pp, 56.7 pp].

  Pooled rates weight kernels by their number of mutants; `matvec` has the
  most kept mutants (46). Source: results/mutation/RESULTS.md.
- **No runtime claims.** Timing is V8 only, on one machine, in one process.
  The median run-to-run difference between the two timing passes was 38.7%
  (max 56.1%), even with inputs scaled up 10x (results/RESULTS.md, Runtime).
  Only 5 of 112 configuration-vs-proof runtime differences exceeded the
  kernel's noise, in both directions. No runtime improvement is claimed;
  the cost metric is checks + guard evaluations executed.
- **The bug corpus is hand-written.** It has 13 programs, one bug and one
  triggering input each (results/RESULTS.md).
- **Mutant inputs are small.** Fuzzed inputs use arrays of length 0-16, so
  a mutant that only misbehaves on larger inputs counts as not triggerable.
  77 of 451 generated variants were dropped as not triggerable
  (results/mutation/RESULTS.md).

## Analysis

- **Intraprocedural.** Range analysis runs per function. It knows nothing
  about callers' arguments, so a callee's checks are proven only from that
  callee's own code.
- **Weak prover.** The analysis is intervals plus less-than facts plus
  exact linear definitions. It proves 10 of the 59 benchmark sites
  (results/RESULTS.md, Static decisions). It cannot prove non-affine
  indices like `arr[i*m + j]`, and it leaves `arr[i+1]` under
  `while (i < len - 1)` unproven when `len - 1` may wrap. The latter is
  deliberate; see docs/AUDIT.md.
- **Provenance is context-insensitive** (`src/harden/taint.ts`). A function
  that returns an external value taints every call result, including calls
  with constant arguments. It is also flow-insensitive per register.
- **Only simple loops are versioned.** Hoisting needs `while (i < N)` or
  `<= N` with a single unconditional `i = i + s`, an `N` not assigned in
  the loop, and indices of the form `i + c`. Natural forms with the bound
  computed in the condition (`i < len - 1`) are not versioned. Under
  `strict`, 16 of 59 benchmark sites are hoisted. The natural `stencil` and
  `smooth` hoist 0; their rewritten variants hoist 4 of 5 and 2 of 3
  (results/RESULTS.md).
- **Checks trust the length argument.** A check compares the index with
  the length the caller passed. If a caller passes a length larger than the
  real array, checked accesses can reach any address in linear memory,
  including the program's own spill stack (`tests/analysisSoundness.test.ts`
  demonstrates it). The A4 equivalence and soundness tests therefore use
  length arguments no larger than the real array.

## Risk score and policies

- **Weights are not learned.** wP = 0.40, wC = 0.35, wW = 0.25 were set
  before any evaluation and never tuned. The ablation in results/RESULTS.md
  is a sensitivity check only.
- **The score is coarse.** R takes at most 12 discrete values; 8 occur for
  unproven sites (docs/FORMAL.md). Thresholds between two adjacent values
  give identical decisions.
- **Omit is unsound by design.** Every policy other than `full`, `proof`
  and `strict` omits checks the analysis has not proven, and can miss real
  out-of-bounds accesses.
- **`chuang` is an approximation** of Chuang et al. 2007 [verify]: it keeps
  unproven writes and omits unproven reads. It is not a reimplementation.
- **The budget policy ignores hoisting savings.** `budget:F` charges a kept
  site its full in-loop cost even when the site is hoisted and almost free.
- **Risk-adaptive policies silently corrupt memory.**
  - `balanced` silently corrupts memory in 4.3% [1.5%, 8.2%] of mutants
    (13 of 305). Every one of these 13 involves an omitted internal write
    with a partial proof: P = 0, C = 0.5, W = 1, so R = 0.425, below
    tau = 0.5. In 9 the attributed site is that write; in 4 it is a read
    (see the last item).
  - `performance` corrupts in 8.9% [4.1%, 14.2%] (27 variants, 29
    attributed-site cases). Its causes are mixed: 9 cases are internal
    writes with R = 0.425, 9 are internal writes with R = 0.6, and 11 are
    reads.
  - `budget:0.5` corrupts in 5.2% and `budget:0.25` in 18.4%.

  Sources: results/mutation/RESULTS.md and results/mutation/raw/silent.csv.
- **`chuang` is the only cheap policy with zero silent corruption.** It
  has 0.0% silent corruption at a cost of 22.8% of `full`'s checks. Its
  detection is lower: 31.5% [22.4%, 40.5%]. `balanced` costs 24.2% and
  detects 74.8%, but corrupts 4.3%. The risk-adaptive policies are **not**
  safer than `chuang`. They detect more mutants per check executed, and
  they let some writes corrupt memory that `chuang` would have stopped
  (results/mutation/RESULTS.md).
- **H2's detection metric weights reads and writes equally.** A mutant
  counts as detected only if the policy traps on every triggering input,
  whether the bug is an out-of-bounds read or a write. This favours
  policies that keep read checks, which `chuang` drops on purpose. H2 is
  about detection per cost; it says nothing about corruption.
- **H2's matched-cost comparison is interpolated.** No threshold
  configuration lands at `chuang`'s cost (22.8%). The threshold sweep jumps
  from 6.9% (tau >= 0.8) to 24.2% (tau 0.45-0.75), and the 70.6% at 22.8%
  is a linear interpolation between those points. The budget sweep has
  points at 21.7% and 24.2% around it. Source: results/mutation/RESULTS.md,
  Sweeps.
- **Many corruptions are attributed to a read.** 38 of the 204
  (variant, configuration) silent-corruption cases in the main
  configurations are attributed, by the preregistered rule, to a read: the
  check that fired first under `full`. A read cannot corrupt memory by
  itself. Omitting it lets execution continue to a later omitted write in
  the same variant, which does the corrupting. All 38 have at least one
  omitted write. The 204 include 90 cases under `none`.
  Source: results/mutation/RESULTS.md and raw/silent.csv.
