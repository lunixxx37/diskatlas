import { afterAll, describe, expect, it } from 'vitest';
import { CATEGORIES, formatDate, formatLocale } from '../../core';
import { de } from './de';
import { en } from './en';
import { detectLanguage, formatLocaleFor, lang, setLanguage, t } from './index';

afterAll(() => setLanguage('en', ['en-US']));

describe('language on the first visit', () => {
  it('takes the first English or German entry of the browser languages', () => {
    expect(detectLanguage(['fr-FR', 'de-AT', 'en-US'])).toBe('de');
    expect(detectLanguage(['en-GB', 'de-DE'])).toBe('en');
    expect(detectLanguage(['DE_ch'])).toBe('de');
  });

  it('falls back to English', () => {
    expect(detectLanguage(['fr-FR', 'es'])).toBe('en');
    expect(detectLanguage([])).toBe('en');
  });
});

describe('number and date locale', () => {
  it('is de-DE for German', () => {
    expect(formatLocaleFor('de', ['de-AT', 'en-GB'])).toBe('de-DE');
  });

  it("is the visitor's own English locale, else en-US", () => {
    expect(formatLocaleFor('en', ['de-DE', 'en-GB'])).toBe('en-GB');
    expect(formatLocaleFor('en', ['en', 'en-AU'])).toBe('en-AU');
    expect(formatLocaleFor('en', ['en_IE'])).toBe('en-IE');
    expect(formatLocaleFor('en', ['en'])).toBe('en-US');
    expect(formatLocaleFor('en', ['de-DE', 'fr-FR'])).toBe('en-US');
    expect(formatLocaleFor('en', ['en-!!'])).toBe('en-US');
  });

  it('switches the core formatters with the language', () => {
    const day = new Date(2026, 10, 3).getTime();
    setLanguage('en', ['en-GB']);
    expect(lang()).toBe('en');
    expect(formatLocale()).toBe('en-GB');
    expect(formatDate(day)).toBe('3 Nov 2026');
    setLanguage('en', ['en-US']);
    expect(formatDate(day)).toBe('Nov 3, 2026');
    setLanguage('de', ['en-US']);
    expect(formatDate(day)).toBe('03.11.2026');
    expect(t.results.export).toBe('Exportieren');
    setLanguage('en', ['en-US']);
    expect(t.results.export).toBe('Export');
  });
});

/** Every string a catalog can produce: plain values and functions called with sample values. */
function strings(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') {
    const args = Array.from({ length: value.length }, (_, k) => `«${k}»`);
    return [[path, String((value as (...a: unknown[]) => unknown)(...args))]];
  }
  if (Array.isArray(value)) return value.flatMap((v, k) => strings(v, `${path}[${k}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

describe('catalogs', () => {
  it('have the same keys and kinds of values', () => {
    const shape = (value: unknown): unknown =>
      typeof value === 'function'
        ? `function/${value.length}`
        : Array.isArray(value)
          ? 'array'
          : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
            : typeof value;
    expect(shape(de)).toEqual(shape(en));
  });

  it('name every category', () => {
    for (const { id } of CATEGORIES) {
      expect(en.categories[id]).toBeTruthy();
      expect(de.categories[id]).toBeTruthy();
    }
  });

  it('keep German out of the English catalog', () => {
    const german = strings(en).filter(([, text]) => /[äöüÄÖÜß„]/.test(text));
    expect(german).toEqual([]);
  });

  it('keep every placeholder in German too', () => {
    for (const [path, text] of strings(en)) {
      const used = text.match(/«\d»/g) ?? [];
      const german = strings(de).find(([p]) => p === path)?.[1] ?? '';
      for (const placeholder of used) expect(german, path).toContain(placeholder);
    }
  });

  it('write CSV the way Excel expects in each language', () => {
    expect(en.csv.separator).toBe(',');
    expect(de.csv.separator).toBe(';');
    expect(en.csv.headers.path).toBe('Path');
    expect(de.csv.headers.path).toBe('Pfad');
  });
});
