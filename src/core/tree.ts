import { CATEGORIES, OTHER_INDEX, categoryIndexOfExt, extOf, type CategoryId } from './categories';
import { PATH_SEP } from './format';

/** The folder could not be listed, or the file's size could not be read. */
export const FLAG_UNREADABLE = 1;
/** The folder was not descended into because it is nested too deeply. */
export const FLAG_TOO_DEEP = 2;

export type ScanSource = 'picker' | 'files' | 'demo';

export interface ScanMeta {
  rootName: string;
  source: ScanSource;
  /** Epoch ms. */
  startedAt: number;
  durationMs: number;
  /** false when the scan was cancelled and only part of the folder was read. */
  complete: boolean;
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
  /** Files in the whole subtree (folders only). */
  fileCount: Uint32Array;
  /** Sub-folders in the whole subtree (folders only). */
  dirCount: Uint32Array;
  /** Children of entry i are childList[childStart[i] .. childStart[i + 1]), largest first. */
  childStart: Int32Array;
  childList: Int32Array;
}

/** Collects entries during a scan; `finish()` turns them into `ScanData`. */
export class TreeBuilder {
  readonly names: string[] = [];
  readonly parent: number[] = [];
  readonly isDir: number[] = [];
  readonly flags: number[] = [];
  readonly size: number[] = [];
  readonly mtime: number[] = [];
  /** Running totals, for progress reports. */
  files = 0;
  dirs = 0;
  bytes = 0;
  errors = 0;
  lastDir = 0;

  get count(): number {
    return this.names.length;
  }

  /** The first folder added (with parent -1) is the root. */
  addDir(parent: number, name: string): number {
    if (parent >= 0) this.dirs++;
    this.lastDir = this.push(parent, name, 1, 0, 0);
    return this.lastDir;
  }

  addFile(parent: number, name: string, size: number, mtime: number): number {
    this.files++;
    this.bytes += size;
    return this.push(parent, name, 0, size, mtime);
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
    const fileCount = new Uint32Array(n);
    const dirCount = new Uint32Array(n);

    // Children always come after their parent, so walking backwards visits a folder
    // only after everything inside it has been added up.
    for (let i = n - 1; i > 0; i--) {
      const p = parent[i];
      size[p] += size[i];
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

    return {
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
  }

  private push(parent: number, name: string, isDir: number, size: number, mtime: number): number {
    const index = this.names.length;
    this.names.push(name);
    this.parent.push(parent);
    this.isDir.push(isDir);
    this.flags.push(0);
    this.size.push(size);
    this.mtime.push(mtime);
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
  ].map((array) => array.buffer as ArrayBuffer);
}

/** Read access to a finished scan. Entries are addressed by index; the root is 0. */
export class ScanTree {
  readonly root = 0;
  private categories?: Uint8Array;

  constructor(readonly data: ScanData) {}

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

  /** Direct children, largest first. A view into the tree: do not modify it. */
  children(i: number): Int32Array {
    return this.data.childList.subarray(this.data.childStart[i], this.data.childStart[i + 1]);
  }

  childCount(i: number): number {
    return this.data.childStart[i + 1] - this.data.childStart[i];
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

  /** Starts with the scanned folder's name; the browser never reveals the full path. */
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
    const stack = [i];
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (let k = childStart[p]; k < childStart[p + 1]; k++) {
        const c = childList[k];
        visit(c);
        if (childStart[c + 1] > childStart[c]) stack.push(c);
      }
    }
  }

  private computeCategories(): Uint8Array {
    const { names, parent, isDir, size } = this.data;
    const n = names.length;
    const k = CATEGORIES.length;
    const slot = new Int32Array(n).fill(-1);
    let dirs = 0;
    for (let i = 0; i < n; i++) if (isDir[i]) slot[i] = dirs++;

    const result = new Uint8Array(n);
    const bytes = new Float64Array(dirs * k);
    for (let i = n - 1; i >= 0; i--) {
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
