import {
  CATEGORIES,
  formatBytes,
  formatDate,
  formatPercent,
  layoutTreemap,
  type ScanTree,
  type TreemapRect,
} from '../../core';
import { h, reducedMotion } from '../dom';
import { displayName, displayPath } from '../format';
import { plural, t } from '../i18n';
import { tooltip, tooltipBody } from '../tooltip';
import { categoryVar, readMapColors, type MapColors } from './colors';

export interface TreemapViewOptions {
  tree: ScanTree;
  /** Fires "change" when the colour theme changes. */
  theme: EventTarget;
  /** A folder region was clicked: it becomes the current folder. */
  onOpenFolder: (dir: number) => void;
  /** A file region was clicked: select it. */
  onSelectEntry: (entry: number) => void;
  /** Pointer over a region (linked highlighting); -1 when it leaves. */
  onHover: (entry: number) => void;
  /** Category index to highlight from the start (kept across a language switch); -1 = none. */
  isolate?: number;
}

const UI_FONT = '"Schibsted Grotesk Variable", "Segoe UI", system-ui, sans-serif';
const MONO_FONT = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
const HEADER = 20;
const CHAIN_SEP = ' › ';

/** The folder whose contents a region shows: the end of a folded chain, else the entry itself. */
const shownFolder = (r: TreemapRect): number => (r.chain && r.chain.length > 0 ? r.chain[r.chain.length - 1] : r.i);

/**
 * The map of the current folder: a nested, squarified treemap on <canvas>. The base
 * canvas holds the land-use map (redrawn on layout, theme or legend changes only);
 * a second canvas on top carries hover, selection and linked highlights, so pointer
 * movement never repaints thousands of regions.
 */
export class TreemapView {
  readonly el: HTMLElement;
  private readonly tree: ScanTree;
  private readonly stage: HTMLElement;
  private readonly canvasWrap: HTMLElement;
  private readonly base: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly bctx: CanvasRenderingContext2D;
  private readonly octx: CanvasRenderingContext2D;
  private readonly legend: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly resize: ResizeObserver;
  private rects: TreemapRect[] = [];
  private rectOf = new Map<number, number>();
  private restOf = new Map<number, number>();
  private folder: number;
  private selected: number;
  private hover = -1;
  private linked = -1;
  private isolate = -1;
  private isolateSticky = -1;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private colors: MapColors;
  private hatch: CanvasPattern | null = null;
  private resizeTimer = 0;
  private laidOut = false;
  private pending: { from: number; to: number } | null = null;
  private readonly onTheme = () => {
    this.colors = readMapColors();
    this.hatch = null;
    this.drawBase();
    this.drawOverlay();
  };
  private readonly onFonts = () => this.drawBase();
  /** Re-armed after every layout: fires when the window moves to a screen with another pixel density. */
  private dprQuery: MediaQueryList | null = null;
  private readonly onDpr = () => {
    this.hatch = null;
    if (this.laidOut) this.layout(this.w, this.hgt);
  };

  constructor(private readonly options: TreemapViewOptions) {
    this.tree = options.tree;
    this.folder = this.tree.root;
    this.selected = this.tree.root;
    this.isolateSticky = options.isolate ?? -1;
    this.isolate = this.isolateSticky;
    this.colors = readMapColors();

    this.base = h('canvas', { class: 'tmap__canvas' });
    this.overlay = h('canvas', { class: 'tmap__canvas tmap__canvas--overlay' });
    this.bctx = this.base.getContext('2d')!;
    this.octx = this.overlay.getContext('2d')!;
    this.canvasWrap = h('div', { class: 'tmap__canvases', role: 'img', 'aria-label': t.map.label }, this.base, this.overlay);
    this.empty = h('div', { class: 'tmap__empty', hidden: true });
    this.stage = h('div', { class: 'tmap__stage' }, this.canvasWrap, this.empty);
    this.legend = h('div', { class: 'legend', role: 'group', 'aria-label': t.map.legend });

    this.el = h(
      'div',
      { class: 'tmap' },
      this.stage,
      h('div', { class: 'tmap__foot' }, this.legend, h('p', { class: 'tmap__hint', text: t.map.hint })),
    );

    this.overlay.addEventListener('pointermove', this.onPointerMove);
    this.overlay.addEventListener('pointerleave', this.onPointerLeave);
    this.overlay.addEventListener('click', this.onClick);
    this.legend.addEventListener('pointerover', this.onLegendOver);
    this.legend.addEventListener('pointerleave', () => this.setIsolate(this.isolateSticky));
    this.legend.addEventListener('focusin', this.onLegendOver);
    this.legend.addEventListener('focusout', () => this.setIsolate(this.isolateSticky));
    this.legend.addEventListener('click', this.onLegendClick);

    options.theme.addEventListener('change', this.onTheme);
    document.fonts?.addEventListener?.('loadingdone', this.onFonts);

    this.resize = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect;
      const w = Math.floor(box.width);
      const hh = Math.floor(box.height);
      if (w < 2 || hh < 2) return; // hidden tab
      if (w === this.w && hh === this.hgt && this.laidOut) return;
      window.clearTimeout(this.resizeTimer);
      if (!this.laidOut) this.layout(w, hh);
      else this.resizeTimer = window.setTimeout(() => this.layout(w, hh), 90);
    });
    this.resize.observe(this.stage);
  }

  destroy(): void {
    this.resize.disconnect();
    window.clearTimeout(this.resizeTimer);
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.options.theme.removeEventListener('change', this.onTheme);
    document.fonts?.removeEventListener?.('loadingdone', this.onFonts);
    tooltip.hide();
  }

  /** Show another folder (with a short zoom when it is inside or above the current one). */
  setFolder(dir: number, selected: number): void {
    this.selected = selected;
    if (dir === this.folder) {
      this.drawOverlay();
      return;
    }
    const from = this.folder;
    this.folder = dir;
    this.hover = -1;
    this.linked = -1;
    if (!this.laidOut) return;
    this.pending = { from, to: dir };
    this.layout(this.w, this.hgt);
  }

  /** The category highlighted by a click in the legend, or -1. */
  get isolated(): number {
    return this.isolateSticky;
  }

  setSelected(entry: number): void {
    this.selected = entry;
    this.drawOverlay();
  }

  /** Linked highlighting from the tree: outline the entry's region (or the region that contains it). */
  setLinked(entry: number): void {
    const next = entry < 0 ? -1 : this.regionFor(entry);
    if (next === this.linked) return;
    this.linked = next;
    this.drawOverlay();
  }

  /** Draw attention to an entry (Enter in the tree): a brief ring, or a frame flash for the whole map. */
  pulse(entry: number): void {
    const index = this.rectOf.get(entry);
    const target = index === undefined ? this.stage : null;
    if (target || reducedMotion()) {
      this.stage.classList.remove('is-pulse');
      void this.stage.offsetWidth;
      this.stage.classList.add('is-pulse');
      return;
    }
    const r = this.rects[index!];
    const ring = h('span', { class: 'tmap__ring', style: { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } });
    ring.addEventListener('animationend', () => ring.remove());
    this.stage.append(ring);
  }

  // ---------- layout & drawing ----------

  private layout(w: number, hh: number): void {
    this.w = w;
    this.hgt = hh;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (dpr !== this.dpr || !this.dprQuery) {
      this.hatch = null;
      this.dprQuery?.removeEventListener('change', this.onDpr);
      this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      this.dprQuery.addEventListener('change', this.onDpr);
    }
    this.dpr = dpr;
    for (const c of [this.base, this.overlay]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(hh * this.dpr);
      c.style.width = `${w}px`;
      c.style.height = `${hh}px`;
    }
    const before = this.pending && this.rectOf.size ? this.zoomOrigin(this.pending) : null;
    const { tree, folder } = this;
    const total = tree.size(folder);
    const message = this.emptyMessage(folder, total);
    this.empty.hidden = !message;
    this.empty.textContent = message ?? '';
    this.canvasWrap.hidden = !!message;
    this.rects = message
      ? []
      : layoutTreemap(tree, folder, w, hh, {
          // Folder chains (Games › SteamLibrary › steamapps) fold into one region with one
          // header; the size limits for nesting stop pointless depth on small maps.
          maxDepth: w < 520 ? 4 : 5,
          padding: 3,
          headerHeight: HEADER,
          minNestWidth: 56,
          minNestHeight: 44,
          minArea: 30,
          collapseChains: true,
        });
    this.rectOf = new Map();
    this.restOf = new Map();
    this.rects.forEach((r, k) => {
      if (r.kind === 'rest') {
        this.restOf.set(r.restParent!, k);
        return;
      }
      this.rectOf.set(r.i, k);
      // Folded folders are shown by their chain's region (linked highlighting, zoom origin).
      for (const c of r.chain ?? []) this.rectOf.set(c, k);
    });
    this.laidOut = true;
    this.hover = -1;
    this.drawBase();
    this.drawOverlay();
    this.updateLegend();
    this.updateLabel();
    if (before !== null || this.pending) this.animateZoom(before);
    this.pending = null;
  }

  private emptyMessage(folder: number, total: number): string | null {
    const { tree } = this;
    if (tree.unreadable(folder) && tree.childCount(folder) === 0) return t.flags.unreadableFolder;
    if (tree.tooDeep(folder)) return t.flags.tooDeep;
    if (tree.childCount(folder) === 0) return t.map.empty;
    if (total <= 0) return t.map.zero;
    return null;
  }

  private get pattern(): CanvasPattern | null {
    if (this.hatch) return this.hatch;
    const size = Math.max(1, Math.round(6 * this.dpr));
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const t = tile.getContext('2d')!;
    t.strokeStyle = this.colors.hatchLine;
    t.lineWidth = Math.max(1, this.dpr * 0.9);
    t.beginPath();
    // 45° lines, continued across tile edges so the pattern is seamless.
    for (const off of [-size, 0, size]) {
      t.moveTo(off, size);
      t.lineTo(off + size, 0);
    }
    t.stroke();
    const pattern = this.bctx.createPattern(tile, 'repeat');
    pattern?.setTransform(new DOMMatrix().scale(1 / this.dpr));
    this.hatch = pattern;
    return pattern;
  }

  private drawBase(): void {
    const ctx = this.bctx;
    const { colors: c, tree } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.hgt);
    if (!this.rects.length) return;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, this.w, this.hgt);
    ctx.textBaseline = 'alphabetic';
    for (const r of this.rects) {
      if (r.w < 0.5 || r.h < 0.5) continue;
      if (r.kind === 'rest') {
        this.fillInset(ctx, r, c.hatchBg);
        const pattern = this.pattern;
        if (pattern) this.fillInset(ctx, r, pattern);
        continue;
      }
      const cat = tree.categoryIndex(r.i);
      if (r.kind === 'dir' && r.nested) {
        ctx.fillStyle = c.frames[Math.min(2, r.depth)];
        ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        ctx.strokeStyle = c.frameLine;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
        this.drawHeader(r, cat);
        continue;
      }
      const dim = this.isolate >= 0 && cat !== this.isolate;
      ctx.globalAlpha = dim ? 0.16 : 1;
      this.fillInset(ctx, r, c.categories[cat]);
      if (r.kind === 'dir' && r.w > 8 && r.h > 10) {
        // Folders drawn as one block get a thin "tab" so they read as containers.
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, Math.min(3, r.h / 5));
      }
      ctx.globalAlpha = 1;
      if (!dim) this.drawLeafLabel(r, cat);
    }
  }

  private fillInset(ctx: CanvasRenderingContext2D, r: TreemapRect, fill: string | CanvasPattern): void {
    const inset = r.w > 3 && r.h > 3 ? 1 : 0;
    ctx.fillStyle = fill;
    ctx.fillRect(r.x + inset, r.y + inset, r.w - 2 * inset, r.h - 2 * inset);
  }

  private drawHeader(r: TreemapRect, cat: number): void {
    const ctx = this.bctx;
    const { colors: c, tree } = this;
    const pad = 7;
    let x = r.x + pad;
    const right = r.x + r.w - pad;
    if (right - x < 14) return;
    ctx.fillStyle = c.categories[cat];
    ctx.fillRect(x, r.y + 7, 7, 7);
    x += 12;
    const avail = right - x;
    if (avail < 22) return;
    const nameFont = `${r.depth === 0 ? 650 : 600} ${r.depth === 0 ? 12 : 11.5}px ${UI_FONT}`;
    const sizeFont = `500 11px ${MONO_FONT}`;
    // A folded chain reads "Games › SteamLibrary › steamapps"; when space runs out the
    // middle goes first ("Games › … › steamapps"), then everything but the first name.
    const names = [r.i, ...(r.chain ?? [])].map((i) => displayName(tree, i));
    const size = ` · ${formatBytes(tree.size(r.i))}`;
    ctx.font = sizeFont;
    const sizeW = ctx.measureText(size).width;
    ctx.font = nameFont;
    const widthOf = (parts: string[]) => ctx.measureText(parts.join(CHAIN_SEP)).width;
    const choices: string[][] = [names];
    if (names.length > 2) choices.push([names[0], '…', names[names.length - 1]]);
    if (names.length > 1) choices.push([names[0]]);
    let parts = choices.find((p) => widthOf(p) + sizeW <= avail) ?? null;
    let withSize = true;
    if (!parts) {
      if (avail - sizeW >= 46) parts = [fitText(ctx, names[0], avail - sizeW)];
      else {
        withSize = false;
        parts = [fitText(ctx, names[0], avail)];
      }
    }
    if (!parts[0]) return;
    const base = r.y + 14.5;
    let cx = x;
    parts.forEach((part, k) => {
      if (k > 0) {
        ctx.fillStyle = c.ink2;
        ctx.fillText(CHAIN_SEP, cx, base);
        cx += ctx.measureText(CHAIN_SEP).width;
      }
      ctx.fillStyle = c.ink;
      ctx.fillText(part, cx, base);
      cx += ctx.measureText(part).width;
    });
    if (withSize) {
      ctx.font = sizeFont;
      ctx.fillStyle = c.ink2;
      ctx.fillText(size, cx, base);
    }
  }

  private drawLeafLabel(r: TreemapRect, cat: number): void {
    if (r.w < 56 || r.h < 24) return;
    const ctx = this.bctx;
    const { colors: c, tree } = this;
    const pad = 7;
    const nameFont = `600 11.5px ${UI_FONT}`;
    const sizeFont = `500 11px ${MONO_FONT}`;
    ctx.font = nameFont;
    const name = fitText(ctx, displayName(tree, r.i), r.w - 2 * pad);
    if (!name) return;
    const two = r.h >= 40;
    const size = formatBytes(tree.size(r.i));
    const nameW = ctx.measureText(name).width;
    ctx.font = sizeFont;
    const sizeW = two ? ctx.measureText(size).width : 0;
    const { color, plate } = c.labels[cat];
    if (plate) {
      // Fills where neither label colour reaches 4.5:1 get a paper plate behind the text.
      ctx.fillStyle = c.panel;
      ctx.globalAlpha = 0.92;
      roundRect(ctx, r.x + 3, r.y + 3, Math.min(r.w - 6, Math.max(nameW, sizeW) + 2 * (pad - 3)), two ? 34 : 20, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = plate ? c.ink : color;
    ctx.font = nameFont;
    ctx.fillText(name, r.x + pad, r.y + 17);
    if (two && sizeW <= r.w - 2 * pad) {
      ctx.font = sizeFont;
      ctx.fillText(size, r.x + pad, r.y + 31);
    }
  }

  private drawOverlay(): void {
    const ctx = this.octx;
    const c = this.colors;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.hgt);
    const sel = this.rectOf.get(this.selected);
    if (this.linked >= 0 && this.linked !== sel && this.linked !== this.hover) this.outline(this.rects[this.linked], c.ink, 2);
    if (this.hover >= 0 && this.hover !== sel) this.outline(this.rects[this.hover], c.ink, 2);
    if (sel !== undefined) this.outline(this.rects[sel], c.accent, 2.5);
  }

  /** A coloured ring with a 1px surface ring inside, so it reads on any fill. */
  private outline(r: TreemapRect | undefined, color: string, width: number): void {
    if (!r) return;
    const ctx = this.octx;
    if (r.w > 7 && r.h > 7) {
      ctx.strokeStyle = this.colors.bg;
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + width + 1.5, r.y + width + 1.5, r.w - 2 * width - 3, r.h - 2 * width - 3);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.strokeRect(r.x + 1 + width / 2, r.y + 1 + width / 2, Math.max(0, r.w - 2 - width), Math.max(0, r.h - 2 - width));
  }

  // ---------- interaction ----------

  private hitTest(x: number, y: number): number {
    for (let k = this.rects.length - 1; k >= 0; k--) {
      const r = this.rects[k];
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return k;
    }
    return -1;
  }

  private entryOf(index: number): number {
    const r = this.rects[index];
    if (!r) return -1;
    return r.kind === 'rest' ? r.restParent! : shownFolder(r);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const box = this.overlay.getBoundingClientRect();
    const index = this.hitTest(event.clientX - box.left, event.clientY - box.top);
    if (index !== this.hover) {
      this.hover = index;
      this.drawOverlay();
      this.options.onHover(this.entryOf(index));
      const r = this.rects[index];
      this.overlay.style.cursor = r && !(r.kind === 'rest' && r.restParent === this.folder) ? 'pointer' : 'default';
    }
    if (index < 0 || event.pointerType === 'touch') {
      tooltip.hide();
      return;
    }
    tooltip.show(`${this.folder}:${index}`, () => this.tooltipFor(this.rects[index]), event.clientX, event.clientY);
  };

  private readonly onPointerLeave = (): void => {
    tooltip.hide();
    if (this.hover !== -1) {
      this.hover = -1;
      this.drawOverlay();
      this.options.onHover(-1);
    }
  };

  private readonly onClick = (event: MouseEvent): void => {
    const box = this.overlay.getBoundingClientRect();
    const index = this.hitTest(event.clientX - box.left, event.clientY - box.top);
    const r = this.rects[index];
    if (!r) return;
    tooltip.hide();
    // A folded chain opens at its end: the folders in between hold nothing else worth a stop.
    if (r.kind === 'dir') this.options.onOpenFolder(shownFolder(r));
    else if (r.kind === 'file') this.options.onSelectEntry(r.i);
    else if (r.restParent !== undefined && r.restParent !== this.folder) this.options.onOpenFolder(r.restParent);
  };

  private tooltipFor(r: TreemapRect) {
    const { tree } = this;
    const total = tree.size(this.folder);
    const where = displayName(tree, this.folder);
    if (r.kind === 'rest') {
      const parent = r.restParent!;
      let size = r.restSize ?? 0;
      if (r.restSize === undefined) for (const c of tree.children(parent)) if (!this.rectOf.has(c)) size += tree.size(c);
      return tooltipBody({
        value: formatBytes(size),
        share: t.map.shareOf(formatPercent(total > 0 ? size / total : 0), where),
        title: plural(r.restCount ?? 0, t.map.smaller),
        meta: t.map.grouped,
        path: displayPath(tree, parent, this.folder),
      });
    }
    const i = r.i;
    const cat = tree.categoryIndex(i);
    const size = tree.size(i);
    const category = t.categories[CATEGORIES[cat].id];
    const meta = tree.isDir(i)
      ? t.map.folderMeta(category, plural(tree.fileCount(i), t.files))
      : t.map.fileMeta(category, formatDate(tree.mtime(i)));
    return tooltipBody({
      value: formatBytes(size),
      share: t.map.shareOf(formatPercent(total > 0 ? size / total : 0), where),
      title: [i, ...(r.chain ?? [])].map((j) => displayName(tree, j)).join(CHAIN_SEP),
      meta,
      key: categoryVar(cat),
      path: displayPath(tree, shownFolder(r), this.folder),
    });
  }

  /** The region that shows `entry`: its own, the "rest" block it was merged into, or a drawn ancestor. */
  private regionFor(entry: number): number {
    const { tree } = this;
    if (entry === this.folder || !tree.contains(this.folder, entry)) return -1;
    for (let j = entry; j >= 0 && j !== this.folder; j = tree.parent(j)) {
      const own = this.rectOf.get(j);
      if (own !== undefined) return own;
      const rest = this.restOf.get(tree.parent(j));
      if (rest !== undefined) return rest;
    }
    return -1;
  }

  // ---------- legend ----------

  private updateLegend(): void {
    const present = new Set<number>();
    let hasRest = false;
    for (const r of this.rects) {
      if (r.kind === 'rest') hasRest = true;
      else if (!(r.kind === 'dir' && r.nested)) present.add(this.tree.categoryIndex(r.i));
    }
    if (this.isolateSticky >= 0 && !present.has(this.isolateSticky)) this.isolateSticky = -1;
    const items: HTMLElement[] = [];
    CATEGORIES.forEach((cat, k) => {
      if (!present.has(k)) return;
      const label = t.categories[cat.id];
      items.push(
        h(
          'button',
          { class: 'legend__item', type: 'button', 'data-cat': String(k), 'aria-pressed': String(k === this.isolateSticky), title: t.map.highlight(label) },
          h('span', { class: 'legend__swatch', style: { '--cat': categoryVar(k) } }),
          label,
        ),
      );
    });
    if (hasRest) items.push(h('span', { class: 'legend__item legend__item--rest' }, h('span', { class: 'legend__swatch legend__swatch--rest' }), t.map.groupedLegend));
    this.legend.replaceChildren(h('span', { class: 'label legend__label', text: t.map.legend }), ...items);
    // A highlighted category that this folder does not have would dim the whole map.
    if (this.isolate >= 0 && !present.has(this.isolate)) this.setIsolate(-1);
    else this.legend.classList.toggle('is-isolating', this.isolate >= 0);
  }

  private readonly onLegendOver = (event: Event): void => {
    const item = (event.target as Element).closest<HTMLElement>('.legend__item[data-cat]');
    if (item) this.setIsolate(Number(item.dataset.cat));
  };

  private readonly onLegendClick = (event: MouseEvent): void => {
    const item = (event.target as Element).closest<HTMLElement>('.legend__item[data-cat]');
    if (!item) return;
    const cat = Number(item.dataset.cat);
    this.isolateSticky = this.isolateSticky === cat ? -1 : cat;
    for (const b of this.legend.querySelectorAll<HTMLElement>('.legend__item[data-cat]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.cat) === this.isolateSticky));
    }
    this.setIsolate(this.isolateSticky >= 0 ? this.isolateSticky : cat);
  };

  private setIsolate(cat: number): void {
    if (cat === this.isolate) return;
    this.isolate = cat;
    this.legend.classList.toggle('is-isolating', cat >= 0);
    this.drawBase();
  }

  private updateLabel(): void {
    const { tree, folder } = this;
    const name = displayName(tree, folder);
    const top = this.rects
      .filter((r) => r.depth === 0 && r.kind !== 'rest')
      .slice(0, 4)
      .map((r) => `${[r.i, ...(r.chain ?? [])].map((j) => displayName(tree, j)).join(' – ')} ${formatBytes(tree.size(r.i))}`);
    const entries = plural(tree.childCount(folder), t.map.entries);
    this.canvasWrap.setAttribute('aria-label', t.map.description(name, formatBytes(tree.size(folder)), entries, top.join(', ')));
  }

  // ---------- zoom transition ----------

  /** Where the new map comes from: the clicked region (zoom in) or null (handled after layout). */
  private zoomOrigin({ from, to }: { from: number; to: number }): DOMRect | null {
    if (!this.tree.contains(from, to)) return null;
    for (let j = to; j >= 0 && j !== from; j = this.tree.parent(j)) {
      const k = this.rectOf.get(j);
      if (k !== undefined) {
        const r = this.rects[k];
        return new DOMRect(r.x, r.y, r.w, r.h);
      }
    }
    return null;
  }

  private animateZoom(zoomInFrom: DOMRect | null): void {
    if (reducedMotion() || !this.pending || typeof this.canvasWrap.animate !== 'function') return;
    const { from, to } = this.pending;
    const W = this.w;
    const H = this.hgt;
    let start: string | null = null;
    if (zoomInFrom && zoomInFrom.width > 0 && zoomInFrom.height > 0) {
      start = `translate(${zoomInFrom.x}px, ${zoomInFrom.y}px) scale(${zoomInFrom.width / W}, ${zoomInFrom.height / H})`;
    } else if (this.tree.contains(to, from)) {
      // Zoom out: the folder we came from is a region of the new map; start magnified on it.
      const k = this.regionFor(from);
      const r = k >= 0 ? this.rects[k] : null;
      if (r && r.w > 0 && r.h > 0) start = `scale(${W / r.w}, ${H / r.h}) translate(${-r.x}px, ${-r.y}px)`;
    }
    const frames = start
      ? [
          { transform: start, opacity: 0.55 },
          { transform: 'none', opacity: 1 },
        ]
      : [{ opacity: 0.4 }, { opacity: 1 }];
    this.canvasWrap.animate(frames, { duration: start ? 280 : 180, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
  }
}

/** Longest prefix of `text` (plus "…") that fits `max` px in the current font; "" if not even one letter fits. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (max <= 0) return '';
  if (ctx.measureText(text).width <= max) return text;
  let lo = 1;
  let hi = text.length - 1;
  let best = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = `${text.slice(0, mid).trimEnd()}…`;
    if (ctx.measureText(candidate).width <= max) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, hh, r);
  else ctx.rect(x, y, w, hh);
}
