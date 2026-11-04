// Tiny DOM helpers. Text always goes in as text nodes, never as HTML: file and folder
// names come from the user's disk and must never be parsed as markup.

export type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string | number;
  /** CSS properties, including custom properties ("--depth"). */
  style?: Record<string, string | number>;
  /** Anything else is an attribute; `true` sets an empty attribute, false/null/undefined skips it. */
  [attribute: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, ...children);
  return el;
}

export function applyProps(el: Element, props: Props): void {
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      el.setAttribute('class', String(value));
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'style') {
      const style = (el as HTMLElement).style;
      for (const [name, v] of Object.entries(value as Record<string, string | number>)) style.setProperty(name, String(v));
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

/** Message text with bold parts ({ b: "…" }) as nodes; still text only, never HTML. */
export function rich(parts: ReadonlyArray<string | { b: string }>): Child[] {
  return parts.map((part) => (typeof part === 'string' ? part : h('strong', { text: part.b })));
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Sets textContent only when it changed (cheap, avoids needless layout work). */
export function setText(el: Node, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

let uid = 0;
/** A document-unique id with a readable prefix. */
export function uniqueId(prefix: string): string {
  uid += 1;
  return `${prefix}-${uid}`;
}

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
