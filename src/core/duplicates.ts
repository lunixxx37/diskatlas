import type { ScanTree } from './tree';

// Possible duplicates: files with the same name (ignoring case) and the same size, or the
// same size alone. Contents are never compared, so these are candidates, not proof.

export interface DuplicateOptions {
  /** Smallest file size that counts, in bytes. */
  minSize: number;
  /** Group by size alone and ignore the names. */
  sizeOnly: boolean;
  /**
   * Also look inside Windows' own folder tree, `$Recycle.Bin` and `System Volume Information`.
   * Off by default: hard links there show the same file in several places.
   */
  includeSystem: boolean;
}

export const DEFAULT_DUPLICATE_OPTIONS: DuplicateOptions = { minSize: 1024 ** 2, sizeOnly: false, includeSystem: false };

export interface DuplicateGroup {
  size: number;
  /** The first member's name (all members share it unless `sizeOnly`). */
  name: string;
  /** All members have the same name (always true unless `sizeOnly`). */
  sameName: boolean;
  /** Files, newest first. */
  members: number[];
  /** What keeping one copy would free: (members − 1) × size. */
  reclaimable: number;
}

export interface DuplicateResult {
  /** Most reclaimable space first. */
  groups: DuplicateGroup[];
  /** Sum over all groups. */
  reclaimable: number;
  /** Files that belong to some group. */
  files: number;
}

/** How long one slice of work may take before the page gets a turn, and how to give it one. */
export interface Pacing {
  sliceMs: number;
  pause: () => Promise<void>;
}

const pageTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const defaultPacing: Pacing = { sliceMs: 12, pause: pageTurn };

const SYSTEM_NAMES = new Set(['$recycle.bin', 'system volume information']);
const DRIVE_ROOT = /^[a-z]:$/i;
const WINDOWS_PATH = /^[a-z]:[\\/]windows([\\/]|$)/i;

/**
 * Folders whose files are left out by default: `$Recycle.Bin` and `System Volume Information`
 * anywhere, and Windows' own folder tree (`<drive>:\Windows` in a scan of a whole drive, or a
 * scan made inside it).
 */
export function isSystemFolder(tree: ScanTree, i: number): boolean {
  if (!tree.isDir(i)) return false;
  const name = tree.name(i).toLowerCase();
  if (SYSTEM_NAMES.has(name)) return true;
  if (i === tree.root) return WINDOWS_PATH.test(tree.name(i));
  return name === 'windows' && tree.parent(i) === tree.root && DRIVE_ROOT.test(tree.name(tree.root));
}

/** True when `folder` lies inside a system folder (or is one), so nothing below it counts by default. */
export function inSystemFolder(tree: ScanTree, folder: number): boolean {
  for (let p = folder; p >= 0; p = tree.parent(p)) if (isSystemFolder(tree, p)) return true;
  return false;
}

/**
 * Groups the files below `folder`. Works in slices so a drive with millions of files never
 * blocks the page; rejects with an AbortError when `signal` aborts.
 */
export async function findDuplicates(
  tree: ScanTree,
  folder: number,
  options: DuplicateOptions = DEFAULT_DUPLICATE_OPTIONS,
  signal?: AbortSignal,
  pacing: Pacing = defaultPacing,
): Promise<DuplicateResult> {
  const { minSize, sizeOnly, includeSystem } = options;
  const groups = new Map<string | number, number[]>();
  if (!includeSystem && inSystemFolder(tree, folder)) return { groups: [], reclaimable: 0, files: 0 };

  const stack = [folder];
  let deadline = performance.now() + pacing.sliceMs;
  let steps = 0;
  while (stack.length > 0) {
    const p = stack.pop()!;
    for (const c of tree.children(p)) {
      if (tree.link(c)) continue;
      if (tree.isDir(c)) {
        if (includeSystem || !isSystemFolder(tree, c)) stack.push(c);
        continue;
      }
      const size = tree.size(c);
      if (size < minSize || size <= 0) continue;
      const key = sizeOnly ? size : `${size}\u0000${tree.name(c).toLowerCase()}`;
      const members = groups.get(key);
      if (members) members.push(c);
      else groups.set(key, [c]);
    }
    if (++steps % 64 === 0 && performance.now() > deadline) {
      if (signal?.aborted) throw new DOMException('Duplicate search aborted', 'AbortError');
      await pacing.pause();
      if (signal?.aborted) throw new DOMException('Duplicate search aborted', 'AbortError');
      deadline = performance.now() + pacing.sliceMs;
    }
  }

  const result: DuplicateGroup[] = [];
  let reclaimable = 0;
  let files = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => tree.mtime(b) - tree.mtime(a) || a - b);
    const size = tree.size(members[0]);
    const name = tree.name(members[0]);
    const lower = name.toLowerCase();
    const group: DuplicateGroup = {
      size,
      name,
      sameName: !sizeOnly || members.every((m) => tree.name(m).toLowerCase() === lower),
      members,
      reclaimable: (members.length - 1) * size,
    };
    result.push(group);
    reclaimable += group.reclaimable;
    files += members.length;
  }
  result.sort((a, b) => b.reclaimable - a.reclaimable || b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { groups: result, reclaimable, files };
}
