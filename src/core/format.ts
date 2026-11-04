/** Path separator for display: backslash on Windows, slash elsewhere. */
export const PATH_SEP =
  typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent) ? '\\' : '/';

// How numbers and dates are written. German by default; the interface switches it with
// its language (`setFormatLocale`). Sizes stay 1024-based in every language.

let locale = 'de-DE';
let german = true;
let fixed: Intl.NumberFormat[] = [];
let integer: Intl.NumberFormat;
let date: Intl.DateTimeFormat;
let dateTime: Intl.DateTimeFormat;

/**
 * Sets the locale for every formatter below, e.g. "de-DE", "en-US" or "en-GB".
 * German writes dates as 03.11.2026; other locales use a month name ("Nov 3, 2026",
 * "3 Nov 2026"), so day and month can never be mixed up.
 */
export function setFormatLocale(tag: string): void {
  locale = tag;
  german = tag.toLowerCase().startsWith('de');
  fixed = [0, 1, 2].map((digits) => new Intl.NumberFormat(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  integer = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
  date = new Intl.DateTimeFormat(tag, german ? { day: '2-digit', month: '2-digit', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });
  dateTime = new Intl.DateTimeFormat(
    tag,
    german
      ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' },
  );
}

setFormatLocale(locale);

/** The locale the formatters use right now. */
export function formatLocale(): string {
  return locale;
}

const UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'];

/** "Byte"/"Bytes" in German, "byte"/"bytes" elsewhere. */
export function byteUnit(count: number): string {
  const one = count === 1;
  return german ? (one ? 'Byte' : 'Bytes') : one ? 'byte' : 'bytes';
}

/**
 * Size with three significant digits in 1024-based units, labelled like Windows Explorer
 * does ("KB", "MB", ...), so numbers can be compared with what Explorer shows.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${integer.format(bytes)} ${byteUnit(bytes)}`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 999.5 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 9.995 ? 2 : value < 99.95 ? 1 : 0;
  return `${fixed[digits].format(value)} ${UNITS[unit]}`;
}

export function formatCount(n: number): string {
  return integer.format(n);
}

/** `fraction` is 0..1. German puts a space before the sign ("12 %"), English does not ("12%"). */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '–';
  const percent = fraction * 100;
  const digits = percent >= 10 || percent === 0 ? 0 : 1;
  return `${fixed[digits].format(percent)}${german ? ' ' : ''}%`;
}

/** 0 means "unknown". */
export function formatDate(ms: number): string {
  return ms > 0 ? date.format(ms) : '–';
}

export function formatDateTime(ms: number): string {
  return ms > 0 ? dateTime.format(ms) : '–';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${integer.format(Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${fixed[1].format(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}
