import type { ScanTree } from './tree';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk) of `values` into the given box.
 * `values` must be positive and sorted largest first; the rectangles keep that order.
 * `ratio` is the preferred aspect ratio of the rectangles.
 */
export function squarify(values: readonly number[], x: number, y: number, w: number, h: number, ratio = PHI): Rect[] {
  const n = values.length;
  const out: Rect[] = new Array(n);
  const x1 = x + w;
  const y1 = y + h;
  let x0 = x;
  let y0 = y;
  let remaining = 0;
  for (const v of values) remaining += v;

  let i0 = 0;
  while (i0 < n) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (dx <= 0 || dy <= 0 || remaining <= 0) {
      for (let k = i0; k < n; k++) out[k] = { x: x0, y: y0, w: 0, h: 0 };
      break;
    }

    // Grow the row while the worst aspect ratio in it keeps improving.
    let i1 = i0 + 1;
    let sum = values[i0];
    let min = sum;
    let max = sum;
    const alpha = Math.max(dy / dx, dx / dy) / (remaining * ratio);
    let beta = sum * sum * alpha;
    let worst = Math.max(max / beta, beta / min);
    for (; i1 < n; i1++) {
      const v = values[i1];
      const s = sum + v;
      const mn = Math.min(min, v);
      const mx = Math.max(max, v);
      beta = s * s * alpha;
      const r = Math.max(mx / beta, beta / mn);
      if (r > worst) break;
      sum = s;
      min = mn;
      max = mx;
      worst = r;
    }

    // Lay the row along the shorter side; the last row and the last rectangle in
    // a row take exactly what is left, so rounding never leaves gaps.
    if (dx < dy) {
      const rowH = i1 < n ? (dy * sum) / remaining : dy;
      let cx = x0;
      for (let k = i0; k < i1; k++) {
        const cw = k === i1 - 1 ? x1 - cx : (dx * values[k]) / sum;
        out[k] = { x: cx, y: y0, w: cw, h: rowH };
        cx += cw;
      }
      y0 += rowH;
    } else {
      const rowW = i1 < n ? (dx * sum) / remaining : dx;
      let cy = y0;
      for (let k = i0; k < i1; k++) {
        const ch = k === i1 - 1 ? y1 - cy : (dy * values[k]) / sum;
        out[k] = { x: x0, y: cy, w: rowW, h: ch };
        cy += ch;
      }
      x0 += rowW;
    }
    remaining -= sum;
    i0 = i1;
  }
  return out;
}

export type TreemapKind = 'dir' | 'file' | 'rest';

export interface TreemapRect extends Rect {
  /** Entry index; -1 for a 'rest' block. */
  i: number;
  kind: TreemapKind;
  /** 0 for the children of the laid-out folder. */
  depth: number;
  /**
   * Folders only: true if a header strip (height `headerHeight`) was reserved at the
   * top for the name, and the children were laid out below it.
   */
  nested: boolean;
  /** 'rest' only: how many small entries the block stands for, and their folder. */
  restCount?: number;
  restParent?: number;
  /** 'rest' only: the bytes the block stands for. */
  restSize?: number;
  /**
   * Nested folders with `collapseChains` only: the folders below this one that were folded
   * into its header, top down. The rectangles laid out inside belong to the last of them.
   */
  chain?: number[];
}

export interface TreemapOptions {
  /** Folder levels to nest (1 = only the direct children). */
  maxDepth?: number;
  /** Gap between a folder's frame and its children, in px. */
  padding?: number;
  /** Height of a nested folder's name strip, in px. */
  headerHeight?: number;
  /** Folders smaller than this (in px) are drawn as one block instead of being nested. */
  minNestWidth?: number;
  minNestHeight?: number;
  /** Entries smaller than this area (px²) are merged into one 'rest' block per folder. */
  minArea?: number;
  /**
   * Fold chains of folders that hold essentially one sub-folder (Games → SteamLibrary →
   * steamapps) into one nested region with one header, so a chain costs neither extra
   * header strips nor depth levels. A folder is folded into its largest child only if that
   * child is a folder with at least 95% of the bytes and every other entry of the folder
   * is too small to be drawn on its own. Those entries stay on the map as a 'rest' block of
   * their folder, so areas remain exact. Default false.
   */
  collapseChains?: boolean;
}

/** Share of a folder's bytes its largest sub-folder needs before `collapseChains` folds it. */
const CHAIN_SHARE = 0.95;

interface ExtraRest {
  parent: number;
  count: number;
  value: number;
}

/**
 * Nested treemap of `root`'s contents in a `width` × `height` box. Parents come
 * before their children, so drawing in order paints children on top, and the last
 * rectangle containing a point is the deepest one under it.
 */
export function layoutTreemap(
  tree: ScanTree,
  root: number,
  width: number,
  height: number,
  options: TreemapOptions = {},
): TreemapRect[] {
  const {
    maxDepth = 3,
    padding = 3,
    headerHeight = 18,
    minNestWidth = 48,
    minNestHeight = 40,
    minArea = 24,
    collapseChains = false,
  } = options;
  const out: TreemapRect[] = [];

  /** The sub-folder `dir` can be folded into (see `collapseChains`), or -1. */
  const foldInto = (dir: number, box: Rect): number => {
    const children = tree.children(dir);
    const total = tree.size(dir);
    if (children.length === 0 || total <= 0) return -1;
    const first = children[0];
    if (!tree.isDir(first) || tree.childCount(first) === 0 || tree.size(first) < total * CHAIN_SHARE) return -1;
    if (children.length > 1 && tree.size(children[1]) >= total * (minArea / (box.w * box.h))) return -1;
    return first;
  };

  // `extra`: entries of folded folders, laid out as 'rest' blocks beside `dir`'s own children.
  const level = (dir: number, box: Rect, depth: number, extra: readonly ExtraRest[] = []) => {
    const area = box.w * box.h;
    let total = tree.size(dir);
    for (const e of extra) total += e.value;
    if (area < 1 || total <= 0) return;

    const children = tree.children(dir);
    const minValue = total * (minArea / area);
    const values: number[] = [];
    let shown = 0;
    // Children are sorted largest first, so the ones too small to show are all at the end.
    while (shown < children.length) {
      const size = tree.size(children[shown]);
      if (size <= 0 || size < minValue) break;
      values.push(size);
      shown++;
    }
    let restCount = 0;
    let restValue = 0;
    for (let k = shown; k < children.length; k++) {
      const size = tree.size(children[k]);
      if (size > 0) {
        restCount++;
        restValue += size;
      }
    }
    if (restValue > 0) values.push(restValue);
    for (const e of extra) values.push(e.value);

    const rects = squarify(values, box.x, box.y, box.w, box.h);
    for (let k = 0; k < shown; k++) {
      const i = children[k];
      const r = rects[k];
      if (!tree.isDir(i)) {
        out.push({ ...r, i, kind: 'file', depth, nested: false });
        continue;
      }
      const nested =
        depth + 1 < maxDepth && tree.childCount(i) > 0 && r.w >= minNestWidth && r.h >= minNestHeight;
      if (!nested) {
        out.push({ ...r, i, kind: 'dir', depth, nested });
        continue;
      }
      const inner = { x: r.x + padding, y: r.y + headerHeight, w: r.w - 2 * padding, h: r.h - headerHeight - padding };
      const chain: number[] = [];
      const rests: ExtraRest[] = [];
      let end = i;
      if (collapseChains) {
        for (let next = foldInto(end, inner); next >= 0; next = foldInto(end, inner)) {
          let count = 0;
          let value = 0;
          for (const c of tree.children(end)) {
            const size = tree.size(c);
            if (c !== next && size > 0) {
              count++;
              value += size;
            }
          }
          if (value > 0) rests.push({ parent: end, count, value });
          chain.push(next);
          end = next;
        }
      }
      out.push(chain.length > 0 ? { ...r, i, kind: 'dir', depth, nested, chain } : { ...r, i, kind: 'dir', depth, nested });
      level(end, inner, depth + 1, rests);
    }
    let at = shown;
    if (restValue > 0) {
      out.push({ ...rects[at++], i: -1, kind: 'rest', depth, nested: false, restCount, restParent: dir, restSize: restValue });
    }
    for (const e of extra) {
      out.push({ ...rects[at++], i: -1, kind: 'rest', depth, nested: false, restCount: e.count, restParent: e.parent, restSize: e.value });
    }
  };

  level(root, { x: 0, y: 0, w: width, h: height }, 0);
  return out;
}
