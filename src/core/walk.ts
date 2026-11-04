import { FLAG_TOO_DEEP, FLAG_UNREADABLE, type TreeBuilder } from './tree';

export interface WalkOptions {
  /** Folders listed at the same time. */
  dirConcurrency?: number;
  /** Size lookups (`getFile()`) in flight per folder. */
  statBatch?: number;
  /** Folders nested deeper than this are recorded but not opened (guards against link loops). */
  maxDepth?: number;
  isCancelled?: () => boolean;
  /** Called when a folder starts being listed, with its entry index. */
  onDirStart?: (index: number) => void;
}

interface Job {
  handle: FileSystemDirectoryHandle;
  index: number;
  depth: number;
}

/**
 * Reads a folder tree through the File System Access API into `builder`.
 * Folders that cannot be read are flagged instead of failing the whole scan.
 */
export function walk(root: FileSystemDirectoryHandle, builder: TreeBuilder, options: WalkOptions = {}): Promise<void> {
  const { dirConcurrency = 8, statBatch = 32, maxDepth = 128, isCancelled = () => false, onDirStart } = options;
  const queue: Job[] = [{ handle: root, index: builder.addDir(-1, root.name), depth: 0 }];
  let active = 0;

  return new Promise<void>((resolve) => {
    const pump = () => {
      while (active < dirConcurrency && queue.length > 0 && !isCancelled()) {
        const job = queue.pop()!;
        active++;
        listDir(job)
          .catch(() => builder.flag(job.index, FLAG_UNREADABLE))
          .finally(() => {
            active--;
            pump();
          });
      }
      if (active === 0 && (queue.length === 0 || isCancelled())) resolve();
    };

    const listDir = async (job: Job) => {
      onDirStart?.(job.index);
      const files: FileSystemFileHandle[] = [];
      try {
        for await (const entry of job.handle.values()) {
          if (isCancelled()) return;
          if (entry.kind === 'directory') {
            const index = builder.addDir(job.index, entry.name);
            if (job.depth + 1 >= maxDepth) {
              builder.flag(index, FLAG_TOO_DEEP);
            } else {
              queue.push({ handle: entry as FileSystemDirectoryHandle, index, depth: job.depth + 1 });
              pump();
            }
          } else {
            files.push(entry as FileSystemFileHandle);
          }
        }
      } catch {
        // Keep what was listed before the error.
        builder.flag(job.index, FLAG_UNREADABLE);
      }

      for (let start = 0; start < files.length && !isCancelled(); start += statBatch) {
        const batch = files.slice(start, start + statBatch);
        const results = await Promise.allSettled(batch.map((file) => file.getFile()));
        results.forEach((result, k) => {
          if (result.status === 'fulfilled') {
            builder.addFile(job.index, batch[k].name, result.value.size, result.value.lastModified);
          } else {
            builder.flag(builder.addFile(job.index, batch[k].name, 0, 0), FLAG_UNREADABLE);
          }
        });
      }
    };

    pump();
  });
}
