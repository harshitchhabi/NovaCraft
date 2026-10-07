# Related work

Only the works listed in section 8 of `NOVACRAFT_IMPROVE_PROMPT.md` are cited.
Every citation is marked **[verify]**. The bibliographic details and the
one-line characterizations below are from memory. They have not been
checked against the papers and must be verified before any of this text is
used elsewhere. The "delta" paragraphs describe NovaCraft, which is checked
against this repository.

**What NovaCraft is, for comparison.** A toy compiler for a small language
targeting 32-bit WebAssembly. It has an intraprocedural interval and
symbolic-fact analysis that eliminates provably redundant bounds checks,
and a per-site risk score R that decides which *unproven* checks to omit.
R is graded: it takes at most 12 discrete values. Optional loop versioning
removes checks from a guarded fast copy of a loop. It is evaluated on 16
hand-written kernels, 13 hand-written bug programs and 305 generated
mutants.

- **Chuang, Narayanasamy, Calder, Jhala. *Bounds Checking with Taint-Based
  Analysis.* HiPEAC 2007. [verify]** Uses taint analysis to decide which
  bounds checks to keep, focusing protection on accesses that untrusted
  input can influence.
  *Delta:* NovaCraft's `chuang` policy is only an approximation of this
  idea: it keeps all unproven writes and drops all unproven reads, and does
  not reimplement the paper's analysis. NovaCraft's provenance (P) is a
  related taint notion, but it is combined with a proof-gap term and a
  write flag in a weighted score. In this repository's mutation
  evaluation, `chuang` was the only cheap policy with zero silent
  corruption (results/mutation/RESULTS.md).

- **Wagner et al. ASAP. IEEE S&P 2015. [verify]** Profile-guided removal
  of the most expensive sanitizer checks under a user-given overhead
  budget.
  *Delta:* NovaCraft's `budget:F` is similar in spirit (keep checks until a
  cost budget is used up), but it ranks by a static risk/cost ratio, uses a
  static loop-depth cost estimate rather than profiles, and works on a toy
  language.

- **SanRazor. USENIX Security 2021. [verify]** Removes redundant sanitizer
  checks by combining static and dynamic analysis.
  *Delta:* NovaCraft removes only checks that its static analysis proves,
  plus checks hoisted by loop versioning. It does not use dynamic profiles
  to find redundancy, and it separately omits unproven checks by risk,
  which is a deliberately unsound choice that SanRazor does not make (as
  understood here [verify]).

- **MSWasm (Michael et al., 2023). [verify]** Memory-safe WebAssembly:
  extends Wasm with segments and handles so that memory safety is enforced
  at the Wasm level.
  *Delta:* NovaCraft enforces bounds in the source language's compiler by
  emitting explicit checks into ordinary Wasm. It trusts the length
  argument a caller passes (docs/LIMITATIONS.md), which a handle-based
  design does not need to do.

- **Cage (Fink et al., CGO 2025). [verify]** Hardware-assisted memory
  safety for WebAssembly (using memory tagging / pointer authentication).
  *Delta:* complementary. It works at the runtime/hardware layer, whereas
  NovaCraft decides at compile time which source-level checks to emit.

- **Döllerer and Engelke. *Performant Bounds Checking for 64-Bit
  WebAssembly.* VMIL 2024. [verify]** Studies how a Wasm engine implements
  the checks that keep memory accesses inside a 64-bit linear memory.
  *Delta:* complementary. Those are engine-level checks on the Wasm memory
  itself; NovaCraft's checks are source-level array bounds inside that
  memory. NovaCraft's runtime numbers come from V8 with 32-bit memory only.

- **Spink et al. *Leaps and Bounds.* IISWC 2022. [verify]** Analyses the
  cost of WebAssembly's memory bounds checking in runtimes.
  *Delta:* also at the runtime layer. NovaCraft measures its own checks
  mainly as a count of checks executed, because its wall-clock
  measurements were too noisy (38.7% median run-to-run difference,
  results/RESULTS.md).

- **Lehmann, Kinder, Pradel. *Everything Old is New Again: Binary Security
  of WebAssembly.* USENIX Security 2020. [verify]** Shows that memory bugs
  in code compiled to Wasm stay exploitable inside linear memory (no
  stack canaries, unprotected linear memory).
  *Delta:* this is the threat NovaCraft's bug corpus models. A silent
  out-of-bounds write that changes a neighbouring array, detected with
  sentinel gaps, is the kind of in-linear-memory corruption that paper
  describes.

- **PICO: *A Presburger In-bounds Check Optimization.* ACM, DOI
  10.1145/3460434. [verify]** Uses Presburger arithmetic to prove more
  bounds checks redundant.
  *Delta:* PICO is a stronger proof technique than NovaCraft's.
  NovaCraft's interval and less-than-fact analysis cannot prove, for
  example, `arr[i*m + j]` in a doubly nested loop, and leaves 49 of 59
  benchmark sites unproven (results/RESULTS.md). A stronger prover would
  shrink the set of sites the risk score has to decide about.

- **Hasabnis et al. *Light-weight Bounds Checking.* CGO 2012. [verify]**
  Lowers the cost of bounds checking for C programs with an efficient
  check implementation.
  *Delta:* NovaCraft does not make individual checks cheaper. It decides
  which checks to emit, and it reduces how many execute through
  elimination and loop versioning.

- **Nagarakatte et al. SoftBound. PLDI 2009. [verify]** Compile-time
  instrumentation that keeps base/bound metadata for pointers, giving
  complete spatial memory safety for C.
  *Delta:* NovaCraft has no pointers. Arrays come with a length argument,
  so it gets bounds information from the calling convention instead of
  propagating metadata. With an honest length argument, `full`, `proof`
  and `strict` detect every out-of-bounds access in this repository's
  tests and evaluation. The other policies give up that completeness by
  design.
