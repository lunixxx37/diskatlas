import { CATEGORIES, OTHER_INDEX, categoryIndexOfExt, extOf, type CategoryId } from './categories';
import { PATH_SEP } from './format';

/** The folder could not be listed, or the file's size could not be read. */
export const FLAG_UNREADABLE = 1;
/** The folder was not descended into because it is nested too deeply. */
export const FLAG_TOO_DEEP = 2;
/** A symbolic link, junction or mount point: listed, but not followed (helper scans). */
export const FLAG_LINK = 4;
/** An online-only placeholder (e.g. OneDrive Files On-Demand): real size, nothing on disk (helper scans). */
export const FLAG_CLOUD = 8;
/** Moved to the Recycle Bin after the scan (set by `ScanTree.remove`, with everything inside). */
export const FLAG_REMOVED = 16;

/** 'helper': read by the DiskAtlas Helper for Windows (docs/helper-protocol.md). */
export type ScanSource = 'picker' | 'files' | 'demo' | 'helper';

/** The helper that made a scan. */
export interface HelperScanInfo {
  version: string;
  /** Ran with administrator rights, so it could read more folders. */
  elevated: boolean;
  /** What it offered besides scanning ("reveal", "recycle"); see docs/helper-protocol.md. */
  features?: string[];
}

export interface ScanMeta {
  rootName: string;
  source: ScanSource;
  /** Epoch ms. */
  startedAt: number;
  durationMs: number;
  /** false when the scan was cancelled and only part of the folder was read. */
  complete: boolean;
  /** Only for source 'helper'. */
  helper?: HelperScanInfo;
}

/**
 * A finished scan as flat arrays, indexed by entry. Entry 0 is the scanned folder and
 * every entry's index is larger than its parent's. Plain data, so it can be moved
 * from the scan worker to the page without copying the arrays.
 */
export interface ScanData {
  meta: ScanMeta;
  names: string[];
  /** -1 for the root. */
  parent: Int32Array;
  /** 1 = folder, 0 = file. */
  isDir: Uint8Array;
  flags: Uint8Array;
  /** Bytes; for folders the total of everything inside. */
  size: Float64Array;
  /** Last modified (epoch ms); for folders the newest file inside; 0 = unknown. */
  mtime: Float64Array;
  /** Size on disk in bytes; for folders the total of everything inside. Only helper scans have it. */
  allocated?: Float64Array;
  /** Files in the whole subtree (folders only). */
  fileCount: Uint32Array;
  /** Sub-folders in the whole subtree (folders only). */
  dirCount: Uint32Array;
  /** Children of entry i are childList[childStart[i] .. childStart[i + 1]), largest first. */
  childStart: Int32Array;
  childList: Int32Array;
}

export interface TreeBuilderOptions {
  /** Also record each file's size on disk (`addFile`'s last argument). */
  allocated?: boolean;
}

/** Collects entries during a scan; `finish()` turns them into `ScanData`. */
export class TreeBuilder {
  readonly names: string[] = [];
  readonly parent: number[] = [];
  readonly isDir: number[] = [];
  readonly flags: number[] = [];
  readonly size: number[] = [];
  readonly mtime: number[] = [];
  /** Size on disk per entry, or null when this scan does not record it. */
  readonly allocated: number[] | null;
  /** Running totals, for progress reports. */
  files = 0;
  dirs = 0;
  bytes = 0;
  errors = 0;
  lastDir = 0;

  constructor(options: TreeBuilderOptions = {}) {
    this.allocated = options.allocated ? [] : null;
  }

  get count(): number {
    return this.names.length;
  }

  /** The first folder added (with parent -1) is the root. */
  addDir(parent: number, name: string): number {
    if (parent >= 0) this.dirs++;
    this.lastDir = this.push(parent, name, 1, 0, 0);
    return this.lastDir;
  }

  /** `allocated`: size on disk, kept only when the builder records it. */
  addFile(parent: number, name: string, size: number, mtime: number, allocated = 0): number {
    this.files++;
    this.bytes += size;
    return this.push(parent, name, 0, size, mtime, allocated);
  }

  flag(index: number, flag: number): void {
    if ((flag & FLAG_UNREADABLE) !== 0 && (this.flags[index] & FLAG_UNREADABLE) === 0) this.errors++;
    this.flags[index] |= flag;
  }

  pathOf(index: number, sep = PATH_SEP): string {
    const parts: string[] = [];
    for (let i = index; i >= 0; i = this.parent[i]) parts.push(this.names[i]);
    return parts.reverse().join(sep);
  }

  finish(meta: ScanMeta): ScanData {
    const n = this.count;
    const parent = Int32Array.from(this.parent);
    const isDir = Uint8Array.from(this.isDir);
    const size = Float64Array.from(this.size);
    const mtime = Float64Array.from(this.mtime);
    const allocated = this.allocated ? Float64Array.from(this.allocated) : undefined;
    const fileCount = new Uint32Array(n);
    const dirCount = new Uint32Array(n);

    // Children always come after their parent, so walking backwards visits a folder
    // only after everything inside it has been added up.
    for (let i = n - 1; i > 0; i--) {
      const p = parent[i];
      size[p] += size[i];
      if (allocated) allocated[p] += allocated[i];
      if (mtime[i] > mtime[p]) mtime[p] = mtime[i];
      if (isDir[i]) {
        fileCount[p] += fileCount[i];
        dirCount[p] += dirCount[i] + 1;
      } else {
        fileCount[p] += 1;
      }
    }

    const childStart = new Int32Array(n + 1);
    for (let i = 1; i < n; i++) childStart[parent[i] + 1]++;
    for (let i = 0; i < n; i++) childStart[i + 1] += childStart[i];
    const childList = new Int32Array(Math.max(0, n - 1));
    const next = childStart.slice(0, n);
    for (let i = 1; i < n; i++) childList[next[parent[i]]++] = i;

    const names = this.names;
    const bySize = (a: number, b: number) =>
      size[b] - size[a] || isDir[b] - isDir[a] || (names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : 0);
    for (let i = 0; i < n; i++) {
      if (childStart[i + 1] - childStart[i] > 1) childList.subarray(childStart[i], childStart[i + 1]).sort(bySize);
    }

    const data: ScanData = {
      meta,
      names,
      parent,
      isDir,
      flags: Uint8Array.from(this.flags),
      size,
      mtime,
      fileCount,
      dirCount,
      childStart,
      childList,
    };
    if (allocated) data.allocated = allocated;
    return data;
  }

  private push(parent: number, name: string, isDir: number, size: number, mtime: number, allocated = 0): number {
    const index = this.names.length;
    this.names.push(name);
    this.parent.push(parent);
    this.isDir.push(isDir);
    this.flags.push(0);
    this.size.push(size);
    this.mtime.push(mtime);
    this.allocated?.push(isDir ? 0 : allocated);
    return index;
  }
}

/** The array buffers of a scan, for `postMessage(..., { transfer })`. */
export function transferablesOf(data: ScanData): ArrayBuffer[] {
  return [
    data.parent,
    data.isDir,
    data.flags,
    data.size,
    data.mtime,
    data.fileCount,
    data.dirCount,
    data.childStart,
    data.childList,
    ...(data.allocated ? [data.allocated] : []),
  ].map((array) => array.buffer as ArrayBuffer);
}

/** What `ScanTree.remove` took away: the entry and everything inside it. */
export interface Removal {
  entry: number;
  parent: number;
  size: number;
  allocated: number;
  files: number;
  /** Folders, the entry itself included when it is one. */
  dirs: number;
}

/**
 * Read access to a finished scan. Entries are addressed by index; the root is 0. The only
 * change after the scan is `remove()`, for an item moved to the Recycle Bin.
 */
export class ScanTree {
  readonly root = 0;
  private categories?: Uint8Array;
  /** End of each folder's children in childList (shrinks when a child is removed). */
  private readonly childEnd: Int32Array;
  /** Counts removals, so caches can tell when their results are stale. */
  version = 0;

  constructor(readonly data: ScanData) {
    this.childEnd = data.childStart.slice(1);
  }

  get meta(): ScanMeta {
    return this.data.meta;
  }

  get count(): number {
    return this.data.names.length;
  }

  name(i: number): string {
    return this.data.names[i];
  }

  /** -1 for the root. */
  parent(i: number): number {
    return this.data.parent[i];
  }

  isDir(i: number): boolean {
    return this.data.isDir[i] === 1;
  }

  /** Bytes; for folders the total of everything inside. */
  size(i: number): number {
    return this.data.size[i];
  }

  /** Last modified (epoch ms); for folders the newest file inside; 0 = unknown. */
  mtime(i: number): number {
    return this.data.mtime[i];
  }

  /** True when the scan knows sizes on disk (helper scans). */
  get hasAllocated(): boolean {
    return this.data.allocated !== undefined;
  }

  /** Size on disk in bytes; for folders the total of everything inside; 0 when unknown. */
  allocated(i: number): number {
    return this.data.allocated ? this.data.allocated[i] : 0;
  }

  /** Files in the whole subtree (0 for files). */
  fileCount(i: number): number {
    return this.data.fileCount[i];
  }

  /** Sub-folders in the whole subtree (0 for files). */
  dirCount(i: number): number {
    return this.data.dirCount[i];
  }

  unreadable(i: number): boolean {
    return (this.data.flags[i] & FLAG_UNREADABLE) !== 0;
  }

  tooDeep(i: number): boolean {
    return (this.data.flags[i] & FLAG_TOO_DEEP) !== 0;
  }

  /** A link, junction or mount point that was not followed. */
  link(i: number): boolean {
    return (this.data.flags[i] & FLAG_LINK) !== 0;
  }

  /** An online-only file or folder: nothing of it is on this PC. */
  cloud(i: number): boolean {
    return (this.data.flags[i] & FLAG_CLOUD) !== 0;
  }

  /** Moved to the Recycle Bin after the scan (or inside something that was). */
  removed(i: number): boolean {
    return (this.data.flags[i] & FLAG_REMOVED) !== 0;
  }

  /** Direct children, largest first. A view into the tree: do not modify it. */
  children(i: number): Int32Array {
    return this.data.childList.subarray(this.data.childStart[i], this.childEnd[i]);
  }

  childCount(i: number): number {
    return this.childEnd[i] - this.data.childStart[i];
  }

  /**
   * Takes an entry (and everything inside it) out of the tree after it went to the Recycle
   * Bin: it leaves its parent's children, and every ancestor loses its size, size on disk,
   * files and folders, gets its newest date again and keeps its place among its siblings
   * (largest first). Returns null for the root or an entry that is already gone.
   */
  remove(i: number): Removal | null {
    const d = this.data;
    if (i <= 0 || i >= this.count || this.removed(i)) return null;
    const parent = d.parent[i];
    const dir = d.isDir[i] === 1;
    const removal: Removal = {
      entry: i,
      parent,
      size: d.size[i],
      allocated: this.allocated(i),
      files: dir ? d.fileCount[i] : 1,
      dirs: dir ? d.dirCount[i] + 1 : 0,
    };
    d.flags[i] |= FLAG_REMOVED;
    this.forEachDescendant(i, (j) => {
      d.flags[j] |= FLAG_REMOVED;
    });

    const list = d.childList;
    const start = d.childStart[parent];
    const end = this.childEnd[parent];
    let k = start;
    while (k < end && list[k] !== i) k++;
    if (k < end) {
      list.copyWithin(k, k + 1, end);
      this.childEnd[parent] = end - 1;
    }

    for (let a = parent; a >= 0; a = d.parent[a]) {
      d.size[a] -= removal.size;
      if (d.allocated) d.allocated[a] -= removal.allocated;
      d.fileCount[a] -= removal.files;
      d.dirCount[a] -= removal.dirs;
      let newest = 0;
      for (const c of this.children(a)) if (d.mtime[c] > newest) newest = d.mtime[c];
      d.mtime[a] = newest;
      this.keepOrder(a);
    }
    this.categories = undefined;
    this.version++;
    return removal;
  }

  /** After `a` got smaller: move it back to its place among its siblings, largest first. */
  private keepOrder(a: number): void {
    const d = this.data;
    const parent = d.parent[a];
    if (parent < 0) return;
    const list = d.childList;
    const end = this.childEnd[parent];
    let k = d.childStart[parent];
    while (k < end && list[k] !== a) k++;
    const before = (x: number, y: number) =>
      d.size[x] > d.size[y] || (d.size[x] === d.size[y] && (d.isDir[x] > d.isDir[y] || (d.isDir[x] === d.isDir[y] && d.names[x] < d.names[y])));
    while (k + 1 < end && before(list[k + 1], a)) {
      list[k] = list[k + 1];
      list[k + 1] = a;
      k++;
    }
  }

  depth(i: number): number {
    let depth = 0;
    for (let p = this.data.parent[i]; p >= 0; p = this.data.parent[p]) depth++;
    return depth;
  }

  /** From the root down to i, both included. */
  ancestors(i: number): number[] {
    const chain: number[] = [];
    for (let p = i; p >= 0; p = this.data.parent[p]) chain.push(p);
    return chain.reverse();
  }

  /** Starts with the scanned folder's name (the full path for helper scans; the browser never reveals it). */
  path(i: number, sep = PATH_SEP): string {
    return this.ancestors(i)
      .map((j) => this.data.names[j])
      .join(sep);
  }

  /** True if `a` is `b` or one of its ancestors. */
  contains(a: number, b: number): boolean {
    for (let p = b; p >= 0; p = this.data.parent[p]) if (p === a) return true;
    return false;
  }

  /** Lower-case file extension; '' for folders and files without one. */
  ext(i: number): string {
    return this.isDir(i) ? '' : extOf(this.data.names[i]);
  }

  /** Index into CATEGORIES. Files by extension; folders by the category with the most bytes inside. */
  categoryIndex(i: number): number {
    this.categories ??= this.computeCategories();
    return this.categories[i];
  }

  category(i: number): CategoryId {
    return CATEGORIES[this.categoryIndex(i)].id;
  }

  /** Visits everything below i (not i itself), parents before their children. */
  forEachDescendant(i: number, visit: (j: number) => void): void {
    const { childStart, childList } = this.data;
    const childEnd = this.childEnd;
    const stack = [i];
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (let k = childStart[p]; k < childEnd[p]; k++) {
        const c = childList[k];
        visit(c);
        if (childEnd[c] > childStart[c]) stack.push(c);
      }
    }
  }

  private computeCategories(): Uint8Array {
    const { names, parent, isDir, size, flags } = this.data;
    const n = names.length;
    const k = CATEGORIES.length;
    const slot = new Int32Array(n).fill(-1);
    let dirs = 0;
    for (let i = 0; i < n; i++) if (isDir[i]) slot[i] = dirs++;

    const result = new Uint8Array(n);
    const bytes = new Float64Array(dirs * k);
    for (let i = n - 1; i >= 0; i--) {
      if ((flags[i] & FLAG_REMOVED) !== 0) continue;
      if (isDir[i]) {
        const base = slot[i] * k;
        let best = OTHER_INDEX;
        for (let c = 0; c < k; c++) if (bytes[base + c] > bytes[base + best]) best = c;
        result[i] = best;
        if (i > 0) {
          const target = slot[parent[i]] * k;
          for (let c = 0; c < k; c++) bytes[target + c] += bytes[base + c];
        }
      } else {
        const c = categoryIndexOfExt(extOf(names[i]));
        result[i] = c;
        bytes[slot[parent[i]] * k + c] += size[i];
      }
    }
    return result;
  }
}
