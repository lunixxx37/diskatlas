import { byteUnit, formatBytes, formatCount, type ScanProgress } from '../core';
import { h, reducedMotion, setText } from './dom';
import { decimalMark, formatClock, formatCounter, splitPath } from './format';
import { plural, t } from './i18n';
import { icon } from './icons';

export interface ScanViewOptions {
  name: string;
  /** 'files': the browser handed over a file list (fallback input); there is no live progress. */
  mode: 'scan' | 'files';
  onCancel?: () => void;
  /** Where an earlier view of the same scan stood (the language changed mid-scan). */
  resume?: ScanViewState;
}

/** What a scan view shows, so another one can carry on from there. */
export interface ScanViewState {
  progress: ScanProgress | null;
  totals: { files: number; bytes: number } | null;
  cancelling: boolean;
}

const SWEEP_MS = 2600; // one pass across the survey field; keep in sync with scan.css
const MAX_MARKS = 70;

/**
 * The scan in progress: a large live size counter, field-book counters, the folder
 * being read, and an indeterminate "survey field" (a sweep that finds points). The
 * total is unknown in advance, so nothing here pretends to be a percentage.
 */
export class ScanView {
  readonly el: HTMLElement;
  private readonly value: HTMLElement;
  private readonly whole: HTMLElement;
  private readonly sep: HTMLElement;
  private readonly fraction: HTMLElement;
  private readonly unit: HTMLElement;
  private readonly files: HTMLElement;
  private readonly dirs: HTMLElement;
  private readonly errors: HTMLElement;
  private readonly errorsCell: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly pathHead: HTMLElement;
  private readonly pathTail: HTMLElement;
  private readonly marks: HTMLElement;
  private readonly live: HTMLElement;
  private readonly t0 = performance.now();
  private target = 0;
  private shown = 0;
  private frame = 0;
  private lastDirs = 0;
  private lastFiles = 0;
  private lastAnnounce = 0;
  private progress: ScanProgress | null = null;
  private totals: { files: number; bytes: number } | null = null;
  private cancelling = false;
  private readonly calm = reducedMotion();

  constructor(options: ScanViewOptions) {
    // Whole part, decimal mark and decimals apart: the mark sits closer than a full mono cell.
    this.whole = h('span', { text: '0' });
    this.sep = h('span', { class: 'counter__sep' });
    this.fraction = h('span');
    this.value = h('span', { class: 'counter__value num' }, this.whole, this.sep, this.fraction);
    this.unit = h('span', { class: 'counter__unit', text: byteUnit(0) });
    this.files = h('span', { class: 'stat__value num', text: '0' });
    this.dirs = h('span', { class: 'stat__value num', text: '0' });
    this.errors = h('span', { class: 'stat__value num', text: '0' });
    this.clock = h('span', { class: 'stat__value num', text: '0:00' });
    this.errorsCell = h('div', { class: 'stat stat--warn', hidden: true }, h('span', { class: 'label', text: t.scan.unreadable }), this.errors);
    this.pathHead = h('span', { class: 'mtrunc__head' });
    this.pathTail = h('span', { class: 'mtrunc__tail', text: options.name });
    this.marks = h('div', { class: 'survey__marks' });
    this.live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });

    const reading = options.mode === 'files' ? t.scan.readingList : t.scan.surveying;
    const actions = h('div', { class: 'scan__actions' });
    if (options.onCancel) {
      const cancel = h('button', { class: 'btn btn--secondary', type: 'button' }, icon('close'), t.scan.cancel);
      const stopping = () => {
        this.cancelling = true;
        cancel.disabled = true;
        setText(cancel.lastChild!, t.scan.stopping);
      };
      cancel.addEventListener('click', () => {
        stopping();
        options.onCancel!();
      });
      if (options.resume?.cancelling) stopping();
      actions.append(cancel, h('p', { class: 'scan__hint', text: t.scan.cancelHint }));
    }

    this.el = h(
      'main',
      { class: 'view view--scan', id: 'main', 'aria-busy': 'true' },
      h(
        'section',
        { class: 'scan', 'aria-labelledby': 'scan-title' },
        h(
          'header',
          { class: 'scan__head' },
          h('p', { class: 'eyebrow eyebrow--live' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), reading),
          h('h1', { class: 'scan__name', id: 'scan-title', tabindex: '-1', text: options.name }),
        ),
        h(
          'div',
          { class: 'counter', 'aria-hidden': 'true' },
          this.value,
          this.unit,
          h('span', { class: 'counter__caption', text: t.scan.foundSoFar }),
        ),
        h(
          'div',
          { class: 'survey', 'aria-hidden': 'true', 'data-calm': this.calm ? 'true' : 'false' },
          h('div', { class: 'survey__grid' }),
          this.marks,
          h('div', { class: 'survey__sweep' }),
          h('span', { class: 'survey__scale survey__scale--start', text: '0' }),
          h('span', { class: 'survey__scale survey__scale--end', text: t.scan.endUnknown }),
        ),
        h(
          'div',
          { class: 'scan__stats' },
          h('div', { class: 'stat' }, h('span', { class: 'label', text: t.scan.files }), this.files),
          h('div', { class: 'stat' }, h('span', { class: 'label', text: t.scan.folders }), this.dirs),
          this.errorsCell,
          h('div', { class: 'stat' }, h('span', { class: 'label', text: t.scan.elapsed }), this.clock),
        ),
        h(
          'div',
          { class: 'scan__path' },
          h('span', { class: 'label', text: t.scan.nowReading }),
          h('span', { class: 'mtrunc mono', title: options.name }, this.pathHead, this.pathTail),
        ),
        actions,
        this.live,
      ),
    );

    const resume = options.resume;
    if (resume?.totals) this.showTotals(resume.totals.files, resume.totals.bytes);
    if (resume?.progress) {
      this.update(resume.progress, false);
      this.lastAnnounce = performance.now();
    }
    // Carry on from the number shown before, instead of counting up from zero again.
    if (resume) this.shown = this.target;
    this.frame = requestAnimationFrame(this.tick);
  }

  /** The state to hand to a view that replaces this one. */
  get state(): ScanViewState {
    return { progress: this.progress, totals: this.totals, cancelling: this.cancelling };
  }

  update(progress: ScanProgress, marks = true): void {
    this.progress = progress;
    this.target = progress.bytes;
    setText(this.files, formatCount(progress.files));
    setText(this.dirs, formatCount(progress.dirs));
    setText(this.clock, formatClock(progress.elapsedMs));
    if (progress.errors > 0) {
      this.errorsCell.hidden = false;
      setText(this.errors, formatCount(progress.errors));
    }
    const [head, tail] = splitPath(progress.currentPath);
    setText(this.pathHead, head);
    setText(this.pathTail, tail);
    (this.pathHead.parentElement as HTMLElement).title = progress.currentPath;

    const found = progress.dirs - this.lastDirs + Math.floor((progress.files - this.lastFiles) / 400);
    this.lastDirs = progress.dirs;
    this.lastFiles = progress.files;
    if (marks) this.addMarks(Math.min(4, found));

    const now = performance.now();
    if (now - this.lastAnnounce > 6000) {
      this.lastAnnounce = now;
      this.live.textContent = t.scan.announce(formatBytes(progress.bytes), plural(progress.files, t.files));
    }
  }

  /** For the fallback file list: show what was handed over while the tree is built. */
  showTotals(files: number, bytes: number): void {
    this.totals = { files, bytes };
    this.target = bytes;
    setText(this.files, formatCount(files));
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
  }

  private readonly tick = (): void => {
    // Ease the shown value towards the latest reading, so the counter counts instead of jumping.
    const diff = this.target - this.shown;
    this.shown = Math.abs(diff) < 1 ? this.target : this.shown + diff * (this.calm ? 1 : 0.18);
    const { value, unit } = formatCounter(this.shown);
    const mark = decimalMark();
    const at = value.indexOf(mark);
    setText(this.whole, at < 0 ? value : value.slice(0, at));
    setText(this.sep, at < 0 ? '' : mark);
    setText(this.fraction, at < 0 ? '' : value.slice(at + mark.length));
    setText(this.unit, unit);
    this.frame = requestAnimationFrame(this.tick);
  };

  /** Survey points appear just behind the sweep line: one per newly found folder (capped). */
  private addMarks(count: number): void {
    if (count <= 0) return;
    const elapsed = performance.now() - this.t0;
    const phase = (elapsed % (2 * SWEEP_MS)) / SWEEP_MS;
    const sweep = phase < 1 ? phase : 2 - phase;
    const direction = phase < 1 ? -1 : 1;
    for (let k = 0; k < count; k++) {
      const x = this.calm ? Math.random() : Math.min(0.99, Math.max(0.01, sweep + direction * Math.random() * 0.06));
      const y = 0.1 + Math.random() * 0.8;
      const mark = h('span', { class: 'survey__mark', style: { left: `${(x * 100).toFixed(2)}%`, top: `${(y * 100).toFixed(2)}%` } });
      mark.addEventListener('animationend', () => mark.remove());
      this.marks.append(mark);
    }
    while (this.marks.childElementCount > MAX_MARKS) this.marks.firstElementChild!.remove();
  }
}

export interface NoticeOptions {
  title: string;
  message: string;
  detail?: string;
  primary?: { label: string; action: () => void };
  secondary?: { label: string; action: () => void };
}

/** A full-view notice, used for scan errors. */
export function noticeView(options: NoticeOptions): { el: HTMLElement; destroy(): void } {
  const buttons = h('div', { class: 'notice__actions' });
  if (options.primary) {
    const b = h('button', { class: 'btn btn--primary', type: 'button' }, icon('refresh'), options.primary.label);
    b.addEventListener('click', options.primary.action);
    buttons.append(b);
  }
  if (options.secondary) {
    const b = h('button', { class: 'btn btn--secondary', type: 'button' }, icon('folderOpen'), options.secondary.label);
    b.addEventListener('click', options.secondary.action);
    buttons.append(b);
  }
  const el = h(
    'main',
    { class: 'view view--notice', id: 'main' },
    h(
      'section',
      { class: 'notice', role: 'alert' },
      icon('alert', 'notice__icon'),
      h('h1', { class: 'notice__title', tabindex: '-1', text: options.title }),
      h('p', { class: 'notice__message', text: options.message }),
      options.detail ? h('p', { class: 'notice__detail mono', text: options.detail }) : null,
      buttons,
    ),
  );
  return { el, destroy: () => undefined };
}
