import { FLAG_CLOUD, FLAG_LINK, FLAG_UNREADABLE, TreeBuilder } from './tree';

// The DiskAtlas Helper's binary scan result (docs/helper-protocol.md, "Binary result
// format"): a 24-byte header, then the names, parent, kind, size, mtime and (optionally)
// allocated sections, each starting at a multiple of 8. Little-endian.

/** "DAH1" read as a little-endian u32. */
const MAGIC = 0x31484144;
export const HELPER_FORMAT_VERSION = 1;
const HEADER_BYTES = 24;
/** Header flag: the allocated section is present. */
const HAS_ALLOCATED = 1;

/** `kind` bits of an entry. */
export const KIND_FOLDER = 1;
export const KIND_UNREADABLE = 2;
export const KIND_LINK = 4;
export const KIND_CLOUD = 8;
const KNOWN_KINDS = KIND_FOLDER | KIND_UNREADABLE | KIND_LINK | KIND_CLOUD;

/** A result buffer that does not follow the format. Nothing of it is used. */
export class HelperFormatError extends Error {
  constructor(message: string) {
    super(`Malformed helper result: ${message}`);
    this.name = 'HelperFormatError';
  }
}

const pad8 = (offset: number) => Math.ceil(offset / 8) * 8;
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Where each section lives, after checking that the buffer is exactly as long as the header says. */
function layout(buffer: ArrayBuffer) {
  const fail = (message: string): never => {
    throw new HelperFormatError(message);
  };
  if (buffer.byteLength < HEADER_BYTES) fail(`${buffer.byteLength} bytes is shorter than the ${HEADER_BYTES}-byte header`);
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) fail('it does not start with "DAH1"');
  const version = view.getUint32(4, true);
  if (version !== HELPER_FORMAT_VERSION) fail(`format version ${version} is not supported (expected ${HELPER_FORMAT_VERSION})`);
  const count = view.getUint32(8, true);
  if (count < 1) fail('it has no entries (the root is missing)');
  const flags = view.getUint32(12, true);
  if ((flags & ~HAS_ALLOCATED) !== 0) fail(`unknown header flags 0x${flags.toString(16)}`);
  const allocated = (flags & HAS_ALLOCATED) !== 0;
  const namesLength = view.getUint32(16, true);

  const names = HEADER_BYTES;
  const parent = pad8(names + namesLength);
  const kind = pad8(parent + 4 * count);
  const size = pad8(kind + count);
  const mtime = pad8(size + 8 * count);
  const alloc = pad8(mtime + 8 * count);
  const end = allocated ? alloc + 8 * count : alloc;
  if (names + namesLength > buffer.byteLength) fail(`the names (${namesLength} bytes) run past the end of the buffer`);
  if (buffer.byteLength !== end) fail(`expected ${end} bytes for ${count} entries, got ${buffer.byteLength}`);
  return { count, allocated, names, namesLength, parent, kind, size, mtime, alloc };
}

function float64s(buffer: ArrayBuffer, offset: number, count: number): Float64Array {
  if (littleEndian) return new Float64Array(buffer, offset, count);
  const view = new DataView(buffer, offset, count * 8);
  return Float64Array.from({ length: count }, (_, k) => view.getFloat64(k * 8, true));
}

function int32s(buffer: ArrayBuffer, offset: number, count: number): Int32Array {
  if (littleEndian) return new Int32Array(buffer, offset, count);
  const view = new DataView(buffer, offset, count * 4);
  return Int32Array.from({ length: count }, (_, k) => view.getInt32(k * 4, true));
}

/**
 * Checks a result buffer completely and reads it into a TreeBuilder (entry i of the result
 * becomes entry i of the builder). Throws HelperFormatError for anything malformed: wrong
 * magic or version, a length that does not match the header, bad UTF-8, a parent that is
 * missing, comes later or is a file, unknown kind bits, or a size that is negative or not
 * a number. Folder sizes in the result are ignored; `finish()` adds them up.
 */
export function decodeHelperResult(buffer: ArrayBuffer): TreeBuilder {
  const at = layout(buffer);
  const { count } = at;
  const fail = (message: string): never => {
    throw new HelperFormatError(message);
  };

  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(buffer, at.names, at.namesLength));
  } catch {
    fail('the names are not valid UTF-8');
  }
  const names = text.split('\0');
  if (names.length !== count) fail(`expected ${count} names, found ${names.length}`);

  const parent = int32s(buffer, at.parent, count);
  const kind = new Uint8Array(buffer, at.kind, count);
  const size = float64s(buffer, at.size, count);
  const mtime = float64s(buffer, at.mtime, count);
  const allocated = at.allocated ? float64s(buffer, at.alloc, count) : null;

  if (parent[0] !== -1) fail(`the root's parent is ${parent[0]}, not -1`);
  if ((kind[0] & KIND_FOLDER) === 0) fail('the root is not a folder');

  const builder = new TreeBuilder({ allocated: allocated !== null });
  for (let i = 0; i < count; i++) {
    const k = kind[i];
    if ((k & ~KNOWN_KINDS) !== 0) fail(`entry ${i} has unknown kind bits 0x${k.toString(16)}`);
    const p = parent[i];
    if (i > 0) {
      if (p < 0 || p >= i) fail(`entry ${i} has parent ${p}; a parent must come before its children`);
      if ((kind[p] & KIND_FOLDER) === 0) fail(`entry ${i} has parent ${p}, which is a file`);
    }
    if (!(Number.isFinite(size[i]) && size[i] >= 0)) fail(`entry ${i} has size ${size[i]}`);
    if (!Number.isFinite(mtime[i])) fail(`entry ${i} has modification time ${mtime[i]}`);
    if (allocated && !(Number.isFinite(allocated[i]) && allocated[i] >= 0)) fail(`entry ${i} has size on disk ${allocated[i]}`);

    const index =
      (k & KIND_FOLDER) !== 0
        ? builder.addDir(p, names[i])
        : builder.addFile(p, names[i], size[i], mtime[i], allocated ? allocated[i] : 0);
    const flags = ((k & KIND_UNREADABLE) !== 0 ? FLAG_UNREADABLE : 0) | ((k & KIND_LINK) !== 0 ? FLAG_LINK : 0) | ((k & KIND_CLOUD) !== 0 ? FLAG_CLOUD : 0);
    if (flags !== 0) builder.flag(index, flags);
  }
  return builder;
}
