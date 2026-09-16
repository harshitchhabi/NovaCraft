// Code generation: structured IR -> WebAssembly text (.wat).
//
// Every virtual register access is routed through the register-allocation
// table (regalloc.ts) -- either a `local.get`/`local.set` on one of the
// fixed r0..r{budget-1} locals (banked by type: an `_i` i32 bank for
// int/bool, an `_f` f32 bank for float), or a load/store against this
// call's spill region in linear memory. This makes the allocator's decisions
// actually observable in the emitted code, not just a printed table.
import { IRFunction, IRInstr, IRProgram, IRPrimType, IRValue } from './ir';
import { allocateRegisters, AllocationResult } from './regalloc';
import { computeFrame, spillOffset, SP_INITIAL, TRAP_INDEX_OFFSET, TRAP_LENGTH_OFFSET, TRAP_CHECK_ID_OFFSET } from './stackFrame';
import { SourceMap, SourceMapEntry } from './sourcemap';

function bank(type: IRPrimType): 'i' | 'f' {
  return type === 'float' ? 'f' : 'i';
}
function wasmType(type: IRPrimType): 'i32' | 'f32' {
  return type === 'float' ? 'f32' : 'i32';
}

function collectRegTypes(fn: IRFunction): Map<string, IRPrimType> {
  const types = new Map<string, IRPrimType>();
  for (const p of fn.params) types.set(p.name, p.type);

  function visit(instrs: IRInstr[]): void {
    for (const instr of instrs) {
      switch (instr.op) {
        case 'const':
        case 'binop':
        case 'unop':
        case 'move':
        case 'arrload':
          types.set(instr.dest, instr.type);
          break;
        case 'call':
          if (instr.dest && instr.type) types.set(instr.dest, instr.type);
          break;
        case 'if':
          visit(instr.thenBody);
          if (instr.elseBody) visit(instr.elseBody);
          break;
        case 'while':
          visit(instr.condInstrs);
          visit(instr.body);
          break;
      }
    }
  }
  visit(fn.body);
  return types;
}

export interface CodegenResult {
  wat: string;
  sourceMap: SourceMap;
  allocations: Map<string, AllocationResult>; // function name -> allocation table (for --emit-alloc)
}

class FuncCodegen {
  private lines: string[] = [];
  private sourceMapEntries: SourceMapEntry[] = [];
  private loopCounter = 0;

  constructor(
    private readonly fn: IRFunction,
    private readonly alloc: AllocationResult,
    private readonly regTypes: Map<string, IRPrimType>,
    private readonly regBudget: number,
  ) {}

  private emit(line: string): void {
    this.lines.push(line);
  }

  private typeOf(name: string): IRPrimType {
    const t = this.regTypes.get(name);
    if (!t) throw new Error(`internal error: no type recorded for register '${name}'`);
    return t;
  }

  private locationOf(name: string): { kind: 'reg'; idx: number; bank: 'i' | 'f' } | { kind: 'spill'; slot: number; bank: 'i' | 'f' } {
    const entry = this.alloc.entries.get(name);
    if (!entry) throw new Error(`internal error: no allocation for register '${name}'`);
    const b = bank(this.typeOf(name));
    if (entry.physicalReg !== null) {
      return { kind: 'reg', idx: parseInt(entry.physicalReg.slice(1), 10), bank: b };
    }
    return { kind: 'spill', slot: entry.spillSlot!, bank: b };
  }

  private pushSpillAddress(slot: number): void {
    this.emit('local.get $frameBase');
    if (spillOffset(slot) !== 0) {
      this.emit(`i32.const ${spillOffset(slot)}`);
      this.emit('i32.add');
    }
  }

  private loadReg(name: string): void {
    const loc = this.locationOf(name);
    if (loc.kind === 'reg') {
      this.emit(`local.get $r${loc.idx}_${loc.bank}`);
    } else {
      this.pushSpillAddress(loc.slot);
      this.emit(`${wasmType(this.typeOf(name))}.load`);
    }
  }

  // Pops the top-of-stack value into `name`'s allocated location.
  private storeReg(name: string): void {
    const loc = this.locationOf(name);
    if (loc.kind === 'reg') {
      this.emit(`local.set $r${loc.idx}_${loc.bank}`);
    } else {
      // Store to memory needs [address, value] with address pushed first;
      // the value is already on the stack, so stash it in a scratch local.
      this.emit(`local.set $scratch_${loc.bank}`);
      this.pushSpillAddress(loc.slot);
      this.emit(`local.get $scratch_${loc.bank}`);
      this.emit(`${wasmType(this.typeOf(name))}.store`);
    }
  }

  private loadValue(v: IRValue): void {
    if (v.kind === 'imm') {
      this.emit(`${wasmType(v.type)}.const ${v.value}`);
    } else {
      this.loadReg(v.name);
    }
  }

  generate(): { wat: string[]; sourceMap: SourceMapEntry[] } {
    const paramList = this.fn.params.map((p) => `(param $arg_${p.name} ${wasmType(p.type)})`).join(' ');
    const resultType = wasmType(this.fn.returnType);
    this.emit(`(func $${this.fn.name} ${paramList} (result ${resultType})`);

    for (let i = 0; i < this.regBudget; i++) {
      this.emit(`  (local $r${i}_i i32)`);
      this.emit(`  (local $r${i}_f f32)`);
    }
    this.emit('  (local $scratch_i i32)');
    this.emit('  (local $scratch_f f32)');
    this.emit('  (local $frameBase i32)');

    const frame = computeFrame(this.fn.name, this.alloc.spillSlotCount);

    // Prologue: allocate this call's frame, then move incoming params from
    // their WASM param locals into their allocated register/spill location.
    this.emit('  ;; prologue');
    this.emit('  global.get $sp');
    this.emit(`  i32.const ${frame.frameSize}`);
    this.emit('  i32.sub');
    this.emit('  local.set $frameBase');
    this.emit('  local.get $frameBase');
    this.emit('  global.set $sp');
    for (const p of this.fn.params) {
      this.emit(`  local.get $arg_${p.name}`);
      this.storeReg(p.name);
    }

    this.emitList(this.fn.body, 1);

    // Semantic analysis guarantees every path already returned, so this is
    // dead code -- but WASM's validator has no reachability analysis of its
    // own: a bare `if`/`else` (no declared result type) whose branches both
    // `return` still leaves the validator expecting a value to fall off the
    // end of the function when that `if` is the last statement. `unreachable`
    // is always well-typed against any expected result, closing that gap
    // without affecting any program that actually reaches it.
    this.emit('  unreachable');

    this.emit(')');
    return { wat: this.lines, sourceMap: this.sourceMapEntries };
  }

  private emitEpilogue(indent: string): void {
    const frame = computeFrame(this.fn.name, this.alloc.spillSlotCount);
    this.emit(`${indent}local.get $frameBase`);
    this.emit(`${indent}i32.const ${frame.frameSize}`);
    this.emit(`${indent}i32.add`);
    this.emit(`${indent}global.set $sp`);
  }

  private ind(depth: number): string {
    return '  '.repeat(depth);
  }

  private emitList(instrs: IRInstr[], depth: number): void {
    const pad = this.ind(depth);
    for (const instr of instrs) {
      this.emitInstr(instr, depth, pad);
    }
  }

  private emitInstr(instr: IRInstr, depth: number, pad: string): void {
    switch (instr.op) {
      case 'const':
        this.emit(`${pad}${wasmType(instr.type)}.const ${instr.value}`);
        this.storeRegPadded(instr.dest, pad);
        return;
      case 'move':
        this.loadValuePadded(instr.src, pad);
        this.storeRegPadded(instr.dest, pad);
        return;
      case 'binop':
        this.emitBinop(instr, pad);
        return;
      case 'unop':
        this.emitUnop(instr, pad);
        return;
      case 'boundscheck':
        this.emitBoundsCheck(instr, pad);
        return;
      case 'arrload':
        this.emitArrLoad(instr, pad);
        return;
      case 'arrstore':
        this.emitArrStore(instr, pad);
        return;
      case 'call':
        this.emitCall(instr, pad);
        return;
      case 'return':
        this.emitReturn(instr, pad);
        return;
      case 'print':
        this.emitPrint(instr, pad);
        return;
      case 'if':
        this.emitIf(instr, depth, pad);
        return;
      case 'while':
        this.emitWhile(instr, depth, pad);
        return;
    }
  }

  // ---- padded helpers (loadValue/storeReg emit unindented via this.emit; wrap with padding) ----
  private loadValuePadded(v: IRValue, pad: string): void {
    const start = this.lines.length;
    this.loadValue(v);
    this.padFrom(start, pad);
  }
  private storeRegPadded(name: string, pad: string): void {
    const start = this.lines.length;
    this.storeReg(name);
    this.padFrom(start, pad);
  }
  private padFrom(start: number, pad: string): void {
    for (let i = start; i < this.lines.length; i++) this.lines[i] = pad + this.lines[i];
  }

  private emitBinop(instr: Extract<IRInstr, { op: 'binop' }>, pad: string): void {
    const operandType = instr.left.type;
    this.loadValuePadded(instr.left, pad);
    this.loadValuePadded(instr.right, pad);
    this.emit(`${pad}${this.binopOpcode(instr.bop, operandType)}`);
    this.storeRegPadded(instr.dest, pad);
  }

  private binopOpcode(bop: string, operandType: IRPrimType): string {
    const t = wasmType(operandType);
    const isFloat = operandType === 'float';
    switch (bop) {
      case '+':
        return `${t}.add`;
      case '-':
        return `${t}.sub`;
      case '*':
        return `${t}.mul`;
      case '/':
        return isFloat ? 'f32.div' : 'i32.div_s';
      case '%':
        return 'i32.rem_s'; // semantic analysis restricts '%' to int operands
      case '==':
        return `${t}.eq`;
      case '!=':
        return `${t}.ne`;
      case '<':
        return isFloat ? 'f32.lt' : 'i32.lt_s';
      case '<=':
        return isFloat ? 'f32.le' : 'i32.le_s';
      case '>':
        return isFloat ? 'f32.gt' : 'i32.gt_s';
      case '>=':
        return isFloat ? 'f32.ge' : 'i32.ge_s';
      case '&&':
        return 'i32.and';
      case '||':
        return 'i32.or';
      default:
        throw new Error(`internal error: unknown binary operator '${bop}'`);
    }
  }

  private emitUnop(instr: Extract<IRInstr, { op: 'unop' }>, pad: string): void {
    if (instr.uop === '-') {
      if (instr.src.type === 'float') {
        this.loadValuePadded(instr.src, pad);
        this.emit(`${pad}f32.neg`);
      } else {
        this.emit(`${pad}i32.const 0`);
        this.loadValuePadded(instr.src, pad);
        this.emit(`${pad}i32.sub`);
      }
    } else {
      this.loadValuePadded(instr.src, pad);
      this.emit(`${pad}i32.eqz`);
    }
    this.storeRegPadded(instr.dest, pad);
  }

  private pushElementAddress(base: IRValue, index: IRValue, pad: string): void {
    this.loadValuePadded(base, pad);
    this.loadValuePadded(index, pad);
    this.emit(`${pad}i32.const 4`);
    this.emit(`${pad}i32.mul`);
    this.emit(`${pad}i32.add`);
  }

  private emitArrLoad(instr: Extract<IRInstr, { op: 'arrload' }>, pad: string): void {
    this.pushElementAddress(instr.base, instr.index, pad);
    this.emit(`${pad}${wasmType(instr.type)}.load`);
    this.storeRegPadded(instr.dest, pad);
  }

  private emitArrStore(instr: Extract<IRInstr, { op: 'arrstore' }>, pad: string): void {
    this.pushElementAddress(instr.base, instr.index, pad);
    this.loadValuePadded(instr.value, pad);
    this.emit(`${pad}${wasmType(instr.type)}.store`);
  }

  private emitBoundsCheck(instr: Extract<IRInstr, { op: 'boundscheck' }>, pad: string): void {
    if (instr.eliminated) {
      this.emit(`${pad};; BoundsCheck eliminated (range analysis proved it safe): ${instr.arrayName}[${instr.index.kind === 'reg' ? instr.index.name : instr.index.value}]`);
      return;
    }

    this.sourceMapEntries.push({
      instrOffsetOrIndex: instr.id,
      line: instr.pos.line,
      column: instr.pos.column,
      kind: 'BoundsCheck',
      functionName: this.fn.name,
      arrayName: instr.arrayName,
    });

    this.loadValuePadded(instr.index, pad);
    this.emit(`${pad}i32.const 0`);
    this.emit(`${pad}i32.lt_s`);
    this.loadValuePadded(instr.index, pad);
    this.loadValuePadded(instr.length, pad);
    this.emit(`${pad}i32.ge_s`);
    this.emit(`${pad}i32.or`);
    this.emit(`${pad}if`);
    this.emit(`${pad}  i32.const ${TRAP_INDEX_OFFSET}`);
    this.loadValuePadded(instr.index, pad + '  ');
    this.emit(`${pad}  i32.store`);
    this.emit(`${pad}  i32.const ${TRAP_LENGTH_OFFSET}`);
    this.loadValuePadded(instr.length, pad + '  ');
    this.emit(`${pad}  i32.store`);
    this.emit(`${pad}  i32.const ${TRAP_CHECK_ID_OFFSET}`);
    this.emit(`${pad}  i32.const ${instr.id}`);
    this.emit(`${pad}  i32.store`);
    this.emit(`${pad}  unreachable`);
    this.emit(`${pad}end`);
  }

  private emitCall(instr: Extract<IRInstr, { op: 'call' }>, pad: string): void {
    for (const a of instr.args) this.loadValuePadded(a, pad);
    this.emit(`${pad}call $${instr.func}`);
    if (instr.dest) this.storeRegPadded(instr.dest, pad);
  }

  private emitReturn(instr: Extract<IRInstr, { op: 'return' }>, pad: string): void {
    this.emitEpilogue(pad);
    if (instr.value) this.loadValuePadded(instr.value, pad);
    this.emit(`${pad}return`);
  }

  private emitPrint(instr: Extract<IRInstr, { op: 'print' }>, pad: string): void {
    this.loadValuePadded(instr.value, pad);
    if (instr.value.type === 'float') {
      this.emit(`${pad}i32.trunc_f32_s`);
    }
    this.emit(`${pad}call $print`);
  }

  private emitIf(instr: Extract<IRInstr, { op: 'if' }>, depth: number, pad: string): void {
    this.loadValuePadded(instr.cond, pad);
    this.emit(`${pad}if`);
    this.emitList(instr.thenBody, depth + 1);
    if (instr.elseBody) {
      this.emit(`${pad}else`);
      this.emitList(instr.elseBody, depth + 1);
    }
    this.emit(`${pad}end`);
  }

  private emitWhile(instr: Extract<IRInstr, { op: 'while' }>, depth: number, pad: string): void {
    const id = this.loopCounter++;
    const contLabel = `$loop${id}_continue`;
    const exitLabel = `$loop${id}_exit`;
    this.emit(`${pad}block ${exitLabel}`);
    this.emit(`${pad}  loop ${contLabel}`);
    this.emitList(instr.condInstrs, depth + 2);
    this.loadValuePadded(instr.cond, pad + '    ');
    this.emit(`${pad}    i32.eqz`);
    this.emit(`${pad}    br_if ${exitLabel}`);
    this.emitList(instr.body, depth + 2);
    this.emit(`${pad}    br ${contLabel}`);
    this.emit(`${pad}  end`);
    this.emit(`${pad}end`);
  }
}

export function generateModule(program: IRProgram, regBudget: number): CodegenResult {
  const lines: string[] = [];
  lines.push('(module');
  lines.push('  (import "env" "print" (func $print (param i32)))');
  lines.push('  (memory (export "memory") 1)');
  lines.push(`  (global $sp (mut i32) (i32.const ${SP_INITIAL}))`);

  const sourceMapEntries: SourceMapEntry[] = [];
  const allocations = new Map<string, AllocationResult>();

  for (const fn of program.functions) {
    const alloc = allocateRegisters(fn, regBudget);
    allocations.set(fn.name, alloc);
    const regTypes = collectRegTypes(fn);
    const gen = new FuncCodegen(fn, alloc, regTypes, regBudget);
    const result = gen.generate();
    for (const l of result.wat) lines.push('  ' + l);
    sourceMapEntries.push(...result.sourceMap);
  }

  for (const fn of program.functions) {
    lines.push(`  (export "${fn.name}" (func $${fn.name}))`);
  }
  lines.push(')');

  return { wat: lines.join('\n'), sourceMap: { entries: sourceMapEntries }, allocations };
}
