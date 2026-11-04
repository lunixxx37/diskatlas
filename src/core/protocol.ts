import type { ScanData } from './tree';

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

export type WorkerRequest = { type: 'scan'; handle: FileSystemDirectoryHandle } | { type: 'cancel' };

export type WorkerResponse =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'done'; data: ScanData }
  | { type: 'error'; message: string };
