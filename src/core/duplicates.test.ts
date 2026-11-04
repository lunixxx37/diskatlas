import { describe, expect, it } from 'vitest';
import { createDemoTree } from './demo';
import { DEFAULT_DUPLICATE_OPTIONS, findDuplicates, inSystemFolder, isSystemFolder, type DuplicateOptions } from './duplicates';
import { buildHelperResult } from './helper-format.fixture';
import { decodeHelperResult } from './helper-format';
import { ScanTree, TreeBuilder, type ScanMeta } from './tree';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const META: ScanMeta = { rootName: '', source: 'helper', startedAt: 0, durationMs: 0, complete: true };
const now = { sliceMs: 1e9, pause: async () => undefined };

/** A drive scan: copies in Users, the same files in Windows (hard links), a link, small files. */
function drive(): ScanTree {
  const entries: Array<[name: string, parent: number, kind: number, size: number, mtime: number]> = [
    ['X:', -1, 1, 0, 0], // 0
    ['Users', 0, 1, 0, 0], // 1
    ['Ann', 1, 1, 0, 0], // 2
    ['Videos', 2, 1, 0, 0], // 3
    ['Trip.MKV', 3, 0, 4 * GB, 3000], // 4
    ['Backup', 2, 1, 0, 0], // 5
    ['trip.mkv', 5, 0, 4 * GB, 5000], // 6
    ['trip (copy).mkv', 5, 0, 4 * GB, 1000], // 7
    ['photo.jpg', 3, 0, 5 * MB, 100], // 8
    ['photo.jpg', 5, 0, 5 * MB, 200], // 9
    ['photo.jpg', 2, 0, 5 * MB, 300], // 10
    ['tiny.txt', 3, 0, 1000, 1], // 11
    ['tiny.txt', 5, 0, 1000, 2], // 12
    ['Windows', 0, 1, 0, 0], // 13
    ['System32', 13, 1, 0, 0], // 14
    ['kernel.dll', 14, 0, 20 * MB, 7], // 15
    ['WinSxS', 13, 1, 0, 0], // 16
    ['kernel.dll', 16, 0, 20 * MB, 7], // 17
    ['$Recycle.Bin', 0, 1, 0, 0], // 18
    ['trip.mkv', 18, 0, 4 * GB, 8], // 19
    ['System Volume Information', 0, 1, 0, 0], // 20
    ['photo.jpg', 20, 0, 5 * MB, 9], // 21
    ['My Videos', 2, 1 | 4, 0, 0], // 22: a junction, not followed
  ];
  const builder = decodeHelperResult(
    buildHelperResult({
      names: entries.map((e) => e[0]),
      parent: entries.map((e) => e[1]),
      kind: entries.map((e) => e[2]),
      size: entries.map((e) => (e[2] & 1 ? 0 : e[3])),
      mtime: entries.map((e) => e[4]),
    }),
  );
  return new ScanTree(builder.finish({ ...META, rootName: builder.names[0] }));
}

const find = (t: ScanTree, name: string, parent?: string) => {
  for (let i = 0; i < t.count; i++) if (t.name(i) === name && (parent === undefined || t.name(t.parent(i)) === parent)) return i;
  throw new Error(name);
};
const groupsOf = async (t: ScanTree, folder: number, options: Partial<DuplicateOptions> = {}) => {
  const result = await findDuplicates(t, folder, { ...DEFAULT_DUPLICATE_OPTIONS, ...options }, undefined, now);
  return { ...result, view: result.groups.map((g) => `${g.name}×${g.members.length}`) };
};

describe('possible duplicates', () => {
  it('groups files with the same name (any case) and size, most reclaimable first', async () => {
    const t = drive();
    const r = await groupsOf(t, 0);
    expect(r.view).toEqual(['trip.mkv×2', 'photo.jpg×3']);
    expect(r.groups[0].reclaimable).toBe(4 * GB);
    expect(r.groups[1].reclaimable).toBe(10 * MB);
    expect(r.reclaimable).toBe(4 * GB + 10 * MB);
    expect(r.files).toBe(5);
    expect(r.groups[0].sameName).toBe(true);
  });

  it('lists the members newest first', async () => {
    const t = drive();
    const trips = (await groupsOf(t, 0)).groups[0];
    expect(trips.members).toEqual([find(t, 'trip.mkv', 'Backup'), find(t, 'Trip.MKV')]);
    expect(trips.name).toBe('trip.mkv');
  });

  it('can ignore names and group by size alone', async () => {
    const t = drive();
    const r = await groupsOf(t, 0, { sizeOnly: true });
    expect(r.view).toEqual(['trip.mkv×3', 'photo.jpg×3']);
    expect(r.groups[0].sameName).toBe(false);
    expect(r.groups[0].reclaimable).toBe(8 * GB);
  });

  it('leaves out files below the minimum size', async () => {
    const t = drive();
    expect((await groupsOf(t, 0, { minSize: 0 })).view).toContain('tiny.txt×2');
    expect((await groupsOf(t, 0, { minSize: 10 * MB })).view).toEqual(['trip.mkv×2']);
    expect((await groupsOf(t, 0, { minSize: 5 * GB })).view).toEqual([]);
  });

  it("leaves out Windows' own folders, the Recycle Bin, System Volume Information and links", async () => {
    const t = drive();
    expect(isSystemFolder(t, find(t, 'Windows'))).toBe(true);
    expect(isSystemFolder(t, find(t, '$Recycle.Bin'))).toBe(true);
    expect(isSystemFolder(t, find(t, 'System Volume Information'))).toBe(true);
    expect(isSystemFolder(t, find(t, 'Users'))).toBe(false);
    expect(inSystemFolder(t, find(t, 'System32'))).toBe(true);
    const off = await groupsOf(t, 0);
    expect(off.view).not.toContain('kernel.dll×2');
    const on = await groupsOf(t, 0, { includeSystem: true });
    expect(on.view).toEqual(['trip.mkv×3', 'kernel.dll×2', 'photo.jpg×4']);
    expect((await groupsOf(t, find(t, 'Windows'))).groups).toEqual([]);
    expect((await groupsOf(t, find(t, 'Windows'), { includeSystem: true })).view).toEqual(['kernel.dll×2']);
  });

  it('only counts a folder named Windows in the root of a drive scan', async () => {
    const b = new TreeBuilder();
    const root = b.addDir(-1, 'Games');
    const win = b.addDir(root, 'Windows');
    b.addFile(win, 'a.bin', 2 * MB, 1);
    b.addFile(root, 'a.bin', 2 * MB, 2);
    const t = new ScanTree(b.finish({ ...META, source: 'picker', rootName: 'Games' }));
    expect(isSystemFolder(t, win)).toBe(false);
    expect((await groupsOf(t, root)).view).toEqual(['a.bin×2']);
    const inside = new TreeBuilder();
    inside.addDir(-1, 'C:\\Windows\\System32');
    expect(isSystemFolder(new ScanTree(inside.finish({ ...META, rootName: 'C:\\Windows\\System32' })), 0)).toBe(true);
  });

  it('looks only below the given folder', async () => {
    const t = drive();
    expect((await groupsOf(t, find(t, 'Backup'))).view).toEqual([]);
    expect((await groupsOf(t, find(t, 'Ann'))).view).toEqual(['trip.mkv×2', 'photo.jpg×3']);
  });

  it('gives the page a turn on big trees and can be aborted', async () => {
    const b = new TreeBuilder();
    const root = b.addDir(-1, 'D:');
    for (let d = 0; d < 400; d++) {
      const dir = b.addDir(root, `dir${d}`);
      for (let f = 0; f < 50; f++) b.addFile(dir, `file${f}.bin`, 2 * MB + f, 1);
    }
    const t = new ScanTree(b.finish({ ...META, rootName: 'D:' }));
    let pauses = 0;
    const r = await findDuplicates(t, root, DEFAULT_DUPLICATE_OPTIONS, undefined, { sliceMs: 0, pause: async () => void pauses++ });
    expect(pauses).toBeGreaterThan(1);
    expect(r.groups).toHaveLength(50);
    expect(r.groups[0].members).toHaveLength(400);
    const controller = new AbortController();
    const aborted = findDuplicates(t, root, DEFAULT_DUPLICATE_OPTIONS, controller.signal, { sliceMs: 0, pause: async () => controller.abort() });
    await expect(aborted).rejects.toThrow(/aborted/);
  });

  it('finds the copies on the demo drive, in both languages alike', async () => {
    const at = Date.UTC(2026, 10, 3);
    const english = createDemoTree(at, 'en');
    const german = createDemoTree(at, 'de');
    const a = await findDuplicates(english, english.root, DEFAULT_DUPLICATE_OPTIONS, undefined, now);
    const b = await findDuplicates(german, german.root, DEFAULT_DUPLICATE_OPTIONS, undefined, now);
    // A film, holiday clips and a month of photos (more than one page of 40 groups).
    expect(a.groups.length).toBeGreaterThan(40);
    expect(a.groups[0].name).toMatch(/\.mkv$/);
    expect(a.groups.every((g) => g.members.length === 2 && g.sameName)).toBe(true);
    expect(a.groups.filter((g) => g.name.startsWith('VID_'))).toHaveLength(4);
    expect([b.groups.length, b.reclaimable]).toEqual([a.groups.length, a.reclaimable]);
  });
});
