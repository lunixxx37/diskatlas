import {
  HelperError,
  demoRootName,
  demoScan,
  dirHandleFromDrop,
  formatBytes,
  pickDirectory,
  scanDirectory,
  supportsDirectoryPicker,
  supportsFolderInput,
  treeFromFiles,
  type RunningScan,
  type ScanProgress,
  type ScanTree,
} from '../core';
import { APP_NAME } from './brand';
import { Cleanup, type CleanupMode } from './cleanup';
import { h, setText } from './dom';
import { displayName } from './format';
import { HelperLink, isWindowsDesktop } from './helper-link';
import { detectLanguage, lang, setLanguage, storeLanguage, storedLanguage, t, type Lang } from './i18n';
import { brandGlyph, icon } from './icons';
import { LangSwitch } from './lang-switch';
import type { LastResultInfo } from './last-result';
import { Navigation, readNavState } from './navigation';
import { ResultsView, type ResultsState } from './results/results-view';
import { ScanView, noticeView, type ScanViewState } from './scan-view';
import { StartView, type Support } from './start-view';
import { ThemeManager, ThemeSwitch } from './theme';
import { toast } from './toast';
import { tooltip } from './tooltip';

type Source =
  | { kind: 'handle'; handle: FileSystemDirectoryHandle }
  | { kind: 'files' }
  | { kind: 'demo' }
  /** Read by the DiskAtlas Helper. */
  | { kind: 'helper'; path: string };

interface View {
  el: HTMLElement;
  destroy(): void;
}

/** The result kept in memory: the start page offers it again, Forward brings it back. */
interface LastResult {
  id: number;
  tree: ScanTree;
  source: Source | null;
  /** When the survey finished (or was stopped). */
  at: number;
  /** Where its view stood when it was left (folder, tab, selection, tree). */
  state?: ResultsState;
}

type ViewName = 'start' | 'scan' | 'results' | 'notice';

interface ShowOptions {
  context?: Node | null;
  actions?: Node | null;
  /** Builds this view again in the active language, with the state it has by then. */
  rerender: () => void;
}

/**
 * The application shell and its states: start → scan → results (or a notice when a
 * scan fails). Scans are tokened, so a superseded scan can never replace a newer view.
 * A language switch rebuilds the current view in place and keeps its state: a running
 * scan keeps running, results keep their folder, selection, tab and tree.
 */
export class App {
  private readonly theme = new ThemeManager();
  /** The DiskAtlas Helper, offered on Windows desktops only. */
  private readonly helper: HelperLink | null = isWindowsDesktop() ? new HelperLink() : null;
  private readonly support: Support;
  private readonly shell: HTMLElement;
  private readonly context: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly dropOverlay: HTMLElement;
  private readonly dropText: HTMLElement;
  private readonly skipLink: HTMLElement;
  private readonly footerClaim: HTMLElement;
  private readonly footerUnits: HTMLElement;
  private readonly themeSwitch: ThemeSwitch;
  private readonly langSwitch: LangSwitch;
  private view: View | null = null;
  private viewEl: HTMLElement;
  private startView: StartView | null = null;
  private scanView: ScanView | null = null;
  private resultsView: ResultsView | null = null;
  private rerender: (() => void) | null = null;
  /** True while the view is rebuilt in place (language switch, an item recycled): keep scroll position and focus. */
  private relocalizing = false;
  private source: Source | null = null;
  private running: RunningScan | null = null;
  private token = 0;
  private dragDepth = 0;
  private readonly nav = new Navigation(window.history);
  private last: LastResult | null = null;
  /** Numbers results (and their history entries). */
  private resultSeq = 0;
  /** The result id of the running survey. */
  private runningId = 0;
  /** The user went to the start page during the survey: its (partial) result is kept, not shown. */
  private detached = false;
  /** After the next return to the start page, scroll to the helper section. */
  private toHelper = false;
  private readonly wordmark: HTMLAnchorElement;

  constructor(root: HTMLElement) {
    setLanguage(storedLanguage() ?? detectLanguage());
    this.support = supportsDirectoryPicker() ? 'picker' : supportsFolderInput() ? 'files' : 'none';

    this.themeSwitch = new ThemeSwitch(this.theme);
    this.langSwitch = new LangSwitch(this.changeLanguage);
    this.context = h('div', { class: 'topbar__slot topbar__slot--context' });
    this.actions = h('div', { class: 'topbar__slot topbar__slot--actions' });
    // The wordmark leads to the start page (a real link, so it also opens in a new tab).
    this.wordmark = h('a', { class: 'wordmark', href: location.pathname }, brandGlyph(), h('span', { class: 'wordmark__text', text: APP_NAME }));
    this.wordmark.addEventListener('click', (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      this.goHome();
    });
    const topbar = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'topbar__brand' }, this.wordmark),
      this.context,
      this.actions,
      h('div', { class: 'topbar__prefs' }, this.langSwitch.el, this.themeSwitch.el),
    );

    this.input = h('input', { type: 'file', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
    this.input.webkitdirectory = true;
    this.input.multiple = true;
    this.input.addEventListener('change', this.onFilesChosen);

    this.dropText = h('p');
    this.dropOverlay = h(
      'div',
      { class: 'drop-overlay', hidden: true, 'aria-hidden': 'true' },
      h('div', { class: 'drop-overlay__inner corners' }, icon('folderScan'), this.dropText),
    );

    this.skipLink = h('a', { class: 'skip-link', href: '#main' });
    this.footerClaim = h('span');
    this.footerUnits = h('p', { class: 'site-footer__meta' });
    this.viewEl = h('main', { class: 'view', id: 'main' });
    this.shell = h(
      'div',
      { class: 'app', 'data-view': 'start' },
      this.skipLink,
      topbar,
      this.viewEl,
      h('footer', { class: 'site-footer' }, h('p', { class: 'site-footer__claim' }, icon('shield'), this.footerClaim), this.footerUnits),
      this.input,
      this.dropOverlay,
    );
    this.relabelShell();
    root.replaceChildren(this.shell);
    this.installDragAndDrop();
    window.addEventListener('popstate', this.onPopState);
  }

  /** Opens the start view, or plays the demo right away for `?demo`. */
  start(): void {
    // This entry is the start page; a survey adds one entry after it.
    this.nav.start();
    if (new URLSearchParams(location.search).has('demo')) this.runDemo();
    else this.showStart();
    // Back to a helper used before, only if that can't bring up a permission prompt.
    void this.helper?.reconnectSilently();
  }

  /** Dev hook: show any tree as a result. */
  showTree(tree: ScanTree): void {
    this.token++;
    this.cancelRunning();
    this.source = null;
    this.keepResultState();
    const id = ++this.resultSeq;
    this.nav.enter(id);
    this.last = { id, tree, source: null, at: Date.now() };
    this.showResults(tree);
  }

  /** Scans a folder handle (from the picker, a drop, or the dev hook). Resolves when the result (or an error) is shown. */
  scanHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    this.source = { kind: 'handle', handle };
    return this.run(handle.name || t.app.selectedFolder, (onProgress) => scanDirectory(handle, onProgress));
  }

  // ---------- language ----------

  /** From the EN/DE switch: everything on screen is rebuilt in the new language, state kept. */
  private readonly changeLanguage = (next: Lang): void => {
    if (next === lang()) return;
    setLanguage(next);
    storeLanguage(next);
    this.relabelShell();
    this.relocalizing = true;
    try {
      this.rerender?.();
    } finally {
      this.relocalizing = false;
    }
  };

  /** Text in the parts of the page that stay while views change. */
  private relabelShell(): void {
    this.wordmark.setAttribute('aria-label', t.app.wordmarkLabel);
    setText(this.skipLink, t.app.skipLink);
    setText(this.dropText, t.app.dropOverlay);
    setText(this.footerClaim, t.app.footerClaim);
    setText(this.footerUnits, t.app.footerUnits);
    this.themeSwitch.relabel();
    this.langSwitch.relabel();
  }

  // ---------- start page and history ----------

  /** The wordmark, "Start page", "Back to the start page": back in history when possible, so Forward returns. */
  private readonly goHome = (): void => {
    if (this.nav.home() !== 'back') this.showHome();
    // 'back': the popstate that follows shows the start page.
  };

  /** Back or Forward in the browser. */
  private readonly onPopState = (event: PopStateEvent): void => {
    const state = readNavState(event.state);
    if (state?.view === 'result') this.showLast(state.id);
    else this.showHome();
  };

  /**
   * The start page, with the result kept in memory. A running survey stops: what it read
   * until then becomes the last result (it isn't shown, the user wanted the start page).
   */
  private showHome(): void {
    if (this.running) {
      this.detached = true;
      this.running.cancel();
      toast(t.app.homeStopped, 'info', 6000);
    }
    this.keepResultState();
    if (this.shell.dataset.view === 'start' && this.startView) {
      window.scrollTo(0, 0);
    } else {
      this.showStart();
    }
    if (this.toHelper) {
      this.toHelper = false;
      document.getElementById('helper')?.scrollIntoView({ block: 'start' });
    } else {
      this.startView?.focus();
    }
  }

  /** Forward to a result (or "Open result"): shown from memory as it was left. */
  private showLast(id: number): void {
    const last = this.last;
    if (!last || last.id !== id) {
      // Its result is gone (a newer survey replaced it); a survey still stopping keeps its entry.
      if (!(this.running && this.runningId === id)) this.nav.forget();
      this.showHome();
      return;
    }
    if (this.running && this.runningId !== id) this.cancelRunning();
    this.token++;
    this.source = last.source;
    this.showResults(last.tree, last.state, true);
  }

  /** "Open result" on the start page. */
  private readonly openLast = (): void => {
    if (!this.last) return;
    this.nav.enter(this.last.id);
    this.showLast(this.last.id);
  };

  /** The results view's state, kept with the last result when its view goes away. */
  private keepResultState(): void {
    const view = this.resultsView;
    if (view && this.last && view.tree === this.last.tree) this.last.state = view.snapshot();
  }

  private lastInfo(): LastResultInfo | null {
    const last = this.last;
    if (!last) return null;
    const { tree } = last;
    return { name: displayName(tree, tree.root), bytes: tree.size(tree.root), at: last.at, complete: tree.meta.complete, demo: tree.meta.source === 'demo' };
  }

  /** A survey or result `id` starts: its history entry, and the result now on screen kept. */
  private beginResult(): { token: number; id: number } {
    this.keepResultState();
    this.detached = false;
    const id = ++this.resultSeq;
    this.nav.enter(id);
    return { token: ++this.token, id };
  }

  /** A survey finished (or was stopped): its result is the last one; shown unless the user went home meanwhile. */
  private finishResult(id: number, tree: ScanTree): void {
    this.last = { id, tree, source: this.source, at: Date.now() };
    if (this.detached) {
      this.detached = false;
      this.startView?.setLast(this.lastInfo());
      return;
    }
    this.showResults(tree);
  }

  // ---------- flows ----------

  private readonly pick = (): void => {
    if (this.support === 'picker') {
      pickDirectory().then(
        (handle) => {
          if (handle) void this.scanHandle(handle);
        },
        (error: unknown) => toast(t.errors.openFailed(errorText(error)), 'alert', 6000),
      );
    } else if (this.support === 'files') {
      this.input.value = '';
      this.input.click();
    } else {
      this.showStart();
      toast(t.errors.noFolderSupport, 'alert', 6000);
    }
  };

  /** The demo drive takes its names from the language that is active when it is created. */
  private readonly runDemo = (): void => {
    this.source = { kind: 'demo' };
    const language = lang();
    void this.run(demoRootName(language), (onProgress) => demoScan(onProgress, undefined, language));
  };

  private readonly rescan = (): void => {
    const source = this.source;
    if (!source) return;
    if (source.kind === 'handle') void this.scanHandle(source.handle);
    else if (source.kind === 'demo') this.runDemo();
    else if (source.kind === 'helper') void this.rescanWithHelper(source.path);
    else {
      this.input.value = '';
      this.input.click();
    }
  };

  /** From the helper section: a scan of `path` that the helper has already started as `id`. */
  private readonly surveyWithHelper = (path: string, id?: string): void => {
    const helper = this.helper;
    if (!helper) return;
    this.source = { kind: 'helper', path };
    void this.run(path, (onProgress) => helper.scan(path, id, onProgress));
  };

  /** "Scan again" for a helper scan: check the helper is still there (it quits when idle), then scan. */
  private async rescanWithHelper(path: string): Promise<void> {
    const helper = this.helper;
    if (!helper) return;
    const client = await helper.ensureClient();
    if (client) {
      this.surveyWithHelper(path);
    } else {
      // The start page's helper section shows what is wrong and how to fix it.
      this.toHelper = true;
      this.goHome();
    }
  }

  /** From the results' "not read" note: restart the helper as administrator, then scan the same folder again. */
  private readonly elevateAndRescan = async (): Promise<void> => {
    const helper = this.helper;
    const source = this.source;
    if (!helper || source?.kind !== 'helper') return;
    const outcome = await helper.elevate();
    if (outcome === 'elevated') this.surveyWithHelper(source.path);
    else if (outcome === 'declined') toast(t.helper.declined, 'info', 6000);
    else toast(helper.client ? t.helper.elevateFailed : t.helper.lost, 'alert', 7000);
  };

  private run(name: string, startScan: (onProgress: (p: ScanProgress) => void) => RunningScan): Promise<void> {
    this.cancelRunning();
    const { token, id } = this.beginResult();
    const showScan = (resume?: ScanViewState) => {
      const view = new ScanView({ name, mode: 'scan', onCancel: () => this.running?.cancel(), resume });
      this.show('scan', view, `${t.app.titleScan(name)} – ${APP_NAME}`, { rerender: () => showScan(this.scanView?.state) });
      this.scanView = view;
    };
    showScan();
    let scan: RunningScan;
    try {
      scan = startScan((progress) => {
        if (token === this.token) this.scanView?.update(progress);
      });
    } catch (error) {
      this.showError(error);
      return Promise.resolve();
    }
    this.running = scan;
    this.runningId = id;
    return scan.result.then(
      (tree) => {
        if (token !== this.token) return;
        this.running = null;
        this.finishResult(id, tree);
      },
      (error: unknown) => {
        if (token !== this.token) return;
        this.running = null;
        // Gone to the start page meanwhile: the error has nothing to show there.
        if (this.detached) this.detached = false;
        else this.showError(error);
      },
    );
  }

  private readonly onFilesChosen = (): void => {
    const files = this.input.files;
    if (!files) return;
    this.cancelRunning();
    this.source = { kind: 'files' };
    const { token, id } = this.beginResult();
    const name = files.length > 0 ? files[0].webkitRelativePath.split('/')[0] || t.app.folder : t.app.folder;
    let bytes = 0;
    for (let k = 0; k < files.length; k++) bytes += files[k].size;
    const showReading = (resume?: ScanViewState) => {
      const view = new ScanView({ name, mode: 'files', resume });
      if (!resume) view.showTotals(files.length, bytes);
      this.show('scan', view, `${t.app.titleFiles(name)} – ${APP_NAME}`, { rerender: () => showReading(this.scanView?.state) });
      this.scanView = view;
    };
    showReading();
    // Let the scan view paint before the (synchronous) tree is built.
    requestAnimationFrame(() =>
      window.setTimeout(() => {
        if (token !== this.token) return;
        try {
          this.finishResult(id, treeFromFiles(files, t.app.emptyFolder));
        } catch (error) {
          this.showError(error);
        }
      }, 40),
    );
  };

  private cancelRunning(): void {
    this.running?.cancel();
    this.running = null;
  }

  // ---------- views ----------

  private showStart(knowOpen = false): void {
    const helper = this.helper ? { link: this.helper, onSurvey: this.surveyWithHelper } : null;
    const view = new StartView({ support: this.support, onPick: this.pick, onDemo: this.runDemo, knowOpen, helper, last: this.lastInfo(), onOpenLast: this.openLast });
    this.show('start', view, `${APP_NAME} – ${t.app.titleStart}`, { rerender: () => this.showStart(this.startView?.knowOpen) });
    this.startView = view;
  }

  /**
   * `restore`: the state of the view this one replaces (language switch, an item recycled),
   * or of the last result brought back (`focusView`: then the view gets the focus as new).
   */
  private showResults(tree: ScanTree, restore?: ResultsState, focusView = !restore): void {
    // Offer the administrator restart only for helper scans without it, while the helper is connected.
    const canElevate = tree.meta.source === 'helper' && tree.meta.helper?.elevated === false && !!this.helper?.client && this.source?.kind === 'helper';
    // Clean-up actions: helper scans only; the scan says which actions its helper offered.
    let cleanup =
      tree.meta.source === 'helper' && this.helper
        ? new Cleanup({
            tree,
            link: this.helper,
            onRemoved: (entry, how) => this.removed(tree, entry, how),
            onPartial: (entry) => this.partlyDeleted(tree, entry),
            onRescan: this.rescan,
            fallbackFocus: () => this.resultsView?.el.querySelector<HTMLElement>('.ftree__scroller') ?? null,
          })
        : null;
    // A helper without any action (an older one, or not on Windows): no empty action columns.
    if (cleanup && !cleanup.offers('reveal') && !cleanup.offers('recycle') && !cleanup.offers('delete')) cleanup = null;
    const view = new ResultsView({
      tree,
      theme: this.theme,
      onRescan: this.source ? this.rescan : null,
      onOtherFolder: this.pick,
      onHome: this.goHome,
      onElevate: canElevate ? this.elevateAndRescan : null,
      cleanup,
      restore,
    });
    this.show('results', view, `${displayName(tree, tree.root)} · ${formatBytes(tree.size(tree.root))} – ${APP_NAME}`, {
      context: view.context,
      actions: view.actions,
      rerender: () => this.showResults(tree, this.resultsView?.snapshot()),
    });
    this.resultsView = view;
    if (focusView) view.focus();
  }

  /** An item is in the Recycle Bin now, or deleted: take it out of the results everywhere, keep the place. */
  private removed(tree: ScanTree, entry: number, how: CleanupMode): void {
    const view = this.resultsView;
    if (!view || view.tree !== tree) return;
    const name = displayName(tree, entry);
    const size = formatBytes(tree.size(entry));
    // The dialog gave the focus back to the control that opened it: a list in a tab, or the tree.
    const opener = document.activeElement;
    const fromPanel = opener instanceof HTMLElement && !!opener.closest('.tabpanel:not(.tabpanel--tree)');
    const removal = tree.remove(entry);
    if (!removal) return;
    const state = view.afterRemoval(removal);
    this.relocalizing = true;
    try {
      this.showResults(tree, state);
    } finally {
      this.relocalizing = false;
    }
    if (fromPanel) this.resultsView?.focusPanel();
    else this.resultsView?.focusTree();
    toast(how === 'permanent' ? t.cleanup.deleted(name, size) : t.cleanup.done(name, size), how === 'permanent' ? 'trashX' : 'trash', 8000);
  }

  /**
   * A folder was deleted only in part: it stays with its scanned numbers (which of its entries
   * are gone is unknown), marked in the tree, and a note says the numbers may be off.
   */
  private partlyDeleted(tree: ScanTree, entry: number): void {
    const view = this.resultsView;
    if (!view || view.tree !== tree) return;
    tree.markPartial(entry);
    const state = view.snapshot();
    this.relocalizing = true;
    try {
      this.showResults(tree, state);
    } finally {
      this.relocalizing = false;
    }
  }

  private showError(error: unknown): void {
    const fromHelper = this.source?.kind === 'helper';
    let title = t.errors.title;
    let message = t.errors.message;
    let detail = errorText(error);
    if (error instanceof HelperError) {
      if (error.kind === 'not-running') {
        this.helper?.lost();
        [title, message, detail] = [t.errors.helperLostTitle, t.errors.helperLostText, ''];
      } else if (error.kind === 'denied') {
        [title, message, detail] = [t.errors.helperDeniedTitle, t.errors.helperDeniedText, ''];
      } else {
        [title, message] = [t.errors.helperFailedTitle, t.errors.helperFailedText];
      }
    }
    const view = noticeView({
      title,
      message,
      detail,
      primary: this.source ? { label: t.errors.retry, action: this.rescan } : undefined,
      secondary: fromHelper ? { label: t.errors.backToStart, action: this.goHome } : { label: t.errors.otherFolder, action: this.pick },
    });
    const relocalizing = this.relocalizing;
    this.show('notice', view, `${t.app.titleError} – ${APP_NAME}`, { rerender: () => this.showError(error) });
    if (!relocalizing) view.el.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }

  private show(name: ViewName, view: View, title: string, options: ShowOptions): void {
    const scrollY = window.scrollY;
    this.view?.destroy();
    tooltip.hide();
    this.startView = null;
    this.scanView = null;
    this.resultsView = null;
    this.view = view;
    this.viewEl.replaceWith(view.el);
    this.viewEl = view.el;
    this.shell.dataset.view = name;
    this.context.replaceChildren(...(options.context ? [options.context] : []));
    this.actions.replaceChildren(...(options.actions ? [options.actions] : []));
    this.rerender = options.rerender;
    document.title = title;
    // A language switch keeps the reader where they were; a new view starts at the top.
    window.scrollTo(0, this.relocalizing ? scrollY : 0);
  }

  // ---------- drag & drop ----------

  private installDragAndDrop(): void {
    const hasFiles = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files');
    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      this.dragDepth++;
      this.setDragging(true);
    });
    window.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = this.canDrop() ? 'copy' : 'none';
    });
    window.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.setDragging(false);
    });
    window.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      this.dragDepth = 0;
      this.setDragging(false);
      this.onDrop(event);
    });
  }

  private canDrop(): boolean {
    return this.support === 'picker' && this.shell.dataset.view !== 'scan';
  }

  private setDragging(on: boolean): void {
    const show = on && this.canDrop();
    if (this.startView) this.startView.setDragOver(show);
    else this.dropOverlay.hidden = !show;
  }

  private onDrop(event: DragEvent): void {
    if (this.shell.dataset.view === 'scan') {
      toast(t.drop.busy, 'info');
      return;
    }
    // Must run synchronously inside the drop handler.
    const pending = this.support === 'picker' ? dirHandleFromDrop(event) : null;
    if (!pending) {
      toast(this.support === 'picker' ? t.drop.notFolder : t.drop.unsupported, 'info', 5000);
      return;
    }
    pending.then(
      (handle) => {
        if (handle) void this.scanHandle(handle);
        else toast(t.drop.singleFile, 'info', 5000);
      },
      () => toast(t.drop.openFailed, 'alert', 5000),
    );
  }
}

/** The browser's own wording when it gives one (often English), else ours. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || t.errors.scanFailed;
  return String(error) || t.errors.scanFailed;
}
