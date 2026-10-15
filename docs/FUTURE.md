# Future work: policy ideas (not implemented, not evaluated)

Recorded instead of being tried, so that no policy is tuned on the
mutation-corpus results (docs/PREREGISTRATION.md). Each would need its own
preregistered evaluation on new data.

- **Write floor ("never omit writes") - proposed follow-up, not
  implemented.** In the mutation corpus (results/mutation/RESULTS.md),
  `chuang`, which never omits a write, had 0.0% silent corruption.
  `balanced` (4.3%), `performance` (8.9%) and the budget policies did not.
  Every `balanced` corruption involves an omitted internal write with a
  partial proof (R = 0.425 < tau = 0.5). The proposal is a policy that
  never omits writes and uses the risk score only to rank reads.

  Evaluating it on the current mutation corpus would be tuning on the data
  that suggested it, so it needs:
  1. a fresh, held-out mutant set, generated with a new seed (new fuzzed
     inputs, and if possible new kernels), before the policy is run on it;
  2. a new preregistration fixing a severity-weighted metric, so that
     silent corruption of memory counts more than a missed out-of-bounds
     read, together with the hypotheses and the comparison against
     `chuang` and `balanced`.

  Until then, no claim is made about it.
- **Read-then-write coupling.** Many silent corruptions are attributed to an
  omitted read whose index is later reused by an omitted write in the same
  iteration (bubble sort's `arr[j]` / `arr[j + 1]`). Keeping a read's check
  when a later write in the same loop body uses an index with the same base
  would stop execution before the write.
- **Hoisting before omitting.** Loop versioning makes many checks free; a
  policy could hoist every versionable site regardless of R and only then
  apply the threshold to what is left.
- **Cost-aware budget with guards.** `budget:F` charges kept sites their
  in-loop cost even when they are hoisted; charging hoisted sites their
  guard cost would let the budget keep more checks for the same cost.
