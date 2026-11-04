import {
  downloadText,
  filesCsv,
  foldersCsv,
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  formatPercent,
  type DuplicateOptions,
  type Removal,
  type ScanTree,
} from '../../core';
import { APP_NAME } from '../brand';
import type { Cleanup } from '../cleanup';
import { h, setText, uniqueId } from '../dom';
import { displayName, displayPath, safeFilename } from '../format';
import { plural, t } from '../i18n';
import { icon, type IconName } from '../icons';
import { closeMenu, menuButton, openContextMenu, type MenuItem } from '../menu';
import type { ThemeManager } from '../theme';
import { copyText, toast } from '../toast';
import { AnalysisCache } from './analysis-cache';
import { DuplicatesPanel } from './duplicates';
import { FileAgePanel } from './file-age';
import { FileTypesPanel } from './file-types';
import { FolderTree, type FolderTreeState } from './folder-tree';
import { TopFilesPanel } from './top-files';
import { TreemapView } from './treemap';

export interface ResultsViewOptions {
  tree: ScanTree;
  theme: ThemeManager;
  /** null: this tree cannot be scanned again (handed in from outside). */
  onRescan: (() => void) | null;
  onOtherFolder: () => void;
  /** A helper scan without administrator rights, helper connected: restart it elevated and scan again. */
  onElevate?: (() => Promise<void>) | null;
  /** Show in Explorer / Move to Recycle Bin (helper scans whose helper offers them); null otherwise. */
  cleanup?: Cleanup | null;
  /** State of an earlier view of the same tree (the language changed): carry on from there. */
  restore?: ResultsState;
}

type TabId = 'tree' | 'map' | 'top' | 'types' | 'age' | 'dupes';

/** Everything a results view needs to be rebuilt as it was. */
export interface ResultsState {
  cache: AnalysisCache;
  selected: number;
  current: number;
  active: TabId;
  folderTree: FolderTreeState | null;
  isolate: number;
  explainOpen: boolean;
  panelScroll: number;
  /** The duplicates tab's options. */
  dupes?: DuplicateOptions;
}

const TABS: Array<{ id: TabId; icon: IconName }> = [
  { id: 'tree', icon: 'tree' },
  { id: 'map', icon: 'map' },
  { id: 'top', icon: 'list' },
  { id: 'types', icon: 'pie' },
  { id: 'age', icon: 'clock' },
  { id: 'dupes', icon: 'duplicate' },
];

const WIDE = '(min-width: 1100px)';
const SPLIT_KEY = 'diskatlas:split';
/** Tree pane share in %: room for all five tree columns next to a usable map at 1440 px. */
const DEFAULT_SPLIT = 46;

interface Panel {
  el: HTMLElement;
  update(folder: number): void;
  destroy?(): void;
}

/**
 * The results: summary, notes, and the workspace. On wide screens the folder tree and
 * a tabbed panel sit side by side with a draggable divider; on narrow screens the tree
 * becomes the first tab. The right side is always about the current folder: the
 * selected entry if it is a folder, else its parent.
 */
export class ResultsView {
  readonly el: HTMLElement;
  /** Shown in the top bar while this view is open. */
  readonly context: HTMLElement;
  readonly actions: HTMLElement;
  readonly tree: ScanTree;
  private readonly cache: AnalysisCache;
  private readonly restoredDupes: DuplicateOptions | undefined;
  private readonly folderTree: FolderTree | null = null;
  private readonly map: TreemapView | null = null;
  private readonly panels = new Map<TabId, Panel>();
  private readonly tabButtons = new Map<TabId, HTMLButtonElement>();
  private readonly tabPanels = new Map<TabId, HTMLElement>();
  private readonly treePane: HTMLElement;
  private readonly workspace: HTMLElement;
  private readonly crumbs: HTMLElement;
  private readonly crumbStats: HTMLElement;
  private explainToggle: HTMLElement | null = null;
  private readonly media = window.matchMedia(WIDE);
  private readonly ids = uniqueId('res');
  private active: TabId = 'map';
  private selected: number;
  private current: number;
  private shown = -1;
  private debounce = 0;
  private readonly onMedia = () => this.applyLayout();

  constructor(private readonly options: ResultsViewOptions) {
    const tree = options.tree;
    const restore = options.restore;
    this.tree = tree;
    this.cache = restore?.cache ?? new AnalysisCache(tree);
    this.selected = restore?.selected ?? tree.root;
    this.current = restore?.current ?? tree.root;
    this.active = restore?.active ?? 'map';
    this.restoredDupes = restore?.dupes;

    this.context = this.buildContext();
    this.actions = this.buildActions();

    this.crumbs = h('ol', { class: 'crumbs__list' });
    this.crumbStats = h('p', { class: 'crumbs__stats num' });
    this.treePane = h('div', { class: 'pane pane--tree' });
    this.workspace = h('div', { class: 'workspace' });

    const empty = tree.childCount(tree.root) === 0;
    if (!empty) {
      this.folderTree = new FolderTree({
        tree,
        state: restore?.folderTree ?? undefined,
        onSelect: (entry, via) => this.select(entry, via),
        onActivate: (entry) => this.showInMap(entry),
        onHover: (entry) => this.map?.setLinked(entry),
        onCopy: (entry) => void this.copyPath(entry),
        actions: options.cleanup ?? null,
        onContextMenu: (entry, at, returnFocus) => this.entryMenu(entry, at, returnFocus),
      });
      this.treePane.append(this.folderTree.el);
      this.map = new TreemapView({
        tree,
        theme: options.theme,
        isolate: restore?.isolate,
        onOpenFolder: (dir) => this.navigate(dir),
        onSelectEntry: (entry) => this.navigate(entry),
        onHover: (entry) => this.folderTree?.setLinked(entry),
        onContextMenu: (entry, at) => this.entryMenu(entry, at, null),
      });
    }

    this.el = h(
      'main',
      { class: 'view view--results', id: 'main' },
      h('h1', { class: 'sr-only', tabindex: '-1', text: t.results.heading(displayName(tree, tree.root)) }),
      this.buildSummary(restore?.explainOpen ?? false),
      ...this.buildBanners(),
      empty ? this.buildEmpty() : this.buildWorkspace(),
    );

    if (!empty) {
      this.media.addEventListener('change', this.onMedia);
      this.applyLayout();
      this.applyCurrent();
      const scroll = restore?.panelScroll ?? 0;
      if (scroll > 0) {
        // The view is attached after construction; restore the panel's scroll before the first paint.
        requestAnimationFrame(() => {
          const panel = this.tabPanels.get(this.active);
          if (panel) panel.scrollTop = scroll;
        });
      }
    }
  }

  /** The view's state, for rebuilding it in another language. */
  snapshot(): ResultsState {
    return {
      cache: this.cache,
      selected: this.selected,
      current: this.current,
      active: this.active,
      folderTree: this.folderTree?.state ?? null,
      isolate: this.map?.isolated ?? -1,
      explainOpen: this.explainToggle?.getAttribute('aria-expanded') === 'true',
      panelScroll: this.tabPanels.get(this.active)?.scrollTop ?? 0,
      dupes: (this.panels.get('dupes') as DuplicatesPanel | undefined)?.settings ?? this.restoredDupes,
    };
  }

  /**
   * The state to rebuild with after `removal` (an item went to the Recycle Bin): the
   * analysis is stale, and the selection moves to the item's parent, shown in the tree.
   * The tabs stay on their folder (a list being worked through keeps its place), unless
   * that folder is gone too.
   */
  afterRemoval(removal: Removal): ResultsState {
    const state = this.snapshot();
    const gone = (i: number) => this.tree.removed(i);
    state.cache.clear();
    state.selected = removal.parent;
    if (gone(state.current)) state.current = removal.parent;
    const tree = state.folderTree;
    if (tree) {
      const expanded = new Set(tree.expanded.filter((e) => !gone(e)));
      for (let a = this.tree.parent(removal.parent); a >= 0; a = this.tree.parent(a)) expanded.add(a);
      tree.expanded = [...expanded];
      tree.selected = removal.parent;
      tree.active = removal.parent;
      tree.reveal = true;
    }
    return state;
  }

  /** Keyboard focus to the folder tree (after a rebuilt view), or the heading when there is none. */
  focusTree(): void {
    if (this.folderTree && (this.media.matches || this.active === 'tree')) this.folderTree.focus();
    else this.focus();
  }

  /** Keyboard focus to the open tab's panel (an action in its list rebuilt the view). */
  focusPanel(): void {
    const panel = this.tabPanels.get(this.active);
    if (panel && this.active !== 'tree' && !panel.hidden) panel.focus({ preventScroll: true });
    else this.focusTree();
  }

  /** The context menu for an entry (tree row or map region). */
  private entryMenu(entry: number, at: { x: number; y: number }, returnFocus: HTMLElement | null): void {
    const cleanup = this.options.cleanup ?? null;
    const items: MenuItem[] = [];
    if (this.tree.isDir(entry) && entry !== this.current) items.push({ label: t.results.openFolder, icon: 'folder', run: () => this.navigate(entry) });
    items.push({ label: t.cleanup.copyPath, icon: 'copy', run: () => void this.copyPath(entry) });
    if (cleanup?.canReveal(entry)) items.push({ label: t.cleanup.reveal, icon: 'folderOpen', run: () => cleanup.reveal(entry, returnFocus) });
    if (cleanup?.canRecycle(entry)) items.push({ label: `${t.cleanup.recycle}…`, icon: 'trash', danger: true, run: () => cleanup.recycle(entry, returnFocus) });
    openContextMenu(at, { label: `${t.cleanup.menu}: ${displayName(this.tree, entry)}`, items }, returnFocus);
  }

  destroy(): void {
    window.clearTimeout(this.debounce);
    this.media.removeEventListener('change', this.onMedia);
    closeMenu();
    this.folderTree?.destroy();
    this.map?.destroy();
    for (const panel of this.panels.values()) panel.destroy?.();
  }

  /** Where keyboard focus should go when the view opens. */
  focus(): void {
    (this.el.querySelector('h1') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  // ---------- selection model ----------

  private select(entry: number, via: 'pointer' | 'keyboard' | 'map'): void {
    this.selected = entry;
    this.current = this.tree.isDir(entry) ? entry : Math.max(0, this.tree.parent(entry));
    window.clearTimeout(this.debounce);
    if (via === 'keyboard') this.debounce = window.setTimeout(() => this.applyCurrent(), 110);
    else this.applyCurrent();
  }

  /** From the map or the breadcrumb: select in the tree too (expanding and scrolling to it). */
  private navigate(entry: number): void {
    this.folderTree?.select(entry);
    this.select(entry, 'map');
  }

  private showInMap(entry: number): void {
    if (entry !== this.selected) this.select(entry, 'pointer');
    window.clearTimeout(this.debounce);
    this.applyCurrent();
    this.activate('map', false);
    this.map?.pulse(entry);
  }

  private applyCurrent(): void {
    const { tree } = this;
    if (this.shown !== this.current) {
      this.shown = this.current;
      this.renderCrumbs();
    }
    this.map?.setFolder(this.current, this.selected);
    this.panels.get(this.active)?.update(this.current);
    const folder = this.current;
    const parts = [formatBytes(tree.size(folder))];
    if (folder !== tree.root && tree.size(tree.root) > 0) parts.push(t.results.ofTotal(formatPercent(tree.size(folder) / tree.size(tree.root))));
    parts.push(plural(tree.fileCount(folder), t.files));
    setText(this.crumbStats, parts.join(' · '));
  }

  private renderCrumbs(): void {
    const { tree } = this;
    const chain = tree.ancestors(this.current);
    // Deep paths keep the first and the last two segments; the ones between go behind "…".
    const segments: Array<number | number[]> = chain.length > 4 ? [chain[0], chain.slice(1, -2), ...chain.slice(-2)] : chain;
    const items = segments.map((segment, k) => {
      if (Array.isArray(segment)) {
        const names = segment.map((i) => displayName(tree, i));
        const more = h('button', { class: 'crumbs__link crumbs__more', type: 'button', title: names.join(' › '), 'aria-label': `${plural(segment.length, t.results.crumbsMore)}: ${names.join(', ')}`, text: '…' });
        menuButton(more, () => ({
          label: t.results.crumbsBetween,
          items: segment.map((i, n) => ({ label: names[n], icon: 'folder' as const, run: () => this.navigate(i) })),
        }));
        return h('li', { class: 'crumbs__item crumbs__item--more' }, more);
      }
      const last = k === segments.length - 1;
      const name = displayName(tree, segment);
      const content = last
        ? h('span', { class: 'crumbs__current', 'aria-current': 'location', title: name, text: name })
        : h('button', { class: 'crumbs__link', type: 'button', title: t.results.goTo(name), text: name, onclick: () => this.navigate(segment) });
      return h('li', { class: last ? 'crumbs__item crumbs__item--last' : 'crumbs__item' }, content);
    });
    this.crumbs.replaceChildren(...items);
    const up = this.crumbs.parentElement?.querySelector<HTMLButtonElement>('.crumbs__up');
    if (up) up.disabled = this.current === tree.root;
  }

  // ---------- layout & tabs ----------

  private applyLayout(): void {
    const wide = this.media.matches;
    this.workspace.dataset.layout = wide ? 'split' : 'tabs';
    const treeTab = this.tabButtons.get('tree');
    const treePanel = this.tabPanels.get('tree');
    if (!treeTab || !treePanel) return;
    if (wide) {
      this.workspace.prepend(this.treePane);
      treeTab.hidden = true;
      if (this.active === 'tree') this.activate('map', false);
    } else {
      treePanel.append(this.treePane);
      treeTab.hidden = false;
    }
  }

  private activate(id: TabId, focus: boolean): void {
    if (id === 'tree' && this.media.matches) id = 'map';
    this.active = id;
    for (const [tab, button] of this.tabButtons) {
      const on = tab === id;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      this.tabPanels.get(tab)!.hidden = !on;
    }
    if (focus) this.tabButtons.get(id)?.focus();
    this.ensurePanel(id)?.update(this.current);
  }

  private ensurePanel(id: TabId): Panel | undefined {
    let panel = this.panels.get(id);
    if (panel || id === 'tree') return panel;
    if (id === 'top') {
      panel = new TopFilesPanel({
        tree: this.tree,
        cache: this.cache,
        onReveal: (entry) => this.revealInTree(entry),
        onExport: (folder) => this.exportFiles(folder),
        actions: this.options.cleanup ?? null,
      });
    } else if (id === 'types') {
      panel = new FileTypesPanel(this.tree, this.cache);
    } else if (id === 'age') {
      panel = new FileAgePanel(this.tree, this.cache);
    } else if (id === 'dupes') {
      panel = new DuplicatesPanel({
        tree: this.tree,
        cache: this.cache,
        actions: this.options.cleanup ?? null,
        onSelect: (entry) => this.revealInTree(entry),
        settings: this.restoredDupes,
      });
    }
    if (!panel) return undefined;
    this.panels.set(id, panel);
    this.tabPanels.get(id)!.append(panel.el);
    return panel;
  }

  /**
   * From "Largest files": select the file in the tree (so its path can be copied from the
   * tree's footer), but keep the panel on its folder, so the list does not change under the
   * pointer. The next navigation goes back to the usual rule.
   */
  private revealInTree(entry: number): void {
    if (!this.media.matches) this.activate('tree', false);
    window.clearTimeout(this.debounce);
    this.selected = entry;
    this.folderTree?.select(entry, true);
    this.map?.setSelected(entry);
  }

  private onTabKey = (event: KeyboardEvent): void => {
    const visible = TABS.map((t) => t.id).filter((id) => !this.tabButtons.get(id)!.hidden);
    const index = visible.indexOf(this.active);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % visible.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + visible.length) % visible.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visible.length - 1;
    else return;
    event.preventDefault();
    this.activate(visible[next], true);
  };

  // ---------- building blocks ----------

  private buildContext(): HTMLElement {
    const { tree } = this;
    const source = tree.meta.source;
    const chip = !tree.meta.complete ? t.results.chipIncomplete : source === 'demo' ? t.results.chipDemo : source === 'files' ? t.results.chipLimited : null;
    return h(
      'div',
      { class: 'topbar__context' },
      h('span', { class: 'topbar__sep', 'aria-hidden': 'true' }),
      icon('folder', 'topbar__folder-icon'),
      h('span', { class: 'topbar__folder', title: displayName(tree, tree.root), text: displayName(tree, tree.root) }),
      chip ? h('span', { class: `chip${!tree.meta.complete ? ' chip--warn' : ''}`, text: chip }) : null,
    );
  }

  private buildActions(): HTMLElement {
    const actions = h('div', { class: 'topbar__actions' });
    if (this.options.onRescan) {
      const rescan = h('button', { class: 'btn btn--ghost', type: 'button', title: t.results.rescanTitle }, icon('refresh'), h('span', { class: 'btn__label', text: t.results.rescan }));
      rescan.setAttribute('aria-label', t.results.rescan);
      rescan.addEventListener('click', this.options.onRescan);
      actions.append(rescan);
    }
    const other = h('button', { class: 'btn btn--ghost', type: 'button', title: t.results.otherTitle }, icon('folderOpen'), h('span', { class: 'btn__label', text: t.results.other }));
    other.setAttribute('aria-label', t.results.other);
    other.addEventListener('click', this.options.onOtherFolder);
    actions.append(other, this.buildExportMenu());
    return actions;
  }

  private buildExportMenu(): HTMLElement {
    const button = h(
      'button',
      { class: 'btn btn--secondary', type: 'button', 'aria-label': t.results.export },
      icon('download'),
      h('span', { class: 'btn__label', text: t.results.export }),
      icon('chevronDown', 'btn__caret'),
    );
    menuButton(button, () => ({
      label: t.results.export,
      align: 'end',
      caption: t.results.exportCaption(displayName(this.tree, this.current)),
      items: [
        { label: t.results.exportFolders, icon: 'tree', run: () => this.exportFolders(this.current) },
        { label: t.results.exportFiles, icon: 'list', run: () => this.exportFiles(this.current) },
      ],
    }));
    return button;
  }

  private buildSummary(explainOpen: boolean): HTMLElement {
    const { tree } = this;
    let unreadable = 0;
    let deep = 0;
    for (let i = 0; i < tree.count; i++) {
      if (tree.removed(i)) continue;
      if (tree.unreadable(i)) unreadable++;
      else if (tree.tooDeep(i)) deep++;
    }
    const cell = (label: string, value: string, extra = '') =>
      h('div', { class: `summary__cell ${extra}` }, h('span', { class: 'label', text: label }), h('span', { class: 'summary__value num', text: value }));

    const cells = [
      cell(t.results.totalSize, formatBytes(tree.size(tree.root)), 'summary__cell--hero'),
      tree.hasAllocated ? cell(t.results.onDisk, formatBytes(tree.allocated(tree.root))) : null,
      cell(t.results.files, formatCount(tree.fileCount(tree.root))),
      cell(t.results.folders, formatCount(tree.dirCount(tree.root))),
      cell(t.results.duration, formatDuration(tree.meta.durationMs)),
    ];
    let explain: HTMLElement | null = null;
    if (unreadable + deep > 0) {
      const id = `${this.ids}-unreadable`;
      const parts: string[] = [];
      const short: string[] = [];
      if (unreadable) {
        parts.push(plural(unreadable, t.results.unreadable));
        short.push(plural(unreadable, t.results.unreadableShort));
      }
      if (deep) {
        parts.push(plural(deep, t.results.tooDeep));
        short.push(plural(deep, t.results.tooDeepShort));
      }
      // Phones show the short wording, so the value stays on one line in the 2 × 2 grid.
      const toggle = h(
        'button',
        { class: 'summary__toggle', type: 'button', 'aria-expanded': String(explainOpen), 'aria-controls': id, 'aria-label': parts.join(', ') },
        icon('lock'),
        h('span', { class: 'num summary__long', text: parts.join(', ') }),
        h('span', { class: 'num summary__short', text: short.join(', ') }),
        icon('chevronDown', 'summary__caret'),
      );
      explain = h('div', { class: 'summary__explain', id, hidden: !explainOpen }, ...this.explainContent(deep > 0));
      this.explainToggle = toggle;
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(open));
        explain!.hidden = !open;
      });
      cells.push(h('div', { class: 'summary__cell summary__cell--warn' }, h('span', { class: 'label', text: t.results.notRead }), toggle));
    }
    const when = tree.meta.startedAt ? t.results.surveyedAt(formatDateTime(tree.meta.startedAt)) : '';
    return h(
      'section',
      { class: 'summary', 'aria-label': t.results.summary },
      h('div', { class: 'summary__cells' }, ...cells, when ? h('p', { class: 'summary__when', text: when }) : null),
      explain,
    );
  }

  /** Why entries were not read; for a helper scan without administrator rights, how to read more. */
  private explainContent(deep: boolean): HTMLElement[] {
    const { meta } = this.tree;
    if (meta.source !== 'helper') return [h('p', null, t.results.explain(deep))];
    const notElevated = meta.helper?.elevated === false;
    const text = h('p', null, t.results.explainHelper(deep), notElevated ? ` ${t.results.elevateHint}` : '');
    const onElevate = this.options.onElevate;
    if (!notElevated || !onElevate) return [text];
    const label = h('span', { text: t.results.elevateRescan });
    const button = h('button', { class: 'btn btn--secondary btn--sm summary__elevate', type: 'button' }, icon('shield'), label);
    button.addEventListener('click', async () => {
      button.disabled = true;
      setText(label, t.results.elevateWaiting);
      try {
        await onElevate();
      } finally {
        // Still here when Windows' prompt was declined.
        button.disabled = false;
        setText(label, t.results.elevateRescan);
      }
    });
    return [text, button];
  }

  private buildBanners(): HTMLElement[] {
    const { tree } = this;
    const out: HTMLElement[] = [];
    if (!tree.meta.complete) {
      const action = this.options.onRescan
        ? h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: this.options.onRescan }, icon('refresh'), t.results.scanFully)
        : null;
      out.push(banner('warn', 'alert', t.results.incompleteTitle, t.results.incompleteText, action));
    }
    if (tree.meta.source === 'files') {
      out.push(banner('info', 'info', t.results.limitedTitle, t.results.limitedText, null));
    }
    if (tree.meta.source === 'demo') {
      const action = h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: this.options.onOtherFolder }, icon('folderOpen'), t.results.demoOwn);
      out.push(banner('info', 'map', t.results.demoTitle, t.results.demoText, action));
    }
    return out.length ? [h('div', { class: 'banners' }, ...out)] : [];
  }

  private buildEmpty(): HTMLElement {
    const other = h('button', { class: 'btn btn--primary', type: 'button' }, icon('folderOpen'), t.results.emptyOther);
    other.addEventListener('click', this.options.onOtherFolder);
    const locked = this.tree.unreadable(this.tree.root);
    return h(
      'section',
      { class: 'empty-state' },
      icon(locked ? 'lock' : 'folder', 'empty-state__icon'),
      h('h2', { class: 'empty-state__title', text: locked ? t.results.lockedTitle : t.results.emptyTitle }),
      h('p', { class: 'empty-state__text', text: locked ? t.results.lockedText : t.results.emptyText }),
      other,
    );
  }

  private buildWorkspace(): HTMLElement {
    const up = h('button', { class: 'btn btn--ghost btn--icon btn--sm crumbs__up', type: 'button', title: t.results.up, 'aria-label': t.results.up }, icon('levelUp'));
    up.addEventListener('click', () => {
      if (this.current !== this.tree.root) this.navigate(this.tree.parent(this.current));
    });
    const nav = h('nav', { class: 'crumbs', 'aria-label': t.results.crumbs }, up, this.crumbs);

    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': t.results.tabs });
    tablist.addEventListener('keydown', this.onTabKey);
    const panelsHost = h('div', { class: 'tabpanels' });
    for (const tab of TABS) {
      const tabId = `${this.ids}-tab-${tab.id}`;
      const panelId = `${this.ids}-panel-${tab.id}`;
      const button = h(
        'button',
        { class: 'tab', type: 'button', role: 'tab', id: tabId, 'aria-controls': panelId, 'aria-selected': 'false', tabindex: '-1', 'aria-label': t.results.tab[tab.id] },
        icon(tab.icon),
        h('span', { class: 'tab__long', text: t.results.tab[tab.id] }),
        h('span', { class: 'tab__short', 'aria-hidden': 'true', text: t.results.tabShort[tab.id] }),
      );
      button.addEventListener('click', () => this.activate(tab.id, false));
      this.tabButtons.set(tab.id, button);
      tablist.append(button);
      const panel = h('div', { class: `tabpanel tabpanel--${tab.id}`, role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, tabindex: tab.id === 'tree' ? '-1' : '0', hidden: true });
      this.tabPanels.set(tab.id, panel);
      panelsHost.append(panel);
    }
    this.tabPanels.get('map')!.append(this.map!.el);

    const main = h(
      'div',
      { class: 'pane pane--main' },
      h('div', { class: 'pane__bar' }, nav, this.crumbStats),
      tablist,
      panelsHost,
    );
    this.workspace.append(this.buildSplitter(), main);
    this.activate(this.active, false);
    return this.workspace;
  }

  private buildSplitter(): HTMLElement {
    const min = 28;
    const max = 68;
    let value = DEFAULT_SPLIT;
    try {
      const stored = Number(localStorage.getItem(SPLIT_KEY));
      if (stored >= min && stored <= max) value = stored;
    } catch {
      // no storage: default width
    }
    const splitter = h('div', {
      class: 'splitter',
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': t.results.splitter,
      'aria-valuemin': String(min),
      'aria-valuemax': String(max),
      title: t.results.splitterTitle,
    });
    const set = (v: number, persist: boolean) => {
      value = Math.min(max, Math.max(min, v));
      this.workspace.style.setProperty('--split', `${value}%`);
      splitter.setAttribute('aria-valuenow', String(Math.round(value)));
      splitter.setAttribute('aria-valuetext', t.results.splitterValue(formatCount(Math.round(value))));
      if (persist) {
        try {
          localStorage.setItem(SPLIT_KEY, String(Math.round(value)));
        } catch {
          // ignore
        }
      }
    };
    set(value, false);
    splitter.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('is-dragging');
      const box = this.workspace.getBoundingClientRect();
      const move = (e: PointerEvent) => set(((e.clientX - box.left) / box.width) * 100, false);
      const up = () => {
        splitter.classList.remove('is-dragging');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        splitter.removeEventListener('pointercancel', up);
        set(value, true);
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
      splitter.addEventListener('pointercancel', up);
    });
    splitter.addEventListener('keydown', (event) => {
      const steps: Record<string, number> = { ArrowLeft: -2, ArrowRight: 2, PageDown: -8, PageUp: 8 };
      if (event.key in steps) set(value + steps[event.key], true);
      else if (event.key === 'Home') set(min, true);
      else if (event.key === 'End') set(max, true);
      else return;
      event.preventDefault();
    });
    splitter.addEventListener('dblclick', () => set(DEFAULT_SPLIT, true));
    return splitter;
  }

  // ---------- actions ----------

  private async copyPath(entry: number): Promise<void> {
    const path = displayPath(this.tree, entry);
    const ok = await copyText(path);
    toast(ok ? t.results.copied : t.results.copyFailed, ok ? 'check' : 'alert');
  }

  /** DiskAtlas-folders-Photos.csv: the app, what is in the file, and the folder it is about. */
  private exportName(kind: string, folder: number): string {
    return `${safeFilename(APP_NAME)}-${kind}-${safeFilename(displayName(this.tree, folder), t.results.fileFallback)}.csv`;
  }

  private exportFolders(folder: number): void {
    downloadText(this.exportName(t.results.foldersFile, folder), foldersCsv(this.tree, folder, t.csv));
    toast(t.results.foldersExported, 'download');
  }

  private exportFiles(folder: number): void {
    downloadText(this.exportName(t.results.filesFile, folder), filesCsv(this.tree, this.cache.topFiles(folder), t.csv));
    toast(t.results.filesExported, 'download');
  }
}

function banner(kind: 'warn' | 'info', iconName: IconName, title: string, text: string, action: HTMLElement | null): HTMLElement {
  return h(
    'div',
    { class: `banner banner--${kind}`, role: kind === 'warn' ? 'alert' : 'note' },
    icon(iconName, 'banner__icon'),
    h('p', { class: 'banner__text' }, h('strong', { text: title }), text),
    action,
  );
}
