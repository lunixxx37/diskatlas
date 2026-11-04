import { describe, expect, it } from 'vitest';
import { ageStats, categoryStats, extensionStats, topFiles } from './analysis';
import { createDemoTree, demoScan } from './demo';
import { foldersCsv, type CsvFormat } from './export';
import { formatBytes, formatPercent } from './format';
import { treeFromFiles } from './scanner';
import { layoutTreemap, squarify, type Rect } from './treemap';
import { ScanTree, TreeBuilder, type ScanMeta } from './tree';
import { walk } from './walk';

// Minimal stand-ins for File System Access handles.
const file = (name: string, size: number, lastModified = 1000) => ({
  kind: 'file',
  name,
  getFile: async () => ({ size, lastModified }),
});
const busyFile = (name: string) => ({
  kind: 'file',
  name,
  getFile: async () => {
    throw new DOMException('locked', 'NotReadableError');
  },
});
const dir = (name: string, ...entries: unknown[]) => ({
  kind: 'directory',
  name,
  async *values() {
    yield* entries;
  },
});
const lockedDir = (name: string) => ({
  kind: 'directory',
  name,
  async *values() {
    throw new DOMException('denied', 'NotAllowedError');
  },
});
const asHandle = (d: unknown) => d as FileSystemDirectoryHandle;
const META: ScanMeta = { rootName: 'root', source: 'picker', startedAt: 0, durationMs: 0, complete: true };

async function scan(root: unknown, options: Parameters<typeof walk>[2] = {}) {
  const builder = new TreeBuilder();
  await walk(asHandle(root), builder, options);
  return { builder, tree: new ScanTree(builder.finish(META)) };
}

function find(tree: ScanTree, name: string): number {
  for (let i = 0; i < tree.count; i++) if (tree.name(i) === name) return i;
  throw new Error(`no entry ${name}`);
}

const sample = () =>
  dir(
    'root',
    file('a.txt', 10, 2000),
    dir('sub', file('b.mp4', 100, 5000), dir('deeper', file('c.zip', 50, 3000))),
    lockedDir('secret'),
    busyFile('busy.dat'),
  );

describe('walk + TreeBuilder', () => {
  it('adds up sizes, counts and dates and sorts children largest first', async () => {
    const { builder, tree } = await scan(sample());
    expect(tree.size(0)).toBe(160);
    expect(tree.fileCount(0)).toBe(4);
    expect(tree.dirCount(0)).toBe(3);
    expect(tree.mtime(0)).toBe(5000);
    expect([...tree.children(0)].map((i) => tree.name(i))).toEqual(['sub', 'a.txt', 'secret', 'busy.dat']);
    const sub = find(tree, 'sub');
    expect(tree.size(sub)).toBe(150);
    expect(tree.fileCount(sub)).toBe(2);
    expect(tree.dirCount(sub)).toBe(1);
    expect(tree.path(find(tree, 'c.zip'), '/')).toBe('root/sub/deeper/c.zip');
    expect(tree.depth(find(tree, 'c.zip'))).toBe(3);
    expect(builder.errors).toBe(2);
  });

  it('flags folders and files it cannot read instead of failing', async () => {
    const { tree } = await scan(sample());
    expect(tree.unreadable(find(tree, 'secret'))).toBe(true);
    expect(tree.unreadable(find(tree, 'busy.dat'))).toBe(true);
    expect(tree.unreadable(find(tree, 'sub'))).toBe(false);
  });

  it('every entry comes after its parent', async () => {
    const { tree } = await scan(sample());
    for (let i = 1; i < tree.count; i++) expect(tree.parent(i)).toBeLessThan(i);
  });

  it('stops descending at the depth limit', async () => {
    const chain = dir('root', dir('1', dir('2', dir('3', dir('4', file('deep.txt', 1))))));
    const { tree } = await scan(chain, { maxDepth: 3 });
    expect(tree.tooDeep(find(tree, '3'))).toBe(true);
    expect(() => find(tree, '4')).toThrow();
  });

  it('reads many folders with limited concurrency', async () => {
    const folders = Array.from({ length: 50 }, (_, k) => dir(`d${k}`, file('x.bin', k + 1), dir('inner', file('y.bin', 1))));
    const { tree } = await scan(dir('root', ...folders), { dirConcurrency: 4, statBatch: 2 });
    expect(tree.dirCount(0)).toBe(100);
    expect(tree.fileCount(0)).toBe(100);
    expect(tree.size(0)).toBe((50 * 51) / 2 + 50);
  });

  it('stops early when cancelled', async () => {
    let started = 0;
    const { tree } = await scan(sample(), { onDirStart: () => started++, isCancelled: () => started > 0 });
    expect(tree.count).toBe(1);
  });

  it('gives folders the category with the most bytes', async () => {
    const { tree } = await scan(sample());
    expect(tree.category(find(tree, 'sub'))).toBe('video');
    expect(tree.category(find(tree, 'c.zip'))).toBe('archive');
    expect(tree.category(find(tree, 'secret'))).toBe('other');
  });
});

describe('treeFromFiles', () => {
  it('rebuilds folders from relative paths', () => {
    const files = [
      { webkitRelativePath: 'Fotos/2024/a.jpg', size: 5, lastModified: 1 },
      { webkitRelativePath: 'Fotos/b.txt', size: 3, lastModified: 2 },
      { webkitRelativePath: 'Fotos/2024/Mai/c.jpg', size: 7, lastModified: 3 },
    ] as unknown as File[];
    const tree = treeFromFiles(files);
    expect(tree.name(0)).toBe('Fotos');
    expect(tree.size(0)).toBe(15);
    expect(tree.dirCount(0)).toBe(2);
    expect(tree.path(find(tree, 'c.jpg'), '/')).toBe('Fotos/2024/Mai/c.jpg');
    expect(tree.meta.source).toBe('files');
  });
});

describe('squarify', () => {
  const overlap = (a: Rect, b: Rect) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

  it('tiles the box with areas proportional to the values', () => {
    const values = [6, 6, 4, 3, 2, 2, 1];
    const rects = squarify(values, 0, 0, 6, 4);
    rects.forEach((r, k) => {
      expect(r.w * r.h).toBeCloseTo(values[k], 9);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(6 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(4 + 1e-9);
    });
    for (let a = 0; a < rects.length; a++)
      for (let b = a + 1; b < rects.length; b++) expect(overlap(rects[a], rects[b])).toBeCloseTo(0, 9);
  });

  it('handles a single value and an empty box', () => {
    expect(squarify([5], 10, 20, 30, 40)).toEqual([{ x: 10, y: 20, w: 30, h: 40 }]);
    expect(squarify([1, 2], 0, 0, 0, 10).every((r) => r.w === 0 && r.h === 0)).toBe(true);
  });
});

describe('layoutTreemap', () => {
  it('keeps every rectangle inside its parent and merges tiny entries', () => {
    const tree = createDemoTree(Date.UTC(2026, 10, 3));
    const rects = layoutTreemap(tree, 0, 1200, 800, { maxDepth: 3, minArea: 30 });
    expect(rects.length).toBeGreaterThan(20);
    const byIndex = new Map(rects.filter((r) => r.i >= 0).map((r) => [r.i, r]));
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(1200 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(800 + 1e-6);
      const parentIndex = r.kind === 'rest' ? r.restParent! : tree.parent(r.i);
      const parent = byIndex.get(parentIndex);
      if (parent) {
        expect(parent.nested).toBe(true);
        expect(r.x).toBeGreaterThanOrEqual(parent.x - 1e-6);
        expect(r.y).toBeGreaterThanOrEqual(parent.y - 1e-6);
        expect(r.x + r.w).toBeLessThanOrEqual(parent.x + parent.w + 1e-6);
        expect(r.y + r.h).toBeLessThanOrEqual(parent.y + parent.h + 1e-6);
      }
    }
    expect(rects.some((r) => r.kind === 'rest' && r.restCount! > 0)).toBe(true);
  });
});

describe('analysis', () => {
  it('finds the largest files and groups by type and age', async () => {
    const { tree } = await scan(sample());
    expect(topFiles(tree, 0, 2).map((i) => tree.name(i))).toEqual(['b.mp4', 'c.zip']);
    expect(extensionStats(tree, 0).map((s) => [s.ext, s.size])).toEqual([
      ['mp4', 100],
      ['zip', 50],
      ['txt', 10],
      ['dat', 0],
    ]);
    expect(categoryStats(tree, 0).map((s) => s.id)).toEqual(['video', 'archive', 'document', 'data']);
    const ages = ageStats(tree, 0, 5000 + 400 * 86_400_000);
    expect(ages.find((b) => b.id === '1to2y')!.count).toBe(3);
    expect(ages.find((b) => b.id === 'unknown')!.count).toBe(1);
  });

  it('topFiles works on large trees', () => {
    const tree = createDemoTree(Date.UTC(2026, 10, 3));
    const top = topFiles(tree, 0, 100);
    expect(top).toHaveLength(100);
    expect(tree.name(top[0])).toBe('Laptop-Systemabbild.vhdx');
    for (let k = 1; k < top.length; k++) expect(tree.size(top[k])).toBeLessThanOrEqual(tree.size(top[k - 1]));
  });
});

describe('demo', () => {
  it('is deterministic and plausible', () => {
    const now = Date.UTC(2026, 10, 3);
    const a = createDemoTree(now);
    const b = createDemoTree(now);
    expect(a.count).toBe(b.count);
    expect(a.size(0)).toBe(b.size(0));
    expect(a.count).toBeGreaterThan(10_000);
    expect(a.size(0) / 1024 ** 3).toBeGreaterThan(500);
    expect(a.size(0) / 1024 ** 3).toBeLessThan(900);
    expect(a.unreadable(find(a, 'System Volume Information'))).toBe(true);
  });

  it('plays back a scan with progress', async () => {
    const seen: number[] = [];
    const scan = demoScan((p) => seen.push(p.files), 100);
    const tree = await scan.result;
    expect(tree.meta.complete).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(tree.fileCount(0));
  });
});

describe('format & export', () => {
  it('formats sizes like Windows Explorer', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
    expect(formatBytes(1)).toBe('1 Byte');
    expect(formatBytes(999)).toBe('999 Bytes');
    expect(formatBytes(1536)).toBe('1,50 KB');
    expect(formatBytes(10 * 1024)).toBe('10,0 KB');
    expect(formatBytes(1023 * 1024)).toBe('1,00 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1,50 GB');
    expect(formatPercent(0.123)).toBe('12 %');
    expect(formatPercent(0.05)).toBe('5,0 %');
  });

  it('exports folders as CSV for Excel', async () => {
    const { tree } = await scan(sample());
    const german: CsvFormat = {
      separator: ';',
      bom: true,
      headers: {
        path: 'Pfad',
        bytes: 'Größe (Bytes)',
        size: 'Größe',
        allocatedBytes: 'Belegt (Bytes)',
        allocated: 'Belegt',
        files: 'Dateien',
        folders: 'Ordner',
        ext: 'Endung',
        modified: 'Zuletzt geändert',
      },
    };
    const text = foldersCsv(tree, 0, german);
    const lines = text.trim().split('\r\n');
    expect(text.startsWith('﻿Pfad;')).toBe(true);
    expect(lines).toHaveLength(1 + 4);
  });
});
