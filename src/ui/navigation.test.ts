import { describe, expect, it } from 'vitest';
import { Navigation, readNavState, type HistoryLike } from './navigation';

/** A browser history in memory: entries, the current index, and popstate as a callback. */
function fakeHistory(initial: unknown = null) {
  const entries: unknown[] = [initial];
  let index = 0;
  const pops: unknown[] = [];
  const history: HistoryLike = {
    get state() {
      return entries[index];
    },
    pushState(data) {
      entries.splice(index + 1);
      entries.push(structuredClone(data));
      index++;
    },
    replaceState(data) {
      entries[index] = structuredClone(data);
    },
    back() {
      if (index > 0) {
        index--;
        pops.push(entries[index]);
      }
    },
  };
  return {
    history,
    forward() {
      if (index < entries.length - 1) {
        index++;
        pops.push(entries[index]);
      }
    },
    get entries() {
      return entries.map((e) => {
        const v = e as { view?: string; id?: number } | null;
        return v && typeof v === 'object' && v.view ? `${v.view}${v.id || ''}` : String(e);
      });
    },
    get index() {
      return index;
    },
    pops,
  };
}

describe('history and the start page', () => {
  it('makes the first entry the start page and adds one entry for a survey and its result', () => {
    const h = fakeHistory({ some: 'old state' });
    const nav = new Navigation(h.history);
    h.history.scrollRestoration = 'auto';
    nav.start();
    expect(nav.current).toEqual({ app: 'diskatlas', view: 'start', id: 0, fromStart: false });
    // The app scrolls itself: the start page opens at the top.
    expect(h.history.scrollRestoration).toBe('manual');
    nav.enter(1);
    expect(h.entries).toEqual(['start', 'result1']);
    expect(nav.current).toEqual({ app: 'diskatlas', view: 'result', id: 1, fromStart: true });
  });

  it('lets a new survey from the results replace their entry, so Back still leads to the start page', () => {
    const h = fakeHistory();
    const nav = new Navigation(h.history);
    nav.start();
    nav.enter(1);
    nav.enter(2);
    expect(h.entries).toEqual(['start', 'result2']);
    expect(nav.current?.fromStart).toBe(true);
  });

  it('goes home by going back, so Forward returns to the result', () => {
    const h = fakeHistory();
    const nav = new Navigation(h.history);
    nav.start();
    nav.enter(3);
    expect(nav.home()).toBe('back');
    expect(h.pops.map(readNavState)).toEqual([{ app: 'diskatlas', view: 'start', id: 0, fromStart: false }]);
    h.forward();
    expect(readNavState(h.pops.at(-1))).toEqual({ app: 'diskatlas', view: 'result', id: 3, fromStart: true });
  });

  it('does nothing on the start page itself', () => {
    const h = fakeHistory();
    const nav = new Navigation(h.history);
    nav.start();
    expect(nav.home()).toBe('here');
    expect(h.entries).toEqual(['start']);
    expect(h.pops).toEqual([]);
  });

  it('never goes back into another page: without our start entry before, it adds one', () => {
    const h = fakeHistory({ app: 'diskatlas', view: 'result', id: 5, fromStart: false });
    const nav = new Navigation(h.history);
    expect(nav.home()).toBe('pushed');
    expect(h.entries).toEqual(['result5', 'start']);
    expect(h.pops).toEqual([]);
  });

  it('opens the last result again from the start page in a new entry, and forgets dead ones', () => {
    const h = fakeHistory();
    const nav = new Navigation(h.history);
    nav.start();
    nav.enter(4);
    nav.home();
    // "Open result" on the start page, after Back.
    nav.enter(4);
    expect(h.entries).toEqual(['start', 'result4']);
    nav.forget();
    expect(h.entries).toEqual(['start', 'start']);
  });

  it('reads only its own states', () => {
    expect(readNavState(null)).toBeNull();
    expect(readNavState({ view: 'start' })).toBeNull();
    expect(readNavState({ app: 'diskatlas', view: 'elsewhere' })).toBeNull();
    expect(readNavState({ app: 'diskatlas', view: 'result', id: 'x' })).toEqual({ app: 'diskatlas', view: 'result', id: 0, fromStart: false });
  });
});
