import type { ScanData, ScanMeta } from './tree';

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  /** Entries that could not be read so far. */
  errors: number;
  /** Folder currently being read, starting with the scanned folder's name. */
  currentPath: string;
  elapsedMs: number;
}

export type WorkerRequest =
  | { type: 'scan'; handle: FileSystemDirectoryHandle }
  | { type: 'cancel' }
  /** A helper result (moved, not copied) to check and turn into ScanData; the root name comes from the buffer. */
  | { type: 'decode'; buffer: ArrayBuffer; meta: ScanMeta };

export type WorkerResponse =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'done'; data: ScanData }
  | { type: 'error'; message: string };
