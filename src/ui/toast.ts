import { h } from './dom';
import { icon, type IconName } from './icons';

let region: HTMLElement | null = null;

function ensureRegion(): HTMLElement {
  if (!region) {
    region = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  return region;
}

/** A short, polite message at the bottom of the screen (also read by screen readers). */
export function toast(message: string, iconName: IconName = 'info', durationMs = 3800): void {
  const host = ensureRegion();
  const el = h('div', { class: 'toast' }, icon(iconName), h('span', { text: message }));
  host.append(el);
  while (host.children.length > 3) host.firstElementChild?.remove();
  window.setTimeout(() => {
    el.classList.add('is-leaving');
    window.setTimeout(() => el.remove(), 200);
  }, durationMs);
}

/** Copies text to the clipboard; falls back to a hidden text area where the async API is missing. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the fallback
  }
  const area = h('textarea', { 'aria-hidden': 'true', readonly: true, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
