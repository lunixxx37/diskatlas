import { formatBytes } from '../core';
import { h, setText } from './dom';
import { lang, t, type Lang } from './i18n';
import { icon } from './icons';

// The start page's card for the result still in memory: "Last survey: C: · 358 GB ·
// 5 minutes ago" with "Open result". Nothing is lost by going back to the start page.

export interface LastResultInfo {
  /** The surveyed folder or drive, as the results name it. */
  name: string;
  bytes: number;
  /** When the survey finished (or was stopped). */
  at: number;
  /** false: the survey was cancelled, so the numbers are incomplete. */
  complete: boolean;
  demo: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "2 hours ago", "yesterday" (or the German forms). */
export function relativeTime(at: number, now: number, language: Lang = lang()): string {
  const ago = Math.max(0, now - at);
  if (ago < 45_000) return t.start.last.justNow;
  const format = new Intl.RelativeTimeFormat(language === 'de' ? 'de-DE' : 'en', { numeric: 'auto' });
  if (ago < HOUR) return format.format(-Math.max(1, Math.round(ago / MINUTE)), 'minute');
  if (ago < DAY) return format.format(-Math.round(ago / HOUR), 'hour');
  return format.format(-Math.round(ago / DAY), 'day');
}

/** The card's parts: name, size, how long ago, and notes such as "incomplete". */
export function lastResultLine(info: LastResultInfo, now: number, language: Lang = lang()): { name: string; size: string; when: string; notes: string[] } {
  const notes: string[] = [];
  if (!info.complete) notes.push(t.start.last.incomplete);
  if (info.demo) notes.push(t.start.last.demo);
  return { name: info.name, size: formatBytes(info.bytes), when: relativeTime(info.at, now, language), notes };
}

/** The card itself; it keeps "… minutes ago" current while it is shown. */
export class LastResultCard {
  readonly el: HTMLElement;
  private readonly name: HTMLElement;
  private readonly size: HTMLElement;
  private readonly when: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly timer: number;

  constructor(
    private info: LastResultInfo,
    onOpen: () => void,
  ) {
    this.name = h('strong', { class: 'last__name' });
    this.size = h('span', { class: 'last__size num' });
    this.when = h('span', { class: 'last__when' });
    this.notes = h('span', { class: 'last__notes' });
    const open = h('button', { class: 'btn btn--primary btn--sm last__open', type: 'button' }, t.start.last.open, icon('arrowRight'));
    open.addEventListener('click', onOpen);
    this.el = h(
      'section',
      { class: 'last', 'aria-label': t.start.last.title },
      icon('map', 'last__icon'),
      h(
        'p',
        { class: 'last__text' },
        h('span', { class: 'last__title', text: `${t.start.last.title}:` }),
        ' ',
        this.name,
        h('span', { class: 'last__sep', 'aria-hidden': 'true', text: ' · ' }),
        this.size,
        h('span', { class: 'last__sep', 'aria-hidden': 'true', text: ' · ' }),
        this.when,
        this.notes,
      ),
      open,
    );
    this.render();
    this.timer = window.setInterval(() => this.render(), 30_000);
  }

  update(info: LastResultInfo): void {
    this.info = info;
    this.render();
  }

  destroy(): void {
    window.clearInterval(this.timer);
  }

  private render(): void {
    const line = lastResultLine(this.info, Date.now());
    setText(this.name, line.name);
    setText(this.size, line.size);
    setText(this.when, line.when);
    // A space before each note, so it is read as its own word.
    this.notes.replaceChildren(...line.notes.flatMap((n) => [' ', h('span', { class: 'chip', text: n })]));
  }
}
