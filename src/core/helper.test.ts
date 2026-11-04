import { describe, expect, it } from 'vitest';
import { buildHelperResult } from './helper-format.fixture';
import {
  HelperClient,
  HelperError,
  asHelperInfo,
  decodeHere,
  findHelper,
  hasFeature,
  helperPath,
  isDriveRoot,
  loopbackPermission,
  recycleItem,
  scanWithHelper,
  type HelperEnvironment,
  type HelperInfo,
  type HelperProgress,
} from './helper';
import type { ScanProgress } from './protocol';

const INFO: HelperInfo = { app: 'diskatlas-helper', version: '0.1.0', protocol: 1, os: 'windows', arch: 'amd64', elevated: false, pid: 4242, idleTimeoutSeconds: 600, features: ['scan', 'reveal', 'recycle'] };
const url = (port: number, path: string) => `http://127.0.0.1:${port}/v1${path}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

type Route = 'refused' | 'hang' | ((init: RequestInit) => Response | Promise<Response>);
type Permission = 'granted' | 'denied' | 'prompt' | 'throws';

/** A fake page: fetch answers from `routes` (anything else is refused), permissions from `permission`. */
function fakePage(routes: Record<string, Route>, permission: Permission = 'prompt') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queries: string[] = [];
  const env: HelperEnvironment = {
    fetch: async (input, init) => {
      calls.push({ url: input, init });
      const route = routes[input] ?? 'refused';
      if (route === 'refused') throw new TypeError('Failed to fetch');
      if (route === 'hang') {
        return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      }
      return route(init);
    },
    permissions: {
      query: async (descriptor) => {
        queries.push((descriptor as { name: string }).name);
        if (permission === 'throws') throw new TypeError("Failed to read the 'name' property");
        return { state: permission };
      },
    },
  };
  return { env, calls, queries };
}

const failure = async (promise: Promise<unknown>): Promise<HelperError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HelperError) return error;
    throw error;
  }
  throw new Error('expected a HelperError');
};

describe('finding the helper', () => {
  it('probes 41417, 41418 and 41419 in order with simple loopback requests', async () => {
    const page = fakePage({
      [url(41418, '/info')]: () => json({ app: 'something-else', protocol: 1 }),
      [url(41419, '/info')]: () => json(INFO),
    });
    const client = await findHelper({ env: page.env });
    expect(client.port).toBe(41419);
    expect(client.info.version).toBe('0.1.0');
    expect(page.calls.map((c) => c.url)).toEqual([url(41417, '/info'), url(41418, '/info'), url(41419, '/info')]);
    for (const { init } of page.calls) {
      expect(init.targetAddressSpace).toBe('loopback');
      expect(init.method).toBe('GET');
      expect(init.headers).toBeUndefined();
      expect(init.body).toBeUndefined();
    }
  });

  it('reports "not running" when nothing answers', async () => {
    const page = fakePage({}, 'prompt');
    const error = await failure(findHelper({ env: page.env }));
    expect(error.kind).toBe('not-running');
    expect(page.calls).toHaveLength(3);
  });

  it('reports a denied permission and stops probing', async () => {
    const page = fakePage({ [url(41419, '/info')]: () => json(INFO) }, 'denied');
    const error = await failure(findHelper({ env: page.env }));
    expect(error.kind).toBe('denied');
    expect(page.calls).toHaveLength(1);
  });

  it('treats a failing permission query as "prompt", and never asks for local-network-access', async () => {
    expect(await loopbackPermission(fakePage({}, 'throws').env)).toBe('prompt');
    expect(await loopbackPermission({ fetch: async () => new Response() })).toBe('prompt');
    for (const state of ['granted', 'denied', 'prompt'] as const) expect(await loopbackPermission(fakePage({}, state).env)).toBe(state);
    const page = fakePage({}, 'throws');
    expect((await failure(findHelper({ env: page.env }))).kind).toBe('not-running');
    expect(new Set(page.queries)).toEqual(new Set(['loopback-network']));
  });

  it('reports another program on the ports', async () => {
    const page = fakePage({
      [url(41417, '/info')]: () => new Response('<!doctype html><title>Something</title>', { headers: { 'Content-Type': 'text/html' } }),
      [url(41418, '/info')]: () => new Response('nope', { status: 404 }),
      [url(41419, '/info')]: () => json({ app: 'diskatlas-helper', protocol: 2 }),
    });
    const error = await failure(findHelper({ env: page.env }));
    expect(error.kind).toBe('wrong-server');
  });

  it('gives up on a port that does not answer in time', async () => {
    const page = fakePage({ [url(41417, '/info')]: 'hang', [url(41418, '/info')]: () => json(INFO) });
    const client = await findHelper({ env: page.env, firstTimeoutMs: 30 });
    expect(client.port).toBe(41418);
    expect(page.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    const alone = fakePage({ [url(41417, '/info')]: 'hang' });
    expect((await failure(findHelper({ env: alone.env, ports: [41417], timeoutMs: 30 }))).kind).toBe('not-running');
  });
});

describe('helper client', () => {
  const PORT = 41417;

  it('lists drives', async () => {
    const drives = [{ path: 'C:\\', label: 'Windows', fileSystem: 'NTFS', type: 'fixed', ready: true, totalBytes: 500, freeBytes: 100, clusterBytes: 4096 }];
    const page = fakePage({ [url(PORT, '/drives')]: () => json({ drives }) });
    expect(await new HelperClient(PORT, INFO, page.env).drives()).toEqual(drives);
  });

  it('starts a scan with a text/plain JSON body and no custom headers', async () => {
    const page = fakePage({ [url(PORT, '/scans')]: () => json({ id: 's1' }, 202) });
    expect(await new HelperClient(PORT, INFO, page.env).startScan('C:\\')).toBe('s1');
    const { init } = page.calls[0];
    expect(init.method).toBe('POST');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({ path: 'C:\\', allocated: true });
    expect(init.headers).toBeUndefined();
    expect(init.targetAddressSpace).toBe('loopback');
    // A string body without headers is sent as text/plain;charset=UTF-8: no preflight.
    expect(new Request('http://127.0.0.1/', { method: 'POST', body: init.body }).headers.get('content-type')).toBe('text/plain;charset=UTF-8');
  });

  it('turns the error body into a HelperError', async () => {
    const page = fakePage({
      [url(PORT, '/scans')]: () => json({ error: { code: 'not_found', message: 'The path does not exist.' } }, 404),
      [url(PORT, '/scans/s1/result')]: () => json({ error: { code: 'scan_running', message: 'The scan is still running.' } }, 409),
      [url(PORT, '/drives')]: () => new Response('oops', { status: 500 }),
    });
    const client = new HelperClient(PORT, INFO, page.env);
    const missing = await failure(client.startScan('C:\\nope'));
    expect([missing.kind, missing.status, missing.code, missing.message]).toEqual(['http', 404, 'not_found', 'The path does not exist.']);
    const running = await failure(client.result('s1'));
    expect([running.status, running.code]).toEqual([409, 'scan_running']);
    const broken = await failure(client.drives());
    expect([broken.kind, broken.status, broken.message]).toEqual(['http', 500, 'HTTP 500']);
  });

  it('classifies a lost connection', async () => {
    expect((await failure(new HelperClient(PORT, INFO, fakePage({}, 'granted').env).drives())).kind).toBe('not-running');
    expect((await failure(new HelperClient(PORT, INFO, fakePage({}, 'denied').env).drives())).kind).toBe('denied');
  });

  it('reads the three answers to elevate', async () => {
    const answer = (body: unknown, status: number) => new HelperClient(PORT, INFO, fakePage({ [url(PORT, '/elevate')]: () => json(body, status) }).env).elevate();
    expect(await answer({ elevated: true }, 200)).toEqual({ outcome: 'elevated' });
    expect(await answer({ restarting: true }, 202)).toEqual({ outcome: 'restarting' });
    expect(await answer({ elevated: false, cancelled: true }, 200)).toEqual({ outcome: 'declined' });
  });

  it('fetches the binary result, shuts down and uninstalls', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const page = fakePage({
      [url(PORT, '/scans/s7/result')]: () => new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }),
      [url(PORT, '/shutdown')]: () => json({}, 202),
      [url(PORT, '/uninstall')]: () => json({}),
    });
    const client = new HelperClient(PORT, INFO, page.env);
    expect(new Uint8Array(await client.result('s7'))).toEqual(bytes);
    await client.shutdown();
    await client.uninstall();
    expect(page.calls.filter((c) => c.init.method === 'POST').map((c) => c.url)).toEqual([url(PORT, '/shutdown'), url(PORT, '/uninstall')]);
  });
});

describe('reveal and recycle', () => {
  const PORT = 41417;
  const item = { path: 'X:\\Users\\Ann\\Videos\\trip.mkv', isDir: false, size: 4509715660, mtime: 1730000000000 };

  it('reads the features, counting a helper without them as scan-only', () => {
    expect(asHelperInfo({ ...INFO, features: ['scan', 'reveal', 'recycle', 7] })!.features).toEqual(['scan', 'reveal', 'recycle']);
    const old = asHelperInfo({ app: 'diskatlas-helper', protocol: 1, version: '0.1.0' })!;
    expect(old.features).toEqual(['scan']);
    expect(hasFeature(old, 'recycle')).toBe(false);
    expect(hasFeature(INFO, 'reveal')).toBe(true);
    expect(hasFeature(null, 'scan')).toBe(false);
  });

  it('reveals an item with a simple POST', async () => {
    const page = fakePage({ [url(PORT, '/reveal')]: () => json({}) });
    await new HelperClient(PORT, INFO, page.env).reveal(item.path);
    const { init } = page.calls[0];
    expect([init.method, init.headers, init.targetAddressSpace]).toEqual(['POST', undefined, 'loopback']);
    expect(JSON.parse(init.body as string)).toEqual({ path: item.path });
  });

  it('reports a reveal of a path that is gone', async () => {
    const page = fakePage({ [url(PORT, '/reveal')]: () => json({ error: { code: 'not_found', message: 'The path does not exist.' } }, 404) });
    const error = await failure(new HelperClient(PORT, INFO, page.env).reveal(item.path));
    expect([error.kind, error.code]).toEqual(['http', 'not_found']);
  });

  it('sends the items with dryRun and returns one result per item', async () => {
    const page = fakePage({
      [url(PORT, '/recycle')]: (init) => {
        const body = JSON.parse(init.body as string);
        return json({ results: body.items.map((i: { path: string }) => ({ path: i.path, status: body.dryRun ? 'ok' : 'recycled', message: '' })) });
      },
    });
    const client = new HelperClient(PORT, INFO, page.env);
    expect(await client.recycle([item], true)).toEqual([{ path: item.path, status: 'ok', message: '' }]);
    expect(await client.recycle([item], false)).toEqual([{ path: item.path, status: 'recycled', message: '' }]);
    const bodies = page.calls.map((c) => JSON.parse(c.init.body as string));
    expect(bodies).toEqual([
      { items: [item], dryRun: true },
      { items: [item], dryRun: false },
    ]);
  });

  it('passes every status through and turns unknown ones into failures', async () => {
    const statuses = ['invalid', 'not_found', 'changed', 'protected', 'unsupported', 'failed', 'exploded'];
    const page = fakePage({
      [url(PORT, '/recycle')]: () => json({ results: statuses.map((status) => ({ path: item.path, status, message: status === 'failed' ? 'Permanent deletion was declined.' : '' })) }),
    });
    const results = await new HelperClient(PORT, INFO, page.env).recycle(statuses.map(() => item), false);
    expect(results.map((r) => r.status)).toEqual(['invalid', 'not_found', 'changed', 'protected', 'unsupported', 'failed', 'failed']);
    expect(results[5].message).toBe('Permanent deletion was declined.');
    expect(results[6].message).toMatch(/exploded/);
  });

  it('rejects an answer that does not match the items', async () => {
    const page = fakePage({ [url(PORT, '/recycle')]: () => json({ results: [] }) });
    expect((await failure(new HelperClient(PORT, INFO, page.env).recycle([item], true))).kind).toBe('wrong-server');
  });

  it('deletes permanently only with confirm: "permanent", and checks without it', async () => {
    const folder = { path: 'X:\\Old\\Backup', isDir: true };
    const page = fakePage({
      [url(PORT, '/delete')]: (init) => {
        const body = JSON.parse(init.body as string);
        if (!body.dryRun && body.confirm !== 'permanent') return json({ error: { code: 'bad_request', message: 'confirm must be "permanent".' } }, 400);
        const done = { path: folder.path, status: 'deleted', deletedFiles: 812, deletedFolders: 41, failedEntries: 0, message: '' };
        return json({ results: [body.dryRun ? { path: folder.path, status: 'ok', deletedFiles: 0, deletedFolders: 0, failedEntries: 0, message: '' } : done] });
      },
    });
    const client = new HelperClient(PORT, INFO, page.env);
    expect(await client.delete([folder], true)).toEqual([{ path: folder.path, status: 'ok', message: '', deletedFiles: 0, deletedFolders: 0, failedEntries: 0 }]);
    expect(await client.delete([folder], false)).toEqual([{ path: folder.path, status: 'deleted', message: '', deletedFiles: 812, deletedFolders: 41, failedEntries: 0 }]);
    const bodies = page.calls.map((c) => JSON.parse(c.init.body as string));
    expect(bodies).toEqual([
      { items: [folder], dryRun: true },
      { items: [folder], dryRun: false, confirm: 'permanent' },
    ]);
    expect(page.calls.every((c) => c.init.method === 'POST' && c.init.headers === undefined)).toBe(true);
  });

  it('passes partial results with their counts through, and missing counts as 0', async () => {
    const page = fakePage({
      [url(PORT, '/delete')]: () =>
        json({
          results: [
            { path: 'X:\\A', status: 'partial', deletedFiles: 812, deletedFolders: 40, failedEntries: 3, message: '3 entries could not be deleted, first: …\\db.lock: in use' },
            { path: 'X:\\B', status: 'failed', message: 'the file is in use' },
            { path: 'X:\\C', status: 'vanished', deletedFiles: -2, deletedFolders: 'x' },
          ],
        }),
    });
    const items = ['X:\\A', 'X:\\B', 'X:\\C'].map((path) => ({ path, isDir: true }));
    const [partial, failed, odd] = await new HelperClient(PORT, INFO, page.env).delete(items, false);
    expect(partial).toEqual({ path: 'X:\\A', status: 'partial', message: '3 entries could not be deleted, first: …\\db.lock: in use', deletedFiles: 812, deletedFolders: 40, failedEntries: 3 });
    expect([failed.status, failed.message, failed.deletedFiles, failed.failedEntries]).toEqual(['failed', 'the file is in use', 0, 0]);
    expect([odd.status, odd.deletedFiles, odd.deletedFolders]).toEqual(['failed', 0, 0]);
    expect(odd.message).toMatch(/vanished/);
  });

  it('reports a refused delete request (400) as an error', async () => {
    const page = fakePage({ [url(PORT, '/delete')]: () => json({ error: { code: 'bad_request', message: 'confirm must be "permanent".' } }, 400) });
    const error = await failure(new HelperClient(PORT, INFO, page.env).delete([item], false));
    expect([error.kind, error.code, error.message]).toEqual(['http', 'bad_request', 'confirm must be "permanent".']);
  });

  it('builds exactly clean paths, also below a lower-case drive root', async () => {
    const t = await decodeHere(
      buildHelperResult({ names: ['x:\\Users\\Ann', 'Videos', 'trip.mkv'], parent: [-1, 0, 1], kind: [1, 1, 0], size: [0, 0, 5], mtime: [0, 0, 1730000000000.5] }),
      { rootName: '', source: 'helper', startedAt: 0, durationMs: 0, complete: true },
    );
    expect(helperPath(t, 2)).toBe('X:\\Users\\Ann\\Videos\\trip.mkv');
    expect(isDriveRoot(helperPath(t, 0))).toBe(false);
    // The date goes back exactly as it came, fractions included.
    expect(JSON.parse(JSON.stringify(recycleItem(t, 2))).mtime).toBe(1730000000000.5);
  });

  it('builds full Windows paths and the values the helper checks', () => {
    const tree = decodeHere(
      buildHelperResult({ names: ['X:', 'Users', 'a.bin'], parent: [-1, 0, 1], kind: [1, 1, 0], size: [0, 0, 1234], mtime: [0, 0, 1730000000000] }),
      { rootName: '', source: 'helper', startedAt: 0, durationMs: 0, complete: true },
    );
    return tree.then((t) => {
      expect(helperPath(t, 0)).toBe('X:');
      expect(isDriveRoot(helperPath(t, 0))).toBe(true);
      expect(helperPath(t, 2)).toBe('X:\\Users\\a.bin');
      expect(recycleItem(t, 2)).toEqual({ path: 'X:\\Users\\a.bin', isDir: false, size: 1234, mtime: 1730000000000 });
      // Folders carry neither size nor date.
      expect(recycleItem(t, 1)).toEqual({ path: 'X:\\Users', isDir: true });
    });
  });
});

describe('scans by the helper', () => {
  const PORT = 41418;
  const result = () =>
    buildHelperResult({
      names: ['C:', 'Users', 'a.bin', 'b.bin'],
      parent: [-1, 0, 1, 0],
      kind: [1, 1, 0, 0],
      size: [0, 0, 300, 100],
      mtime: [0, 0, 5, 6],
      allocated: [0, 0, 4096, 4096],
    });
  const progress = (state: HelperProgress['state'], files: number, extra: Partial<HelperProgress> = {}): HelperProgress => ({
    id: 's1',
    state,
    path: 'C:\\',
    entries: files + 2,
    files,
    dirs: 1,
    bytes: files * 100,
    errors: 0,
    currentPath: 'C:\\Users',
    elapsedMs: files * 10,
    error: '',
    ...extra,
  });

  /** A helper whose scan runs for `polls` progress requests, unless it is cancelled first. */
  function scanningHelper(polls: number, final: HelperProgress['state'] = 'done', extra: Partial<HelperProgress> = {}) {
    let seen = 0;
    let cancelled = false;
    let cancels = 0;
    const page = fakePage(
      {
        [url(PORT, '/scans')]: () => json({ id: 's1' }, 202),
        [url(PORT, '/scans/s1')]: () => {
          seen++;
          if (cancelled) return json(progress('cancelled', 1));
          return json(seen < polls ? progress('running', seen) : progress(final, 2, extra));
        },
        [url(PORT, '/scans/s1/cancel')]: () => {
          cancels++;
          cancelled = true;
          return json(progress('running', 1), 202);
        },
        [url(PORT, '/scans/s1/result')]: () => new Response(result()),
      },
      'granted',
    );
    return { page, cancels: () => cancels };
  }

  it('reports progress, then the decoded result with helper details', async () => {
    const { page } = scanningHelper(3);
    const client = new HelperClient(PORT, { ...INFO, elevated: true, version: '0.2.0' }, page.env);
    const seen: ScanProgress[] = [];
    const tree = await scanWithHelper(client, 'C:\\', (p) => seen.push(p), { pollMs: 1, decode: decodeHere }).result;
    expect(seen.map((p) => p.files)).toEqual([1, 2, 2]);
    expect(seen[0]).toEqual({ files: 1, dirs: 1, bytes: 100, errors: 0, currentPath: 'C:\\Users', elapsedMs: 10 });
    expect(tree.name(0)).toBe('C:');
    expect(tree.size(0)).toBe(400);
    expect(tree.allocated(0)).toBe(8192);
    expect(tree.meta).toMatchObject({ rootName: 'C:', source: 'helper', complete: true, durationMs: 20, helper: { version: '0.2.0', elevated: true, features: ['scan', 'reveal', 'recycle'] } });
  });

  it('can be cancelled and then resolves with the part read so far', async () => {
    const { page, cancels } = scanningHelper(1000);
    const client = new HelperClient(PORT, INFO, page.env);
    let scan: ReturnType<typeof scanWithHelper> | null = null;
    scan = scanWithHelper(client, 'C:\\', (p) => {
      if (p.files >= 2) scan!.cancel();
    }, { pollMs: 1, decode: decodeHere });
    const tree = await scan.result;
    expect(tree.meta.complete).toBe(false);
    expect(cancels()).toBe(1);
  });

  it('sends a cancel requested before the scan has its id', async () => {
    const { page, cancels } = scanningHelper(1000);
    const scan = scanWithHelper(new HelperClient(PORT, INFO, page.env), 'C:\\', () => undefined, { pollMs: 1, decode: decodeHere });
    scan.cancel();
    expect((await scan.result).meta.complete).toBe(false);
    expect(cancels()).toBe(1);
  });

  it('continues a scan that was started beforehand', async () => {
    const { page } = scanningHelper(2);
    const tree = await scanWithHelper(new HelperClient(PORT, INFO, page.env), 'C:\\', () => undefined, { id: 's1', pollMs: 1, decode: decodeHere }).result;
    expect(page.calls.some((c) => c.url === url(PORT, '/scans'))).toBe(false);
    expect(tree.count).toBe(4);
  });

  it('rejects when the helper reports a failed scan', async () => {
    const { page } = scanningHelper(2, 'failed', { error: 'The volume was removed.' });
    const error = await failure(scanWithHelper(new HelperClient(PORT, INFO, page.env), 'E:\\', () => undefined, { pollMs: 1, decode: decodeHere }).result);
    expect([error.code, error.message]).toEqual(['scan_failed', 'The volume was removed.']);
  });

  it('rejects when the helper goes away mid-scan', async () => {
    let polls = 0;
    const page = fakePage(
      {
        [url(PORT, '/scans')]: () => json({ id: 's1' }, 202),
        [url(PORT, '/scans/s1')]: () => {
          if (++polls > 2) throw new TypeError('Failed to fetch');
          return json(progress('running', polls));
        },
      },
      'granted',
    );
    const error = await failure(scanWithHelper(new HelperClient(PORT, INFO, page.env), 'C:\\', () => undefined, { pollMs: 1, decode: decodeHere }).result);
    expect(error.kind).toBe('not-running');
  });
});
