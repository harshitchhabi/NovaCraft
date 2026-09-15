# Build NovaCraft: a compiler for a small imperative language, targeting WebAssembly, with bounds-checked arrays and static check elimination

You are building the full implementation for a college Compiler Design lab project. Build the complete system end-to-end in this repository, in one session, without stopping to ask me questions — every design decision you need is specified below. Where something genuinely isn't specified, make the most standard/textbook choice, document it in `DEVLOG.md` with a one-line rationale, and keep going.

Work incrementally but don't stop between stages: implement lexer → parser → semantic analysis → IR → optimizations → register allocation → codegen → runtime harness, writing tests as you go, and only consider the task done when every acceptance test at the bottom of this document passes.

## 1. Project goal

A compiler for **NovaCraft**, a small statically-typed imperative language, that compiles all the way to a real, executable WebAssembly binary — not an interpreter. Every classical compiler stage must be genuinely implemented and individually inspectable: lexing, parsing, semantic analysis, IR generation, optimization (including a real static-analysis-based optimization, not just constant folding), register allocation with spilling, explicit stack frame management, and code generation to WebAssembly text, assembled and actually run.

The standout feature: **every array access is automatically bounds-checked, and a compile-time range analysis proves and eliminates the checks that are provably redundant**, so the language is memory-safe without paying for a check on every single access. Checks that survive to runtime report the exact NovaCraft source location on violation, via a generated source map — not a bare WebAssembly trap.

## 2. Tech stack (if you think of something to add do it)

- **Language/runtime:** TypeScript on Node.js (use `ts-node` or compile with `tsc`; either is fine, pick one and be consistent)
- **Parser:** hand-written recursive-descent with precedence climbing — no parser-generator library (no peg.js, nearley, ANTLR, etc.)
- **WebAssembly assembly:** use the `wabt` **npm package** (not a system binary install) so the project is portable — it exposes `wat2wasm` compiled to WASM/JS. Import it as `wabt` from npm.
- **Execution:** Node's built-in `WebAssembly` global — no browser required.
- **Testing:** Jest.
- **CLI:** a single entry point, package it as a bin script.

## 3. Language specification (fixed grammar — implement exactly this)

### Keywords
`func let if else while return print int float bool true false`

### Token categories
| Category | Pattern |
|---|---|
| Identifier | `[A-Za-z_][A-Za-z0-9_]*` (not a keyword) |
| Integer literal | `[0-9]+` |
| Float literal | `[0-9]+\.[0-9]+` |
| Operators | `+ - * / % == != < <= > >= && \|\| ! = -> :` |
| Punctuation | `( ) { } [ ] , ;` |
| Comment | `//` to end of line, skipped (not a token) |

### Grammar (EBNF)

```
program        ::= { function_decl } ;
function_decl  ::= "func" IDENT "(" [ param_list ] ")" "->" type block ;
param_list     ::= param { "," param } ;
param          ::= IDENT ":" type ;
type           ::= "int" | "float" | "bool" | type "[" "]" ;
block          ::= "{" { statement } "}" ;
statement      ::= var_decl | assign_stmt | if_stmt | while_stmt
                  | return_stmt | print_stmt | expr_stmt ;
var_decl       ::= "let" IDENT ":" type [ "=" expression ] ";" ;
assign_stmt    ::= lvalue "=" expression ";" ;
lvalue         ::= IDENT [ "[" expression "]" ] ;
if_stmt        ::= "if" "(" expression ")" block [ "else" block ] ;
while_stmt     ::= "while" "(" expression ")" block ;
return_stmt    ::= "return" [ expression ] ";" ;
print_stmt     ::= "print" "(" expression ")" ";" ;
expr_stmt      ::= expression ";" ;

expression     ::= logic_or ;
logic_or       ::= logic_and { "||" logic_and } ;
logic_and      ::= equality { "&&" equality } ;
equality       ::= relational { ("==" | "!=") relational } ;
relational     ::= additive { ("<" | "<=" | ">" | ">=") additive } ;
additive       ::= multiplicative { ("+" | "-") multiplicative } ;
multiplicative ::= unary { ("*" | "/" | "%") unary } ;
unary          ::= ("-" | "!") unary | primary ;
primary        ::= INT_LIT | FLOAT_LIT | "true" | "false"
                  | IDENT [ "[" expression "]" ]
                  | IDENT "(" [ arg_list ] ")"
                  | "(" expression ")" ;
arg_list       ::= expression { "," expression } ;
```

### Array semantics — resolved, do not redesign

Arrays in this implementation **only appear as function parameters** — there are no array literals and no local array allocation in this build (this is a deliberate scope decision, not a gap). An array parameter (`arr: int[]`) is represented at the WebAssembly level as an `i32` base address into linear memory; the array's length is always passed as a separate, explicit `int` parameter by convention (as in the example below) — the compiler does not track length automatically. The **test harness** is responsible for writing test array data into linear memory at a known offset before calling a compiled function and passing that offset as the array argument (see §8).

### Example program the whole pipeline must handle correctly

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

func main() -> int {
    let n: int = 5;
    print(n);
    return 0;
}
```

## 4. Pipeline stages — implement all of these as separate, independently testable modules

1. **Lexer** — hand-written scanner, full token set above, tracks line/column, reports `Lexical error at L:C - <message>` on illegal characters.
2. **Parser** — recursive-descent + precedence climbing per the grammar above, produces an AST, reports `Syntax error at L:C - <message>`, attempts panic-mode recovery (skip to next `;` or `}`) so it can report more than one syntax error per run rather than stopping at the first.
3. **Semantic analysis** — scoped symbol table (function scope + block scope), static type checking of every expression and assignment, function signature checking (arity + return type on every `return`, including "missing return on some path" as an error), undeclared/redeclared-name detection. Reports `Semantic error at L:C - <message>`.
4. **IR generation** — lower the AST to three-address code (unlimited virtual registers, e.g. `%t0`, `%t1`, ...). Every IR instruction carries the source line/column it was generated from. **During this stage, insert an explicit `BoundsCheck` IR instruction immediately before every array read or write** (`arr[i]` for read, `arr[i] = ...` for write), taking the index value and the length value (the parameter passed alongside the array, per §3) as operands.
5. **Optimization pass 1 — constant folding.**
6. **Optimization pass 2 — dead-code elimination** (unreachable code after `return`; assignments to variables never read again).
7. **Optimization pass 3 — range analysis / bounds-check elimination (the key feature).** See §5 below for the required algorithm and required test behavior.
8. **Register allocation** — linear-scan (Poletto & Sarkar), **fixed register budget of 4** physical registers (name them `r0`..`r3`), computed over live ranges in the optimized IR. When live ranges exceed the budget, spill the one with the furthest next use to an explicit spill slot (see memory layout in §6). Produce a printable allocation table: `%t3 -> r1`, `%t7 -> spill[2]`, etc.
9. **Stack frame layout** — explicit activation record per function: incoming parameters, locals, spill slots, laid out at fixed offsets from a frame base; generate matching prologue (allocate frame, save what's needed) and epilogue (restore, deallocate) instruction sequences in the low-level IR, before codegen.
10. **Code generation** — emit WebAssembly text (`.wat`): expressions as operand-stack sequences; `if`/`while` as properly nested `block`/`loop`/`br_if` (no unstructured jumps); array reads/writes as explicit `base + index*4` address computation (assume 4-byte `i32`/`f32` elements) against linear memory (`i32.load`/`i32.store` etc.); a retained `BoundsCheck` compiles to a comparison + `br_if` to a trap (`unreachable`) block. Spill slots and stack frames live in linear memory above a stack-pointer global (`$sp`, mutable `i32`, initialized to a fixed high offset, e.g. `65536`).
11. **Source map generation** — alongside the `.wat`, emit a JSON source map: an array of `{ instrOffsetOrIndex, line, column, kind }` entries, at minimum covering every retained `BoundsCheck`'s trap target, so a runtime trap can be translated back to a NovaCraft source location by the harness.
12. **Runtime harness** — a small Node module that: assembles the `.wat` via the `wabt` npm package, instantiates the resulting module, provides a `print` import (collects/prints i32 values), catches `WebAssembly.RuntimeError` on trap, looks up the trapping instruction in the source map, and prints `Runtime error: array index out of bounds at <file>:<line>:<col> (index=<i>, length=<n>)` using the actual failing index/length values (pass them to the trap via a side-channel — e.g., write them to two known linear-memory locations just before trapping, and have the harness read them out of the instance's memory after catching the trap).

## 5. Range analysis / bounds-check elimination — required algorithm and required outcomes

Implement forward interval analysis over the IR within each function:

- Track each variable's value range as `[lo, hi]` (use `-Infinity`/`+Infinity` for unknown bounds).
- On a constant assignment (`i = 0`), set the exact range.
- On `i = i + 1` inside a loop, and on entry to a `while (cond) { ... }` loop, run a small fixed-point iteration over the loop body (re-analyze until ranges stop changing, or apply widening to `+Infinity` after 2 iterations if a bound doesn't stabilize — standard widening to guarantee termination).
- Use the loop condition to refine ranges inside the loop body: for `while (i < len)`, inside the body `i`'s upper bound is refined to be at most `len - 1` (if `len`'s own range is known/stable) in addition to whatever the fixed-point iteration computed.
- At each `BoundsCheck(index, length)` instruction, if the analysis can prove `index.lo >= 0 AND index.hi < length.lo` (i.e. even the worst case of `length` is still above the best-known worst case of `index`), delete the `BoundsCheck` instruction. Otherwise leave it in place. Never remove a check unless this is fully proven — when in doubt, keep it.
- Record, per function and in total, how many `BoundsCheck` instructions were inserted vs. how many survived after this pass. Print this summary (e.g. `Bounds checks: 1 inserted, 0 retained (100% eliminated)` for `sumArray` above) whenever the compiler runs with `--emit-ir` or `--stats`.

**Required, testable outcomes** (see §9 for the actual test cases):
- The `BoundsCheck` on `arr[i]` inside `sumArray` above **must** be eliminated.
- A `BoundsCheck` on an access like `arr[k]` where `k` is a function parameter with no loop-derived relation to `len` **must not** be eliminated (there is nothing to prove it safe).
- A deliberately out-of-bounds access on an un-eliminated check must trap at runtime and produce the source-located diagnostic described in §4 step 12.

## 6. Memory layout (fixed — implement exactly this)

- Linear memory, single memory instance, initial size 1 page (grow if a test needs more).
- Offset `0` .. `4095`: reserved for the test harness to write array test data (harness decides exact offsets per test; document this in `DEVLOG.md`/README).
- A mutable `i32` global `$sp` initialized to `65536` (start of the second page), used as a downward-growing stack pointer for spill slots and stack frames — decrement on function entry (prologue) by the frame's total size, restore on exit (epilogue).
- Two reserved `i32` globals or fixed memory slots for the trap side-channel described in §4 step 12 (failing index, failing length) — pick fixed offsets, e.g. `4096` and `4100`, and document them.

## 7. Project structure(if you need something add it)

```
/src
  lexer.ts
  tokens.ts
  parser.ts
  ast.ts
  semantic.ts
  ir.ts               (AST -> three-address IR, including BoundsCheck insertion)
  optimize/
    constantFold.ts
    deadCode.ts
    rangeAnalysis.ts   (bounds-check elimination)
  regalloc.ts          (linear-scan)
  stackFrame.ts
  codegen.ts           (IR -> WAT text)
  sourcemap.ts
  cli.ts
/runtime
  harness.ts           (assemble + instantiate + run + trap translation)
/examples
  sumArray.min          (the §3 example)
  fib.min                (recursive, no arrays — for register-pressure/call tests)
  bounds_violation.min   (deliberately indexes out of range with an unprovable index)
  unsafe_index.min       (indexes with a parameter that has no derivable bound — check must survive)
/tests
  (Jest unit tests per module, plus end-to-end tests using the /examples files)
DEVLOG.md               (running log of decisions made while building, per the lab manual's requirement)
README.md               (build/run/test instructions, CLI usage, and a short summary of the pipeline)
package.json
```

## 8. CLI contract

```
novac <file.min> [options]
  --emit-tokens     print the token stream
  --emit-ast        print the AST
  --emit-ir         print IR before and after each optimization pass, plus the bounds-check stats line
  --emit-alloc      print the register allocation table
  --emit-wat        print/save the generated .wat
  --run             assemble, instantiate, and execute (calls `main`), printing program output
  --reg-budget N    override the register budget (default 4)
  --stats           print bounds-check elimination stats even without --emit-ir
```

Exit code must be non-zero on any lexical/syntax/semantic error, with all discovered errors printed (not just the first, where recovery allows it).

## 9. Required acceptance tests (write these as real Jest tests — the build is not done until all of these pass)

1. **Lexer:** tokenizing `examples/sumArray.min` produces the correct token sequence including `PUNCT "["` and `PUNCT "]"` for the array type/index syntax; a deliberately malformed input (`let x: int = 5 @ 3;`) produces `Lexical error at 1:16 - unexpected character '@'`.
2. **Parser:** `examples/sumArray.min` and `examples/fib.min` parse to a well-formed AST with no errors; a program with a missing `;` produces a `Syntax error` at the correct location and the parser still finishes reporting the rest of the file (recovery).
3. **Semantic analysis:** a program assigning a `bool` to an `int` variable is rejected with a `Semantic error`; a program using an undeclared identifier is rejected; `examples/sumArray.min` and `examples/fib.min` both pass with no errors.
4. **IR + bounds-check insertion:** compiling `examples/sumArray.min` to IR shows exactly one `BoundsCheck` instruction inserted (for `arr[i]`).
5. **Range analysis (the key test):** after optimization, `examples/sumArray.min` has **0** retained `BoundsCheck` instructions (eliminated); `examples/unsafe_index.min` (indexing with an unrelated parameter) retains its `BoundsCheck`.
6. **Register allocation:** a function with more than 4 simultaneously-live values (construct one deliberately in a test fixture) produces at least one `spill[]` entry in the allocation table — i.e. the 4-register budget is actually exercised, not just satisfied trivially.
7. **Codegen + execution, happy path:** `examples/sumArray.min` compiles to valid `.wat` (assembles with `wabt` without error) and running it via the harness against a real test array (e.g. `[1,2,3,4,5]`, `len=5`) returns `15`.
8. **Codegen + execution, recursion:** `examples/fib.min` compiles and running `fib(10)` via the harness returns the correct value (`55`), exercising the stack-frame/call convention machinery.
9. **Runtime bounds violation, end to end:** `examples/bounds_violation.min` (or a harness-driven call with an out-of-range index against `unsafe_index.min`'s function) traps, and the harness prints a message in the exact form `Runtime error: array index out of bounds at <file>:<line>:<col> (index=<i>, length=<n>)` with the correct line/column matching the actual source location of the access, and the correct index/length values.
10. **End-to-end CLI smoke test:** `novac examples/sumArray.min --run` exits 0 and prints `15` somewhere in its output (adjust to whatever your `main`/print convention ends up being, but keep it consistent and documented in the README).

## 10. How to work

- Build in the stage order of §4 — don't start codegen before IR and optimization are solid, since later stages depend on earlier ones being correct.
- Write and run tests for each stage before moving to the next; don't leave testing until the end.
- Keep `DEVLOG.md` updated as you go with what you built and any decisions you made that weren't fully pinned down above.
- Do not stop to ask me clarifying questions — every ambiguity that matters has a resolution above; anything smaller, use standard practice and note it.
- At the end, the repository should build clean (`npm install && npm test` passes fully) and `README.md` should let someone run `novac examples/sumArray.min --run` and see it work with zero setup beyond `npm install`.
