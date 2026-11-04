import { formatBytes, formatCount, formatDate, formatPercent, type ScanTree } from '../../core';
import { h, setText, uniqueId } from '../dom';
import { displayName, displayPath, splitPath } from '../format';
import { lang, plural, t, type Lang } from '../i18n';
import { icon } from '../icons';
import { categoryVar } from './colors';
import { TreeRows } from './tree-rows';

/** What the tree shows, so a rebuilt tree (after a language switch) looks the same. */
export interface FolderTreeState {
  expanded: number[];
  showFiles: boolean;
  selected: number;
  active: number;
  scrollTop: number;
}

export interface FolderTreeOptions {
  tree: ScanTree;
  state?: FolderTreeState;
  /** The selection moved (selection follows focus, as in Explorer). */
  onSelect: (entry: number, via: 'pointer' | 'keyboard') => void;
  /** Enter: show the entry in the map. */
  onActivate: (entry: number) => void;
  /** Pointer over a row (linked highlighting); -1 when it leaves. */
  onHover: (entry: number) => void;
  onCopy: (entry: number) => void;
}

/** Browsers cap element heights (Firefox near 17.9 million px); taller lists scroll scaled. */
const MAX_SCROLL = 8_000_000;
const OVERSCAN = 6;
/** Indent per level in px (keep in sync with .tr__indent in tree.css). */
const INDENT = 12;
/**
 * Width of the "Modified" column in px (set as --c-date). Dates take 10 characters in German
 * ("03.11.2026") and up to 12 in English ("Nov 28, 2026", "28 Sept 2026").
 */
const DATE_WIDTH: Record<Lang, number> = { de: 78, en: 92 };

/** Why an entry has no (complete) size, or null. */
export function flagText(tree: ScanTree, i: number): string | null {
  if (tree.unreadable(i)) return tree.isDir(i) ? t.flags.unreadableFolder : t.flags.unreadableFile;
  if (tree.tooDeep(i)) return t.flags.tooDeep;
  return null;
}

interface RowView {
  el: HTMLElement;
  row: number;
  entry: number;
  cat: HTMLElement;
  name: HTMLElement;
  flag: HTMLElement;
  size: HTMLElement;
  share: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
  files: HTMLElement;
  date: HTMLElement;
}

/**
 * The folder tree: a virtualized ARIA tree (only visible rows exist in the DOM).
 * Focus stays on the tree element and moves with aria-activedescendant, so recycled
 * row elements never lose keyboard focus.
 */
export class FolderTree {
  readonly el: HTMLElement;
  readonly treeEl: HTMLElement;
  private readonly rows: TreeRows;
  private readonly tree: ScanTree;
  private readonly spacer: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly cols: HTMLElement;
  private readonly filesToggle: HTMLInputElement;
  private readonly selIcon: HTMLElement;
  private readonly selHead: HTMLElement;
  private readonly selTail: HTMLElement;
  private readonly selPath: HTMLElement;
  private readonly selFlag: HTMLElement;
  private readonly idPrefix = uniqueId('ftree');
  private pool: RowView[] = [];
  private rowH = 30;
  private viewH = 0;
  private activeEntry: number;
  /** Row of activeEntry; refreshed whenever the rows or the active entry change. */
  private activeRow = 0;
  private selected: number;
  private linked = -1;
  private flash = -1;
  private flashTimer = 0;
  private hovered = -1;
  private frame = 0;
  private typed = '';
  private typedAt = 0;
  /** Scroll position to restore once the list has a height; -1 = none. */
  private pendingScroll = -1;
  private lastScroll = 0;
  private readonly dateWidth = DATE_WIDTH[lang()];
  private readonly resize: ResizeObserver;

  constructor(private readonly options: FolderTreeOptions) {
    this.tree = options.tree;
    const state = options.state;
    this.rows = new TreeRows(this.tree, state?.showFiles ?? true, state?.expanded);
    this.activeEntry = state?.active ?? this.tree.root;
    this.selected = state?.selected ?? this.tree.root;
    this.pendingScroll = state?.scrollTop ?? -1;
    this.lastScroll = Math.max(0, this.pendingScroll);
    this.syncActive();
    this.rowH = window.matchMedia('(pointer: coarse)').matches ? 40 : 30;

    this.filesToggle = h('input', { type: 'checkbox', role: 'switch' });
    this.filesToggle.checked = this.rows.showFiles;
    this.filesToggle.addEventListener('change', () => this.setShowFiles(this.filesToggle.checked));

    this.cols = h(
      'div',
      { class: 'ftree__cols', 'aria-hidden': 'true' },
      h('span', { class: 'tc tc--name', text: t.tree.colName }),
      h('span', { class: 'tc tc--size', text: t.tree.colSize }),
      h('span', { class: 'tc tc--share', text: t.tree.colShare }),
      h('span', { class: 'tc tc--files', text: t.tree.colFiles }),
      h('span', { class: 'tc tc--date', text: t.tree.colModified, title: t.tree.colModifiedTitle }),
    );

    this.spacer = h('div', { class: 'ftree__spacer' });
    this.layer = h('div', { class: 'ftree__layer', role: 'presentation' });
    this.treeEl = h(
      'div',
      { class: 'ftree__scroller', role: 'tree', tabindex: '0', 'aria-label': t.tree.label, style: { '--row-h': `${this.rowH}px` } },
      this.spacer,
      this.layer,
    );

    const copyButton = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, icon('copy'), t.tree.copyPath);
    copyButton.addEventListener('click', () => options.onCopy(this.selected));
    this.selIcon = h('span', { class: 'selbar__icon' });
    this.selHead = h('span', { class: 'mtrunc__head' });
    this.selTail = h('span', { class: 'mtrunc__tail' });
    this.selPath = h('span', { class: 'mtrunc mono' }, this.selHead, this.selTail);
    this.selFlag = h('p', { class: 'selbar__flag', hidden: true });

    this.el = h(
      'section',
      { class: 'ftree', 'aria-label': t.tree.title, style: { '--c-date': `${this.dateWidth}px` } },
      h(
        'header',
        { class: 'pane__head ftree__head' },
        h('h2', { class: 'pane__title' }, icon('tree'), t.tree.title),
        h('label', { class: 'switch' }, this.filesToggle, t.tree.showFiles),
      ),
      this.cols,
      this.treeEl,
      h(
        'footer',
        { class: 'selbar' },
        h('div', { class: 'selbar__main' }, this.selIcon, h('span', { class: 'sr-only', text: t.tree.selected }), this.selPath, copyButton),
        this.selFlag,
      ),
    );

    this.treeEl.addEventListener(
      'scroll',
      () => {
        if (this.pendingScroll < 0) this.lastScroll = this.treeEl.scrollTop;
        this.schedule();
      },
      { passive: true },
    );
    this.treeEl.addEventListener('click', this.onClick);
    this.treeEl.addEventListener('dblclick', this.onDoubleClick);
    this.treeEl.addEventListener('keydown', this.onKey);
    this.treeEl.addEventListener('pointermove', this.onPointerMove);
    this.treeEl.addEventListener('pointerleave', () => this.setHovered(-1));
    this.treeEl.addEventListener('focus', () => this.schedule());

    this.resize = new ResizeObserver(() => {
      const h = this.treeEl.clientHeight;
      const scrollbar = this.treeEl.offsetWidth - this.treeEl.clientWidth;
      this.cols.style.setProperty('--sbw', `${scrollbar}px`);
      this.updateColumns();
      if (h !== this.viewH) {
        this.viewH = h;
        // Render right away (resize callbacks run before paint), so the list never flashes empty.
        this.render();
      }
    });
    this.resize.observe(this.treeEl);
    this.updateSelectionBar();
  }

  destroy(): void {
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.flashTimer);
  }

  focus(): void {
    this.treeEl.focus({ preventScroll: true });
  }

  /**
   * Select an entry from elsewhere (map, breadcrumb, list): expands to it and scrolls it
   * into view. `flash` briefly highlights the row, for when the user came from a list.
   */
  select(entry: number, flash = false): void {
    if (!this.rows.showFiles && !this.tree.isDir(entry)) this.setShowFiles(true, false);
    const row = this.rows.expandTo(entry);
    this.selected = entry;
    if (row >= 0) {
      this.activeEntry = entry;
      this.activeRow = row;
      this.ensureVisible(row, true);
    } else {
      this.syncActive();
    }
    if (flash && row >= 0) {
      this.flash = entry;
      window.clearTimeout(this.flashTimer);
      this.flashTimer = window.setTimeout(() => {
        this.flash = -1;
        this.render();
      }, 1800);
    }
    this.updateSelectionBar();
    this.render();
  }

  /** Linked highlighting from the map: the entry's row, or its nearest visible ancestor. */
  setLinked(entry: number): void {
    const next = entry < 0 ? -1 : this.rows.entries[this.rows.nearestRow(entry)] ?? -1;
    if (next === this.linked) return;
    this.linked = next;
    this.schedule();
  }

  get selection(): number {
    return this.selected;
  }

  get state(): FolderTreeState {
    return {
      expanded: [...this.rows.expanded],
      showFiles: this.rows.showFiles,
      selected: this.selected,
      active: this.activeEntry,
      scrollTop: this.pendingScroll >= 0 ? this.pendingScroll : this.lastScroll,
    };
  }

  // ---------- internals ----------

  private setShowFiles(show: boolean, notify = true): void {
    this.filesToggle.checked = show;
    this.rows.setShowFiles(show);
    this.syncActive();
    if (!show && !this.tree.isDir(this.selected)) {
      this.selected = this.tree.parent(this.selected);
      this.updateSelectionBar();
      if (notify) this.options.onSelect(this.selected, 'pointer');
    }
    this.ensureVisible(this.activeRow, false);
    this.render();
  }

  /** Re-finds the active entry's row after the rows changed (or its nearest visible ancestor). */
  private syncActive(): void {
    let row = this.rows.indexOf(this.activeEntry);
    if (row < 0) {
      row = Math.max(0, this.rows.nearestRow(this.activeEntry));
      this.activeEntry = this.rows.entries[row];
    }
    this.activeRow = row;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private geometry() {
    const n = this.rows.length;
    const total = n * this.rowH;
    const height = Math.min(total, MAX_SCROLL);
    const scale = total > MAX_SCROLL && height > this.viewH ? (total - this.viewH) / (height - this.viewH) : 1;
    return { n, height, scale };
  }

  private ensureVisible(row: number, center: boolean): void {
    const { scale } = this.geometry();
    const top = row * this.rowH;
    const viewTop = this.treeEl.scrollTop * scale;
    const viewH = this.viewH || this.treeEl.clientHeight;
    let target = viewTop;
    if (center && (top < viewTop || top + this.rowH > viewTop + viewH)) target = top - (viewH - this.rowH) / 2;
    else if (top < viewTop) target = top;
    else if (top + this.rowH > viewTop + viewH) target = top + this.rowH - viewH;
    if (target !== viewTop) this.treeEl.scrollTop = Math.max(0, target / scale);
  }

  /**
   * Which columns fit: the name column must keep room for the deepest visible row's indent
   * plus a readable name. "Modified" goes first, then "Files", then the share bar.
   */
  private updateColumns(): void {
    const width = this.treeEl.clientWidth;
    if (width <= 0) return;
    const gap = 12;
    const room = width - 26; // row padding
    // Indent, then chevron, category mark, icon and their gaps (64 px), then about 20 characters of name.
    const nameNeeds = this.rows.maxDepth * INDENT + 64 + 160;
    const layouts: Array<[cols: string, used: number]> = [
      ['5', 72 + 92 + 60 + this.dateWidth + 4 * gap],
      ['4', 72 + 92 + 60 + 3 * gap],
      ['3', 72 + 92 + 2 * gap],
    ];
    const fit = layouts.find(([, used]) => room - used >= nameNeeds);
    const cols = fit ? fit[0] : '2';
    if (this.el.dataset.cols !== cols) this.el.dataset.cols = cols;
  }

  private render(): void {
    this.updateColumns();
    const { n, height, scale } = this.geometry();
    this.spacer.style.height = `${height}px`;
    if (this.pendingScroll >= 0 && this.treeEl.clientHeight > 0) {
      // Restored state: scroll back once the list is visible and as tall as before.
      this.treeEl.scrollTop = this.pendingScroll;
      this.pendingScroll = -1;
      this.lastScroll = this.treeEl.scrollTop;
    }
    const viewH = this.viewH || this.treeEl.clientHeight || 600;
    const scrollTop = this.treeEl.scrollTop;
    const virtualTop = scrollTop * scale;
    const offset = scrollTop - virtualTop;
    const first = Math.max(0, Math.floor(virtualTop / this.rowH) - OVERSCAN);
    const last = Math.min(n - 1, Math.ceil((virtualTop + viewH) / this.rowH) + OVERSCAN);
    const need = Math.max(0, last - first + 1);

    if (this.pool.length < need) {
      while (this.pool.length < need) this.pool.push(this.makeRow());
      for (const v of this.pool) v.row = -1;
    }
    const size = this.pool.length;
    const used = new Set<number>();
    const activeRow = this.activeRow;
    let activeId = '';
    for (let row = first; row <= last; row++) {
      const slot = row % size;
      used.add(slot);
      const v = this.pool[slot];
      const entry = this.rows.entries[row];
      if (v.row !== row || v.entry !== entry) this.fill(v, row);
      v.el.hidden = false;
      v.el.style.transform = `translateY(${row * this.rowH + offset}px)`;
      this.applyState(v, row === activeRow);
      if (row === activeRow) activeId = v.el.id;
    }
    for (let slot = 0; slot < size; slot++) {
      if (!used.has(slot)) {
        this.pool[slot].el.hidden = true;
        this.pool[slot].row = -1;
      }
    }
    if (activeId) this.treeEl.setAttribute('aria-activedescendant', activeId);
    else this.treeEl.removeAttribute('aria-activedescendant');
  }

  private makeRow(): RowView {
    const cat = h('span', { class: 'tr__cat' });
    const name = h('span', { class: 'tr__name' });
    const flag = h('span', { class: 'tr__flag' }, icon('lock', 'tr__flag-locked'), icon('layers', 'tr__flag-deep'));
    const fill = h('span', { class: 'share__fill' });
    const share = h('span', { class: 'share' }, fill);
    const pct = h('span', { class: 'share__pct num' });
    const size = h('div', { class: 'tc tc--size num' });
    const files = h('div', { class: 'tc tc--files num' });
    const date = h('div', { class: 'tc tc--date num' });
    const el = h(
      'div',
      { class: 'tr', role: 'treeitem', hidden: true },
      h(
        'div',
        { class: 'tc tc--name' },
        h('span', { class: 'tr__indent' }),
        h('span', { class: 'tr__chev' }, icon('chevron')),
        cat,
        h('span', { class: 'tr__kind' }, icon('folder', 'tr__kind-dir'), icon('file', 'tr__kind-file')),
        name,
        flag,
        h('span', { class: 'tr__copy', title: t.tree.copyPath, 'aria-hidden': 'true' }, icon('copy')),
      ),
      size,
      h('div', { class: 'tc tc--share' }, share, pct),
      files,
      date,
    );
    this.layer.append(el);
    return { el, row: -1, entry: -1, cat, name, flag, size, share, fill, pct, files, date };
  }

  private fill(v: RowView, row: number): void {
    const { tree, rows } = this;
    const entry = rows.entries[row];
    const depth = rows.depths[row];
    v.row = row;
    v.entry = entry;
    const el = v.el;
    el.id = `${this.idPrefix}-${entry}`;
    el.dataset.row = String(row);
    el.style.setProperty('--depth', String(depth));
    const dir = tree.isDir(entry);
    el.dataset.kind = dir ? 'dir' : 'file';
    el.setAttribute('aria-level', String(depth + 1));
    el.setAttribute('aria-setsize', String(rows.setSize(entry)));
    el.setAttribute('aria-posinset', String(rows.positions[row]));
    v.cat.style.setProperty('--cat', categoryVar(tree.categoryIndex(entry)));

    const name = displayName(tree, entry);
    setText(v.name, name);
    v.name.title = name;
    const flag = flagText(tree, entry);
    el.dataset.flag = tree.unreadable(entry) ? 'locked' : tree.tooDeep(entry) ? 'deep' : '';
    v.flag.title = flag ?? '';

    const size = tree.size(entry);
    const sizeText = tree.unreadable(entry) && size === 0 ? '–' : formatBytes(size);
    setText(v.size, sizeText);
    const parent = tree.parent(entry);
    let shareText = '';
    if (parent >= 0) {
      const total = tree.size(parent);
      const share = total > 0 ? size / total : 0;
      shareText = formatPercent(share);
      v.fill.style.width = `${Math.max(share > 0 ? 1.5 : 0, share * 100)}%`;
      v.share.hidden = false;
    } else {
      v.share.hidden = true;
    }
    setText(v.pct, shareText);
    setText(v.files, dir ? formatCount(tree.fileCount(entry)) : '');
    setText(v.date, formatDate(tree.mtime(entry)));

    const label = [name, dir ? t.tree.folder : t.tree.file, sizeText];
    if (shareText) label.push(t.tree.ofParent(shareText));
    if (dir) label.push(plural(tree.fileCount(entry), t.files));
    if (tree.mtime(entry) > 0) label.push(t.tree.modifiedOn(formatDate(tree.mtime(entry))));
    if (flag) label.push(flag);
    el.setAttribute('aria-label', label.join(', '));
  }

  private applyState(v: RowView, active: boolean): void {
    const { el, entry } = v;
    const expandable = this.rows.isExpandable(entry);
    el.dataset.expandable = expandable ? 'true' : 'false';
    if (expandable) el.setAttribute('aria-expanded', String(this.rows.expanded.has(entry)));
    else el.removeAttribute('aria-expanded');
    const selected = entry === this.selected;
    el.setAttribute('aria-selected', String(selected));
    el.classList.toggle('is-selected', selected);
    el.classList.toggle('is-active', active);
    el.classList.toggle('is-linked', entry === this.linked && !selected);
    el.classList.toggle('is-flash', entry === this.flash);
  }

  private rowFromEvent(event: Event): number {
    const target = event.target as Element | null;
    const rowEl = target?.closest<HTMLElement>('.tr');
    if (!rowEl || rowEl.dataset.row === undefined) return -1;
    const row = Number(rowEl.dataset.row);
    return row < this.rows.length ? row : -1;
  }

  private readonly onClick = (event: MouseEvent): void => {
    const row = this.rowFromEvent(event);
    if (row < 0) return;
    const target = event.target as Element;
    const entry = this.rows.entries[row];
    if (target.closest('.tr__copy')) {
      this.options.onCopy(entry);
      return;
    }
    if (target.closest('.tr__chev')) {
      this.toggleRow(row);
      return;
    }
    this.moveTo(row, 'pointer');
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const row = this.rowFromEvent(event);
    if (row < 0) return;
    const target = event.target as Element;
    if (target.closest('.tr__chev, .tr__copy')) return;
    const entry = this.rows.entries[row];
    if (this.rows.isExpandable(entry)) this.toggleRow(row);
    else this.options.onActivate(entry);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    const row = this.rowFromEvent(event);
    this.setHovered(row < 0 ? -1 : this.rows.entries[row]);
  };

  private setHovered(entry: number): void {
    if (entry === this.hovered) return;
    this.hovered = entry;
    this.options.onHover(entry);
  }

  private toggleRow(row: number): void {
    // A collapsed folder takes the focus of anything that was inside it (nearest visible ancestor).
    this.rows.toggle(row);
    this.syncActive();
    this.render();
  }

  private moveTo(row: number, via: 'pointer' | 'keyboard'): void {
    const entry = this.rows.entries[row];
    if (entry === undefined) return;
    this.activeEntry = entry;
    this.activeRow = row;
    this.ensureVisible(row, false);
    if (entry !== this.selected) {
      this.selected = entry;
      this.updateSelectionBar();
      this.options.onSelect(entry, via);
    }
    this.render();
  }

  private pageRows(): number {
    return Math.max(1, Math.floor((this.viewH || 300) / this.rowH) - 1);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    const n = this.rows.length;
    if (n === 0) return;
    const { rows } = this;
    let row = Math.min(this.activeRow, n - 1);
    const entry = rows.entries[row];
    switch (event.key) {
      case 'ArrowDown':
        row = Math.min(n - 1, row + 1);
        break;
      case 'ArrowUp':
        row = Math.max(0, row - 1);
        break;
      case 'Home':
        row = 0;
        break;
      case 'End':
        row = n - 1;
        break;
      case 'PageDown':
        row = Math.min(n - 1, row + this.pageRows());
        break;
      case 'PageUp':
        row = Math.max(0, row - this.pageRows());
        break;
      case 'ArrowRight':
        if (!rows.isExpandable(entry)) break;
        if (!rows.expanded.has(entry)) {
          event.preventDefault();
          this.toggleRow(row);
          return;
        }
        row = Math.min(n - 1, row + 1);
        break;
      case 'ArrowLeft':
        if (rows.isExpandable(entry) && rows.expanded.has(entry)) {
          event.preventDefault();
          this.toggleRow(row);
          return;
        }
        if (rows.parentRow(row) >= 0) row = rows.parentRow(row);
        break;
      case 'Enter':
        event.preventDefault();
        this.options.onActivate(entry);
        return;
      case ' ': {
        // Never scroll the list away from the active row; a space can continue a type-ahead search.
        event.preventDefault();
        if (!this.typed || performance.now() - this.typedAt >= 700) return;
        const found = this.typeAhead(' ', row);
        if (found < 0) return;
        row = found;
        break;
      }
      default:
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
          event.preventDefault();
          this.options.onCopy(entry);
          return;
        }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
          const found = this.typeAhead(event.key, row);
          if (found < 0) return;
          row = found;
          break;
        }
        return;
    }
    event.preventDefault();
    this.moveTo(row, 'keyboard');
  };

  /** Jump to the next visible row whose name starts with what was typed. */
  private typeAhead(key: string, from: number): number {
    const now = performance.now();
    this.typed = now - this.typedAt < 700 ? this.typed + key : key;
    this.typedAt = now;
    const needle = this.typed.toLocaleLowerCase(lang());
    const n = this.rows.length;
    const start = this.typed.length > 1 ? from : from + 1;
    for (let k = 0; k < n; k++) {
      const row = (start + k) % n;
      if (displayName(this.tree, this.rows.entries[row]).toLocaleLowerCase(lang()).startsWith(needle)) return row;
    }
    return -1;
  }

  private updateSelectionBar(): void {
    const entry = this.selected;
    const path = displayPath(this.tree, entry);
    const [head, tail] = splitPath(path);
    setText(this.selHead, head);
    setText(this.selTail, tail);
    this.selPath.title = path;
    this.selIcon.replaceChildren(icon(this.tree.isDir(entry) ? 'folder' : 'file'));
    this.selIcon.style.setProperty('--cat', categoryVar(this.tree.categoryIndex(entry)));
    const flag = flagText(this.tree, entry);
    this.selFlag.hidden = !flag;
    this.selFlag.replaceChildren(...(flag ? [icon(this.tree.unreadable(entry) ? 'lock' : 'layers'), flag] : []));
  }
}
