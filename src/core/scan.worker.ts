import { decodeHelperResult } from './helper-format';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { TreeBuilder, transferablesOf } from './tree';
import { walk } from './walk';

const PROGRESS_INTERVAL_MS = 120;

let cancelled = false;

function send(message: WorkerResponse, transfer: Transferable[] = []): void {
  postMessage(message, { transfer });
}

onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (request.type === 'decode') {
    // A helper result: check it, add up the folders and sort, off the page's thread.
    try {
      const builder = decodeHelperResult(request.buffer);
      const data = builder.finish({ ...request.meta, rootName: builder.names[0] });
      send({ type: 'done', data }, transferablesOf(data));
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const builder = new TreeBuilder();
  const startedAt = Date.now();
  const t0 = performance.now();
  let currentDir = 0;
  const report = () =>
    send({
      type: 'progress',
      progress: {
        files: builder.files,
        dirs: builder.dirs,
        bytes: builder.bytes,
        errors: builder.errors,
        currentPath: builder.count > 0 ? builder.pathOf(currentDir) : request.handle.name,
        elapsedMs: performance.now() - t0,
      },
    });
  const timer = setInterval(report, PROGRESS_INTERVAL_MS);

  try {
    await walk(request.handle, builder, {
      isCancelled: () => cancelled,
      onDirStart: (index) => {
        currentDir = index;
      },
    });
    report();
    const data = builder.finish({
      rootName: request.handle.name,
      source: 'picker',
      startedAt,
      durationMs: performance.now() - t0,
      complete: !cancelled,
    });
    send({ type: 'done', data }, transferablesOf(data));
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(timer);
  }
};
