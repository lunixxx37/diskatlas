import { CATEGORIES, squarify, type CategoryId } from '../core';
import { t } from './i18n';

// The start page's decorative "map sheet": a small nested treemap of an invented
// drive, laid out with the core's own squarify(), framed like a topographic map
// (neatline, grid ticks, legend, area scale). Purely decorative: aria-hidden.
// Two variants: 'wide' (the full sheet) and 'compact' for phones, where the sheet's
// small print would shrink to a few pixels: just the map, at a readable scale.

const NS = 'http://www.w3.org/2000/svg';

interface Region {
  name: string;
  gb: number;
  cat: CategoryId;
  children?: Array<[name: string, gb: number, cat?: CategoryId]>;
}

/** The invented drive, named in the active language. The first child of Backups is the largest file. */
function drive(): Region[] {
  const n = t.heroMap;
  const [game1, game2, game3, game4] = n.gameTitles;
  return [
    { name: n.games, gb: 268, cat: 'data', children: [[game1, 92], [game2, 71], [game3, 44], [game4, 36], ['', 25, 'other']] },
    { name: n.videos, gb: 152, cat: 'video', children: [[n.movies, 74], [n.recordings, 48], [n.trips, 30]] },
    { name: n.backups, gb: 121, cat: 'archive', children: [[n.systemImage, 82], [n.phoneBackup, 39]] },
    { name: n.photos, gb: 86, cat: 'image', children: [['2025', 31], ['2024', 27], ['2023', 20], ['', 8, 'other']] },
    { name: n.music, gb: 34, cat: 'audio' },
    { name: n.projects, gb: 22, cat: 'code' },
    { name: n.programs, gb: 18, cat: 'program' },
    { name: n.documents, gb: 9, cat: 'document' },
    { name: n.other, gb: 5, cat: 'other' },
  ];
}

/** Fills whose best label colour stays below 4.5:1 in some theme get a paper plate (shown by CSS). */
const PLATE_CATEGORIES: ReadonlySet<CategoryId> = new Set(['code']);

interface Sheet {
  w: number;
  h: number;
  map: { x: number; y: number; w: number; h: number };
  /** Average advance of the label font, in viewBox units. */
  char: number;
  frame: boolean;
}

const SHEETS: Record<'wide' | 'compact', Sheet> = {
  wide: { w: 600, h: 452, map: { x: 30, y: 30, w: 540, h: 318 }, char: 5.9, frame: true },
  compact: { w: 360, h: 300, map: { x: 10, y: 10, w: 340, h: 280 }, char: 6.4, frame: false },
};

const HEADER = 17;
const PAD = 3;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function text(parent: Element, x: number, y: number, content: string, cls: string): SVGTextElement {
  const node = el('text', { x, y, class: cls }, parent);
  node.textContent = content;
  return node;
}

export function createHeroMap(variant: 'wide' | 'compact' = 'wide'): SVGSVGElement {
  const sheet = SHEETS[variant];
  const { map: MAP, char } = sheet;
  const fits = (label: string, width: number) => label.length * char <= width;
  const hatchId = `hm-hatch-${variant}`;
  const svg = el('svg', { viewBox: `0 0 ${sheet.w} ${sheet.h}`, class: `hero-map__svg hero-map__svg--${variant}`, 'aria-hidden': 'true', focusable: 'false' });
  const DRIVE = drive();
  const total = DRIVE.reduce((s, r) => s + r.gb, 0);

  // Hatch for merged small entries (as in the real map).
  const defs = el('defs', {}, svg);
  const hatch = el('pattern', { id: hatchId, width: 6, height: 6, patternUnits: 'userSpaceOnUse' }, defs);
  el('rect', { width: 6, height: 6, class: 'hm-hatch-bg' }, hatch);
  el('path', { d: 'M-1 7L7-1M-1 1L1-1M5 7L7 5', class: 'hm-hatch-line' }, hatch);

  // Sheet and neatline.
  el('rect', { x: 0.5, y: 0.5, width: sheet.w - 1, height: sheet.h - 1, rx: 3, class: 'hm-sheet' }, svg);
  if (sheet.frame) {
    el('rect', { x: MAP.x - 8.5, y: MAP.y - 8.5, width: MAP.w + 17, height: MAP.h + 17, class: 'hm-neat' }, svg);
    // Grid ticks with map-style references (A, B, C … / 1, 2, 3 …).
    const ticks = el('g', { class: 'hm-ticks' }, svg);
    const cols = 6;
    const rows = 4;
    for (let k = 0; k <= cols; k++) {
      const x = MAP.x + (MAP.w * k) / cols;
      el('line', { x1: x, y1: MAP.y - 8.5, x2: x, y2: MAP.y - 14 }, ticks);
      el('line', { x1: x, y1: MAP.y + MAP.h + 8.5, x2: x, y2: MAP.y + MAP.h + 14 }, ticks);
      if (k < cols) text(ticks, x + MAP.w / cols / 2, MAP.y - 14, String.fromCharCode(65 + k), 'hm-ref');
    }
    for (let k = 0; k <= rows; k++) {
      const y = MAP.y + (MAP.h * k) / rows;
      el('line', { x1: MAP.x - 8.5, y1: y, x2: MAP.x - 14, y2: y }, ticks);
      el('line', { x1: MAP.x + MAP.w + 8.5, y1: y, x2: MAP.x + MAP.w + 14, y2: y }, ticks);
      if (k < rows) text(ticks, MAP.x - 19, y + MAP.h / rows / 2 + 3, String(k + 1), 'hm-ref hm-ref--side');
    }
  }

  const map = el('g', { class: 'hm-map' }, svg);
  let order = 0;
  let marker: { x: number; y: number; label: string } | null = null;

  /** Name and size like the real map: the name shortens with "…"; without room for it, the size alone. */
  const label = (x: number, y: number, w: number, h: number, name: string, gb: number, cat: CategoryId) => {
    const room = w - 12;
    const size = `${gb} GB`;
    let shown: string | null = null;
    if (name && fits(name, room)) shown = name;
    else if (name) {
      const n = Math.floor(room / char);
      if (n >= 5) shown = `${name.slice(0, n - 1).trimEnd()}…`;
    }
    const lines: Array<[string, string]> = [];
    if (shown && h > 26) lines.push([shown, 'hm-label']);
    if (fits(size, room) && h > (lines.length ? 40 : 24)) lines.push([size, 'hm-size']);
    if (!lines.length) return;
    if (PLATE_CATEGORIES.has(cat)) {
      const width = Math.max(...lines.map(([line]) => line.length * char)) + 8;
      el('rect', { x: x + 3, y: y + 4, width: Math.min(w - 6, width), height: lines.length * 13 + 5, rx: 2, class: 'hm-plate' }, map);
    }
    lines.forEach(([line, cls], k) => text(map, x + 7, y + 15 + k * 13, line, `${cls} hm-label--${cat}`));
  };

  const cell = (x: number, y: number, w: number, h: number, cat: CategoryId, rest: boolean) =>
    el(
      'rect',
      {
        x: x + 1,
        y: y + 1,
        width: Math.max(0, w - 2),
        height: Math.max(0, h - 2),
        class: `hm-cell${rest ? ' hm-cell--rest' : ''}`,
        style: rest ? `--i:${order++};fill:url(#${hatchId})` : `--i:${order++};--fill:var(--cat-${cat})`,
      },
      map,
    );

  const tops = squarify(DRIVE.map((r) => r.gb), MAP.x, MAP.y, MAP.w, MAP.h);
  DRIVE.forEach((region, k) => {
    const r = tops[k];
    if (region.children && r.w > 60 && r.h > 44) {
      el('rect', { x: r.x + 1, y: r.y + 1, width: r.w - 2, height: r.h - 2, class: 'hm-frame', style: `--i:${order++}` }, map);
      const head = `${region.name} · ${region.gb} GB`;
      if (fits(head, r.w - 12)) text(map, r.x + 7, r.y + 13, head, 'hm-head');
      else if (fits(region.name, r.w - 12)) text(map, r.x + 7, r.y + 13, region.name, 'hm-head');
      const kids = squarify(region.children.map((c) => c[1]), r.x + PAD + 1, r.y + HEADER, r.w - 2 * PAD - 2, r.h - HEADER - PAD - 1);
      region.children.forEach(([name, gb, cat], j) => {
        const c = kids[j];
        const fill = cat ?? region.cat;
        cell(c.x, c.y, c.w, c.h, fill, !name);
        if (name) label(c.x, c.y, c.w, c.h, name, gb, fill);
        if (!marker && name === t.heroMap.systemImage) marker = { x: c.x + c.w * 0.58, y: c.y + c.h * 0.6, label: t.heroMap.largestFile };
      });
    } else {
      cell(r.x, r.y, r.w, r.h, region.cat, false);
      label(r.x, r.y, r.w, r.h, region.name, region.gb, region.cat);
    }
  });

  // One survey sweep across the sheet (CSS animated; skipped with reduced motion).
  el('rect', { x: MAP.x, y: MAP.y - 6, width: 1.5, height: MAP.h + 12, class: 'hm-sweep', style: `--sweep:${MAP.w}px` }, svg);

  // A measured point with a callout: what the map is for (finding the biggest things).
  if (marker) {
    const { x, y, label: tag } = marker as { x: number; y: number; label: string };
    const g = el('g', { class: 'hm-marker' }, svg);
    el('circle', { cx: x, cy: y, r: 9, class: 'hm-marker__pulse' }, g);
    el('circle', { cx: x, cy: y, r: 5.5, class: 'hm-marker__ring' }, g);
    el('path', { d: `M${x - 10} ${y}h6M${x + 4} ${y}h6M${x} ${y - 10}v6M${x} ${y + 4}v6`, class: 'hm-marker__cross' }, g);
    const bw = tag.length * 6.3 + 18;
    const bx = Math.max(MAP.x + 4, Math.min(x + 18, MAP.x + MAP.w - bw - 6));
    const by = y - 36;
    el('path', { d: `M${x + 5} ${y - 5}L${bx + 10} ${by + 22}`, class: 'hm-marker__leader' }, g);
    el('rect', { x: bx, y: by, width: bw, height: 22, rx: 3, class: 'hm-marker__tag' }, g);
    text(g, bx + 9, by + 15, tag, 'hm-marker__text');
  }

  if (!sheet.frame) return svg;

  // Legend (map key) and area scale.
  const legendY = MAP.y + MAP.h + 34;
  const legend = el('g', { class: 'hm-legend' }, svg);
  text(legend, MAP.x - 8, legendY, t.heroMap.legend, 'hm-caption');
  const colW = 142;
  CATEGORIES.forEach((cat, k) => {
    const col = Math.floor(k / 3);
    const row = k % 3;
    const x = MAP.x - 8 + col * colW;
    const y = legendY + 12 + row * 19;
    el('rect', { x, y, width: 10, height: 10, rx: 2, class: 'hm-swatch', style: `--fill:var(--cat-${cat.id})` }, legend);
    text(legend, x + 16, y + 9, t.categories[cat.id], 'hm-legend__text');
  });

  // Area scale: a square whose area stands for 10 GB at this map's scale (treemaps
  // encode size as area, so a linear scale bar would mislead).
  const side = Math.sqrt((10 / total) * MAP.w * MAP.h);
  const sx = MAP.x + MAP.w + 8 - side;
  const sy = legendY + 12 + 19 * 2 + 10 - side;
  text(legend, MAP.x + MAP.w + 8, legendY, t.heroMap.areaScale, 'hm-caption hm-caption--end');
  el('rect', { x: sx, y: sy, width: side, height: side, class: 'hm-scale' }, legend);
  text(legend, sx - 8, sy + side / 2 + 4, '≙ 10 GB', 'hm-scale__text');

  return svg;
}
