// Fixed memory layout (see §6 of NOVACRAFT_BUILD_PROMPT.md and README.md).
export const SP_INITIAL = 65536; // start of the second 64KiB page
export const TRAP_INDEX_OFFSET = 4096; // failing array index, written before a trap
export const TRAP_LENGTH_OFFSET = 4100; // failing array length, written before a trap
export const TRAP_CHECK_ID_OFFSET = 4104; // id of the BoundsCheck that fired, correlates to the source map
// The stack occupies [STACK_LIMIT, SP_INITIAL). A prologue that would move
// $sp below STACK_LIMIT traps instead, so the stack can never overwrite the
// trap side channel or the harness's array region below it.
export const STACK_LIMIT = 8192;
// Written to TRAP_CHECK_ID_OFFSET when the stack limit is hit (BoundsCheck
// ids are always >= 0).
export const STACK_OVERFLOW_CHECK_ID = -1;
// Written to TRAP_CHECK_ID_OFFSET when a fuel-limited build (CodegenOptions
// .fuel) runs out of loop iterations.
export const FUEL_EXHAUSTED_CHECK_ID = -2;
export const SPILL_SLOT_SIZE = 4; // bytes per spill slot (both i32 and f32 are 4 bytes)

// An explicit per-function activation record: incoming params live in their
// allocated register/spill location (moved there in the prologue); locals
// and temporaries likewise live in a register or a spill slot; spill slots
// are laid out at fixed offsets from `frameBase`, a per-call local capturing
// the value of the global `$sp` stack pointer after this call's prologue
// decrements it. The epilogue restores `$sp` to `frameBase + frameSize`
// (its value before this call) immediately before every `return`.
export interface StackFrame {
  functionName: string;
  frameSize: number; // spillSlotCount * SPILL_SLOT_SIZE
  spillSlotCount: number;
}

export function computeFrame(functionName: string, spillSlotCount: number): StackFrame {
  return { functionName, frameSize: spillSlotCount * SPILL_SLOT_SIZE, spillSlotCount };
}

export function spillOffset(slot: number): number {
  return slot * SPILL_SLOT_SIZE;
}
