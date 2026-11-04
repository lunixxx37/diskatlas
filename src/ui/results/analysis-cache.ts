import {
  ageStats,
  categoryStats,
  extensionStats,
  topFiles,
  type AgeBucket,
  type CategoryStat,
  type ExtensionStat,
  type ScanTree,
} from '../../core';

const LIMIT = 48;

/** A small LRU map: per-folder results are cheap to recompute but nice to keep. */
class Lru<V> {
  private readonly map = new Map<number, V>();
  get(key: number, make: () => V): V {
    let value = this.map.get(key);
    if (value === undefined) {
      value = make();
      if (this.map.size >= LIMIT) this.map.delete(this.map.keys().next().value!);
    } else {
      this.map.delete(key);
    }
    this.map.set(key, value);
    return value;
  }
}

/** Analysis per folder, computed only when a tab needs it, then cached. */
export class AnalysisCache {
  private readonly top = new Lru<number[]>();
  private readonly ext = new Lru<ExtensionStat[]>();
  private readonly cat = new Lru<CategoryStat[]>();
  private readonly age = new Lru<AgeBucket[]>();
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
}
