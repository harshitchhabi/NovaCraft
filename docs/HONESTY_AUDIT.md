# Honesty audit (milestone A5)

Checked `docs/FORMAL.md`, `docs/RELATED_WORK.md`, `docs/LIMITATIONS.md`,
`README.md` and `results/RESULTS.md` against the code and the raw CSVs. Only
docs were changed. Two sentences of `results/RESULTS.md` are generated, so
their wording was fixed in the prose strings of `eval/report.ts`, and
RESULTS.md was regenerated from the unchanged raw CSVs. A diff confirmed
that only those sentences, and the two sentences added below, changed; no
number changed. No code path, policy, weight, corpus or raw result was
touched, and nothing was rerun to obtain numbers.

## Headline numbers and their sources

| number | value | source |
|---|---|---|
| mutants generated / kept / not triggerable / duplicate / not compilable | 451 / 305 / 77 / 69 / 0 | results/mutation/RESULTS.md (Corpus), results/mutation/corpus.json |
| detection, `full` / `proof` / `strict` | 100.0% each | results/mutation/RESULTS.md, raw/outcomes.csv |
| detection, `balanced` | 74.8% [66.4%, 82.2%] | same |
| detection, `chuang` | 31.5% [22.4%, 40.5%] | same |
| detection, `performance` | 22.6% [15.5%, 30.5%] | same |
| detection, `budget:0.5` | 60.0% [47.5%, 72.1%] | same |
| silent corruption, `balanced` | 4.3% [1.5%, 8.2%] (13 of 305) | same; raw/silent.csv |
| silent corruption, `performance` | 8.9% [4.1%, 14.2%] | same |
| silent corruption, `budget:0.5` / `budget:0.25` | 5.2% / 18.4% | same |
| silent corruption, `chuang` / `proof` / `strict` / `full` | 0.0% | same |
| silent corruption, `none` | 28.9% [20.8%, 37.2%] | same |
| cost (checks + guards, % of full), proof / strict / balanced / chuang / performance / budget:0.5 | 79.8 / 44.7 / 24.2 / 22.8 / 6.9 / 12.9 | results/mutation/RESULTS.md; raw/cost.csv |
| H1: cost(proof) - cost(strict) | 35.1 pp [14.7, 56.7], outcomes identical | results/mutation/RESULTS.md (H1) |
| H2 threshold: detection at chuang's cost vs chuang | 70.6% vs 31.5%, +39.1 pp [9.2, 62.5] | results/mutation/RESULTS.md (H2) |
| H2 budget | 79.1% vs 31.5%, +47.6 pp [29.3, 63.4] | same |
| H2 resamples excluded (chuang outside range) | 33 of 2000 per family | same |
| AUC threshold / budget | 0.830 [0.732, 0.911] / 0.872 [0.805, 0.932] | same |
| silent-corruption cases attributed to a read | 38 of 204 (main configs, 90 of the 204 under `none`) | results/mutation/RESULTS.md; raw/silent.csv |
| `balanced` corruption cases: attributed write R=0.425 / read | 9 / 4 (all 13 have an omitted R=0.425 write) | raw/silent.csv |
| `performance` corruption cases: write R=0.425 / write R=0.6 / read | 9 / 9 / 11 (29 cases, 27 variants) | raw/silent.csv |
| benchmark sites / proven / hoisted under strict | 59 / 10 / 16 | results/RESULTS.md (Static decisions); raw/static.csv |
| A3 cost, strict checks+guards / checks only | 44.8% / 44.2% | results/RESULTS.md (Cost); raw/dynamic.csv |
| bug corpus detected, full / proof / strict / balanced / chuang / performance | 13 / 13 / 13 / 9 / 8 / 5 of 13 | results/RESULTS.md (Security); raw/security.csv |
| bug corpus silent corruption, balanced / chuang / performance | 1 / 0 / 3 | same |
| runtime run-to-run noise (median / max over kernels) | 38.7% / 56.1% | results/RESULTS.md (Runtime); raw/timing.csv |
| runtime differences vs proof beyond noise | 5 of 112, both directions | same |
| benchmark speedups quoted in README (single runs) | 1.05x, 1.33x (earlier run 1.04x/1.34x) | docs/AUDIT.md |
| tests | 276 (after A4); see final report | `npm test` |

## Claims removed or softened

README.md:
1. "so the language is memory-safe without paying for a check on every
   single access". **Softened.** It holds only under `proof`, `full` and
   `strict`, and only with honest length arguments: checks trust the length
   argument (tests/analysisSoundness.test.ts demonstrates the failure).
   Other policies omit checks by design.
2. "grown automatically by the wabt/WebAssembly runtime if a program needs
   more". **Removed (false).** Generated code never grows memory; only the
   evaluation host does.
3. "`strict` is tested to be observably identical to `full`".
   **Qualified:** on fuzzed inputs with honest length arguments.
4. Register-allocation example for `sumArray`. **Corrected.** The current
   compiler also spills `%t1`-`%t3`; the README showed an older table.
5. Range-analysis description ("a BoundsCheck is eliminated only when both
   facts are established"). **Updated** to the current analysis (i32
   wraparound handling, branch facts, linear definitions, policy-dependent
   handling of unproven checks).
6. Benchmark section: "removing the single read check in sumArray saves
   little, while removing the read + write checks in scaleArray saves
   more". **Removed.** These are single runs, and the evaluation's
   run-to-run noise is 38.7%, so they support no runtime claim. (A later
   run printed 1.63x for scaleArray, but its output was not recorded in a
   file, so it is not cited.)
7. "Linear scan (Poletto & Sarkar)". This citation predates the
   improvement milestones and is not in the section-8 list. **Marked
   [verify]** and labelled as such.
8. Tests section listed only the original test files. **Extended**; it is
   not a false claim, but it was incomplete.

results/RESULTS.md (prose in eval/report.ts):

9. "'versionable' counts unproven sites whose loop matches the versioning
   pattern". **Fixed.** There is no "versionable" column; under `strict`
   the hoisted column equals the versionable count, and the text now says
   that.
10. "missed_benign ... or a write that stayed inside the gap pattern".
    **Fixed** (not meaningful). It now reads: a write that did not change
    any sentinel word, e.g. one that skipped past a gap.
11. "5 of 112 configuration-vs-proof runtime differences exceed the
    kernel's run-to-run noise: ...". **Softened.** With 112 comparisons and
    a noise estimate from only two passes, a few exceedances are expected by
    chance, and they go in both directions; they are listed, not claimed.
12. "Chuang et al. 2007". **Marked [verify].**

docs/FORMAL.md, docs/LIMITATIONS.md, docs/RELATED_WORK.md (written in A4,
checked in A5):

13. The A4 task's soundness property "no out-of-bounds access at a check
    that proof or strict marked ... hoisted" **is false for hoisted
    sites** and is not claimed. A hoisted check fires under `full` whenever
    the guard is false. FORMAL.md 5.1 states the property that is tested
    instead.
14. "balanced and performance silently corrupt memory mainly through
    internal writes with partial proof (R=0.425)". **Holds for `balanced`**
    (all 13 cases involve an omitted R=0.425 write). **Does not hold as
    "mainly" for `performance`**, where R=0.425 writes, R=0.6 writes and
    reads contribute 9, 9 and 11 cases. LIMITATIONS.md states the split.
15. "38 of 204 silent-corruption cases follow an omitted write's preceding
    read". Checked: the 38 cases are those attributed to a read, and every
    one has at least one omitted write. LIMITATIONS.md adds that the 204
    include 90 under `none`.
16. H2's matched-cost detection numbers are **interpolations**: no
    threshold configuration has cost near 22.8%. This is stated wherever
    H2 is reported (README.md, LIMITATIONS.md).
17. RELATED_WORK.md characterizations of the cited papers are from memory.
    Every one is marked [verify]; only statements about NovaCraft are
    checked against the repository.

Checked and left unchanged (supported by the CSVs or tests): every number
in the README results table and H1/H2 paragraphs; the R value table and the
"at most 12 discrete values" statement; the decision rules (src/harden);
the guard conditions (src/harden/version.ts); the 16/59 hoisted and 10/59
proven counts; the bug-corpus outcomes; all LIMITATIONS numbers.

## Clean-checkout check

Fresh clone of `harden/risk-adaptive` at a259dfe, then `npm ci && npm test
&& npm run eval`:

- `npm ci` succeeded, and `npm test` passed 22 suites with 276 tests.
- `npm run eval` completed in about 6.3 minutes.
- The deterministic raw files (`static.csv`, `dynamic.csv`, `sweep.csv`,
  `security.csv`, `ablation.csv`, `sites.csv`) are byte-identical to the
  committed ones.
- Timing differs, as expected: that run's median run-to-run noise was
  22.3% (max 63.7%), against 38.7% (max 56.1%) in the committed run. This
  confirms that runtime numbers on this machine do not support claims. The
  clean-checkout outputs were not committed; the committed results are
  unchanged.
