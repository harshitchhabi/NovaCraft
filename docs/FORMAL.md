# Formal description

This document describes what the code in `src/optimize/rangeAnalysis.ts` and
`src/harden/` does, and sketches why three properties hold. The sketches are
arguments on paper, not machine-checked proofs. Next to each property is the
test that checks it empirically, and the conditions under which it holds.
Nothing here is claimed beyond what those tests exercise.

## 1. Setting

A NovaCraft function is compiled to a structured IR (`src/ir.ts`): straight-
line three-address instructions, `if` with nested then/else lists, and
`while` with a condition-instruction list and a body list. Every array
access `a[e]` is preceded by `BoundsCheck(e, len)`, where `len` is the int
parameter directly after the array parameter `a` (the adjacent-parameter
convention, DEVLOG.md). All `int` arithmetic is WebAssembly `i32`
arithmetic: two's complement, wrapping modulo 2^32. A check traps iff
`e < 0 || e >= len` (signed). It writes the check id, the index and the
length to a fixed side channel before trapping.

**Trust assumption.** A check compares the index with the *length argument*.
If a caller passes a length larger than the real array, accesses that pass
their check can reach any address in linear memory. That includes the
program's own spill stack, because a byte address is `base + 4 * index`
modulo 2^32. No property below holds for such inputs. The tests restrict
length arguments to at most the real array length; see
`docs/LIMITATIONS.md`.

## 2. Abstract domain (range analysis)

For each program point, the analysis keeps a state with four parts:

- **Intervals.** `ranges: reg -> [lo, hi]` with
  `INT_MIN <= lo <= hi <= INT_MAX`. A register with no entry denotes the
  full i32 range (TOP). Float registers are always TOP.
- **Less-than facts.** `condBound: x -> {(y, strict)}`. Each fact means
  `x < y` (strict) or `x <= y` holds between the current values of
  registers x and y.
- **Linear definitions.** `lin: d -> (b, c)`, meaning `d = b + c` exactly,
  as mathematical integers (no wraparound), with constant `c`.
- **Dead flag.** `dead` marks a point that is unreachable: after a
  `return`, or on a branch whose refined interval is empty.

Join (at the end of an `if`):

- A dead side contributes nothing.
- Otherwise intervals are joined pointwise (min of lo, max of hi), and
  facts and linear definitions are intersected.

Transfer functions:

- **`+`, `-`, unary `-`.** The exact interval result is computed; if it may
  leave `[INT_MIN, INT_MAX]`, the result is TOP (`fit`).
- **`*`, `/`, `%`.** Only both-constant operands are evaluated, with i32
  semantics. `x / 0`, `x % 0` and `INT_MIN / -1` give TOP, because they
  trap at runtime. Anything else gives TOP.
- **Comparisons and logic** give `[0, 1]`.
- **Redefinition.** Redefining a register removes every fact and linear
  definition that mentions it.
- **New linear definitions.** `d = b + k` (and `b - k`, `k + b`, and the
  move `d = b`) records `lin[d] = (b, ±k)` only when `b`'s interval plus
  `k` stays inside i32.

Branch refinement:

- **Condition shape.** The comparison must be the instruction immediately
  before an `if` or at the end of a `while` condition, so no operand is
  redefined in between, and both operands must be ints.
- **Effect.** It narrows both operands' intervals on the true and false
  edges, and records `a < b` or `a <= b` on the edge where that holds.

Loops:

- **Head state.** The head is `entry JOIN back-edge`. It is iterated until
  a round changes nothing. From the second round on, a bound that still
  moves is widened to `INT_MIN` / `INT_MAX`. A fallback sets every
  register the loop defines to TOP if 1000 rounds are reached.
- **Facts inside the loop.** Facts from before the loop are used in the
  loop and after it only if the loop redefines neither register.

**Check decision.** `BoundsCheck(i, n)` gets two flags:

- `provenLo`: the interval of `i` has `lo >= 0`.
- `provenHi`, from either of two routes:
  - numerically: `hi(i) < lo(n)`;
  - symbolically: `i = A + c1` exactly, a fact `A < B` (or `A <= B`), and
    `B = n + c2` exactly, with `c1 + c2 <= 0` (or `<= -1` for `<=`). Both
    `i` and `B` may be reached through chains of linear definitions.

The site is **proven** iff both flags hold.

## 3. Risk function

For an unproven site:

- P = 1 if the index register is external, else 0. External means it is
  data-dependent on a parameter of an entry-point function
  (`src/harden/taint.ts`). The analysis is flow-insensitive per register
  and context-insensitive across calls.
- C = 0.5 if exactly one of `provenLo` and `provenHi` holds, else 1.
- W = 1 for a store, 0 for a load.

    R = wP*P + wC*C + wW*W        default wP = 0.40, wC = 0.35, wW = 0.25

R is rounded to 1e-9. Proven sites are not scored (C = 0, R undefined).

**R is graded, not continuous.** P, C and W are each drawn from a set of at
most three values, so R takes **at most 12 discrete values** (2 x 3 x 2
combinations of P, C, W). Only 8 of them occur for scored sites, because
an unproven site has C in {0.5, 1}. With the default weights they are:

| P | C | W | R |
|---|---|---|---|
| 0 | 0.5 | 0 | 0.175 |
| 0 | 1 | 0 | 0.35 |
| 0 | 0.5 | 1 | 0.425 |
| 1 | 0.5 | 0 | 0.575 |
| 0 | 1 | 1 | 0.6 |
| 1 | 1 | 0 | 0.75 |
| 1 | 0.5 | 1 | 0.825 |
| 1 | 1 | 1 | 1.0 |

Consequences, from the decision rule below:

- `threshold:tau` decisions change only when tau crosses one of these
  values.
- The 21-step sweeps in `results/` therefore show plateaus.
- The score ranks *classes* of sites, not individual sites.

Loop depth D is used only for the budget cost, `cost = 10^min(D, 3)`.

## 4. Decision rule and policies

Each site gets one of Eliminate, Hoist, Retain, Omit
(`src/harden/harden.ts`, `decide`):

| policy | rule |
|---|---|
| `none` | Omit every site |
| `full` | Retain every site |
| `proof` | proven: Eliminate; else Retain |
| `threshold:tau` (`strict` = 0, `balanced` = 0.5, `performance` = 0.8) | proven: Eliminate; else R < tau: Omit; else versionable: Hoist; else Retain |
| `budget:F` | see below |
| `chuang` | proven: Eliminate; unproven write: Retain; unproven read: Omit (no hoisting) |

**Budget rule.**

1. Proven sites are eliminated.
2. Unproven sites are sorted by R/cost, descending, with ties broken by
   site id.
3. Sites are kept as long as the cumulative cost stays at or below
   F x (sum of every site's cost). The first site that does not fit, and
   every site after it, is omitted.
4. Kept sites are hoisted if versionable, otherwise retained.

Hoisting is not credited in the cost.

**Codegen.** A runtime test is emitted for Retain everywhere, and for Hoist
only in the slow copy of the versioned loop (`checkEmitted`, `src/ir.ts`).
Omit is the only unsound decision. It occurs under `none`, `chuang`,
`budget:F`, and `threshold:tau` with tau > 0.

**Loop versioning (Hoist), `src/harden/version.ts`.**

Qualifying loop:

- Its condition is `i < N` or `i <= N`.
- `i` has exactly one assignment in the loop: a top-level `i = i + s`
  with constant s > 0.
- `N` is not assigned in the loop.

Qualifying site:

- Its index is `i + c` (constant c), with the index register defined once
  in the loop.
- Its length is not assigned in the loop.
- If the site comes after the update, its effective offset is c + s.

The guard runs before the loop in 64-bit arithmetic, with `Nmax = N - 1`
for `<` and `N` for `<=`:

    for every hoisted site:  0 <= i_entry + c      and   Nmax + c + 1 <= len
    once per loop:           Nmax + s <= INT_MAX

If the guard holds, the fast copy runs, without the hoisted checks.
Otherwise the slow copy runs, which is the original loop. Both copies keep
the same check ids.

## 5. Properties

### 5.1 Range analysis is sound under i32 wraparound

**Claim.** If the analysis marks a check proven, then on every execution in
which that check is reached, its index lies in `[0, len)`.

**Conditions.** Length arguments are honest (section 1), and the program
has not corrupted its own spill stack.

**Sketch.** By induction over the IR, each state over-approximates the
concrete i32 values at that point.

- **Intervals.**
  - Every transfer either computes an exact interval that provably stays
    inside i32 (so the wrapped value equals the exact value), or returns
    TOP.
  - Refinement on a branch only removes values that make the branch
    condition false.
  - The loop head is a verified post-fixpoint of `entry JOIN body`, so it
    contains every value the loop head can see.
- **Facts.** A fact `x < y` is created only on an edge where the
  comparison of the current x and y was true. It is deleted when x or y is
  redefined. In a loop, it is kept only if the loop never redefines x or y,
  so it holds at every visit of the loop head.
- **Linear definitions.** `d = b + c` is recorded only when the addition
  cannot wrap, so it is an exact integer equation. It is deleted when d or
  b is redefined.
- **The symbolic test.** It chains these as exact inequalities over the
  integers.

**Tested by:**

- the A0 fixtures and `tests/soundness.test.ts` (wraparound, off-by-one,
  reassignment, nested loops, if-joins, `for`, CSE and constant folding);
- `tests/differential.test.ts` (proof vs `--no-bounds-elim`);
- `tests/analysisSoundness.test.ts`: under `full`, on all programs in
  `examples/`, `bench/`, `bench/bugs/` and the fixtures, with fuzzed
  extreme inputs, no bounds check that proof or strict marked proven ever
  fires.

**Not true in general for hoisted sites.** A hoisted check can fire under
`full`: the guard is then false and the slow copy keeps the check.
`tests/analysisSoundness.test.ts` asserts the property that does hold:
whenever a hoisted check fires under `full`, `strict` traps at the same
check with the same index and length. It also asserts that this happens
on some inputs.

### 5.2 `strict` is observably identical to `full`

**Claim.** For every input, `strict` and `full` give:

- the same result, or the same trap (check id, index, length);
- the same printed output;
- the same memory outside the spill stack.

**Conditions.** As in 5.1, plus: stack exhaustion is treated as one
outcome, because the depth at which the stack limit traps depends on frame
sizes, which can differ between the two builds.

**Sketch.**

- `strict` omits nothing (tau = 0 and R >= 0).
- Its eliminated checks never fire (5.1), so removing them changes no
  outcome.
- Its hoisted checks are absent only in a fast copy, which runs only when
  the guard holds. The guard implies the following:
  - The update cannot wrap, so the values of `i` at the top of the body
    are `i_entry, i_entry + s, ...`, all `<= Nmax`.
  - Every hoisted index `i + c` therefore lies in
    `[i_entry + c, Nmax + c]`, which is a subset of `[0, len)`.
  - So none of the removed checks would have fired.
- In the slow copy every check that `full` has is either present or
  proven. Check ids are shared, so a trap reports the same id.

**Tested by:**

- `tests/strictEquiv.test.ts`: every program in `examples/`, `bench/`,
  `bench/bugs/` and the fixtures, 100 fuzzed cases per function, scalar
  and loop-bound arguments including 0, ±1, INT_MAX and INT_MIN;
- `tests/versioning.test.ts`: guard true and false, a bound near INT_MAX,
  and a mutant without the overflow term, which is caught.

### 5.3 Threshold monotonicity

**Claim.** For tau1 < tau2:

- retained-or-hoisted(tau2) is a subset of retained-or-hoisted(tau1);
- omitted(tau1) is a subset of omitted(tau2).

**Sketch.**

- R depends only on the site, not on tau.
- A site is omitted at tau iff it is unproven and R < tau. If R < tau1,
  then R < tau2, so omitted(tau1) is a subset of omitted(tau2).
- Every unproven site that is not omitted is retained or hoisted, and the
  choice between those two does not depend on tau. Proven sites are
  eliminated at every tau. So retained-or-hoisted(tau) is the unproven
  sites minus omitted(tau), which shrinks as tau grows.

**Tested by:** `tests/monotonicity.test.ts` (fast-check, 300 runs over all
programs, random weights in [0, 1] and random tau pairs in [0, 1.2]) and
`tests/harden.test.ts` (the 0.05-step sweep).

Monotonicity is about which *sites* are kept. It does not imply that
detection or cost is monotone in tau on a particular input: different
mutants are affected by different sites.
