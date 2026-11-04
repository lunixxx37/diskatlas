import { afterEach, describe, expect, it } from 'vitest';
import { ageStats, categoryStats, extensionStats, topFiles } from './analysis';
import { findDuplicates } from './duplicates';
import { filesCsv, foldersCsv, type CsvFormat } from './export';
import { setFormatLocale } from './format';
import { buildHelperResult } from './helper-format.fixture';
import { decodeHelperResult } from './helper-format';
import { layoutTreemap } from './treemap';
import { ScanTree, type ScanMeta } from './tree';

const META: ScanMeta = { rootName: '', source: 'helper', startedAt: 0, durationMs: 0, complete: true, helper: { version: '0.1.0', elevated: false, features: ['scan', 'reveal', 'recycle'] } };
const MB = 1024 ** 2;
const CSV: CsvFormat = {
  separator: ',',
  bom: false,
  headers: { path: 'Path', bytes: 'Bytes', size: 'Size', allocatedBytes: 'Disk bytes', allocated: 'Disk', files: 'Files', folders: 'Folders', ext: 'Ext', modified: 'Modified' },
};

/** X:\ with Users\Ann\{Videos\trip.mkv, Videos\old\clip.mp4, notes.txt} and Games\big.pak. */
function tree(): ScanTree {
  const builder = decodeHelperResult(
    buildHelperResult({
      names: ['X:', 'Users', 'Ann', 'Videos', 'trip.mkv', 'old', 'clip.mp4', 'notes.txt', 'Games', 'big.pak'],
      parent: [-1, 0, 1, 2, 3, 3, 5, 2, 0, 8],
      kind: [1, 1, 1, 1, 0, 1, 0, 0, 1, 0],
      size: [0, 0, 0, 0, 400 * MB, 0, 300 * MB, 2 * MB, 0, 500 * MB],
      mtime: [0, 0, 0, 0, 3000, 0, 9000, 1000, 0, 2000],
      allocated: [0, 0, 0, 0, 400 * MB, 0, 300 * MB, 2 * MB + 4096, 0, 500 * MB],
    }),
  );
  return new ScanTree(builder.finish({ ...META, rootName: builder.names[0] }));
}

const find = (t: ScanTree, name: string) => {
  for (let i = 0; i < t.count; i++) if (t.name(i) === name) return i;
  throw new Error(name);
};
const names = (t: ScanTree, list: Iterable<number>) => [...list].map((i) => t.name(i));

afterEach(() => setFormatLocale('de-DE'));

describe('removing an entry after it went to the Recycle Bin', () => {
  it('takes size, size on disk, files and folders off every ancestor', () => {
    const t = tree();
    const videos = find(t, 'Videos');
    const removal = t.remove(videos)!;
    expect(removal).toEqual({ entry: videos, parent: find(t, 'Ann'), size: 700 * MB, allocated: 700 * MB, files: 2, dirs: 2 });
    for (const [name, size, allocated, files, dirs] of [
      ['Ann', 2 * MB, 2 * MB + 4096, 1, 0],
      ['Users', 2 * MB, 2 * MB + 4096, 1, 1],
      ['X:', 502 * MB, 502 * MB + 4096, 2, 3],
    ] as const) {
      const i = find(t, name);
      expect([t.size(i), t.allocated(i), t.fileCount(i), t.dirCount(i)], name).toEqual([size, allocated, files, dirs]);
    }
  });

  it('marks everything inside as removed and drops it from the children', () => {
    const t = tree();
    t.remove(find(t, 'Videos'));
    for (const name of ['Videos', 'trip.mkv', 'old', 'clip.mp4']) expect(t.removed(find(t, name)), name).toBe(true);
    expect(t.removed(find(t, 'notes.txt'))).toBe(false);
    expect(names(t, t.children(find(t, 'Ann')))).toEqual(['notes.txt']);
    const seen: string[] = [];
    t.forEachDescendant(0, (i) => seen.push(t.name(i)));
    expect(seen.sort()).toEqual(['Ann', 'Games', 'Users', 'big.pak', 'notes.txt']);
  });

  it('dates each ancestor again by its newest remaining file', () => {
    const t = tree();
    expect(t.mtime(0)).toBe(9000);
    t.remove(find(t, 'clip.mp4'));
    expect(t.mtime(find(t, 'old'))).toBe(0);
    expect(t.mtime(find(t, 'Videos'))).toBe(3000);
    expect(t.mtime(0)).toBe(3000);
  });

  it('keeps every folder in its place among its siblings, largest first', () => {
    const t = tree();
    expect(names(t, t.children(0))).toEqual(['Users', 'Games']);
    t.remove(find(t, 'trip.mkv'));
    expect(names(t, t.children(0))).toEqual(['Games', 'Users']);
    expect(names(t, t.children(find(t, 'Videos')))).toEqual(['old']);
  });

  it('refuses the root and entries that are already gone', () => {
    const t = tree();
    expect(t.remove(0)).toBeNull();
    const trip = find(t, 'trip.mkv');
    expect(t.remove(trip)).not.toBeNull();
    expect(t.remove(trip)).toBeNull();
    expect(t.remove(find(t, 'Videos'))).not.toBeNull();
    expect(t.remove(find(t, 'clip.mp4'))).toBeNull();
    expect(t.version).toBe(2);
  });

  it('is gone from the largest files, types, ages, map and duplicates', async () => {
    const t = tree();
    const trip = find(t, 'trip.mkv');
    expect(topFiles(t, 0, 10)).toContain(trip);
    t.remove(trip);
    expect(names(t, topFiles(t, 0, 10))).toEqual(['big.pak', 'clip.mp4', 'notes.txt']);
    expect(extensionStats(t, 0).map((s) => s.ext)).not.toContain('mkv');
    expect(categoryStats(t, 0).find((s) => s.id === 'video')!.size).toBe(300 * MB);
    expect(ageStats(t, 0, 10_000).reduce((n, b) => n + b.count, 0)).toBe(3);
    const rects = layoutTreemap(t, 0, 800, 600, { maxDepth: 4 });
    expect(rects.some((r) => r.i === trip)).toBe(false);
    expect((await findDuplicates(t, 0, { minSize: 0, sizeOnly: true, includeSystem: true })).files).toBe(0);
  });

  it('is gone from both CSV exports, and the folder rows show the new totals', () => {
    setFormatLocale('en-US');
    const t = tree();
    t.remove(find(t, 'trip.mkv'));
    const folders = foldersCsv(t, 0, CSV);
    expect(folders).not.toContain('trip.mkv');
    expect(folders.split('\r\n')[1].startsWith(`X:,${802 * MB},`)).toBe(true);
    const files = filesCsv(t, topFiles(t, 0, 10), CSV);
    expect(files).not.toContain('trip.mkv');
  });

  it('lets the folder categories follow what is left', () => {
    const t = tree();
    const videos = find(t, 'Videos');
    expect(t.category(videos)).toBe('video');
    t.remove(find(t, 'Games'));
    expect(t.category(0)).toBe('video');
    t.remove(videos);
    expect(t.category(0)).toBe('document');
  });
});
