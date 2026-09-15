// Source map: correlates a runtime trap back to a NovaCraft source location.
//
// The WebAssembly JS API gives no instruction offset for a caught
// WebAssembly.RuntimeError, so instead of an offset-keyed map we assign each
// retained BoundsCheck a small integer id at codegen time, write that id (plus
// the failing index/length) into a fixed memory side-channel immediately
// before the `unreachable` that traps, and key the source map by that id.
export interface SourceMapEntry {
  instrOffsetOrIndex: number; // the BoundsCheck's id, written to the trap side-channel
  line: number;
  column: number;
  kind: 'BoundsCheck';
  functionName: string;
  arrayName: string;
}

export interface SourceMap {
  entries: SourceMapEntry[];
}

export function toJSON(map: SourceMap): string {
  return JSON.stringify(map, null, 2);
}

export function findEntry(map: SourceMap, id: number): SourceMapEntry | undefined {
  return map.entries.find((e) => e.instrOffsetOrIndex === id);
}
