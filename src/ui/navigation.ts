// The browser history of the app: the start page, and one entry for a survey and its
// result. Back goes from a result (or a running survey) to the start page, Forward goes
// back to the result, which stays in memory. A reload always starts on the start page.

/** One of our history entries. `id` names the result; `fromStart`: the entry before is our start page. */
export interface NavState {
  app: 'diskatlas';
  view: 'start' | 'result';
  id: number;
  fromStart: boolean;
}

/** The parts of `window.history` this needs (so tests can pass their own). */
export interface HistoryLike {
  readonly state: unknown;
  /** 'manual': the app scrolls itself (the start page opens at the top, not where it was left). */
  scrollRestoration?: 'auto' | 'manual';
  pushState(data: unknown, unused: string): void;
  replaceState(data: unknown, unused: string): void;
  back(): void;
}

const START: NavState = { app: 'diskatlas', view: 'start', id: 0, fromStart: false };

/** Our entry state, or null for anything else (an entry of another page, a hand-made state). */
export function readNavState(value: unknown): NavState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<NavState>;
  if (v.app !== 'diskatlas' || (v.view !== 'start' && v.view !== 'result')) return null;
  return { app: 'diskatlas', view: v.view, id: typeof v.id === 'number' ? v.id : 0, fromStart: v.fromStart === true };
}

/** What `home()` did: went back in history (a popstate follows), found the start page already, or added it. */
export type HomeStep = 'back' | 'here' | 'pushed';

export class Navigation {
  constructor(private readonly history: HistoryLike) {}

  get current(): NavState | null {
    return readNavState(this.history.state);
  }

  /** On load: this entry is the start page (a result never survives a reload). */
  start(): void {
    this.history.replaceState({ ...START }, '');
    // The views are rebuilt on Back and Forward; the browser's own scroll restoration would land mid-page.
    if ('scrollRestoration' in this.history) this.history.scrollRestoration = 'manual';
  }

  /**
   * A survey or a result with `id` is shown: a new entry after the start page, or the
   * current result's entry reused (a new survey replaces the result it was started from).
   */
  enter(id: number): void {
    const current = this.current;
    if (!current || current.view === 'start') this.history.pushState({ app: 'diskatlas', view: 'result', id, fromStart: current !== null }, '');
    else this.history.replaceState({ ...current, id }, '');
  }

  /**
   * To the start page: back in history when the entry before is our start page, so Forward
   * returns to the result. 'here' when the start page is shown already.
   */
  home(): HomeStep {
    const current = this.current;
    if (!current || current.view === 'start') return 'here';
    if (current.fromStart) {
      this.history.back();
      return 'back';
    }
    this.history.pushState({ ...START }, '');
    return 'pushed';
  }

  /** An entry whose result is gone (a newer one replaced it): it becomes a start page. */
  forget(): void {
    this.history.replaceState({ ...START }, '');
  }
}
