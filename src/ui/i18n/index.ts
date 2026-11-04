import { formatCount, setFormatLocale } from '../../core';
import { de } from './de';
import { en, type Messages } from './en';
import type { Plural } from './types';

export type { Messages } from './en';
export type { Plural, Rich } from './types';

// The interface language: English or German. The first visit follows the browser's
// language list; a choice made with the switch is stored and wins from then on.

export type Lang = 'en' | 'de';

export const LANGS: readonly Lang[] = ['en', 'de'];

/** localStorage key. public/theme-init.js reads it too, to set <html lang> before the first paint. */
export const LANG_STORAGE_KEY = 'diskatlas:lang';

const CATALOGS: Record<Lang, Messages> = { en, de };

/** Messages in the active language. A live binding: importers always see the current catalog. */
export let t: Messages = en;

let active: Lang = 'en';
let rules = new Intl.PluralRules('en');

export function lang(): Lang {
  return active;
}

export function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'de';
}

/** The visitor's languages, most preferred first. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

const primaryTag = (tag: string) => tag.toLowerCase().split(/[-_]/)[0];

/** The first of `languages` whose primary subtag is "en" or "de"; English when there is none. */
export function detectLanguage(languages: readonly string[] = browserLanguages()): Lang {
  for (const tag of languages) {
    const primary = primaryTag(tag);
    if (isLang(primary)) return primary;
  }
  return 'en';
}

/**
 * Locale for numbers and dates. German always uses de-DE. English uses the visitor's own
 * English locale when the browser names one with a region (en-GB writes "3 Nov 2026",
 * en-US "Nov 3, 2026"), and en-US otherwise.
 */
export function formatLocaleFor(language: Lang, languages: readonly string[] = browserLanguages()): string {
  if (language === 'de') return 'de-DE';
  for (const tag of languages) {
    if (primaryTag(tag) !== 'en' || !/[-_]/.test(tag)) continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(tag.replace(/_/g, '-'));
      if (canonical && Intl.NumberFormat.supportedLocalesOf(canonical).length > 0) return canonical;
    } catch {
      // Not a valid language tag: try the next one.
    }
  }
  return 'en-US';
}

/** The language picked with the switch on an earlier visit, if any. */
export function storedLanguage(): Lang | null {
  try {
    const value = localStorage.getItem(LANG_STORAGE_KEY);
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeLanguage(language: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, language);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the choice then lasts for this visit.
  }
}

/** Switches the messages, plural rules, number and date formats, and <html lang>. */
export function setLanguage(language: Lang, languages: readonly string[] = browserLanguages()): void {
  active = language;
  t = CATALOGS[language];
  rules = new Intl.PluralRules(language);
  setFormatLocale(formatLocaleFor(language, languages));
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

/** "1 file", "1,234 files": the form the active language's plural rules pick, "#" replaced by the number. */
export function plural(n: number, forms: Plural): string {
  return (rules.select(n) === 'one' ? forms.one : forms.other).replace('#', formatCount(n));
}
