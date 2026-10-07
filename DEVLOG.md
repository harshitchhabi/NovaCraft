# DEVLOG

Running log of design decisions made while building NovaCraft, for anything
the build prompt left to "standard practice."

## Structured IR instead of flat label/goto three-address code

`if`/`while` are kept as *structured* IR nodes (`IfInstr` carries
`thenBody`/`elseBody` instruction lists; `WhileInstr` carries `condInstrs` +
`body`) rather than being flattened into labels and conditional jumps.
Reasons:
1. It maps losslessly onto WebAssembly's structured `block`/`loop`/`br_if`
   control flow, which is the codegen target — no CFG-to-structured-control
   recovery algorithm (e.g. Relooper) is needed.
2. The required range-analysis fixed-point iteration ("re-analyze the loop
   body until ranges stabilize") is naturally "iterate over this loop's body
   list."
3. Linear-scan register allocation still applies: a separate flattening pass
   (`regalloc.ts`) assigns every instruction a linear program-point index
   purely for computing live ranges, while the nested shape is preserved
   everywhere else (optimization, codegen).

Each virtual register still gets exactly one three-address-style definition
site per assignment (`dest = op(a, b)`), so this is a three-address code in
the conventional sense — only the control-flow skeleton around it is
structured instead of flattened.

## Array-length convention

The language has no dependent typing linking an array parameter to a length
parameter, and §3 of the spec is explicit that "the compiler does not track
length automatically" while still requiring a length operand at every
`BoundsCheck`. The resolution used here: within a function's own parameter
list, an `arr: T[]` parameter's length is **the parameter immediately
following it**, if that next parameter has type `int` (e.g.
`sumArray(arr: int[], len: int)`). This is established once per function
during IR generation (`ir.ts`, `arrayLength` map) and is exactly the
convention shown in the spec's own example. Since arrays only ever appear as
parameters (no locals, no literals), every array variable referenced inside
a function is one of that function's own parameters, so this per-function
convention is sufficient — no cross-function or whole-program analysis is
needed.

## Bounds-check elimination: numeric intervals + a "less-than fact" map

Plain numeric interval analysis (`[lo, hi]` with ±∞) is not enough on its
own to prove `sumArray`'s `arr[i]` access safe: `len` is an unconstrained
parameter, so its numeric range is `[-∞, +∞]` and no purely numeric interval
for `i` can ever be shown to be `< len`. Two facts are threaded forward
together through each function instead (`optimize/rangeAnalysis.ts`):

1. A standard numeric range per register, with the required fixed-point +
   widening treatment for `while` loops (re-analyze the body; after 2
   rounds without stabilizing, widen any still-growing bound to infinity).
   This proves facts like `i >= 0`.
2. A lightweight `condBound` map recording, on entry to a `while (x < y)`
   body, that `x < y` holds *symbolically* (by register identity, not by
   value) — invalidated the instant `x` or `y` is next redefined. This lets
   the analysis prove `i < len` from the loop header even though `len`
   itself carries no useful numeric upper bound.

A `BoundsCheck(index, length)` is eliminated only when **both**
`index.lo >= 0` and (`index.hi < length.lo` numerically **or** the
`condBound` map proves `index < length` symbolically) hold. When in doubt,
the check is kept — this bias toward keeping checks is deliberate per the
spec ("never remove a check unless fully proven").

## Loop-carried liveness for the linear-scan flattening pass

The flattening pass that numbers instructions for linear-scan register
allocation originally computed each virtual register's live range as
`[firstDefOrUse, lastDefOrUse]` in a single textual pass over the flattened
program. This under-counts liveness across a loop's back-edge: a variable
read near the *top* of a loop body (e.g. `len` in `i < len`) is needed again
on the *next* iteration, even though its last textual occurrence in a single
pass appears earlier than some other register's def/use later in that same
iteration. The fix (`regalloc.ts`, `flattenList`'s `while` case): after
flattening a loop's `condInstrs` + `body`, collect every register touched
anywhere inside it and add one synthetic "use" of all of them immediately
after the loop. This conservatively extends every loop-touched register's
live range to cover the loop's entire span, preventing two registers that
are actually both live across the back-edge from being assigned the same
physical register or spill slot.

## Physical registers as banked WASM locals; spills in linear memory

WebAssembly itself has no register file — it's a stack machine with
per-function locals of unlimited count. To make the 4-register budget and
spilling behavior *actually observable in the generated code* (not just a
printed table), codegen routes every virtual register access through the
allocation table: a "physical register" `rN` is realized as a pair of WASM
locals, `$rN_i` (i32, for int/bool) and `$rN_f` (f32, for float) — since a
given physical slot is only ever assigned to non-overlapping virtual
register lifetimes, reusing the same `N` across both type banks is safe. A
spilled register is instead loaded/stored against this call's spill region
in linear memory, addressed as `$frameBase + slot * 4`. Every function
declares the full fixed set of `r0_i..r{budget-1}_i`, `r0_f..r{budget-1}_f`
locals regardless of actual use, plus two scratch locals (`$scratch_i`,
`$scratch_f`) used only to reorder a freshly computed value before a memory
store (WASM's `store` instructions expect `[address, value]` on the stack,
address first, but a computed value is already sitting on top of the stack
by the time codegen decides it must go to a spill slot).

## Stack frame / calling convention

Each call decrements the global `$sp` by its own frame's spill-slot bytes in
the prologue, captures the resulting address in a local `$frameBase`, and
restores `$sp` to `frameBase + frameSize` immediately before every `return`
(WASM's native multi-exit `return` instruction is used directly — no
epilogue-via-branch gymnastics needed). Because `$sp` is a single global
shared by all activations and each call only ever touches the region between
its own `frameBase` and `frameBase + frameSize`, this is correct under
recursion: nested/recursive calls push further down from whatever value the
caller left `$sp` at, and each restores exactly what it decremented on its
own return, independent of how many calls happened in between.

## Runtime trap side-channel and source map correlation

The spec's side-channel mechanism (write the failing index/length to fixed
memory offsets before trapping) is extended with a third slot,
`TRAP_CHECK_ID_OFFSET` (4104), holding the id of the specific `BoundsCheck`
that fired. This is necessary because the JS `WebAssembly.RuntimeError`
caught by the harness carries no instruction offset, so there is no other
way to know *which* of a function's (possibly several) retained bounds
checks trapped. Each retained check gets a small globally-unique id at IR
generation time; the JSON source map is keyed by that id and the harness
looks it up after reading the side-channel to produce the final
`<file>:<line>:<column>` diagnostic.

## `%` restricted to `int` operands

The grammar's `additive`/`multiplicative` precedence levels don't
distinguish which arithmetic operators apply to which numeric type, but
WebAssembly has no `f32` remainder instruction. Semantic analysis requires
both operands of `%` to be `int` (a normal restriction in comparable
languages); `+ - * /` remain valid for both `int` and `float`.

## `print` truncates floats to i32

The spec's runtime harness contract is specifically "a `print` import
(collects/prints i32 values)". Printing a `float` truncates it to `i32` via
`i32.trunc_f32_s` before the call — not exercised by the required examples,
but keeps `print(someFloat)` well-defined rather than a codegen error.

## `main`'s signature for `--run`

NovaCraft has no array literals or local array allocation — arrays only
ever arrive as parameters (§3) — so a NovaCraft program has no way to
*construct* an array value from within the language itself. This means
`main` cannot call an array-taking function like `sumArray` unless `main`
itself takes array parameters. `examples/sumArray.min`'s `main` therefore
has the signature `main(arr: int[], len: int) -> int`, and the CLI's `--run`
driver (`src/cli.ts`, `buildRunArgs`) special-cases this: using `main`'s own
IR-level array-length convention (see above), it seeds a fixed default test
array (`[1, 2, 3, 4, 5]`) into linear memory for every array parameter of
`main` and passes the matching length/offset when invoking it. This is a
harness-side convention, not a language feature — it only affects how the
CLI's `--run` flag chooses arguments for `main`, exactly as permitted by the
spec ("adjust to whatever your main/print convention ends up being, but keep
it consistent and documented").

## An inner loop was discarding an outer loop's still-valid fact

Found while building `examples/anomalyDetect.min` / `tools/anomaly-cli.ts`
(moving-average anomaly detection — see README.md), the first real
application built on the compiler rather than a language-feature demo. Its
`movingAvgFlag` function has an outer `for (i = 0; i < len; ...)` loop whose
body contains an inner windowed `while (j <= i + window)` loop, followed
later in the same iteration by a direct `data[i]` access. `data[i]` should
have been provably safe: the outer loop's own condition establishes the
symbolic fact `i < len` (see the "condBound" design above), and nothing
between establishing that fact and the `data[i]` access redefines `i` or
`len`. It wasn't being eliminated.

Root cause (`rangeAnalysis.ts`, `analyzeWhile`): the `stateOut` returned by
*any* completed `while` loop unconditionally reset `condBound` to `new
Map()`. This is correct for that loop's *own* condition-derived fact (once
the loop exits, its condition is false, so `i < len` no longer holds for
*that* loop) — but it also erased every *other*, unrelated fact that was
already valid on entry, including ones about registers the loop's body
never touches at all. Here, the outer loop's `i < len` fact was destroyed
the moment the unrelated inner `while (j <= i + window)` loop finished,
purely because *some* while loop had completed — even though that inner
loop only ever reads/writes `j`, `sum`, and its own temporaries.

Fix: `stateOut.condBound` is now computed by keeping every fact that held on
entry to the loop (`stateIn.condBound`), minus only the facts whose left- or
right-hand register was actually defined somewhere inside that loop's own
`condInstrs`/`body` (`collectDefRegs` + `survivingCondBound`, mirroring the
same "invalidate the registers a subtree actually defines" pattern already
used by `constantFold.ts`'s `collectDefs` and `cse.ts`'s `collectDefRegs`).
A loop's own condition-derived fact still doesn't survive its own exit,
since the loop variable it's about is essentially always among the
registers the loop redefines. Regression tests:
`tests/rangeAnalysis.test.ts` (checks the elimination count directly) and
`tests/anomalyDetect.test.ts` (checks the compiled WASM's behavior against
an independent JS reference implementation).

## Common-subexpression elimination runs last, after range analysis

`src/optimize/cse.ts` was added as a fourth optimization pass but placed
*after* `rangeAnalysis`, not alongside `constantFold`/`deadCodeElimination`
earlier in the pipeline (see `compile.ts`). Reason: `rangeAnalysis.ts`'s
`extractCondFact` proves a `while` loop's own "less-than fact" by pattern-
matching a specific `binop` instruction (`i.op === 'binop' && (i.bop === '<'
|| i.bop === '<=')`) inside the loop's `condInstrs`. If CSE ran first and
happened to rewrite that comparison into a `move` (aliasing an identical
comparison computed earlier in the same instruction list), the pattern match
would silently fail and a provably-safe `BoundsCheck` would stop being
eliminated — a correct but much weaker compiler, and a regression that would
only show up as "elimination got worse" rather than a crash. Running CSE
after range analysis sidesteps the interaction entirely: nothing downstream
of CSE inspects instruction *shape* the way `extractCondFact` does. A plain
dead-code elimination pass runs one more time after CSE, since replacing a
`binop` with a `move` can leave the `binop`'s original operands (or, after
their own defining instructions, transitively more code) unused.

## `for` loops and `else if` are parser-level sugar, not new IR shapes

Both were added without touching `ir.ts`'s `IRInstr` union or any
downstream pass:

- `else if` parses as an ordinary `else` block containing a single nested
  `if` statement (`parser.ts`, `parseIfStmt`) — the existing recursive
  statement handling in every later stage already does the right thing with
  a nested `if`, so no other file changes.
- `for (init; cond; update) { body }` desugars during IR generation
  (`ir.ts`, the `'ForStmt'` case) into exactly the same `while` IR node a
  hand-written `while` loop produces: `init` runs once in the enclosing
  scope, then a `WhileInstr` is emitted whose `body` is the for-loop's body
  with `update` appended. This means range analysis, register allocation,
  and codegen handle `for` for free — they only ever see `while`. The
  alternative (a first-class `ForInstr`) was rejected because it would have
  needed its own copy of every one of those passes' loop-handling logic for
  no behavioral difference.

`else if` is a parser-only rewrite (semantic analysis and IR generation
never know it happened); `for` is genuinely desugared at IR generation, one
level later, because its `init` needs a scope of its own (`semantic.ts`'s
`checkForStmt` creates a `Scope` that outlives the body block, the same
relationship `while`'s condition variable would have if the language
allowed loop-scoped declarations there) — sugaring it any earlier, in the
parser, would have required either inventing a block-statement AST node
that doesn't otherwise exist or leaking the loop variable into the
enclosing block.

## Every function ends with a trailing `unreachable`

Discovered via `examples/classify.min` (an `if`/`else if`/`else` chain,
every branch returning, as a function's last statement): semantic analysis
already accepted this shape (`checkIfStmt` treats `thenReturns &&
elseReturns && elseBlock !== null` as a guaranteed return), but codegen
produced a WASM module that failed `wabt`'s validator with "type mismatch in
implicit return". The cause: `emitIf` (`codegen.ts`) emits a bare `if`
with no declared result type, since neither branch leaves a value on the
stack (each ends in an explicit `return` instead). WASM's validator has no
whole-program reachability analysis of its own — a block's type is exactly
its declared immediate, regardless of whether every path inside it
diverges — so when that untyped `if` is the last instruction in a function
declared `(result i32)`, the validator complains about the implicit return
at the end of the function body, even though the `if` can in fact never
fall through. The fix: `FuncCodegen.generate()` (`codegen.ts`) now emits a
trailing `unreachable` after the function body, unconditionally. It is
genuinely dead code whenever the function actually falls off the end of its
body (semantic analysis guarantees every path already returned before that
point), but `unreachable` type-checks against any expected result type, so
it closes the validator's gap for free. This was a latent bug that any
sufficiently deep terminal `if`/`else` chain could have hit even without the
`for`/`else if` work — `else if` just made it far more likely to occur in
ordinary code.

## Audit (milestone A0) decisions

Full findings in `docs/AUDIT.md`. One line per decision the improvement
spec left open:

- Range analysis intervals are clamped to i32: any `+`/`-`/negation whose
  exact interval leaves [INT_MIN, INT_MAX] becomes the full range ("could
  wrap"), rather than modelling wraparound precisely.
- The loop fixed point now runs until verified stable (cap 1000 rounds,
  fallback: every register the loop defines becomes unknown) instead of a
  fixed 4 rounds.
- Facts from before a loop are visible inside the loop only if the loop
  redefines neither register (they must hold on every back-edge, not just
  the first iteration).
- Branch refinement for `if`/`while` uses only the comparison that is the
  instruction immediately before the branch, so no operand can have been
  redefined in between.
- `arr[i+1]` under `while (i < len - 1)` is proven only when `len - 1`
  cannot wrap (e.g. under `if (len > 0)`); proving it for unconstrained
  `len` is unsound for `len == INT_MIN`.
- Constant folding matches the emitted instruction exactly (i32 wrap,
  f32 rounding) and leaves trapping operations unfolded.
- Dead-code elimination keeps an unused int `/` or `%` whose divisor could
  trap.
- Int literal 2147483648 is accepted and wraps to INT_MIN (so
  `-2147483648` is writable); larger literals are a semantic error.
- The differential fuzz harness runs each case in a worker thread with a
  400 ms budget; full-check runs that time out are counted and skipped,
  not compared.

## Stack limit instead of a layout change

The spill stack grows down from 65536 with no bound; deep recursion in a
function with spill slots ran it through the trap side channel (4096) and
the harness array region (0..4095) before hitting an out-of-bounds memory
trap (measured: 8171 of the 8192 bytes below 8192 overwritten by
`tests/fixtures/soundness/deepRecursion.min`). Chosen fix: a stack-limit
check in the prologue of every function with a non-empty frame
(`src/codegen.ts`): if `frameBase < STACK_LIMIT` (8192), write
`STACK_OVERFLOW_CHECK_ID` (-1) to the check-id slot and trap; the harness
reports it as `Runtime error: stack overflow`. Rejected alternative: moving
the stack above the arrays, which would change the layout the CLI,
benchmark and tests already rely on, and still leave the stack unbounded
against whatever lies below it. Frameless functions are not checked; their
recursion is bounded by the engine's own call-stack limit.

## Register-budget differential test

`tests/regBudget.test.ts` compiles every program with budgets 2, 3, 4, 8.
Two normalizations: memory is compared outside the stack region
[8192, 65536) (spill-slot contents legitimately differ), and stack
exhaustion (the stack-limit trap or a host RangeError) compares equal
regardless of where it happened. Fuzzed length arguments are kept <= the
real array length, since a larger one lets a program legitimately read and
write into its own spill slots, whose layout is what the test varies.
