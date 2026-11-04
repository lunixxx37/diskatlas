import type { ScanTree } from '../../core';

/**
 * The folder tree flattened into the rows that are currently visible, in display
 * order (expanded folders followed by their children, largest first as the core
 * sorts them). Plain arrays, changed only on expand/collapse, so a list of 500,000
 * rows costs nothing while scrolling.
 */
export class TreeRows {
  /** Entry index of each row. */
  entries: number[] = [];
  /** Depth of each row (the scanned folder is 0). */
  depths: number[] = [];
  /** 1-based position among the visible siblings (aria-posinset). */
  positions: number[] = [];
  readonly expanded = new Set<number>();
  private files: boolean;
  /** Cached deepest visible row; -1 = recompute. */
  private deepest = -1;
  private readonly dirChildren = new Map<number, number>();

  /** `expanded`: folders to show open (besides the scanned folder), e.g. from an earlier view. */
  constructor(
    readonly tree: ScanTree,
    showFiles = true,
    expanded: Iterable<number> = [],
  ) {
    this.files = showFiles;
    this.expanded.add(tree.root);
    for (const entry of expanded) this.expanded.add(entry);
    this.rebuild();
  }

  get length(): number {
    return this.entries.length;
  }

  /** Depth of the deepest visible row (the tree view sizes its columns by it). */
  get maxDepth(): number {
    if (this.deepest < 0) {
      let max = 0;
      for (const d of this.depths) if (d > max) max = d;
      this.deepest = max;
    }
    return this.deepest;
  }

  get showFiles(): boolean {
    return this.files;
  }

  setShowFiles(show: boolean): void {
    if (show === this.files) return;
    this.files = show;
    this.rebuild();
  }

  /** Children a row shows when expanded (with "Show files" off, only folders count). */
  visibleChildCount(entry: number): number {
    if (!this.tree.isDir(entry)) return 0;
    if (this.files) return this.tree.childCount(entry);
    let n = this.dirChildren.get(entry);
    if (n === undefined) {
      n = 0;
      for (const c of this.tree.children(entry)) if (this.tree.isDir(c)) n++;
      this.dirChildren.set(entry, n);
    }
    return n;
  }

  isExpandable(entry: number): boolean {
    return this.visibleChildCount(entry) > 0;
  }

  /** aria-setsize: how many visible siblings the entry has (itself included). */
  setSize(entry: number): number {
    const p = this.tree.parent(entry);
    return p < 0 ? 1 : this.visibleChildCount(p);
  }

  isExpanded(entry: number): boolean {
    return this.expanded.has(entry) && this.isExpandable(entry);
  }

  /** Row of an entry, or -1 if it is not visible. Linear; used on demand only. */
  indexOf(entry: number): number {
    return this.entries.indexOf(entry);
  }

  /** Nearest visible row for an entry: the entry's own row or that of its closest visible ancestor. */
  nearestRow(entry: number): number {
    for (let p = entry; p >= 0; p = this.tree.parent(p)) {
      const row = this.entries.indexOf(p);
      if (row >= 0) return row;
    }
    return -1;
  }

  parentRow(row: number): number {
    const depth = this.depths[row];
    for (let r = row - 1; r >= 0; r--) if (this.depths[r] < depth) return r;
    return -1;
  }

  /** Expands the folder in `row`; returns false if there was nothing to expand. */
  expand(row: number): boolean {
    const entry = this.entries[row];
    if (entry === undefined || !this.isExpandable(entry) || this.expanded.has(entry)) return false;
    this.expanded.add(entry);
    this.deepest = -1;
    const sub = { entries: [] as number[], depths: [] as number[], positions: [] as number[] };
    this.collectChildren(entry, this.depths[row] + 1, sub);
    this.entries = splice(this.entries, row + 1, 0, sub.entries);
    this.depths = splice(this.depths, row + 1, 0, sub.depths);
    this.positions = splice(this.positions, row + 1, 0, sub.positions);
    return true;
  }

  /** Collapses the folder in `row`; returns false if it was not expanded. */
  collapse(row: number): boolean {
    const entry = this.entries[row];
    if (entry === undefined || !this.expanded.has(entry)) return false;
    this.expanded.delete(entry);
    this.deepest = -1;
    const depth = this.depths[row];
    let end = row + 1;
    while (end < this.depths.length && this.depths[end] > depth) end++;
    const count = end - row - 1;
    if (count > 0) {
      this.entries.splice(row + 1, count);
      this.depths.splice(row + 1, count);
      this.positions.splice(row + 1, count);
    }
    return true;
  }

  toggle(row: number): boolean {
    const entry = this.entries[row];
    if (entry === undefined) return false;
    return this.expanded.has(entry) ? this.collapse(row) : this.expand(row);
  }

  /**
   * Expands every folder above `entry` and returns its row, or -1 if the entry stays
   * hidden (a file while files are not shown).
   */
  expandTo(entry: number): number {
    const chain = this.tree.ancestors(entry);
    let row = 0;
    for (let k = 0; k < chain.length - 1; k++) {
      const folder = chain[k];
      if (!this.expanded.has(folder)) {
        if (!this.expand(row)) return -1;
      }
      const next = chain[k + 1];
      const depth = this.depths[row];
      let r = row + 1;
      while (r < this.entries.length && this.depths[r] > depth) {
        if (this.depths[r] === depth + 1 && this.entries[r] === next) break;
        r++;
      }
      if (r >= this.entries.length || this.entries[r] !== next) return -1;
      row = r;
    }
    return row;
  }

  rebuild(): void {
    const out = { entries: [] as number[], depths: [] as number[], positions: [] as number[] };
    out.entries.push(this.tree.root);
    out.depths.push(0);
    out.positions.push(1);
    if (this.expanded.has(this.tree.root)) this.collectChildren(this.tree.root, 1, out);
    this.entries = out.entries;
    this.depths = out.depths;
    this.positions = out.positions;
    this.deepest = -1;
  }

  private collectChildren(
    folder: number,
    depth: number,
    out: { entries: number[]; depths: number[]; positions: number[] },
  ): void {
    // Iterative depth-first walk; a stack of [folder, next child offset, position counter].
    const { tree } = this;
    const stack: Array<[number, number, number, number]> = [[folder, 0, 0, depth]];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const [dir, offset, , d] = top;
      const children = tree.children(dir);
      if (offset >= children.length) {
        stack.pop();
        continue;
      }
      const child = children[offset];
      top[1] = offset + 1;
      if (!this.files && !tree.isDir(child)) continue;
      top[2] += 1;
      out.entries.push(child);
      out.depths.push(d);
      out.positions.push(top[2]);
      if (this.expanded.has(child) && this.isExpandable(child)) stack.push([child, 0, 0, d + 1]);
    }
  }
}

/** Array splice that never spreads a huge argument list (folders can have 50,000+ children). */
function splice<T>(array: T[], at: number, remove: number, insert: T[]): T[] {
  if (insert.length < 10_000 && remove === 0) {
    array.splice(at, 0, ...insert);
    return array;
  }
  return array.slice(0, at).concat(insert, array.slice(at + remove));
}
