import { CATEGORIES, categoryIndexOfExt, type CategoryId } from './categories';
import type { ScanTree } from './tree';

/** The largest files below `root`, largest first. */
export function topFiles(tree: ScanTree, root: number, limit = 100): number[] {
  let picked: number[] = [];
  let threshold = -1;
  const bySize = (a: number, b: number) => tree.size(b) - tree.size(a);
  tree.forEachDescendant(root, (i) => {
    if (tree.isDir(i) || tree.size(i) <= threshold) return;
    picked.push(i);
    if (picked.length >= limit * 4) {
      picked = picked.sort(bySize).slice(0, limit);
      threshold = tree.size(picked[picked.length - 1]);
    }
  });
  return picked.sort(bySize).slice(0, limit);
}

export interface ExtensionStat {
  /** '' = no extension. */
  ext: string;
  category: CategoryId;
  count: number;
  size: number;
}

/** Files below `root` grouped by extension, largest total first. */
export function extensionStats(tree: ScanTree, root: number): ExtensionStat[] {
  const byExt = new Map<string, ExtensionStat>();
  tree.forEachDescendant(root, (i) => {
    if (tree.isDir(i)) return;
    const ext = tree.ext(i);
    let stat = byExt.get(ext);
    if (!stat) {
      stat = { ext, category: CATEGORIES[categoryIndexOfExt(ext)].id, count: 0, size: 0 };
      byExt.set(ext, stat);
    }
    stat.count++;
    stat.size += tree.size(i);
  });
  return [...byExt.values()].sort((a, b) => b.size - a.size || b.count - a.count);
}

export interface CategoryStat {
  id: CategoryId;
  count: number;
  size: number;
}

/** Files below `root` grouped by category, largest total first; empty categories are left out. */
export function categoryStats(tree: ScanTree, root: number): CategoryStat[] {
  const stats = CATEGORIES.map(({ id }) => ({ id, count: 0, size: 0 }));
  tree.forEachDescendant(root, (i) => {
    if (tree.isDir(i)) return;
    const stat = stats[tree.categoryIndex(i)];
    stat.count++;
    stat.size += tree.size(i);
  });
  return stats.filter((s) => s.count > 0).sort((a, b) => b.size - a.size || b.count - a.count);
}

/** Stable ids of the age buckets; the interface's message catalogs name them. */
export type AgeBucketId = 'last30d' | '1to6m' | '6to12m' | '1to2y' | '2to5y' | 'over5y' | 'unknown';

export interface AgeBucket {
  id: AgeBucketId;
  /** Age range in days, `fromDays` included, `toDays` excluded; null for files without a date. */
  fromDays: number | null;
  toDays: number | null;
  count: number;
  size: number;
}

const DAY_MS = 86_400_000;
const AGE_RANGES: ReadonlyArray<[id: AgeBucketId, fromDays: number, toDays: number]> = [
  ['last30d', 0, 30],
  ['1to6m', 30, 182],
  ['6to12m', 182, 365],
  ['1to2y', 365, 730],
  ['2to5y', 730, 1826],
  ['over5y', 1826, Infinity],
];

/** Files below `root` grouped by when they were last changed, newest first. */
export function ageStats(tree: ScanTree, root: number, now = Date.now()): AgeBucket[] {
  const buckets: AgeBucket[] = AGE_RANGES.map(([id, fromDays, toDays]) => ({
    id,
    fromDays,
    toDays,
    count: 0,
    size: 0,
  }));
  const unknown: AgeBucket = { id: 'unknown', fromDays: null, toDays: null, count: 0, size: 0 };
  tree.forEachDescendant(root, (i) => {
    if (tree.isDir(i)) return;
    const mtime = tree.mtime(i);
    let bucket = unknown;
    if (mtime > 0) {
      const days = Math.max(0, (now - mtime) / DAY_MS);
      bucket = buckets.find((b) => days < b.toDays!)!;
    }
    bucket.count++;
    bucket.size += tree.size(i);
  });
  return unknown.count > 0 ? [...buckets, unknown] : buckets;
}
