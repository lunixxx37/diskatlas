import { describe, expect, it } from 'vitest';
import { createDemoTree } from './demo';
import { ScanTree, TreeBuilder, type ScanMeta } from './tree';
import { layoutTreemap, type TreemapRect } from './treemap';

const META: ScanMeta = { rootName: 'root', source: 'picker', startedAt: 0, durationMs: 0, complete: true };

/**
 * root ─ Spiele ─ Steam ─ apps ─ a.pak, b.pak, c.pak
 *                       └ steam.vdf (1 byte, too small to draw)
 *      ─ Musik ─ six songs
 *      ─ notes.txt
 */
function chainTree() {
  const b = new TreeBuilder();
  const root = b.addDir(-1, 'root');
  const steam = b.addDir(b.addDir(root, 'Spiele'), 'Steam');
  const apps = b.addDir(steam, 'apps');
  b.addFile(apps, 'a.pak', 60_000, 1);
  b.addFile(apps, 'b.pak', 30_000, 1);
  b.addFile(apps, 'c.pak', 10_000, 1);
  b.addFile(steam, 'steam.vdf', 1, 1);
  const musik = b.addDir(root, 'Musik');
  for (let k = 0; k < 6; k++) b.addFile(musik, `song${k}.mp3`, 9_000 - k * 1_000, 1);
  b.addFile(root, 'notes.txt', 20_000, 1);
  const tree = new ScanTree(b.finish(META));
  const find = (name: string) => {
    for (let i = 0; i < tree.count; i++) if (tree.name(i) === name) return i;
    throw new Error(`no entry ${name}`);
  };
  return { tree, find };
}

const inside = (r: TreemapRect, p: TreemapRect) =>
  r.x >= p.x - 1e-6 && r.y >= p.y - 1e-6 && r.x + r.w <= p.x + p.w + 1e-6 && r.y + r.h <= p.y + p.h + 1e-6;

describe('layoutTreemap with collapseChains', () => {
  it('is off by default: every folder of a chain gets its own frame', () => {
    const { tree, find } = chainTree();
    const rects = layoutTreemap(tree, tree.root, 800, 500);
    const spiele = rects.find((r) => r.i === find('Spiele'))!;
    expect(spiele.chain).toBeUndefined();
    expect(rects.some((r) => r.i === find('Steam'))).toBe(true);
  });

  it('folds a chain into one region whose children are the chain end’s', () => {
    const { tree, find } = chainTree();
    const rects = layoutTreemap(tree, tree.root, 800, 500, { collapseChains: true });
    const spiele = rects.find((r) => r.i === find('Spiele'))!;
    expect(spiele.nested).toBe(true);
    expect(spiele.chain).toEqual([find('Steam'), find('apps')]);
    expect(rects.some((r) => r.i === find('Steam') || r.i === find('apps'))).toBe(false);
    const paks = rects.filter((r) => r.i >= 0 && tree.parent(r.i) === find('apps'));
    expect(paks.map((r) => tree.name(r.i))).toEqual(['a.pak', 'b.pak', 'c.pak']);
    for (const r of paks) {
      expect(r.depth).toBe(1);
      expect(inside(r, spiele)).toBe(true);
    }
  });

  it('keeps folded small entries as a rest block, so areas stay exact', () => {
    const { tree, find } = chainTree();
    const padding = 3;
    const headerHeight = 18;
    const rects = layoutTreemap(tree, tree.root, 800, 500, { collapseChains: true, padding, headerHeight });
    const spiele = rects.find((r) => r.i === find('Spiele'))!;
    const rest = rects.find((r) => r.kind === 'rest' && r.restParent === find('Steam'))!;
    expect(rest).toBeDefined();
    expect(rest.restCount).toBe(1);
    expect(rest.restSize).toBe(1);
    expect(inside(rest, spiele)).toBe(true);
    const level = rects.filter((r) => r.depth === 1 && inside(r, spiele));
    const innerArea = (spiele.w - 2 * padding) * (spiele.h - headerHeight - padding);
    expect(level.reduce((s, r) => s + r.w * r.h, 0)).toBeCloseTo(innerArea, 6);
    const a = rects.find((r) => r.i === find('a.pak'))!;
    expect((a.w * a.h) / innerArea).toBeCloseTo(60_000 / tree.size(find('Spiele')), 6);
  });

  it('does not fold when another entry is big enough to be drawn', () => {
    const b = new TreeBuilder();
    const root = b.addDir(-1, 'root');
    const x = b.addDir(root, 'X');
    const y = b.addDir(x, 'Y');
    for (let k = 0; k < 4; k++) b.addFile(y, `f${k}.bin`, 24_000, 1);
    b.addFile(x, 'visible.bin', 4_000, 1); // 4 % of X: below the share, and large enough to draw
    const tree = new ScanTree(b.finish(META));
    const rects = layoutTreemap(tree, tree.root, 600, 400, { collapseChains: true });
    expect(rects.find((r) => r.i === x)!.chain).toBeUndefined();
    expect(rects.some((r) => r.i === y && r.nested)).toBe(true);
  });

  it('keeps every rectangle inside its nearest drawn ancestor on the demo drive', () => {
    const tree = createDemoTree(Date.UTC(2026, 10, 3));
    const rects = layoutTreemap(tree, tree.root, 1200, 800, { maxDepth: 5, collapseChains: true, minArea: 30 });
    const drawn = new Map<number, TreemapRect>();
    for (const r of rects) {
      if (r.kind === 'rest') continue;
      drawn.set(r.i, r);
      for (const c of r.chain ?? []) drawn.set(c, r);
    }
    expect(rects.some((r) => (r.chain?.length ?? 0) > 0)).toBe(true);
    for (const r of rects) {
      let p = r.kind === 'rest' ? r.restParent! : tree.parent(r.i);
      while (p >= 0 && !drawn.has(p)) p = tree.parent(p);
      const parent = p >= 0 ? drawn.get(p) : undefined;
      if (parent && parent !== r) expect(inside(r, parent)).toBe(true);
    }
  });
});
