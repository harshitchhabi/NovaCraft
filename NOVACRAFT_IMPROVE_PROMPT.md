# NovaCraft: audit the existing compiler, then add risk-adaptive bounds-check hardening and a publishable evaluation

This repository already has a working compiler (lexer, parser, semantic analysis, IR with BoundsCheck insertion, constant folding, dead-code elimination, range analysis, CSE, linear-scan register allocation, WebAssembly codegen, runtime harness, Jest tests, CI, a benchmark, and an anomaly-detection tool). `NOVACRAFT_BUILD_PROMPT.md` is the OLD spec that built it. Ignore it except as history. Do not rebuild or rewrite anything that works.

Do not stop to ask me questions. For anything not decided here, pick the standard choice and log one line in `DEVLOG.md`. Work on a new branch `harden/risk-adaptive`. Commit after each milestone and push the branch. Do not touch `master`.

Rules for everything you write:
- Never invent a number. Every figure in a report comes from a script reading raw result files. If the data does not support a claim, the report says so.
- Never invent a citation. Use only the list in section 8, each marked `[verify]`.
- Negative and mixed results go in the reports as they are.

## Research goal

Every array access already gets a BoundsCheck and the range analysis already removes provably redundant ones. The new contribution is a **per-site, risk-adaptive decision** about the checks that cannot be proven: eliminate, hoist, retain, or omit, driven by a risk score and a policy. The paper's claim, if the data supports it, is that this gives a better overhead-vs-coverage trade-off than proof-only elimination and than a binary rule like "check writes only".

## Milestone A0: audit and baseline (do this first)

1. `npm ci`, `npm test`, `npm run benchmark`. Record results in `docs/AUDIT.md`.
2. Read `DEVLOG.md`, `src/optimize/rangeAnalysis.ts`, `src/ir.ts`, `runtime/harness.ts`, `src/stackFrame.ts`, and the existing tests.
3. Review the range analysis for **soundness**, and write a failing test for every problem you find, then fix it. Cases that must be covered: (a) i32 wraparound: `len` or the index near `INT_MAX`/`INT_MIN`, arithmetic that can overflow must not yield a proof; (b) off-by-one `while (i <= len)` must NOT be proven; (c) `len` or the index reassigned inside the loop; (d) nested loops (the README mentions one fix already, check for others); (e) facts surviving across `if`/`else` joins; (f) the `for` desugaring; (g) interaction with CSE and constant folding.
4. Add a **differential fuzz test**: for every program in `examples/`, compile with and without range analysis (`--no-bounds-elim` path), run both with fuzzed arguments including `0, 1, -1, INT_MAX, INT_MIN`, and lengths shorter or longer than loop bounds. They must give identical output or the identical trap (same check id, index, length). Any difference is a soundness bug in the analysis. Fix it.
5. Required analysis outcomes (tests): `sumArray` proven; `arr[i+1]` inside `while (i < len - 1)` proven; `while (i <= len) { arr[i] }` not proven; `arr[k]` with unrelated parameter not proven; `arr[i*m + j]` in a doubly nested loop with a separate `len` not proven (do not extend the analysis to prove it, it is a realistic case for the risk model). If the existing analysis fails a "proven" outcome, extend it minimally and document why. Do not replace it with a different technique unless the audit shows it cannot be made sound.

## Milestone A1: provenance, risk score, policies

- **Provenance** (`src/harden/taint.ts`): a value is *external* if it is a parameter of an entry-point function (a function no other function calls; `main` always counts), or depends through IR data flow on one. Parameters of internally-called functions inherit external-ness from call-site arguments (context-insensitive, fixed point over the call graph). `P(site) = 1` if the index operand is external, else 0.
- **Proof gap** `C`: 0 if proven (such sites are eliminated, not scored); 0.5 if exactly one of lower or upper bound is proven; 1 if neither. If the existing analysis cannot report the two halves separately, add that.
- **Write flag** `W = 1` for a store, else 0.
- **Risk** `R = wP*P + wC*C + wW*W`, defaults `wP=0.40, wC=0.35, wW=0.25`, in one config file, overridable from the CLI.
- **Loop depth** `D` is used only in a cost estimate `cost = 10^min(D,3)`, never in risk.
- **Decision order**: proven then Eliminate; else if `R < tau` then **Omit** (no check emitted, the only unsound tier, exists only when `tau > 0`); else if loop-versionable then **Hoist** (A2); else **Retain**.
- **CLI** `--harden=`: `none` (no checks at all), `full` (every check, no analysis; same as existing `--no-bounds-elim`), `proof` (current behavior), `strict` (`tau=0` plus hoisting; must be observably identical to `full`: same outputs, same trap, same check id and values), `balanced` (`tau=0.5`), `performance` (`tau=0.8`), `threshold:T`, `budget:F` (keep checks by descending `R/cost` until retained cost is at most fraction F of the full-check cost, omit the rest), `chuang` (baseline approximating Chuang et al. 2007: eliminate proven, retain unproven writes, omit unproven reads; describe it honestly as an approximation).
- **Hardening report** per function: site id, line:col, read/write, P, C, W, R, D, decision. Print with `--emit-ir`/`--stats` and write as JSON.

## Milestone A2: hoisting by loop versioning

Do not move a check before the loop (it traps earlier than the original and changes behavior). Emit two copies of the loop: a guard computed before the loop selects a fast copy with qualifying checks removed, or the original slow copy. Qualifying pattern: `while (i < N)` or `while (i <= N)`; `i` has exactly one update `i = i + s` with constant `s > 0`, no other assignment in the body; `N` and `len` not assigned in the body; index is `i + c` with constant `c`. Guard in 64-bit arithmetic: `i_entry + c >= 0 && Nmax + c < len` where `Nmax = N-1` for `<`, `N` for `<=`. Guard false means slow loop. Anything else stays Retain. Tests: fast and slow loops give identical results when the guard is true; slow loop is taken when it is false; guard cannot be fooled by overflow.

## Milestone A3: evaluation corpus and harness

I cannot compile PolyBenchC with this compiler. Write **NovaCraft ports of PolyBench-style kernels** and say so plainly. Put 12 to 15 programs in `bench/` (reuse the existing examples where they fit), arrays flattened to 1D: dot product, axpy, matrix-vector (`i*n+j`), prefix sum, 1D stencil, smoothing, histogram (index from input data), bubble sort, insertion sort, binary search, gather (`out[i] = a[idx[i]]`), scatter, reverse, plus a few more. Mix programs where analysis proves everything with ones where it proves nothing.

`bench/bugs/`: 12 or more programs with one injected out-of-bounds bug each, plus `manifest.json` with ground truth (buggy check id, read/write, external or internal index, triggering input). Include off-by-one loop bounds, an unchecked external-index write, an internal counter error, a read overread, and a write that corrupts a neighboring array. For detecting silent corruption, have the harness place arrays with a 16-byte sentinel gap between them and compare afterwards. Reuse the harness's existing memory layout and extend it only as needed; document changes in `DEVLOG.md`.

`eval/run.ts`: every benchmark under every `--harden` configuration, raw CSVs into `results/raw/`:
- Static: sites total, eliminated, hoisted, omitted, retained, code size.
- Dynamic: checks executed (add a counter-instrumented build mode, deterministic) and runtime (5 warm-ups, 30 timed runs, median and IQR, fixed seeds, same inputs across configs, overhead relative to `none`).
- Coverage: `protected(site) = proven or hoisted or retained`; report overall coverage and `coverage_ext_write` (protected external-index writes over all external-index writes).
- Security: per bug program and config, `detected` (trap at the right check), `silent_corruption` (sentinel changed, no trap), or `missed_benign`, compared to the manifest.

`eval/report.ts` writes `results/RESULTS.md` (tables), a Pareto SVG (overhead vs `coverage_ext_write`, one point per config per benchmark, plus a tau sweep 0 to 1 in 0.05 steps, no heavy plotting dependencies), a weight ablation (each factor zeroed in turn), and `results/hardening/<bench>.json`. Add `npm run eval`.

## Milestone A4: tests and docs

Tests (Jest, add `fast-check` for properties):
1. Strict equivalence: `strict` and `full` give identical output or identical trap on every program in `bench/`, `bench/bugs/`, and `examples/`, with fuzzed extreme inputs.
2. Analysis soundness: under `full`, any out-of-bounds access at a check that `proof`/`strict` marked proven or hoisted is a failure.
3. Monotonicity: for `tau1 < tau2`, retained-or-hoisted sites at `tau2` are a subset of those at `tau1`, and omitted sites at `tau1` are a subset of those at `tau2`.
4. All the earlier existing tests still pass.

Docs: `docs/FORMAL.md` (abstract domain, risk function, decision rule, policies; state and give proof sketches of analysis soundness under i32 wraparound, strict-equals-full, and threshold monotonicity; claim nothing untested). `docs/RELATED_WORK.md` (section 8). `docs/LIMITATIONS.md` (honest: ports not real PolyBench, intraprocedural analysis, weights not learned, Omit unsound by design, `chuang` is an approximation, V8-only timing). Update `README.md` and `DEVLOG.md`.

## Milestone A5: honesty audit

Audit `docs/FORMAL.md`, `docs/RELATED_WORK.md`, `README.md` and `results/RESULTS.md` against the code and raw CSVs. List every claim the data or tests do not support and fix the docs. Do not change code or numbers in this step. Finish with `npm ci && npm test && npm run eval` from a clean checkout, then report.

## 8. Related work (use only these, each marked [verify])

Chuang, Narayanasamy, Calder, Jhala, *Bounds Checking with Taint-Based Analysis* (HiPEAC 2007). Wagner et al., ASAP (IEEE S&P 2015). SanRazor (USENIX Security 2021). MSWasm (Michael et al., 2023). Cage (Fink et al., CGO 2025). Döllerer and Engelke, *Performant Bounds Checking for 64-Bit WebAssembly* (VMIL 2024). Spink et al., *Leaps and Bounds* (IISWC 2022). Lehmann, Kinder, Pradel, *Everything Old is New Again* (USENIX Security 2020). PICO, *A Presburger In-bounds Check Optimization* (ACM, DOI 10.1145/3460434). Hasabnis et al., *Light-weight Bounds Checking* (CGO 2012). Nagarakatte et al., SoftBound (PLDI 2009). State the delta against each in your own words. Döllerer and Engelke and Cage work at the runtime/hardware layer and are complementary; PICO is a stronger proof technique than this project's.
