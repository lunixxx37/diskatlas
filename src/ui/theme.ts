import { h, setText, uniqueId } from './dom';
import { t } from './i18n';
import { icon, type IconName } from './icons';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key. public/theme-init.js reads the same key before the first paint. */
export const THEME_STORAGE_KEY = 'diskatlas:theme';

const PAPER: Record<ResolvedTheme, string> = { light: '#f3f0e8', dark: '#101417' };

function readStored(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function writeStored(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the choice then lasts for this visit.
  }
}

/**
 * Follows the system colour scheme by default; a manual choice is stored and written
 * to <html data-theme>. Fires "change" whenever the resolved theme may have changed,
 * so canvas drawings can re-read their colours.
 */
export class ThemeManager extends EventTarget {
  private current: ThemeChoice = readStored();
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    super();
    this.apply();
    this.media.addEventListener('change', () => {
      if (this.current === 'system') this.apply();
    });
  }

  get choice(): ThemeChoice {
    return this.current;
  }

  get resolved(): ResolvedTheme {
    if (this.current !== 'system') return this.current;
    return this.media.matches ? 'dark' : 'light';
  }

  set(choice: ThemeChoice): void {
    if (choice === this.current) return;
    this.current = choice;
    writeStored(choice);
    this.apply();
  }

  private apply(): void {
    const root = document.documentElement;
    if (this.current === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', this.current);
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = PAPER[this.resolved];
    this.dispatchEvent(new Event('change'));
  }
}

const OPTIONS: Array<[ThemeChoice, IconName]> = [
  ['system', 'monitor'],
  ['light', 'sun'],
  ['dark', 'moon'],
];

/** Segmented control (a native radio group) for System / Light / Dark. */
export class ThemeSwitch {
  readonly el: HTMLFieldSetElement;
  private readonly legend: HTMLLegendElement;
  private readonly options: Array<{ value: ThemeChoice; input: HTMLInputElement; label: HTMLLabelElement; text: HTMLElement }> = [];

  constructor(theme: ThemeManager) {
    const name = uniqueId('theme');
    this.legend = h('legend', { class: 'sr-only' });
    this.el = h('fieldset', { class: 'seg-switch theme-switch' }, this.legend);
    for (const [value, iconName] of OPTIONS) {
      const input = h('input', { type: 'radio', name, value });
      input.checked = theme.choice === value;
      input.addEventListener('change', () => {
        if (input.checked) theme.set(value);
      });
      const text = h('span', { class: 'theme-switch__text' });
      const label = h('label', null, input, icon(iconName), text);
      this.options.push({ value, input, label, text });
      this.el.append(label);
    }
    theme.addEventListener('change', () => {
      for (const option of this.options) option.input.checked = option.value === theme.choice;
    });
    this.relabel();
  }

  /** Writes the labels in the active language. */
  relabel(): void {
    setText(this.legend, t.theme.legend);
    for (const { value, label, text } of this.options) {
      const name = t.theme[value];
      setText(text, name);
      label.title = t.theme.option(name);
    }
  }
}
