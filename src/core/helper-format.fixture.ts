// Test support: writes a helper result byte by byte, straight from the table in
// docs/helper-protocol.md ("Binary result format"), independent of the decoder. The
// overrides produce malformed buffers on purpose.

export interface ResultSpec {
  names: string[];
  parent: number[];
  /** Bit flags: 1 folder, 2 unreadable, 4 link, 8 cloud. */
  kind: number[];
  size: number[];
  mtime: number[];
  /** Present: the allocated section is written and header flag bit 0 is set. */
  allocated?: number[];
  magic?: string;
  version?: number;
  count?: number;
  flags?: number;
  namesLength?: number;
  /** Raw bytes for the names section instead of the UTF-8 of `names` joined with \0. */
  rawNames?: Uint8Array;
  /** Extra zero bytes at the end. */
  trailing?: number;
  /** Bytes cut off the end. */
  truncate?: number;
}

const pad8 = (offset: number) => Math.ceil(offset / 8) * 8;

export function buildHelperResult(spec: ResultSpec): ArrayBuffer {
  const nameBytes = spec.rawNames ?? new TextEncoder().encode(spec.names.join('\0'));
  const count = spec.parent.length;
  const parentAt = pad8(24 + nameBytes.length);
  const kindAt = pad8(parentAt + 4 * count);
  const sizeAt = pad8(kindAt + count);
  const mtimeAt = pad8(sizeAt + 8 * count);
  const allocAt = pad8(mtimeAt + 8 * count);
  const end = spec.allocated ? allocAt + 8 * count : allocAt;

  const buffer = new ArrayBuffer(end + (spec.trailing ?? 0));
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode((spec.magic ?? 'DAH1').slice(0, 4)), 0);
  view.setUint32(4, spec.version ?? 1, true);
  view.setUint32(8, spec.count ?? count, true);
  view.setUint32(12, spec.flags ?? (spec.allocated ? 1 : 0), true);
  view.setUint32(16, spec.namesLength ?? nameBytes.length, true);
  view.setUint32(20, 0, true);
  bytes.set(nameBytes, 24);
  for (let i = 0; i < count; i++) {
    view.setInt32(parentAt + 4 * i, spec.parent[i], true);
    view.setUint8(kindAt + i, spec.kind[i]);
    view.setFloat64(sizeAt + 8 * i, spec.size[i], true);
    view.setFloat64(mtimeAt + 8 * i, spec.mtime[i], true);
    if (spec.allocated) view.setFloat64(allocAt + 8 * i, spec.allocated[i], true);
  }
  return spec.truncate ? buffer.slice(0, buffer.byteLength - spec.truncate) : buffer;
}

/** The section offsets the format prescribes, for checking padding in tests. */
export function sectionOffsets(namesLength: number, count: number) {
  const parent = pad8(24 + namesLength);
  const kind = pad8(parent + 4 * count);
  const size = pad8(kind + count);
  const mtime = pad8(size + 8 * count);
  return { parent, kind, size, mtime, allocated: pad8(mtime + 8 * count) };
}
