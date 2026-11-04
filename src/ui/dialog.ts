import { h, uniqueId } from './dom';

export interface ModalOptions {
  title: string;
  /** Where focus goes when the dialog opens: the safe choice (e.g. Cancel). */
  initialFocus: () => HTMLElement | null;
  /** Called once when the dialog goes away (Cancel, Escape, a click outside, or close()). */
  onClose?: () => void;
  /** Focus goes back here afterwards, if it is still on the page; else to `fallbackFocus`. */
  returnFocus?: HTMLElement | null;
  fallbackFocus?: () => HTMLElement | null;
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog on the native <dialog> (the rest of the page is inert while it is open).
 * Tab and Shift+Tab stay inside it, Escape and a click on the backdrop cancel, unless the
 * dialog is `busy`.
 */
export class Modal {
  readonly el: HTMLDialogElement;
  /** Put the content here. */
  readonly body: HTMLElement;
  readonly titleEl: HTMLElement;
  /** While busy (a request in flight), the dialog cannot be cancelled. */
  busy = false;
  private closed = false;

  constructor(private readonly options: ModalOptions) {
    const titleId = uniqueId('dialog-title');
    this.titleEl = h('h2', { class: 'modal__title', id: titleId, text: options.title });
    this.body = h('div', { class: 'modal__body' });
    this.el = h('dialog', { class: 'modal', 'aria-labelledby': titleId }, h('div', { class: 'modal__inner' }, this.titleEl, this.body));
    this.el.addEventListener('cancel', (event) => {
      // Escape: our own close, so the cleanup runs (and nothing happens while busy).
      event.preventDefault();
      if (!this.busy) this.close();
    });
    // The browser may close it on its own (a repeated Escape without user activation is not
    // cancelable): clean up the same way.
    this.el.addEventListener('close', () => this.close());
    this.el.addEventListener('keydown', this.onKey);
    this.el.addEventListener('click', (event) => {
      // A click on the backdrop lands on the <dialog> itself, outside its inner box.
      if (event.target === this.el && !this.busy) this.close();
    });
  }

  open(): void {
    document.body.append(this.el);
    this.el.showModal();
    (this.options.initialFocus() ?? this.firstFocusable())?.focus();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.el.close();
    this.el.remove();
    const back = this.options.returnFocus;
    if (back && back.isConnected) back.focus();
    else this.options.fallbackFocus?.()?.focus();
    this.options.onClose?.();
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private firstFocusable(): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(FOCUSABLE);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const items = [...this.el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.offsetParent !== null || e === document.activeElement);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !this.el.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.el.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
}
