import { h } from './dom';
import { icon, type IconName } from './icons';

export interface MenuItem {
  label: string;
  icon?: IconName;
  run: () => void;
}

export interface MenuSpec {
  /** Accessible name of the menu. */
  label: string;
  items: MenuItem[];
  caption?: string;
  align?: 'start' | 'end';
}

let closeOpen: (() => void) | null = null;

/** Closes whichever menu is open. */
export function closeMenu(): void {
  closeOpen?.();
}

/**
 * A menu that pops up under its button (ARIA menu pattern): arrow keys, Home/End,
 * Escape (focus back to the button), Tab and clicks outside close it. It lives on
 * <body> with fixed position, so no scrolling or clipping container can cut it off.
 */
export function openMenu(anchor: HTMLElement, spec: MenuSpec, focus: 'first' | 'last' = 'first'): void {
  closeMenu();
  const buttons = spec.items.map((item) => {
    const b = h('button', { class: 'menu__item', type: 'button', role: 'menuitem', tabindex: '-1' }, item.icon ? icon(item.icon) : null, h('span', { class: 'menu__text', text: item.label }));
    b.addEventListener('click', () => {
      close(true);
      item.run();
    });
    return b;
  });
  const menu = h(
    'div',
    { class: 'menu menu--popup', role: 'menu', 'aria-label': spec.label },
    spec.caption ? h('p', { class: 'menu__caption', text: spec.caption }) : null,
    ...buttons,
  );
  document.body.append(menu);

  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = spec.align === 'end' ? box.right - width : box.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = box.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, box.top - 6 - height);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const onPointer = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!menu.contains(target) && !anchor.contains(target)) close(false);
  };
  const onResize = () => close(false);
  menu.addEventListener('keydown', (event) => {
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length].focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : buttons.length - 1].focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
  });
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('resize', onResize);

  function close(returnFocus: boolean): void {
    if (!menu.isConnected) return;
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('resize', onResize);
    closeOpen = null;
    if (returnFocus) anchor.focus();
  }
  closeOpen = () => close(false);
  buttons[focus === 'last' ? buttons.length - 1 : 0]?.focus();
}

/** Makes `button` open the menu that `spec()` describes (on click, ArrowDown or ArrowUp). */
export function menuButton(button: HTMLElement, spec: () => MenuSpec): void {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-expanded') === 'true') closeMenu();
    else openMenu(button, spec());
  });
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openMenu(button, spec(), event.key === 'ArrowUp' ? 'last' : 'first');
  });
}
