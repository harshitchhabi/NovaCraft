# NovaCraft

A compiler for **NovaCraft**, a small statically-typed imperative language,
that compiles all the way down to real, executable WebAssembly. Every
classical compiler stage is genuinely implemented and individually
inspectable: lexing, parsing, semantic analysis, IR generation, four
optimization passes (constant folding, dead-code elimination, a
range-analysis-based bounds-check elimination, and common-subexpression
elimination), linear-scan register allocation with spilling, explicit
stack-frame management, and WebAssembly text codegen, assembled and actually
run via Node's built-in `WebAssembly`.

The standout feature: **every array access is automatically bounds-checked,
and a compile-time range analysis proves and eliminates the checks that are
provably redundant**, so the language is memory-safe without paying for a
check on every single access. Checks that survive to runtime report the
exact NovaCraft source location on violation via a generated source map —
not a bare WebAssembly trap.

## Quick start

```bash
npm install
npm test                                    # full Jest suite (unit + end-to-end)
npx ts-node src/cli.ts examples/sumArray.min --run
```

The last command prints `15` (see "Running via the CLI" below for why
`main` takes array parameters here).

## A real application: moving-average anomaly detection

`tools/anomaly-cli.ts` is a small but genuine application built on the
compiler, not just a language demo: it flags anomalous points in a numeric
time series (request latency, sensor readings, queue depth — anything a
monitoring pipeline watches for spikes) using a moving-average deviation
check compiled from `examples/anomalyDetect.min` straight to WebAssembly.

```bash
npm run anomaly -- data/sample-latency-ms.csv --window 3 --threshold 30
```

```
Bounds checks [movingAvgFlag]: 2 inserted, 1 retained (50% eliminated)
...
60 points, window=3, threshold=30
10 anomalies flagged:

  [10] value=48
  [11] value=54
  [12] value=210
  [13] value=195
  ...
```

It's a genuine demonstration of the compiler's actual value, not just its
existence: `movingAvgFlag` has two array accesses on the *same* array —
`data[i]`, directly bounded by the surrounding loop's own condition, gets
its `BoundsCheck` proven safe and eliminated; `data[j]`, a windowed read the
analysis genuinely cannot relate back to the array's length, correctly keeps
its check. Building this program is also what surfaced a real bug in
`rangeAnalysis.ts` — see DEVLOG.md's "An inner loop was discarding an outer
loop's still-valid fact" — where an unrelated inner loop was silently
discarding the outer loop's proof, which this codebase now has a regression
test for (`tests/rangeAnalysis.test.ts`, `tests/anomalyDetect.test.ts`).

## Pipeline

```
source (.min)
  -> Lexer            (src/lexer.ts)        tokens
  -> Parser           (src/parser.ts)       AST
  -> Semantic analysis(src/semantic.ts)     type-checked AST
  -> IR generation    (src/ir.ts)           three-address IR + BoundsCheck insertion
  -> Constant folding (src/optimize/constantFold.ts)
  -> Dead-code elim.  (src/optimize/deadCode.ts)
  -> Range analysis   (src/optimize/rangeAnalysis.ts)   proves checks (each bound separately)
  -> Hardening        (src/harden/)         per-site risk score + policy: eliminate / hoist / retain / omit,
                                            loop versioning for hoisted checks
  -> CSE               (src/optimize/cse.ts)   common-subexpression elimination
  -> Dead-code elim.  (src/optimize/deadCode.ts)   (again, to clean up after CSE)
  -> Register alloc   (src/regalloc.ts)     linear scan, 4-register budget, spilling
  -> Codegen          (src/codegen.ts)      WebAssembly text (.wat) + source map
  -> Runtime harness  (runtime/harness.ts)  assemble (wabt) + instantiate + run
```

## Language

```
func sumArray(arr: int[], len: int) -> int {
    let total: int = 0;
    let i: int = 0;
    while (i < len) {
        total = total + arr[i];
        i = i + 1;
    }
    return total;
}
```

Types: `int`, `float`, `bool`, and single-dimension arrays of these
(`int[]`, etc.). Arrays **only appear as function parameters** — there are
no array literals and no local array allocation (see DEVLOG.md). An array
parameter is represented at the WebAssembly level as an `i32` base address
into linear memory; its length is a separate `int` parameter, by
convention the very next parameter in the list (`arr: int[], len: int`).

`if`/`else` chains and `while` loops are the core control flow. Two more are
parser-level sugar over them, adding no new IR shape (see DEVLOG.md):

- `else if` — an `else` immediately followed by `if` parses as a single
  nested `if` inside the `else` block, so any-length `if`/`else if`/.../`else`
  chains work.
- `for (init; cond; update) { body }` — desugars straight into a scoped
  `let` followed by the same structured `while` IR node a hand-written
  `while` loop produces, so it goes through the exact same range-analysis
  and codegen path (`examples/forSum.min`).

Full grammar is in `NOVACRAFT_BUILD_PROMPT.md`.

## CLI

```
novac <file.min> [options]
  --emit-tokens     print the token stream
  --emit-ast        print the AST (JSON)
  --emit-ir         print IR before and after each optimization pass, plus bounds-check stats
  --emit-alloc      print the register allocation table
  --emit-wat        print/save the generated .wat (and a .sourcemap.json alongside it)
  --run             assemble, instantiate, and execute (calls `main`), printing program output
  --reg-budget N    override the register budget (default 4)
  --stats           print bounds-check elimination stats even without --emit-ir
  --no-bounds-elim  retain every BoundsCheck (same as --harden=full)
                    (for comparison -- see "Does the elimination actually matter?" below)
  --harden=POLICY   bounds-check policy (default: proof):
                      none          no checks at all
                      full          every check, no elimination
                      proof         eliminate proven checks, retain the rest
                      strict        proof + hoisting by loop versioning; never omits
                      balanced      omit unproven checks with risk R < 0.5, hoist/retain the rest
                      performance   same with R < 0.8
                      threshold:T   same with R < T
                      budget:F      keep checks by descending R/cost until their cost is at
                                    most fraction F of the full-check cost, omit the rest
                      chuang        approximation of Chuang et al. 2007: retain unproven
                                    writes, omit unproven reads
  --risk-weights=wP,wC,wW   override the risk weights (default 0.40,0.35,0.25)
  --harden-report=FILE      write the per-site hardening report as JSON
```

With `--stats` or `--emit-ir` the per-site hardening report is also printed
(site id, line:col, read/write, P, C, W, R, loop depth D, decision). The risk
of an unproven site is `R = wP*P + wC*C + wW*W`: P = 1 if the index depends
on an entry-point parameter (`src/harden/taint.ts`), C = proof gap (0.5 if
one bound is proven, 1 if neither), W = 1 for a store. Only the threshold,
budget, chuang and none policies omit checks, and omitting is unsound by
design. `strict` is tested to be observably identical to `full`.

Run it via `npx ts-node src/cli.ts <file> [options]`, or `npm run novac --
<file> [options]`, or `node bin/novac.js <file> [options]` (the packaged
`novac` bin script), or build once with `npm run build` and run
`node dist/src/cli.js <file> [options]`. The exit code is non-zero on any
lexical/syntax/semantic error (all discovered errors are printed, not just
the first, wherever panic-mode recovery allows more than one) or on an
uncaught runtime trap during `--run`.

### Running via the CLI

NovaCraft has no array literals or local array allocation, so a NovaCraft
program cannot construct an array value from within the language — arrays
only ever arrive as parameters. That means `main` itself must take array
parameters for a program to exercise an array-taking function end to end.
`examples/sumArray.min`'s `main` therefore has the signature
`main(arr: int[], len: int) -> int`. When `--run` is used, the CLI seeds a
fixed default test array `[1, 2, 3, 4, 5]` into linear memory for every
array parameter of `main` (using the same adjacent-parameter length
convention as the rest of the compiler) and passes the matching
offset/length automatically — see `buildRunArgs` in `src/cli.ts` and
DEVLOG.md for the full rationale. `main` functions with no parameters (like
`examples/fib.min`) are simply called with no arguments.

## Examples

| File | Purpose |
|---|---|
| `examples/sumArray.min` | The canonical example; its one `BoundsCheck` is proven safe and eliminated. |
| `examples/fib.min` | Recursive Fibonacci; no arrays — exercises the call/stack-frame machinery and register pressure. |
| `examples/unsafe_index.min` | Indexes with a parameter unrelated to the loop/length; its `BoundsCheck` cannot be proven and survives. |
| `examples/bounds_violation.min` | Indexes with a constant (100) with no relation to the array's length; traps at runtime against any short test array. |
| `examples/forSum.min` | `sumArray.min` rewritten with a `for` loop; desugars to the same IR, same elimination. |
| `examples/classify.min` | An `if`/`else if`/`else` chain where every branch returns, as the function's last statement. |
| `examples/scaleArray.min` | Reads and writes the same index each iteration; two `BoundsCheck`s eliminated per iteration instead of one. |
| `examples/anomalyDetect.min` | Moving-average anomaly detection; the real application behind `npm run anomaly` (see above). One check eliminated, one genuinely retained, on the same array. |

## Memory layout

- Single linear memory, 1 initial page, grown automatically by the `wabt`/
  WebAssembly runtime if a program needs more.
- Offset `0..4095`: reserved for a test harness (Jest tests or the CLI's
  `--run` driver) to write array test data. The CLI seeds its default test
  array starting at offset `0`.
- A mutable `i32` global `$sp`, initialized to `65536` (start of the second
  page): a downward-growing stack pointer for spill slots. Each call
  decrements it by its own frame's size in the prologue and restores it
  before every `return`. The stack is confined to `8192..65535`
  (`STACK_LIMIT`): a prologue that would move `$sp` below `8192` traps with
  check id `-1` in the side channel, reported as
  `Runtime error: stack overflow`, so the stack never reaches the side
  channel or the harness array region.
- Three fixed offsets used as a trap side-channel (`src/stackFrame.ts`):
  `4096` (failing index), `4100` (failing length), `4104` (id of the
  `BoundsCheck` that fired, used to look up the source location in the
  generated source map — see DEVLOG.md for why an id is needed).

## Register allocation

Linear scan (Poletto & Sarkar) over live ranges computed by flattening the
(structurally nested) IR into a linear sequence of program points, with a
fixed physical-register budget (`r0..r{budget-1}`, default 4, overridable
via `--reg-budget`). On overflow, the interval with the furthest next use is
spilled to an explicit spill slot in linear memory. `--emit-alloc` prints
the resulting table, e.g.:

```
Register allocation for sumArray (budget=4):
  %t0 -> r2
  arr -> r0
  i -> r3
  len -> r1
  total -> spill[0]
```

## Range analysis / bounds-check elimination

See `src/optimize/rangeAnalysis.ts` and DEVLOG.md for the full algorithm.
In short: a numeric interval analysis with fixed-point iteration + widening
over `while` loops (proves e.g. `i >= 0`), combined with a symbolic
"less-than fact" carried from a loop's own condition (proves `i < len` even
though `len` has no useful numeric bound of its own). A `BoundsCheck` is
eliminated only when both facts are established; otherwise it is kept.
Running with `--emit-ir` or `--stats` prints a summary, e.g.:

```
Bounds checks [sumArray]: 1 inserted, 0 retained (100% eliminated)
```

### Does the elimination actually matter?

Proving a check redundant is only interesting if removing it is actually
faster. `benchmark/boundsCheckBenchmark.ts` compiles two programs **each
twice** from the same source — once normally (their checks eliminated) and
once with `--no-bounds-elim`'s underlying option (every check retained,
running on every single array access) — assembles all four to real
WebAssembly, and times each variant over a 4,000,000-element array across 20
calls, after a warmup:

- `sumArray.min` — one `BoundsCheck` per loop iteration (a read).
- `scaleArray.min` — two `BoundsCheck`s per loop iteration (a read and a
  write to the same index), showing the benefit scale with how many checks
  a hot loop actually contains.

Run it with:

```bash
npm run benchmark
```

Output measured during the audit (`docs/AUDIT.md`, section 1; Node
v22.22.0, single run, after the A0 soundness fixes):

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

These figures vary by machine, Node/V8 version and run: the benchmark
reports a mean of 20 calls with no variance, and the run before the fixes
on the same machine gave 1.04x and 1.34x. Treat them as indicative only;
on this machine removing the single read check in `sumArray` saves little,
while removing the read + write checks in `scaleArray` saves more.

Both variants of each scenario are verified to compute the identical,
correct result before any timing number is trusted — the benchmark is not
just measuring two programs that happen to run at different speeds, it's
measuring the *same* proven result reached with and without paying for the
check(s).

## Evaluation

`npm run eval` runs the benchmark kernels, bug corpus and policy sweeps and
writes `results/RESULTS.md`; `npm run eval:mutation` runs the preregistered
mutation-corpus evaluation (`docs/PREREGISTRATION.md`) and writes
`results/mutation/RESULTS.md`. Both reports are generated from raw CSVs.

## Common-subexpression elimination

`src/optimize/cse.ts` runs after range analysis (deliberately — CSE could
otherwise rewrite the exact `binop` instruction rangeAnalysis.ts pattern-
matches for its `x < y` "less-than fact" into a `move`, defeating that
match). Within a single straight-line instruction list, a `binop` that
recomputes the same operator and operands as an earlier still-live one is
replaced with a `move` from that earlier result instead of being
recomputed; as with constant folding and dead-code elimination, this does
not cross `if`/`while` boundaries, since a branch or loop body may execute
conditionally or repeatedly. A final dead-code elimination pass then cleans
up any now-unused intermediate the rewrite left behind.

## Tests

`npm test` runs the full Jest suite: one file per pipeline stage
(`tests/lexer.test.ts`, `parser.test.ts`, `semantic.test.ts`, `ir.test.ts`,
`rangeAnalysis.test.ts`, `regalloc.test.ts`), `tests/cse.test.ts` (verifying
a duplicate expression is actually folded to a `move`, and that doing so
doesn't change the result), `tests/compile.test.ts` (guarding the
`--no-bounds-elim` path the benchmark relies on), plus `tests/e2e.test.ts`
covering real WebAssembly execution (the happy-path sum, recursive
Fibonacci, a runtime bounds-violation trap with the exact diagnostic
message, the `for`/`else if` sugar, and a CLI smoke test). CI
(`.github/workflows/ci.yml`) runs the type checker, the full suite, and a
production build on every push/PR against Node 18 and 20.
