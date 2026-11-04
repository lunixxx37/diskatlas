import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PATH_SEP, ageStats, createDemoTree, topFiles, treeFromFiles, type AgeBucket } from '../core';
import { decimalMark, displayName, displayPath, folderBelow, formatClock, formatCounter, safeFilename, splitPath } from './format';
import { plural, setLanguage, t } from './i18n';
import { ageInsight } from './results/file-age';

afterAll(() => setLanguage('en', ['en-US']));

describe('UI formatting in German', () => {
  beforeEach(() => setLanguage('de', ['de-DE']));

  it('counts with two decimals in Explorer units', () => {
    expect(formatCounter(0)).toEqual({ value: '0', unit: 'Bytes' });
    expect(formatCounter(1)).toEqual({ value: '1', unit: 'Byte' });
    expect(formatCounter(1536)).toEqual({ value: '1,50', unit: 'KB' });
    expect(formatCounter(412.38 * 1024 ** 3)).toEqual({ value: '412,38', unit: 'GB' });
    expect(formatCounter(1023.999 * 1024 ** 2).unit).toBe('GB');
    expect(decimalMark()).toBe(',');
  });

  it('pluralises German labels', () => {
    expect(plural(1, t.files)).toBe('1 Datei');
    expect(plural(1234, t.files)).toBe('1.234 Dateien');
    expect(plural(3, t.map.smaller)).toBe('3 kleinere Einträge');
  });

  it('names folders without a name', () => {
    const tree = treeFromFiles([]);
    expect(displayName(tree, tree.root)).toBe('Ausgewählter Ordner');
  });
});

describe('UI formatting in English', () => {
  beforeEach(() => setLanguage('en', ['en-US']));

  it('counts with two decimals in Explorer units', () => {
    expect(formatCounter(0)).toEqual({ value: '0', unit: 'bytes' });
    expect(formatCounter(1)).toEqual({ value: '1', unit: 'byte' });
    expect(formatCounter(1536)).toEqual({ value: '1.50', unit: 'KB' });
    expect(formatCounter(412.38 * 1024 ** 3)).toEqual({ value: '412.38', unit: 'GB' });
    expect(decimalMark()).toBe('.');
  });

  it('follows an English locale that writes a decimal comma', () => {
    setLanguage('en', ['en-ZA']);
    expect(formatCounter(1536)).toEqual({ value: '1,50', unit: 'KB' });
    expect(decimalMark()).toBe(',');
  });

  it('pluralises English labels', () => {
    expect(plural(1, t.files)).toBe('1 file');
    expect(plural(0, t.files)).toBe('0 files');
    expect(plural(1234, t.files)).toBe('1,234 files');
    expect(plural(1, t.results.crumbsMore)).toBe('1 more folder');
  });

  it('names folders without a name', () => {
    const tree = treeFromFiles([]);
    expect(displayName(tree, tree.root)).toBe('Selected folder');
  });
});

describe('clock, paths and file names', () => {
  it('shows elapsed time as a clock', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(4200)).toBe('0:04');
    expect(formatClock(754_000)).toBe('12:34');
    expect(formatClock(3_723_000)).toBe('1:02:03');
  });

  it('splits paths for middle truncation and makes safe file names', () => {
    expect(splitPath('A\\B\\c.txt')).toEqual(['A\\B\\', 'c.txt']);
    expect(splitPath('Laufwerk')).toEqual(['', 'Laufwerk']);
    expect(safeFilename('Bilder: 2024/Mai?')).toBe('Bilder- 2024-Mai');
    expect(safeFilename('...')).toBe('folder');
    expect(safeFilename('...', 'ordner')).toBe('ordner');
  });
});

describe('paths in the tree', () => {
  const tree = createDemoTree(Date.UTC(2026, 10, 3));
  const biggest = topFiles(tree, tree.root, 1)[0];

  it('builds display paths from any ancestor', () => {
    const full = displayPath(tree, biggest);
    expect(full.startsWith(displayName(tree, tree.root))).toBe(true);
    expect(full.endsWith(tree.name(biggest))).toBe(true);
    const parent = tree.parent(biggest);
    expect(displayPath(tree, biggest, parent)).toBe([tree.name(parent), tree.name(biggest)].join(PATH_SEP));
  });

  it('names the folder below the current one', () => {
    const parent = tree.parent(biggest);
    expect(folderBelow(tree, biggest, parent)).toBe('');
    expect(folderBelow(tree, biggest, tree.root)).toBe(displayPath(tree, parent, tree.ancestors(biggest)[1]));
  });
});

describe('age insight', () => {
  const bucket = (fromDays: number | null, size: number): AgeBucket => ({ id: fromDays === null ? 'unknown' : 'over5y', fromDays, toDays: null, count: 1, size });
  const fresh: AgeBucket = { id: 'last30d', fromDays: 0, toDays: 30, count: 1, size: 90 };

  it('prefers the two-year statement when it is substantial', () => {
    setLanguage('de', ['de-DE']);
    expect(ageInsight([bucket(0, 60), bucket(730, 40)]).text).toBe('40 % der Daten wurden seit über 2 Jahren nicht verändert.');
    setLanguage('en', ['en-US']);
    expect(ageInsight([bucket(0, 60), bucket(730, 40)]).text).toBe("40% of the data hasn't changed in over 2 years.");
  });

  it('falls back to one year, then to fresh data', () => {
    setLanguage('de', ['de-DE']);
    expect(ageInsight([bucket(0, 70), bucket(365, 30)]).text).toBe('30 % der Daten wurden seit über einem Jahr nicht verändert.');
    expect(ageInsight([fresh, bucket(365, 10)]).text).toBe('Die Daten sind frisch: 90 % wurden in den letzten 6 Monaten geändert.');
    setLanguage('en', ['en-US']);
    expect(ageInsight([bucket(0, 70), bucket(365, 30)]).text).toBe("30% of the data hasn't changed in over a year.");
    expect(ageInsight([fresh, bucket(365, 10)]).text).toBe('The data is fresh: 90% was changed in the last 6 months.');
  });

  it('handles files without dates and real buckets', () => {
    expect(ageInsight([bucket(null, 100)]).bytes).toBe(0);
    const tree = createDemoTree(Date.UTC(2026, 10, 3));
    expect(ageInsight(ageStats(tree, tree.root, Date.UTC(2026, 10, 3))).text).toMatch(/%/);
  });
});
