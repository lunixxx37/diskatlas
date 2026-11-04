import { HelperError, formatBytes, formatCount, formatDate, helperPath, isDriveRoot, recycleItem, type ScanTree } from '../core';
import { controlsFor, stateFromError, stateFromResult, type RecycleDialogState } from './cleanup-state';
import { Modal } from './dialog';
import { h } from './dom';
import { displayName } from './format';
import type { HelperLink } from './helper-link';
import { plural, t } from './i18n';
import { icon, type IconName } from './icons';
import { toast } from './toast';

// Clean-up through the DiskAtlas Helper: "Show in Explorer" and "Move to Recycle Bin", for
// helper scans whose helper offered them. Moving needs a confirmation in a dialog that has
// checked the item with a dry run first; the helper never deletes permanently.

/** What lists and bars need to offer the actions for an entry. */
export interface EntryActions {
  canReveal(entry: number): boolean;
  canRecycle(entry: number): boolean;
  reveal(entry: number, opener: HTMLElement | null): void;
  recycle(entry: number, opener: HTMLElement | null): void;
}

export interface CleanupHost {
  tree: ScanTree;
  link: HelperLink;
  /** The entry is in the Recycle Bin now: take it out of the results. */
  onRecycled: (entry: number) => void;
  /** "Survey again", after the item changed or went away since the scan. */
  onRescan: () => void;
  /** Focus target when a dialog closes and the control that opened it is gone. */
  fallbackFocus: () => HTMLElement | null;
}

const isGone = (error: unknown) => error instanceof HelperError && (error.kind === 'not-running' || error.kind === 'denied');

export class Cleanup implements EntryActions {
  constructor(private readonly host: CleanupHost) {}

  /** The helper that made this scan listed the feature (never for browser, file-list or demo scans). */
  offers(feature: 'reveal' | 'recycle'): boolean {
    const { meta } = this.host.tree;
    return meta.source === 'helper' && (meta.helper?.features ?? ['scan']).includes(feature);
  }

  /** Not a bare drive root ("C:"): Explorer has no parent folder to show it in. */
  canReveal(entry: number): boolean {
    const { tree } = this.host;
    return this.offers('reveal') && !tree.removed(entry) && !isDriveRoot(helperPath(tree, entry));
  }

  /** Not the scanned folder itself: that would empty the results. */
  canRecycle(entry: number): boolean {
    const { tree } = this.host;
    return this.offers('recycle') && entry !== tree.root && !tree.removed(entry);
  }

  reveal(entry: number, opener: HTMLElement | null): void {
    void this.revealNow(entry, opener);
  }

  recycle(entry: number, opener: HTMLElement | null): void {
    new RecycleDialog(this.host, entry, opener).open();
  }

  private async revealNow(entry: number, opener: HTMLElement | null): Promise<void> {
    const client = this.host.link.client;
    if (!client) {
      offlineDialog(this.host, t.cleanup.reveal, opener, () => this.revealNow(entry, opener));
      return;
    }
    try {
      await client.reveal(helperPath(this.host.tree, entry));
      toast(t.cleanup.revealed, 'check');
    } catch (error) {
      if (isGone(error)) {
        if (error instanceof HelperError && error.kind === 'not-running') this.host.link.lost();
        offlineDialog(this.host, t.cleanup.reveal, opener, () => this.revealNow(entry, opener));
      } else {
        toast(t.cleanup.revealFailed(error instanceof Error ? error.message : String(error)), 'alert', 6000);
      }
    }
  }
}

/** Small icon buttons for a row: Show in Explorer, Move to Recycle Bin. Null when neither is offered. */
export function entryButtons(actions: EntryActions | null, tree: ScanTree, entry: number): HTMLElement | null {
  if (!actions) return null;
  const name = displayName(tree, entry);
  const buttons: HTMLElement[] = [];
  const button = (iconName: IconName, label: string, run: (opener: HTMLElement) => void, extra = '') => {
    const b = h('button', { class: `btn btn--ghost btn--icon btn--sm entry-action ${extra}`, type: 'button', title: label, 'aria-label': label }, icon(iconName));
    b.addEventListener('click', (event) => {
      event.stopPropagation();
      run(b);
    });
    return b;
  };
  if (actions.canReveal(entry)) buttons.push(button('folderOpen', t.cleanup.revealItem(name), (b) => actions.reveal(entry, b)));
  if (actions.canRecycle(entry)) buttons.push(button('trash', t.cleanup.recycleItem(name), (b) => actions.recycle(entry, b), 'entry-action--recycle'));
  return buttons.length ? h('span', { class: 'entry-actions' }, ...buttons) : null;
}

/** "The helper isn't connected" with Reconnect; `retry` runs once it is back. */
function offlineDialog(host: CleanupHost, title: string, opener: HTMLElement | null, retry: () => Promise<void>): void {
  const cancel = h('button', { class: 'btn btn--secondary', type: 'button', text: t.cleanup.cancel });
  const reconnect = h('button', { class: 'btn btn--primary', type: 'button' }, icon('plug'), t.cleanup.reconnect);
  const status = h('p', { class: 'recycle__status', role: 'status', 'aria-live': 'polite', 'data-tone': 'warn' }, icon('alert'), h('span', { text: t.cleanup.offline }));
  const modal = new Modal({ title, initialFocus: () => cancel, returnFocus: opener, fallbackFocus: host.fallbackFocus });
  modal.body.append(status, h('div', { class: 'modal__actions' }, cancel, reconnect));
  cancel.addEventListener('click', () => modal.close());
  reconnect.addEventListener('click', async () => {
    modal.busy = true;
    reconnect.disabled = true;
    const client = await host.link.ensureClient();
    modal.busy = false;
    reconnect.disabled = false;
    if (client) {
      modal.close();
      await retry();
    } else {
      reconnect.focus();
    }
  });
  modal.open();
}

/** Any online-only file inside the folder? (They would leave OneDrive's cloud as well.) */
function cloudInside(tree: ScanTree, folder: number): boolean {
  const stack = [folder];
  while (stack.length > 0) {
    for (const c of tree.children(stack.pop()!)) {
      if (tree.cloud(c)) return true;
      if (tree.isDir(c)) stack.push(c);
    }
  }
  return false;
}

class RecycleDialog {
  private state: RecycleDialogState = { kind: 'checking' };
  private readonly modal: Modal;
  private readonly status: HTMLElement;
  /** The helper's own message (English), when it gives one. */
  private readonly detail: HTMLElement;
  private readonly cancel: HTMLButtonElement;
  private readonly confirm: HTMLButtonElement;
  private readonly rescan: HTMLButtonElement;
  private readonly reconnect: HTMLButtonElement;

  constructor(
    private readonly host: CleanupHost,
    private readonly entry: number,
    opener: HTMLElement | null,
  ) {
    const { tree } = host;
    const dir = tree.isDir(entry);
    this.cancel = h('button', { class: 'btn btn--secondary', type: 'button', text: t.cleanup.cancel });
    this.rescan = h('button', { class: 'btn btn--secondary', type: 'button', hidden: true }, icon('refresh'), t.cleanup.rescan);
    this.reconnect = h('button', { class: 'btn btn--secondary', type: 'button', hidden: true }, icon('plug'), t.cleanup.reconnect);
    this.confirm = h('button', { class: 'btn btn--danger', type: 'button', disabled: true }, icon('trash'), t.cleanup.recycle);
    this.status = h('p', { class: 'recycle__status', role: 'status', 'aria-live': 'polite', tabindex: '-1' });
    this.detail = h('p', { class: 'recycle__detail', hidden: true });
    this.modal = new Modal({ title: t.cleanup.title, initialFocus: () => this.cancel, returnFocus: opener, fallbackFocus: host.fallbackFocus });

    const facts: Array<[string, string]> = [[t.cleanup.factSize, formatBytes(tree.size(entry))]];
    if (tree.hasAllocated) facts.push([t.cleanup.factOnDisk, formatBytes(tree.allocated(entry))]);
    if (dir) facts.push([t.cleanup.factFiles, formatCount(tree.fileCount(entry))]);
    if (tree.mtime(entry) > 0) facts.push([t.cleanup.factModified, formatDate(tree.mtime(entry))]);
    const notes: HTMLElement[] = [];
    if (dir && tree.fileCount(entry) > 0) notes.push(note('info', t.cleanup.folderNote(plural(tree.fileCount(entry), t.files))));
    if (tree.cloud(entry)) notes.push(note('cloud', t.cleanup.cloud, 'warn'));
    else if (dir && cloudInside(tree, entry)) notes.push(note('cloud', t.cleanup.cloudInside, 'warn'));

    this.modal.body.append(
      h('p', { class: 'modal__lede', text: t.cleanup.lede }),
      h(
        'div',
        { class: 'recycle__item' },
        h('p', { class: 'recycle__name' }, icon(dir ? 'folder' : 'file'), h('strong', { text: displayName(tree, entry) })),
        h('p', { class: 'recycle__path mono' }, h('span', { class: 'sr-only', text: `${t.cleanup.factPath}: ` }), helperPath(tree, entry)),
        h('dl', { class: 'recycle__facts' }, ...facts.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { class: 'num', text: v })])),
      ),
      ...notes,
      h('div', { class: 'recycle__outcome' }, this.status, this.detail),
      h('div', { class: 'modal__actions' }, this.cancel, this.rescan, this.reconnect, this.confirm),
    );
    this.cancel.addEventListener('click', () => this.modal.close());
    this.confirm.addEventListener('click', () => void this.moveNow());
    this.rescan.addEventListener('click', () => {
      this.modal.close();
      host.onRescan();
    });
    this.reconnect.addEventListener('click', async () => {
      this.set({ kind: 'checking' });
      const client = await host.link.ensureClient();
      if (client) await this.check();
      else this.set({ kind: 'offline' });
    });
  }

  open(): void {
    this.modal.open();
    this.render();
    void this.check();
  }

  /** The dry run: every check, nothing changed. */
  private async check(): Promise<void> {
    this.set({ kind: 'checking' });
    const client = this.host.link.client;
    if (!client) {
      this.set({ kind: 'offline' });
      return;
    }
    try {
      const [result] = await client.recycle([recycleItem(this.host.tree, this.entry)], true);
      this.set(stateFromResult(result, true));
    } catch (error) {
      this.failedRequest(error);
    }
  }

  private async moveNow(): Promise<void> {
    const client = this.host.link.client;
    if (!client) {
      this.set({ kind: 'offline' });
      return;
    }
    this.set({ kind: 'working' });
    try {
      const [result] = await client.recycle([recycleItem(this.host.tree, this.entry)], false);
      const next = stateFromResult(result, false);
      if (next.kind === 'recycled') {
        this.modal.close();
        this.host.onRecycled(this.entry);
        return;
      }
      this.set(next);
    } catch (error) {
      this.failedRequest(error);
    }
  }

  private failedRequest(error: unknown): void {
    if (error instanceof HelperError && error.kind === 'not-running') this.host.link.lost();
    this.set(stateFromError(error));
  }

  private set(state: RecycleDialogState): void {
    this.state = state;
    if (this.modal.isOpen) this.render();
  }

  private render(): void {
    const { state } = this;
    const c = controlsFor(state);
    const hadFocus = document.activeElement;
    this.modal.busy = c.busy;
    this.confirm.disabled = !c.canConfirm;
    this.cancel.disabled = c.busy;
    this.rescan.hidden = !c.offerRescan;
    this.reconnect.hidden = !c.offerReconnect;
    this.reconnect.disabled = false;
    let text = '';
    let tone = '';
    let message = '';
    let mark: HTMLElement | SVGSVGElement | null = null;
    switch (state.kind) {
      case 'checking':
      case 'working':
        text = state.kind === 'checking' ? t.cleanup.checking : t.cleanup.working;
        mark = h('span', { class: 'spinner', 'aria-hidden': 'true' });
        break;
      case 'ready':
        text = t.cleanup.ready;
        tone = 'ok';
        mark = icon('check');
        break;
      case 'refused':
        text = t.cleanup.refused[state.status];
        message = state.message;
        tone = 'warn';
        mark = icon(state.status === 'protected' ? 'lock' : 'alert');
        break;
      case 'offline':
        text = t.cleanup.offline;
        tone = 'warn';
        mark = icon('alert');
        break;
      case 'failed':
      case 'blocked':
      case 'error':
        text = state.kind === 'failed' ? t.cleanup.failed : state.kind === 'blocked' ? t.cleanup.blocked : t.cleanup.error;
        message = state.message;
        tone = 'warn';
        mark = icon('alert');
        break;
      case 'recycled':
        break;
    }
    this.status.dataset.tone = tone;
    this.status.dataset.state = state.kind;
    this.status.replaceChildren(...(mark ? [mark] : []), h('span', { text }));
    this.detail.hidden = !message;
    this.detail.textContent = message ? t.cleanup.detail(message) : '';
    // A control that just became unusable must not keep (or lose) the focus; it waits on the
    // status while the move runs, and goes to the safe choice, Cancel, afterwards.
    const inside = hadFocus instanceof HTMLElement && this.modal.el.contains(hadFocus);
    const unusable = hadFocus instanceof HTMLButtonElement && (hadFocus.disabled || hadFocus.hidden);
    if (inside && (unusable || (hadFocus === this.status && !c.busy))) {
      if (!this.cancel.disabled) this.cancel.focus();
      else this.status.focus();
    }
  }
}

function note(iconName: IconName, text: string, tone = ''): HTMLElement {
  return h('p', { class: 'recycle__note', 'data-tone': tone }, icon(iconName), h('span', { text }));
}
