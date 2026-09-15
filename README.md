# NovaCraft

A compiler for **NovaCraft**, a small statically-typed imperative language,
that compiles all the way down to real, executable WebAssembly. Every
classical compiler stage is genuinely implemented and individually
inspectable: lexing, parsing, semantic analysis, IR generation, three
optimization passes (constant folding, dead-code elimination, and a
range-analysis-based bounds-check elimination), linear-scan register
allocation with spilling, explicit stack-frame management, and WebAssembly
text codegen, assembled and actually run via Node's built-in `WebAssembly`.

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

## Pipeline

```
source (.min)
  -> Lexer            (src/lexer.ts)        tokens
  -> Parser           (src/parser.ts)       AST
  -> Semantic analysis(src/semantic.ts)     type-checked AST
  -> IR generation    (src/ir.ts)           three-address IR + BoundsCheck insertion
  -> Constant folding (src/optimize/constantFold.ts)
  -> Dead-code elim.  (src/optimize/deadCode.ts)
  -> Range analysis   (src/optimize/rangeAnalysis.ts)   bounds-check elimination
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
```

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

## Memory layout

- Single linear memory, 1 initial page, grown automatically by the `wabt`/
  WebAssembly runtime if a program needs more.
- Offset `0..4095`: reserved for a test harness (Jest tests or the CLI's
  `--run` driver) to write array test data. The CLI seeds its default test
  array starting at offset `0`.
- A mutable `i32` global `$sp`, initialized to `65536` (start of the second
  page): a downward-growing stack pointer for spill slots. Each call
  decrements it by its own frame's size in the prologue and restores it
  before every `return`.
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

## Tests

`npm test` runs the full Jest suite: one file per pipeline stage
(`tests/lexer.test.ts`, `parser.test.ts`, `semantic.test.ts`, `ir.test.ts`,
`rangeAnalysis.test.ts`, `regalloc.test.ts`), plus `tests/e2e.test.ts`
covering real WebAssembly execution (the happy-path sum, recursive
Fibonacci, a runtime bounds-violation trap with the exact diagnostic
message, and a CLI smoke test).
