# Preregistration: mutation-corpus evaluation (milestone A3b)

Written and committed before any mutation-corpus result exists. Nothing in
this file may be changed after the first mutation-corpus run; deviations are
recorded in a "Deviations" section appended at the end, with the reason.

## Frozen artifacts

- **Policies, risk weights and analysis are frozen at commit
  `b1f11bc8eef0a8c822fdc004d615cf2e54750b2d`** (branch
  `harden/risk-adaptive`). This covers `src/harden/` (policies, weights
  wP=0.40, wC=0.35, wW=0.25, decision rules, loop versioning),
  `src/optimize/` and the rest of the compile pipeline.
- The only compiler change allowed after this commit: an opt-in
  deterministic loop-fuel build option (see "Runs") that is off by default
  and does not change any policy decision. It is needed so that mutants with
  unbounded loops end deterministically.
- No weight, threshold or policy is retuned in response to these results.
  New policy ideas go to `docs/FUTURE.md` only.

## Configurations

- Main: `none`, `full`, `proof`, `strict`, `balanced`, `performance`,
  `budget:0.25`, `budget:0.5`, `chuang`.
- Threshold sweep: `threshold:T` for T = 0, 0.05, ..., 1 (21 values).
- Budget sweep: `budget:F` for F = 0, 0.05, ..., 1 (21 values).

## Mutation corpus

Source: the 16 kernels in `bench/` (A3). `eval/mutate.ts` parses each kernel,
applies **one** mutation per variant, and prints the variant back to source.
Each operator is applied at **every** applicable site of the kernel's entry
function (one variant per site, or per site and replacement where an operator
has several replacements). No variant is hand-picked or hand-removed.

Operators:

1. `lt-to-le`: a `<` in a `while`/`for` condition becomes `<=`.
2. `bound-plus-one`: in a `while`/`for` condition, an operand that is a
   length parameter `len` becomes `len + 1`.
3. `start-minus-one`: a `let v: int = 0` (or `for (let v: int = 0; ...)`)
   whose variable appears in a loop condition becomes `= -1`.
4. `index-plus-one` / `index-minus-one`: an array index expression `e`
   becomes `e + 1` / `e - 1` (two variants per access).
5. `swap-index-var`: in an array index expression, an occurrence of an int
   variable is replaced by another int variable in scope at that point
   (one variant per occurrence and replacement).
6. `swap-length`: an occurrence of a length parameter (the int parameter
   directly after an array parameter) is replaced by another length
   parameter of the same function (one variant per occurrence and
   replacement).
7. `remove-guard`: an `if` whose condition is an int comparison is replaced
   by one of its branches: without `else`, by the then-block; with `else`,
   by the branch containing an array access when exactly one does.
8. `write-index-external`: the index of an array write becomes an int
   parameter of the entry function (one variant per write and parameter).

Variants that fail to compile (e.g. a swap creating a type error) are
discarded and counted as "not compilable".

**Fallback operators**, applied in this order only if fewer than 300
variants are kept after operators 1-8, until 300 are kept or the list is
exhausted (whichever comes first), with the reason logged in DEVLOG.md:
(A) `if-lt-to-le`: `<` to `<=` in an `if` condition; (B) `index-is-length`:
an array index becomes that array's length parameter; (C) `minus-one-drop`:
an expression `x - 1` becomes `x`.

## Inputs and triggerability

- Per kernel, `eval/mutate.ts` generates **200 fuzzed inputs** from a fixed
  seed (identical for all variants of a kernel). Inputs are valid for the
  original kernel: small arrays (length 0-16) with honest length arguments
  and kernel-specific constraints (e.g. histogram values in range, gather
  indices in range, sorted array for binary search, matrix dimensions that
  match the array length). Before any mutant is run, the original kernel is
  checked under `full` on all 200 inputs; it must never trap and never
  change a sentinel (otherwise the generator is fixed first).
- Arrays use the A3 layout (above the stack, 16-byte sentinel gaps).
- Each run has a loop fuel of 1,000,000 loop iterations; exhausting it ends
  the run deterministically ("fuel").
- A variant is **triggerable** if, under `full`, at least one input ends in
  a bounds-check trap or changes a sentinel. Only triggerable variants are
  kept; the count dropped as not triggerable is reported. The inputs on
  which it triggers under `full` are its **triggering inputs**.

## Outcomes

Per (variant, configuration, triggering input), the run ends in exactly one
of: `detected` (a bounds-check trap, any check), `silent_corruption` (no
bounds-check trap, a sentinel changed), `missed_benign` (no bounds-check
trap, sentinels intact, normal return), `other` (fuel, stack exhaustion or
another trap, sentinels intact).

Per (variant, configuration):

- **detected** (primary) iff every triggering input ends in `detected`
  (the policy catches the bug for every input that exposes it under full).
- detected-any (secondary) iff at least one triggering input ends in
  `detected`.
- **silent corruption** iff at least one triggering input ends in
  `silent_corruption`.

## Metrics

- **Detection rate** = detected variants / triggerable variants (pooled over
  kernels).
- **Silent corruption rate** = variants with silent corruption /
  triggerable variants.
- **Cost** of a configuration = checks executed + loop-versioning guard
  evaluations, measured with the counter build on the **unmutated** kernels
  on their A3 benchmark inputs at input scale 1 (`eval/benchmarks.ts`,
  `args(1)`), summed over kernels and divided by the checks `full` executes.
- **Detection-vs-cost curve** of a sweep family: its 21 points (cost,
  detection rate); for points with equal cost the highest detection rate is
  kept. Linear interpolation between points.
- **AUC** of a family: trapezoid area over cost in [0, 1] of the curve
  extended with (0, detection of `none`) and (1, detection of `full`).
- **95% confidence intervals**: percentile bootstrap, B = 2000, seed
  20261007, resampling the 16 **kernels** with replacement (all variants of
  a resampled kernel come along); every statistic, including cost, is
  recomputed on each resample. Mutants are never resampled individually.

## Hypotheses

**H1.** `strict` (guards counted) executes fewer checks + guards than
`proof`, with identical detection.
Supported iff (a) the 95% CI of cost(proof) - cost(strict) lies entirely
above 0, and (b) for every triggerable variant and every triggering input,
`strict` and `proof` produce the same outcome class (and, for `detected`,
the same check id). (b) is an exact check, no statistics.

**H2.** At matched total checks executed, threshold and budget policies
detect more bugs than `chuang`.
For each family F in {threshold sweep, budget sweep}: let x_c = cost of
`chuang`, D_F(x_c) the family's interpolated detection rate at x_c, and
delta_F = D_F(x_c) - detection rate of `chuang`. H2 is supported for F iff
the 95% CI of delta_F lies entirely above 0; refuted for F if it lies
entirely below 0; inconclusive otherwise; untestable for F if x_c is outside
F's cost range in the full sample. H2 is supported overall only if it is
supported for both families. The same comparison with detected-any is
reported as secondary.

## Determinism check

The whole mutation evaluation is run twice; the per-(variant,
configuration, input) outcome file must be byte-identical between the two
runs. The diff is reported.

## Also reported (not hypotheses)

AUC for both sweeps with CIs; per mutation class and per configuration, the
silent-corruption cases with the omitted site that caused them (the check
that fired under `full` on that input, its position, access, P, C, W, R and
the configuration's decision for it); variants generated, not compilable,
not triggerable and kept, per operator and per kernel.
