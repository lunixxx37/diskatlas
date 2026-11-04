import { describe, expect, it } from 'vitest';
import { COMPARE_ROWS } from './helper-compare';
import { de } from './i18n/de';
import { en } from './i18n/en';

describe('the comparison of the browser alone and the helper', () => {
  it('shows every row of the catalog, in its order, in both languages', () => {
    const keys = COMPARE_ROWS.map((r) => r.key);
    expect(keys).toEqual(Object.keys(en.helper.compare.rows));
    expect(keys).toEqual(Object.keys(de.helper.compare.rows));
  });

  it('explains every "no" of the browser where it isn\'t obvious, and words every text-only cell', () => {
    for (const { key, browser, helper } of COMPARE_ROWS) {
      for (const catalog of [en, de]) {
        const row = catalog.helper.compare.rows[key];
        expect(row.what, key).not.toBe('');
        if (browser === 'text') expect(row.browser, key).not.toBe('');
        if (helper === 'text') expect(row.helper, key).not.toBe('');
      }
      // The helper never takes anything away.
      expect(helper === 'no', key).toBe(false);
    }
    expect(en.helper.compare.rows.drives.browser).toMatch(/blocks/);
    expect(de.helper.compare.rows.cleanup.browser).toMatch(/liest nur/);
  });
});
