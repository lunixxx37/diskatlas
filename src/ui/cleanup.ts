import { HelperError, formatBytes, formatCount, formatDate, helperPath, isDriveRoot, recycleItem, type DeleteResult, type RecycleResult, type ScanTree } from '../core';
import { controlsFor, stateFromError, stateFromResult, suggestPermanent, type CleanupDialogState, type CleanupMode } from './cleanup-state';
import { Modal } from './dialog';
import { h, uniqueId } from './dom';
import { displayName } from './format';
import type { HelperLink } from './helper-link';
import { plural, t } from './i18n';
import { icon, type IconName } from './icons';
import { toast } from './toast';

// Clean-up through the DiskAtlas Helper: "Show in Explorer", "Move to Recycle Bin" and
// "Delete permanently", for helper scans whose helper offered them. Both ways of removing
// need a confirmation in a dialog that has checked the item with a dry run first; deleting
// permanently also needs the box "I understand this can't be undone".

export type { CleanupMode } from './cleanup-state';

/** What lists, bars and menus need to offer the actions for an entry. */
export interface EntryActions {
  canReveal(entry: number): boolean;
  canRecycle(entry: number): boolean;
  canDelete(entry: number): boolean;
  reveal(entry: number, opener: HTMLElement | null): void;
  /** The clean-up dialog, starting with "Move to Recycle Bin", or with "Delete permanently" for `mode` 'permanent'. */
  remove(entry: number, opener: HTMLElement | null, mode?: CleanupMode): void;
}

export interface CleanupHost {
  tree: ScanTree;
  link: HelperLink;
  /** The entry is in the Recycle Bin now, or deleted for good: take it out of the results. */
  onRemoved: (entry: number, how: CleanupMode) => void;
  /** A folder was deleted only in part: it stays, marked, and its numbers may be off. */
  onPartial: (entry: number) => void;
  /** "Survey again", after the item changed, went away or was deleted in part. */
  onRescan: () => void;
  /** Focus target when a dialog closes and the control that opened it is gone. */
  fallbackFocus: () => HTMLElement | null;
}

const isGone = (error: unknown) => error instanceof HelperError && (error.kind === 'not-running' || error.kind === 'denied');

export class Cleanup implements EntryActions {
  constructor(private readonly host: CleanupHost) {}

  /** The helper that made this scan listed the feature (never for browser, file-list or demo scans). */
  offers(feature: 'reveal' | 'recycle' | 'delete'): boolean {
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
    return this.offers('recycle') && this.removable(entry);
  }

  canDelete(entry: number): boolean {
    return this.offers('delete') && this.removable(entry);
  }

  reveal(entry: number, opener: HTMLElement | null): void {
    void this.revealNow(entry, opener);
  }

  remove(entry: number, opener: HTMLElement | null, mode: CleanupMode = 'recycle'): void {
    const modes = { recycle: this.canRecycle(entry), permanent: this.canDelete(entry) };
    const start: CleanupMode | null = modes[mode] ? mode : modes.recycle ? 'recycle' : modes.permanent ? 'permanent' : null;
    if (start) new CleanupDialog(this.host, entry, opener, start, modes).open();
  }

  private removable(entry: number): boolean {
    return entry !== this.host.tree.root && !this.host.tree.removed(entry);
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

/** Small icon buttons for a row: Show in Explorer, and the clean-up dialog. Null when neither is offered. */
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
  if (actions.canRecycle(entry)) buttons.push(button('trash', t.cleanup.recycleItem(name), (b) => actions.remove(entry, b), 'entry-action--recycle'));
  else if (actions.canDelete(entry)) buttons.push(button('trashX', t.cleanup.deleteItem(name), (b) => actions.remove(entry, b, 'permanent'), 'entry-action--recycle'));
  return buttons.length ? h('span', { class: 'entry-actions' }, ...buttons) : null;
}

/**
 * Delete and Shift+Delete on an entry: the clean-up dialog, for the Recycle Bin or for
 * deleting permanently. True when the key was used.
 */
export function cleanupKey(actions: EntryActions | null | undefined, event: KeyboardEvent, entry: number, opener: HTMLElement | null): boolean {
  if (!actions || event.key !== 'Delete' || event.ctrlKey || event.metaKey || event.altKey) return false;
  const mode: CleanupMode = event.shiftKey ? 'permanent' : 'recycle';
  if (mode === 'permanent' ? !actions.canDelete(entry) : !actions.canRecycle(entry)) return false;
  event.preventDefault();
  actions.remove(entry, opener, mode);
  return true;
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

/**
 * "Move to the Recycle Bin?" or "Delete permanently?": the item with its numbers, the
 * helper's dry-run verdict, and the one button that does it. With both modes offered, a
 * choice switches between them (and checks again).
 */
class CleanupDialog {
  private state: CleanupDialogState = { kind: 'checking' };
  /** Ticked "I understand this can't be undone" (permanent mode only; cleared on every switch). */
  private understood = false;
  /** Recycle mode: the permanent check, when the Recycle Bin can't take the item. */
  private permanentCheck: DeleteResult | null = null;
  /** Answers to older requests (another mode, a check before Reconnect) are dropped. */
  private seq = 0;
  private readonly modal: Modal;
  private readonly lede: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly understand: HTMLLabelElement;
  private readonly understandBox: HTMLInputElement;
  private readonly status: HTMLElement;
  /** The helper's own message (English), when it gives one. */
  private readonly detail: HTMLElement;
  private readonly instead: HTMLElement;
  private readonly cancel: HTMLButtonElement;
  private readonly confirm: HTMLButtonElement;
  private readonly rescan: HTMLButtonElement;
  private readonly reconnect: HTMLButtonElement;
  private readonly modeInputs: HTMLInputElement[] = [];

  constructor(
    private readonly host: CleanupHost,
    private readonly entry: number,
    opener: HTMLElement | null,
    private mode: CleanupMode,
    private readonly modes: Record<CleanupMode, boolean>,
  ) {
    const { tree } = host;
    const dir = tree.isDir(entry);
    this.cancel = h('button', { class: 'btn btn--secondary', type: 'button', text: t.cleanup.cancel });
    this.rescan = h('button', { class: 'btn btn--secondary', type: 'button', hidden: true }, icon('refresh'), t.cleanup.rescan);
    this.reconnect = h('button', { class: 'btn btn--secondary', type: 'button', hidden: true }, icon('plug'), t.cleanup.reconnect);
    this.confirm = h('button', { class: 'btn btn--danger', type: 'button', disabled: true });
    this.lede = h('p', { class: 'modal__lede' });
    this.notes = h('div', { class: 'recycle__notes' });
    this.understandBox = h('input', { type: 'checkbox' });
    this.understand = h('label', { class: 'check recycle__understand', hidden: true }, this.understandBox, h('span', { text: t.cleanup.understand }));
    this.status = h('p', { class: 'recycle__status', role: 'status', 'aria-live': 'polite', tabindex: '-1' });
    this.detail = h('p', { class: 'recycle__detail', hidden: true });
    const insteadButton = h('button', { class: 'btn btn--secondary btn--sm', type: 'button' }, icon('trashX'), t.cleanup.insteadButton);
    this.instead = h('div', { class: 'recycle__instead', hidden: true }, h('p', { text: t.cleanup.instead }), insteadButton);
    this.modal = new Modal({ title: t.cleanup.title, initialFocus: () => this.cancel, returnFocus: opener, fallbackFocus: host.fallbackFocus });

    const facts: Array<[string, string]> = [[t.cleanup.factSize, formatBytes(tree.size(entry))]];
    if (tree.hasAllocated) facts.push([t.cleanup.factOnDisk, formatBytes(tree.allocated(entry))]);
    if (dir) facts.push([t.cleanup.factFiles, formatCount(tree.fileCount(entry))]);
    if (tree.mtime(entry) > 0) facts.push([t.cleanup.factModified, formatDate(tree.mtime(entry))]);

    this.modal.body.append(
      // The choice right under the question; the lede then says what the chosen way means.
      ...(this.modes.recycle && this.modes.permanent ? [this.modeChoice()] : []),
      this.lede,
      h(
        'div',
        { class: 'recycle__item' },
        h('p', { class: 'recycle__name' }, icon(dir ? 'folder' : 'file'), h('strong', { text: displayName(tree, entry) })),
        h('p', { class: 'recycle__path mono' }, h('span', { class: 'sr-only', text: `${t.cleanup.factPath}: ` }), helperPath(tree, entry)),
        h('dl', { class: 'recycle__facts' }, ...facts.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { class: 'num', text: v })])),
      ),
      this.notes,
      this.understand,
      h('div', { class: 'recycle__outcome' }, this.status, this.detail),
      this.instead,
      h('div', { class: 'modal__actions' }, this.cancel, this.rescan, this.reconnect, this.confirm),
    );
    this.cancel.addEventListener('click', () => this.modal.close());
    this.confirm.addEventListener('click', () => void this.run());
    this.rescan.addEventListener('click', () => {
      this.modal.close();
      host.onRescan();
    });
    this.reconnect.addEventListener('click', async () => {
      const seq = ++this.seq;
      this.set({ kind: 'checking' });
      const client = await host.link.ensureClient();
      if (seq !== this.seq) return;
      if (client) await this.check();
      else this.set({ kind: 'offline' });
    });
    this.understandBox.addEventListener('change', () => {
      this.understood = this.understandBox.checked;
      this.render();
    });
    insteadButton.addEventListener('click', () => {
      this.switchTo('permanent');
      this.modeInputs.find((i) => i.value === 'permanent')?.focus();
    });
  }

  open(): void {
    this.modal.open();
    this.render();
    void this.check();
  }

  /** "Move to Recycle Bin" or "Delete permanently", as two radio buttons. */
  private modeChoice(): HTMLElement {
    const name = uniqueId('cleanup-mode');
    const option = (mode: CleanupMode, iconName: IconName, label: string) => {
      const input = h('input', { type: 'radio', name, value: mode });
      input.checked = mode === this.mode;
      input.addEventListener('change', () => {
        if (input.checked) this.switchTo(mode);
      });
      this.modeInputs.push(input);
      return h('label', { class: `recycle__mode recycle__mode--${mode}` }, input, icon(iconName), h('span', { text: label }));
    };
    return h(
      'fieldset',
      { class: 'recycle__modes' },
      h('legend', { class: 'sr-only', text: t.cleanup.mode }),
      option('recycle', 'trash', t.cleanup.recycle),
      option('permanent', 'trashX', t.cleanup.deletePermanently),
    );
  }

  private switchTo(mode: CleanupMode): void {
    if (mode === this.mode || !this.modes[mode] || !controlsFor(this.state, this.mode, this.understood).canSwitch) {
      for (const input of this.modeInputs) input.checked = input.value === this.mode;
      return;
    }
    this.mode = mode;
    for (const input of this.modeInputs) input.checked = input.value === mode;
    this.understood = false;
    this.understandBox.checked = false;
    this.permanentCheck = null;
    void this.check();
  }

  /** The dry run for the current mode: every check, nothing changed. */
  private async check(): Promise<void> {
    const seq = ++this.seq;
    const mode = this.mode;
    this.permanentCheck = null;
    this.set({ kind: 'checking' });
    const client = this.host.link.client;
    if (!client) {
      this.set({ kind: 'offline' });
      return;
    }
    const item = recycleItem(this.host.tree, this.entry);
    try {
      const [result] = mode === 'permanent' ? await client.delete([item], true) : await client.recycle([item], true);
      if (seq !== this.seq) return;
      const state = stateFromResult(result, true);
      this.set(state);
      // The Recycle Bin can't take it: maybe deleting it permanently can (removable drives, long paths).
      if (mode === 'recycle' && state.kind === 'refused' && state.status === 'unsupported' && this.modes.permanent) {
        const [check] = await client.delete([item], true).catch(() => [null]);
        if (seq !== this.seq) return;
        this.permanentCheck = check;
        this.render();
      }
    } catch (error) {
      if (seq !== this.seq) return;
      this.failedRequest(error);
    }
  }

  /** The real request, after the confirmation. */
  private async run(): Promise<void> {
    const client = this.host.link.client;
    if (!client) {
      this.set({ kind: 'offline' });
      return;
    }
    const mode = this.mode;
    if (mode === 'permanent' && !this.understood) return;
    const seq = ++this.seq;
    this.set({ kind: 'working' });
    const item = recycleItem(this.host.tree, this.entry);
    try {
      const [result]: Array<RecycleResult | DeleteResult> = mode === 'permanent' ? await client.delete([item], false) : await client.recycle([item], false);
      if (seq !== this.seq) return;
      const next = stateFromResult(result, false);
      if (next.kind === 'done') {
        this.modal.close();
        this.host.onRemoved(this.entry, mode);
        return;
      }
      this.set(next);
      if (next.kind === 'partial') this.host.onPartial(this.entry);
    } catch (error) {
      if (seq !== this.seq) return;
      this.failedRequest(error);
    }
  }

  private failedRequest(error: unknown): void {
    if (error instanceof HelperError && error.kind === 'not-running') this.host.link.lost();
    this.set(stateFromError(error));
  }

  private set(state: CleanupDialogState): void {
    this.state = state;
    if (this.modal.isOpen) this.render();
  }

  private render(): void {
    const { state, mode } = this;
    const permanent = mode === 'permanent';
    const c = controlsFor(state, mode, this.understood);
    const hadFocus = document.activeElement;

    this.modal.el.dataset.mode = mode;
    this.modal.titleEl.textContent = permanent ? t.cleanup.titlePermanent : t.cleanup.title;
    this.lede.replaceChildren(...(permanent ? [icon('alert'), h('span', { text: t.cleanup.ledePermanent })] : [t.cleanup.lede]));
    this.lede.classList.toggle('recycle__danger', permanent);
    this.renderNotes();
    // After a partial deletion, what "would" happen is history: only the outcome stays.
    const after = state.kind === 'partial';
    if (after) this.notes.hidden = true;
    this.understand.hidden = !permanent || after;
    for (const input of this.modeInputs) input.disabled = !c.canSwitch;
    this.confirm.replaceChildren(icon(permanent ? 'trashX' : 'trash'), permanent ? t.cleanup.deletePermanently : t.cleanup.recycle);

    this.modal.busy = c.busy;
    this.confirm.disabled = !c.canConfirm;
    this.cancel.disabled = c.busy;
    this.cancel.textContent = state.kind === 'partial' ? t.cleanup.close : t.cleanup.cancel;
    this.rescan.hidden = !c.offerRescan;
    this.reconnect.hidden = !c.offerReconnect;
    this.instead.hidden = !(mode === 'recycle' && suggestPermanent(state, this.permanentCheck));

    let text = '';
    let tone = '';
    let message = '';
    let mark: HTMLElement | SVGSVGElement | null = null;
    switch (state.kind) {
      case 'checking':
      case 'working':
        text = state.kind === 'checking' ? t.cleanup.checking : permanent ? t.cleanup.workingPermanent : t.cleanup.working;
        mark = h('span', { class: 'spinner', 'aria-hidden': 'true' });
        break;
      case 'ready':
        text = permanent ? t.cleanup.readyPermanent : t.cleanup.ready;
        tone = 'ok';
        mark = icon('check');
        break;
      case 'refused':
        text = permanent && (state.status === 'protected' || state.status === 'unsupported') ? t.cleanup.refusedPermanent[state.status] : t.cleanup.refused[state.status];
        message = state.message;
        tone = 'warn';
        mark = icon(state.status === 'protected' ? 'lock' : 'alert');
        break;
      case 'offline':
        text = t.cleanup.offline;
        tone = 'warn';
        mark = icon('alert');
        break;
      case 'partial': {
        const gone = t.cleanup.goneCounts(plural(state.deletedFiles, t.files), plural(state.deletedFolders, t.cleanup.folders));
        text = `${t.cleanup.partial(gone, plural(state.failedEntries, t.cleanup.entries))} ${t.cleanup.partialHint}`;
        message = state.message;
        tone = 'warn';
        mark = icon('alert');
        break;
      }
      case 'failed':
      case 'blocked':
      case 'error':
        text =
          state.kind === 'failed'
            ? state.denied
              ? t.cleanup.deniedFailed
              : permanent
                ? t.cleanup.failedPermanent
                : t.cleanup.failed
            : state.kind === 'blocked'
              ? permanent
                ? t.cleanup.blockedPermanent
                : t.cleanup.blocked
              : t.cleanup.error;
        message = state.message;
        tone = 'warn';
        mark = icon('alert');
        break;
      case 'done':
        break;
    }
    this.status.dataset.tone = tone;
    this.status.dataset.state = state.kind;
    this.status.replaceChildren(...(mark ? [mark] : []), h('span', { text }));
    this.detail.hidden = !message;
    this.detail.textContent = message ? t.cleanup.detail(message) : '';
    // A control that just became unusable must not keep (or lose) the focus; it waits on the
    // status while the request runs, and goes to the safe choice, Cancel, afterwards.
    const inside = hadFocus instanceof HTMLElement && this.modal.el.contains(hadFocus);
    const unusable = (hadFocus instanceof HTMLButtonElement || hadFocus instanceof HTMLInputElement) && (hadFocus.disabled || hadFocus.hidden || !!hadFocus.closest('[hidden]'));
    if (inside && (unusable || (hadFocus === this.status && !c.busy))) {
      if (!this.cancel.disabled) this.cancel.focus();
      else this.status.focus();
    }
  }

  /** The folder note and the OneDrive warning, worded for the mode. */
  private renderNotes(): void {
    const { tree } = this.host;
    const entry = this.entry;
    const permanent = this.mode === 'permanent';
    const notes: HTMLElement[] = [];
    if (tree.isDir(entry) && tree.fileCount(entry) > 0) {
      const files = plural(tree.fileCount(entry), t.files);
      notes.push(note('info', permanent ? t.cleanup.folderNotePermanent(files) : t.cleanup.folderNote(files)));
    }
    if (tree.cloud(entry)) notes.push(note('cloud', permanent ? t.cleanup.cloudPermanent : t.cleanup.cloud, 'warn'));
    else if (tree.isDir(entry) && cloudInside(tree, entry)) notes.push(note('cloud', permanent ? t.cleanup.cloudInsidePermanent : t.cleanup.cloudInside, 'warn'));
    // An elevated helper still changes files with the user's own rights (docs: "Security").
    const { link } = this.host;
    if (link.client ? link.elevated : tree.meta.helper?.elevated === true) notes.push(note('shield', t.cleanup.normalRights));
    this.notes.replaceChildren(...notes);
    this.notes.hidden = notes.length === 0;
  }
}

function note(iconName: IconName, text: string, tone = ''): HTMLElement {
  return h('p', { class: 'recycle__note', 'data-tone': tone }, icon(iconName), h('span', { text }));
}
