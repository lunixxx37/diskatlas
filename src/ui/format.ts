import { PATH_SEP, byteUnit, formatCount, formatLocale, type ScanTree } from '../core';
import { t } from './i18n';

// UI-side formatting on top of the core's formatters (same locale as they use).

const UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'];
let twoDigitsLocale = '';
let twoDigits: Intl.NumberFormat;
let mark = '.';

/** Two-decimal number format and decimal mark of the active locale, rebuilt when it changes. */
function twoDigitFormat(): Intl.NumberFormat {
  const locale = formatLocale();
  if (locale !== twoDigitsLocale) {
    twoDigitsLocale = locale;
    twoDigits = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    mark = twoDigits.formatToParts(1.5).find((part) => part.type === 'decimal')?.value ?? '.';
  }
  return twoDigits;
}

/**
 * The live size counter: same 1024-based units as `formatBytes` (Explorer style), but
 * always two decimals, so the number visibly counts while a scan runs.
 */
export function formatCounter(bytes: number): { value: string; unit: string } {
  if (bytes < 1000) return { value: formatCount(Math.round(bytes)), unit: byteUnit(Math.round(bytes)) };
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 999.995 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return { value: twoDigitFormat().format(value), unit: UNITS[unit] };
}

/** The decimal mark of the active locale: "," in German, "." in US English. */
export function decimalMark(): string {
  twoDigitFormat();
  return mark;
}

/** Elapsed time as a clock: 0:04, 12:30, 1:02:03. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** The scanned folder can come without a name (e.g. the browser's private file system). */
export function displayName(tree: ScanTree, i: number): string {
  const name = tree.name(i);
  if (name) return name;
  return i === tree.root ? t.app.selectedFolder : t.app.noName;
}

/** Path from `from` (included) down to `i`, as shown to the user. */
export function displayPath(tree: ScanTree, i: number, from = tree.root): string {
  const parts: string[] = [];
  for (let p = i; p >= 0; p = tree.parent(p)) {
    parts.push(displayName(tree, p));
    if (p === from) break;
  }
  return parts.reverse().join(PATH_SEP);
}

/**
 * The folder that holds `i`, relative to `base` (excluded): "" when `i` sits directly
 * in `base`.
 */
export function folderBelow(tree: ScanTree, i: number, base: number): string {
  const parts: string[] = [];
  for (let p = tree.parent(i); p >= 0 && p !== base; p = tree.parent(p)) parts.push(displayName(tree, p));
  return parts.reverse().join(PATH_SEP);
}

/** Splits a path for middle truncation: everything up to the last separator, and the last segment. */
export function splitPath(path: string): [head: string, tail: string] {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  if (cut <= 0) return ['', path];
  return [path.slice(0, cut + 1), path.slice(cut + 1)];
}

/** A file name that Windows, macOS and Linux all accept; `fallback` when nothing usable is left. */
export function safeFilename(name: string, fallback = 'folder'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/** "–" for an empty value, so table cells never collapse. */
export const dash = '–';
