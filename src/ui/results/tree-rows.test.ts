import { describe, expect, it } from 'vitest';
import { createDemoTree, topFiles } from '../../core';
import { TreeRows } from './tree-rows';

const tree = createDemoTree(Date.UTC(2026, 10, 3));

/** What the rows must look like for a given expanded set, computed the slow, obvious way. */
function expected(rows: TreeRows) {
  const entries: number[] = [];
  const depths: number[] = [];
  const positions: number[] = [];
  const visit = (i: number, depth: number, pos: number) => {
    entries.push(i);
    depths.push(depth);
    positions.push(pos);
    if (!rows.expanded.has(i)) return;
    let k = 0;
    for (const c of tree.children(i)) {
      if (!rows.showFiles && !tree.isDir(c)) continue;
      visit(c, depth + 1, ++k);
    }
  };
  visit(tree.root, 0, 1);
  return { entries, depths, positions };
}

const snapshot = (rows: TreeRows) => ({ entries: rows.entries, depths: rows.depths, positions: rows.positions });

describe('TreeRows', () => {
  it('starts with the scanned folder expanded one level, largest first', () => {
    const rows = new TreeRows(tree);
    expect(rows.entries[0]).toBe(tree.root);
    expect(rows.length).toBe(1 + tree.childCount(tree.root));
    expect(rows.entries.slice(1)).toEqual([...tree.children(tree.root)]);
    expect(rows.depths.slice(1).every((d) => d === 1)).toBe(true);
    expect(rows.positions.slice(1)).toEqual(rows.entries.slice(1).map((_, k) => k + 1));
  });

  it('expands and collapses incrementally, matching a full rebuild', () => {
    const rows = new TreeRows(tree);
    const before = snapshot(rows);
    const row = rows.entries.findIndex((e) => tree.name(e) === 'Spiele');
    expect(rows.expand(row)).toBe(true);
    expect(snapshot(rows)).toEqual(expected(rows));
    expect(rows.collapse(row)).toBe(true);
    expect(snapshot(rows)).toEqual(before);
  });

  it('reveals a deep entry by expanding its ancestors', () => {
    const rows = new TreeRows(tree);
    const deepest = topFiles(tree, tree.root, 100).reduce((a, b) => (tree.depth(b) > tree.depth(a) ? b : a));
    const row = rows.expandTo(deepest);
    expect(row).toBeGreaterThan(0);
    expect(rows.entries[row]).toBe(deepest);
    expect(rows.depths[row]).toBe(tree.depth(deepest));
    for (const a of tree.ancestors(deepest).slice(0, -1)) expect(rows.expanded.has(a)).toBe(true);
    expect(snapshot(rows)).toEqual(expected(rows));
  });

  it('hides files on request and keeps folder positions contiguous', () => {
    const rows = new TreeRows(tree);
    rows.expandTo(topFiles(tree, tree.root, 1)[0]);
    rows.setShowFiles(false);
    expect(rows.entries.every((e) => tree.isDir(e))).toBe(true);
    expect(snapshot(rows)).toEqual(expected(rows));
    const file = topFiles(tree, tree.root, 1)[0];
    expect(rows.expandTo(file)).toBe(-1);
    rows.setShowFiles(true);
    expect(rows.entries[rows.expandTo(file)]).toBe(file);
  });

  it('stays consistent through a random sequence of toggles', () => {
    const rows = new TreeRows(tree);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let step = 0; step < 200; step++) {
      const row = Math.floor(rnd() * rows.length);
      rows.toggle(row);
      if (step % 50 === 49) rows.setShowFiles(!rows.showFiles);
    }
    expect(snapshot(rows)).toEqual(expected(rows));
    for (let r = 1; r < rows.length; r++) {
      const parent = rows.parentRow(r);
      expect(rows.entries[parent]).toBe(tree.parent(rows.entries[r]));
    }
  });
});
