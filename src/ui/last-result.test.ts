import { afterAll, describe, expect, it } from 'vitest';
import { setLanguage } from './i18n';
import { lastResultLine, relativeTime, type LastResultInfo } from './last-result';

afterAll(() => setLanguage('en', ['en-US']));

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const MIN = 60_000;
const info = (extra: Partial<LastResultInfo> = {}): LastResultInfo => ({ name: 'C:', bytes: 358 * 1024 ** 3, at: NOW - 5 * MIN, complete: true, demo: false, ...extra });

describe('the last-result card', () => {
  it('says how long ago, in English', () => {
    setLanguage('en', ['en-US']);
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 50_000, NOW)).toBe('1 minute ago');
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe('5 minutes ago');
    expect(relativeTime(NOW - 2 * 60 * MIN, NOW)).toBe('2 hours ago');
    expect(relativeTime(NOW - 26 * 60 * MIN, NOW)).toBe('yesterday');
    // A clock that went back never says "in 5 minutes".
    expect(relativeTime(NOW + 5 * MIN, NOW)).toBe('just now');
  });

  it('says how long ago, in German', () => {
    setLanguage('de', ['de-DE']);
    expect(relativeTime(NOW - 10_000, NOW)).toBe('gerade eben');
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe('vor 5 Minuten');
    expect(relativeTime(NOW - 3 * 60 * MIN, NOW)).toBe('vor 3 Stunden');
    expect(relativeTime(NOW - 26 * 60 * MIN, NOW)).toBe('gestern');
  });

  it('names the result with its size and notes an incomplete survey or example data', () => {
    setLanguage('en', ['en-US']);
    expect(lastResultLine(info(), NOW)).toEqual({ name: 'C:', size: '358 GB', when: '5 minutes ago', notes: [] });
    expect(lastResultLine(info({ complete: false }), NOW).notes).toEqual(['incomplete']);
    setLanguage('de', ['de-DE']);
    expect(lastResultLine(info({ name: 'Beispiel-Laufwerk', demo: true, bytes: 1536 }), NOW)).toEqual({ name: 'Beispiel-Laufwerk', size: '1,50 KB', when: 'vor 5 Minuten', notes: ['Beispieldaten'] });
  });
});
