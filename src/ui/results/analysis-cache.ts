import {
  ageStats,
  categoryStats,
  extensionStats,
  topFiles,
  type AgeBucket,
  type CategoryStat,
  type DuplicateOptions,
  type DuplicateResult,
  type ExtensionStat,
  type ScanTree,
} from '../../core';

const LIMIT = 48;

/** A small LRU map: per-folder results are cheap to recompute but nice to keep. */
class Lru<K, V> {
  private readonly map = new Map<K, V>();

  get(key: K, make: () => V): V {
    let value = this.map.get(key);
    if (value === undefined) {
      value = make();
      this.set(key, value);
    } else {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    if (this.map.size >= LIMIT) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Analysis per folder, computed only when a tab needs it, then cached. */
export class AnalysisCache {
  private readonly top = new Lru<number, number[]>();
  private readonly ext = new Lru<number, ExtensionStat[]>();
  private readonly cat = new Lru<number, CategoryStat[]>();
  private readonly age = new Lru<number, AgeBucket[]>();
  /** Finished duplicate searches, per folder and options (searches run in slices, see DuplicatesPanel). */
  private readonly dupes = new Lru<string, DuplicateResult>();
  private readonly now = Date.now();

  constructor(private readonly tree: ScanTree) {}

  topFiles(dir: number): number[] {
    return this.top.get(dir, () => topFiles(this.tree, dir, 100));
  }

  extensions(dir: number): ExtensionStat[] {
    return this.ext.get(dir, () => extensionStats(this.tree, dir));
  }

  categories(dir: number): CategoryStat[] {
    return this.cat.get(dir, () => categoryStats(this.tree, dir));
  }

  ages(dir: number): AgeBucket[] {
    return this.age.get(dir, () => ageStats(this.tree, dir, this.now));
  }

  static duplicateKey(tree: ScanTree, dir: number, options: DuplicateOptions): string {
    return `${tree.version}|${dir}|${options.minSize}|${options.sizeOnly ? 1 : 0}|${options.includeSystem ? 1 : 0}`;
  }

  duplicates(key: string): DuplicateResult | undefined {
    return this.dupes.peek(key);
  }

  storeDuplicates(key: string, result: DuplicateResult): void {
    this.dupes.set(key, result);
  }

  /** After the tree changed (an item went to the Recycle Bin): everything is stale. */
  clear(): void {
    this.top.clear();
    this.ext.clear();
    this.cat.clear();
    this.age.clear();
    this.dupes.clear();
  }
}
