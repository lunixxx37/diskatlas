import { clear, h, type Child } from './dom';

/**
 * One floating tooltip for the whole page (pointer hover on map regions and chart
 * marks). It only enhances: every value it shows is also in a table or label.
 */
class Tooltip {
  private el: HTMLElement | null = null;
  private key: unknown = null;

  private ensure(): HTMLElement {
    if (!this.el) {
      this.el = h('div', { class: 'tooltip', 'aria-hidden': 'true' });
      document.body.append(this.el);
    }
    return this.el;
  }

  /** Shows content near the viewport point (x, y). `key` avoids rebuilding the same content on every move. */
  show(key: unknown, build: () => Child[], x: number, y: number): void {
    const el = this.ensure();
    if (key !== this.key) {
      clear(el);
      for (const child of build()) if (child !== null && child !== undefined && child !== false) el.append(child as Node | string);
      this.key = key;
    }
    el.classList.add('is-visible');
    const pad = 14;
    const rect = el.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    if (left + rect.width > window.innerWidth - 8) left = Math.max(8, x - pad - rect.width);
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - pad - rect.height);
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  hide(): void {
    if (!this.el) return;
    this.el.classList.remove('is-visible');
    this.key = null;
  }
}

export const tooltip = new Tooltip();

/** Standard tooltip body: value first (strong), then the name, then quieter details. */
export function tooltipBody(parts: {
  value: string;
  share?: string;
  title: string;
  meta?: string;
  key?: string;
  path?: string;
}): Child[] {
  const value = h('div', { class: 'tooltip__value' }, parts.value, parts.share ? h('small', { text: parts.share }) : null);
  const meta = parts.meta
    ? h('div', { class: 'tooltip__meta' }, parts.key ? h('span', { class: 'tooltip__key', style: { '--key': parts.key } }) : null, parts.meta)
    : null;
  return [value, h('div', { class: 'tooltip__title', text: parts.title }), meta, parts.path ? h('div', { class: 'tooltip__path', text: parts.path }) : null];
}
