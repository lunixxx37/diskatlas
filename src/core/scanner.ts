import type { ScanProgress, WorkerRequest, WorkerResponse } from './protocol';
import { ScanTree, TreeBuilder } from './tree';

export interface RunningScan {
  /** Resolves with the scanned tree. After `cancel()` it resolves with the part read so far (`meta.complete` is false). */
  readonly result: Promise<ScanTree>;
  cancel(): void;
}

/** Chrome, Edge and other Chromium browsers: folders can be scanned directly. */
export function supportsDirectoryPicker(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

/** Fallback for Firefox and Safari: `<input type="file" webkitdirectory>`. */
export function supportsFolderInput(): boolean {
  return 'webkitdirectory' in document.createElement('input');
}

/** Opens the browser's folder picker. Resolves null if the user closes it. Must be called from a click. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker!({ id: 'diskatlas-scan', mode: 'read' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

/**
 * The folder dropped onto the page. Must be called synchronously inside the `drop` handler.
 * Returns null if this browser cannot turn dropped folders into handles; the promise
 * resolves null if what was dropped is not a folder.
 */
export function dirHandleFromDrop(event: DragEvent): Promise<FileSystemDirectoryHandle | null> | null {
  const items = event.dataTransfer?.items;
  if (!items) return null;
  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    if (item.kind !== 'file') continue;
    if (typeof item.getAsFileSystemHandle !== 'function') return null;
    return item
      .getAsFileSystemHandle()
      .then((handle) => (handle?.kind === 'directory' ? (handle as FileSystemDirectoryHandle) : null));
  }
  return null;
}

/** Scans a folder in a background worker. */
export function scanDirectory(
  handle: FileSystemDirectoryHandle,
  onProgress: (progress: ScanProgress) => void,
): RunningScan {
  const worker = new Worker(new URL('./scan.worker.ts', import.meta.url), { type: 'module' });
  const result = new Promise<ScanTree>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress(message.progress);
        return;
      }
      worker.terminate();
      if (message.type === 'done') resolve(new ScanTree(message.data));
      else reject(new Error(message.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      // An empty message lets the interface show its own wording.
      reject(new Error(event.message || ''));
    };
  });
  const post = (request: WorkerRequest) => worker.postMessage(request);
  post({ type: 'scan', handle });
  return { result, cancel: () => post({ type: 'cancel' }) };
}

/**
 * Builds a tree from the files of `<input type="file" webkitdirectory>`.
 * That list has no empty folders and no folders that could not be read.
 * An empty list gives a root named `emptyName`.
 */
export function treeFromFiles(files: ArrayLike<File>, emptyName = ''): ScanTree {
  const startedAt = Date.now();
  const t0 = performance.now();
  const builder = new TreeBuilder();
  const rootName = files.length > 0 ? files[0].webkitRelativePath.split('/')[0] : emptyName;
  const dirs = new Map<string, number>([[rootName, builder.addDir(-1, rootName)]]);

  const dirFor = (path: string): number => {
    let index = dirs.get(path);
    if (index === undefined) {
      const slash = path.lastIndexOf('/');
      index = builder.addDir(dirFor(path.slice(0, slash)), path.slice(slash + 1));
      dirs.set(path, index);
    }
    return index;
  };

  for (let k = 0; k < files.length; k++) {
    const file = files[k];
    const path = file.webkitRelativePath || `${rootName}/${file.name}`;
    const slash = path.lastIndexOf('/');
    builder.addFile(dirFor(path.slice(0, slash)), path.slice(slash + 1), file.size, file.lastModified);
  }

  return new ScanTree(
    builder.finish({ rootName, source: 'files', startedAt, durationMs: performance.now() - t0, complete: true }),
  );
}
