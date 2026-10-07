# Future work: policy ideas (not implemented, not evaluated)

Recorded instead of being tried, so that no policy is tuned on the
mutation-corpus results (docs/PREREGISTRATION.md). Each would need its own
preregistered evaluation on new data.

- **Write floor.** In the mutation corpus (results/mutation/RESULTS.md) every
  silent corruption under the risk-adaptive policies came from an omitted
  check, and `chuang`, which never omits a write, had no silent corruption,
  while `balanced` and `budget:0.5` did. A policy that never omits writes
  (chuang's floor) and uses the risk score only to rank reads would combine
  chuang's zero-corruption property with the threshold/budget policies'
  higher detection. The risk score currently lets internal writes with a
  partial proof (P=0, C=0.5, W=1, R=0.425) fall below tau = 0.5.
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
