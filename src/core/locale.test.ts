import { afterEach, describe, expect, it } from 'vitest';
import { createDemoTree, demoRootName, demoScan } from './demo';
import { de, en } from './demo-names';
import { filesCsv, foldersCsv, type CsvFormat } from './export';
import {
  formatBytes,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatLocale,
  formatPercent,
  setFormatLocale,
} from './format';
import { ScanTree, TreeBuilder } from './tree';

afterEach(() => setFormatLocale('de-DE'));

describe('English formatting', () => {
  it('writes sizes, counts and percentages the English way, still 1024-based', () => {
    setFormatLocale('en-US');
    expect(formatLocale()).toBe('en-US');
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(999)).toBe('999 bytes');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(10 * 1024)).toBe('10.0 KB');
    expect(formatBytes(1023 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GB');
    expect(formatCount(15_234)).toBe('15,234');
    expect(formatPercent(0.123)).toBe('12%');
    expect(formatPercent(0.05)).toBe('5.0%');
    expect(formatPercent(Number.NaN)).toBe('–');
    expect(formatDuration(2345)).toBe('2.3 s');
  });

  it('writes dates with a month name, so day and month cannot be mixed up', () => {
    const ms = new Date(2026, 10, 3, 14, 5).getTime();
    setFormatLocale('en-US');
    expect(formatDate(ms)).toBe('Nov 3, 2026');
    expect(formatDateTime(ms)).toMatch(/^Nov 3, 2026,? (at )?2:05\sPM$/);
    setFormatLocale('en-GB');
    expect(formatDate(ms)).toBe('3 Nov 2026');
    expect(formatDateTime(ms)).toMatch(/^3 Nov 2026,? (at )?14:05$/);
    expect(formatDate(0)).toBe('–');
  });

  it('switches back to German', () => {
    setFormatLocale('en-US');
    setFormatLocale('de-DE');
    expect(formatBytes(1536)).toBe('1,50 KB');
    expect(formatBytes(1)).toBe('1 Byte');
    expect(formatPercent(0.123)).toBe('12 %');
    expect(formatCount(15_234)).toBe('15.234');
    expect(formatDate(new Date(2026, 10, 3).getTime())).toBe('03.11.2026');
  });
});

describe('English CSV', () => {
  const english: CsvFormat = {
    separator: ',',
    bom: true,
    headers: {
      path: 'Path',
      bytes: 'Size (bytes)',
      size: 'Size',
      allocatedBytes: 'Size on disk (bytes)',
      allocated: 'Size on disk',
      files: 'Files',
      folders: 'Folders',
      ext: 'Extension',
      modified: 'Last modified',
    },
  };
  const day = Date.UTC(2026, 10, 3, 12);

  function smallTree(): ScanTree {
    const b = new TreeBuilder();
    const root = b.addDir(-1, 'root');
    const trip = b.addDir(root, 'Lena, Tom');
    b.addFile(trip, 'clip "final".mp4', 3 * 1024 ** 2, day);
    b.addFile(root, 'notes.txt', 2048, day);
    return new ScanTree(b.finish({ rootName: 'root', source: 'picker', startedAt: 0, durationMs: 0, complete: true }));
  }

  it('separates with commas, uses English headers and quotes cells that need it', () => {
    setFormatLocale('en-US');
    const tree = smallTree();
    const lines = foldersCsv(tree, 0, english).split('\r\n');
    expect(lines[0]).toBe('﻿Path,Size (bytes),Size,Files,Folders,Last modified');
    expect(lines[1]).toBe(`root,${3 * 1024 ** 2 + 2048},3.00 MB,2,1,2026-11-03`);
    expect(lines[2]).toBe(`"root/Lena, Tom",${3 * 1024 ** 2},3.00 MB,1,0,2026-11-03`);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
  });

  it('lists files with the same rules', () => {
    setFormatLocale('en-US');
    const tree = smallTree();
    const files: number[] = [];
    tree.forEachDescendant(0, (i) => {
      if (!tree.isDir(i)) files.push(i);
    });
    const lines = filesCsv(tree, files, { ...english, bom: false }).trim().split('\r\n');
    expect(lines[0]).toBe('Path,Size (bytes),Size,Extension,Last modified');
    expect(lines).toContain(`"root/Lena, Tom/clip ""final"".mp4",${3 * 1024 ** 2},3.00 MB,mp4,2026-11-03`);
    expect(lines).toContain('root/notes.txt,2048,2.00 KB,txt,2026-11-03');
  });
});

describe('demo drive names', () => {
  const now = Date.UTC(2026, 10, 3);

  it('follows the language it is created in, with the same layout and sizes', () => {
    const german = createDemoTree(now, 'de');
    const english = createDemoTree(now, 'en');
    expect(german.name(0)).toBe('Beispiel-Laufwerk');
    expect(english.name(0)).toBe('Example Drive');
    expect(demoRootName('en')).toBe('Example Drive');
    expect(demoRootName('de')).toBe('Beispiel-Laufwerk');
    expect(english.count).toBe(german.count);
    expect(english.size(0)).toBe(german.size(0));
    const folders = [...english.children(0)].filter((i) => english.isDir(i)).map((i) => english.name(i));
    expect(folders).toEqual(expect.arrayContaining(['Games', 'Videos', 'Photos', 'Music', 'Documents', 'Backups', 'Downloads']));
    const germanLooking: string[] = [];
    for (let i = 0; i < english.count; i++) if (/[äöüÄÖÜß]/.test(english.name(i))) germanLooking.push(english.name(i));
    expect(germanLooking).toEqual([]);
  });

  it('plays back a scan in English', async () => {
    const tree = await demoScan(() => {}, 50, 'en').result;
    expect(tree.name(0)).toBe('Example Drive');
    expect(tree.meta.rootName).toBe('Example Drive');
  });

  it('has lists of the same length in both languages', () => {
    const shape = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(shape)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
          : typeof value;
    expect(shape(en)).toEqual(shape(de));
  });
});
