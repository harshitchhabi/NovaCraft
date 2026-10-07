# Audit (milestone A0)

Branch `harden/risk-adaptive`, created from `master` at `22ef7b4`.
Node v22.22.0.

## 1. Baseline before any change

`npm ci` installed cleanly. `npm test`: **10 suites, 34 tests, all passing.**

`npm run benchmark` (raw output, pre-fix):

```
NovaCraft bounds-check elimination benchmark
Array length: 4,000,000 elements, 20 timed calls per variant

--- sumArray (1 check/iteration: read) ---
Checks eliminated (range analysis ON):  14.73 ms/call avg
Checks retained   (range analysis OFF): 15.31 ms/call avg
Speedup from elimination: 1.04x  (3.9% overhead removed)
Both variants computed the correct result: 4000000.

--- scaleArray (2 checks/iteration: read + write) ---
Checks eliminated (range analysis ON):  11.11 ms/call avg
Checks retained   (range analysis OFF): 14.89 ms/call avg
Speedup from elimination: 1.34x  (34.0% overhead removed)
Both variants computed the correct result: 1048576.
```

Post-fix (same machine, same session):

```
--- sumArray (1 check/iteration: read) ---
Checks eliminated (range analysis ON):  14.86 ms/call avg
Checks retained   (range analysis OFF): 15.67 ms/call avg
Speedup from elimination: 1.05x  (5.5% overhead removed)

--- scaleArray (2 checks/iteration: read + write) ---
Checks eliminated (range analysis ON):  10.17 ms/call avg
Checks retained   (range analysis OFF): 13.47 ms/call avg
Speedup from elimination: 1.33x  (32.5% overhead removed)
```

Both are single runs of a mean-of-20 benchmark with no variance reported;
treat them as indicative only. The fixes did not change which checks are
eliminated in either benchmark program (see section 4).

**Discrepancy, not fixed here:** `README.md` quotes "representative" figures
of 1.33x (sumArray) and 1.75x (scaleArray). Neither run in this audit
reproduces the sumArray figure (1.04x and 1.05x measured). The README claim
should be replaced by numbers produced by the A3 evaluation harness.

## 2. What was read

`DEVLOG.md`, `src/optimize/rangeAnalysis.ts`, `src/ir.ts`,
`src/optimize/{constantFold,deadCode,cse}.ts`, `src/compile.ts`,
`src/codegen.ts`, `src/regalloc.ts`, `src/stackFrame.ts`, `src/cli.ts`,
`runtime/harness.ts`, all existing tests and examples.

## 3. Soundness findings

"Sound" here means: for every input, the build with range analysis behaves
exactly like the build with every check retained (`--no-bounds-elim`) —
same result or same trap (check id, index, length), same printed output,
same final memory. Each finding below has a fixture under
`tests/fixtures/soundness/`, a static test in `tests/soundness.test.ts`, and
is also exercised by the differential fuzz test. All tests listed as failing
were run against the unmodified `src/` (via `git stash`) and failed there.

| # | Bug | Case | Fixture | Effect before fix |
|---|-----|------|---------|-------------------|
| B1 | Interval arithmetic used exact (unbounded) math with ±Infinity; a result past INT_MAX was kept as a large positive range instead of "could wrap to anything". | (a) | `wrapIndex.min` | `arr[i + 2147483647]` with `i` in [0,1] was eliminated; at runtime the index is INT_MIN. Full build traps (index -2147483648); proof build silently reads `arr[0]` (address wraps). Fuzz: 63 of 101 cases diverged. |
| B2 | Loop fixed point stopped after 4 rounds without checking that it had converged; widening is applied per round, so a value depending on a chain of loop-carried copies was still under-approximated. | (d) | `delayChain.min` | `arr[e]` (e lags a counter by 4 iterations) was eliminated using e ∈ [0,0]. Fuzz: 100 of 101 cases diverged. |
| B3 | An inner loop's body started from the outer state's symbolic facts (e.g. outer `i < len`) even when the inner loop itself redefines `i`; the fact only holds on the inner loop's first iteration. (The README's earlier nested-loop fix handled the loop *exit*, not the inner loop's *back-edge*.) | (d) | `nestedStale.min` | `arr[i]` inside the inner loop eliminated; reads past `len` from the second outer iteration on. Fuzz: 38 of 101 cases diverged. |
| B4 | Constant folding used JS doubles: `2147483647 + 1` folded to 2147483648, `65536 * 65536` to 4294967296 (an invalid `i32.const`, module fails to assemble), unary minus on INT_MIN did not wrap, `INT_MIN / -1` was folded although it traps. | (a)(g) | `constWrap.min` | Wrong constants reach both the emitted code and the range analysis. `constWrap.min` could not be assembled at all. |
| B5 | Dead-code elimination removed an unused `x / y` or `x % y`, removing its division-by-zero trap. Not a bounds-check-elimination bug (both builds are affected identically, so the differential test cannot see it). | (g) | `cseFold.min` (`divTrap`) | `divTrap(0)` returned 1 instead of trapping. |
| B6 | Integer literals above INT_MAX were accepted unchecked; above 2^32-1 they produce an invalid `i32.const`. | (a) | `tests/soundness.test.ts` | Crash in the assembler instead of a compile error. |

Cases checked and found already correct (tests added, all pass before and
after): (b) `while (i <= len)` keeps its check; (c) `len` or the index
reassigned in the body before the access keeps the check, and `len`
reassigned *after* the access is correctly still provable (the condition is
re-evaluated each iteration); (e) a fact killed on one branch of an `if`
does not survive the join; (f) the `for` desugaring (stride-2 `arr[i+1]` and
a post-loop access are kept); (g) CSE runs after range analysis and only
rewrites `binop` into `move`, which preserves the values every eliminated
check relied on — confirmed dynamically by the fuzz test on `cseFold.min`.

### Fixes

`src/optimize/rangeAnalysis.ts` keeps the same technique (intervals +
symbolic less-than facts) with these changes:

- Ranges are always subsets of [INT_MIN, INT_MAX]. A missing register means
  the full i32 range. Any `+`, `-`, unary `-` whose exact result interval
  leaves i32 becomes the full range; `*`, `/`, `%` are evaluated only on
  constants, with i32 semantics (`Math.imul`, trapping cases → full range).
  Float registers are not tracked. (B1)
- The loop fixed point iterates until the head state is verified stable
  (widening to INT_MIN/INT_MAX after 2 rounds makes this terminate; a cap of
  1000 rounds falls back to "every register the loop defines is unknown",
  which is trivially stable). (B2)
- Facts from before a loop are used inside the loop (and after it) only if
  the loop defines neither register they mention. (B3)
- The loop body is analyzed after the condition instructions, and the
  condition's facts are added on the body edge (previously they were added
  before the condition instructions ran, so a condition like
  `i < len - 1` lost its fact immediately).
- Two minimal extensions, needed for the required `arr[i+1]` outcome
  (section 5): (1) branch refinement: the comparison directly defining an
  `if`/`while` condition narrows both operands' ranges on the true and false
  edges and records the symbolic fact; a branch whose refined range is empty
  is infeasible and a branch that always returns contributes nothing to the
  join; several facts per register are kept. (2) Exact linear definitions:
  `d = b + c` / `d = b - c` / `d = b` with a constant `c` is recorded only
  when the interval of `b` shows the addition cannot wrap; the symbolic check
  proves `idx < len` from `idx = A + c1`, `A < B` (or `A <= B`),
  `B = len + c2` with `c1 + c2 <= 0` (or `<= -1`).

`src/optimize/constantFold.ts` folds with i32 wraparound and f32 rounding
and leaves `x / 0`, `x % 0`, `INT_MIN / -1` unfolded (B4).
`src/optimize/deadCode.ts` keeps an unused int `/` or `%` unless its divisor
is a constant that cannot trap (B5). `src/semantic.ts` rejects int literals
above 2147483648 and maps 2147483648 to INT_MIN so `-2147483648` can be
written (B6).

## 4. Differential fuzz test

`tests/differential.test.ts` + `tests/differentialHarness.ts` +
`tests/fuzzWorker.js`. For every program in `examples/` and
`tests/fixtures/soundness/`, both builds are run on the same inputs, for
every exported function: array parameters get a real array (length 0–24,
mostly small values plus 0, ±1, INT_MAX, INT_MIN) placed in linear memory;
the adjacent length parameter is the true length, length ± 1, 0, 1, -1,
2·length + 3, INT_MAX or INT_MIN; other int parameters are drawn from
0, ±1, small values, INT_MAX, INT_MIN, INT_MAX - 1, INT_MIN + 1. Inputs come
from a seeded PRNG, so runs are reproducible. Each run executes in a worker
thread; a full-check run that does not finish in 400 ms (a fuzzed INT_MAX
loop bound over a loop that never touches memory) is counted as a timeout
and not compared. The test also checks that the oracle has teeth: a fake
"proof" build that drops every check is detected on `unsafe_index.min`,
`offByOne.min` and `nestedMatrix.min`.

Result with the test's settings (120 cases per function, seed 1), after the
fixes: **0 mismatches in all 19 programs**; 3 timeouts in total
(`anomalyDetect.min` 1, `nestedMatrix.min` 2). Before the fixes the same
harness (100 cases per function) found the divergences listed in B1–B3, and
`constWrap.min` failed to assemble (B4).

Elimination counts on the 8 `examples/` programs are identical before and
after the fixes (e.g. `sumArray` 1/1, `scaleArray` 2/3, `movingAvgFlag`
1/2). On the fixtures, the fixes remove the 3 unsound eliminations (B1–B3:
`wrapIndex`, `delayChain`, `nestedStale`, 1 each) and add 5 sound ones
(`plusOneGuarded` 0→2, `cseDup` 0→2, `constLen` 1→2, the last from the
loop exit edge refining `i >= 4`).

## 5. Required analysis outcomes

| Outcome | Status | Test |
|---|---|---|
| `sumArray` proven | proven | `tests/soundness.test.ts`, `tests/rangeAnalysis.test.ts` |
| `arr[i+1]` in `while (i < len - 1)` proven | **proven only when `len - 1` cannot wrap** (see below) | `plusOneGuarded` |
| `while (i <= len) { arr[i] }` not proven | not proven | `offByOne.min` |
| `arr[k]`, unrelated parameter, not proven | not proven | `unsafe_index.min` |
| `arr[i*m + j]`, doubly nested, separate `len`, not proven | not proven | `nestedMatrix.min` |

**Deviation from the requirement.** With no information about `len`, proving
`arr[i+1]` under `while (i < len - 1)` is unsound under i32 semantics, which
the same spec requires in case (a): for `len == INT_MIN`, `len - 1` wraps to
INT_MAX, the loop is entered with `i == 0`, and the full-check program traps
at `arr[1]` (1 ≥ INT_MIN) while a proof build would read on. So the
unconstrained form (`plusOne` in `plusOne.min`) is deliberately **not**
proven, and the test asserts that. The analysis proves the same access as
soon as anything establishes `len > INT_MIN` — in `plusOneGuarded` that is an
enclosing `if (len > 0)`, which branch refinement turns into `len ∈ [1,
INT_MAX]`. If you want the unguarded form proven, the language would need a
rule that length parameters are non-negative (and the harness/CLI would
have to enforce it); that is a semantic change, not an analysis one, so I
did not make it.

## 6. Still open / not done in A0

- README benchmark figures (section 1) are not reproduced. *Fixed after A0:
  the README now quotes the post-fix run above and says figures vary by
  machine (`tests/docs.test.ts`).*
- The register allocator, codegen and stack-frame code were read but not
  audited in depth; the differential test exercises them only in so far as
  both builds share them, so a bug that affects both builds identically
  (like B5) is invisible to it.
- The `$sp` stack grows down from 65536 with no overflow check; deep
  recursion with spill slots can write into low memory, where test arrays
  live. Same in both builds; not a bounds-check issue. *Fixed after A0: a
  prologue stack-limit check (`tests/stackLimit.test.ts`, DEVLOG.md).*
- *Added after A0:* `tests/regBudget.test.ts` compares register budgets 2,
  3, 4 and 8 on every program; it fails on 12 of 20 programs if the
  allocator's loop-carried liveness fix is reverted.
- Float constant folding now rounds to f32, but no test demonstrates a case
  where the old f64 folding gave a different answer (the 0.1 + 0.2 test
  passes on the old code too).
- The analysis is intraprocedural, as before.
