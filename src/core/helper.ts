import { decodeHelperResult } from './helper-format';
import type { ScanProgress } from './protocol';
import { decodeHelperResultInWorker, type RunningScan } from './scanner';
import { ScanTree, type ScanMeta } from './tree';

// Scanning only reads. The helper changes files in exactly one case: when the user has
// confirmed on this page that an item goes to the Recycle Bin (`recycle`); never permanently.

// The website side of the DiskAtlas Helper (docs/helper-protocol.md): a small Windows
// program that serves scans over HTTP on 127.0.0.1. Every request is a *simple* CORS
// request (GET without custom headers, POST with a text/plain JSON body), is made from
// the page (never a worker) and declares `targetAddressSpace: 'loopback'`.

/** Probed in this order. */
export const HELPER_PORTS: readonly number[] = [41417, 41418, 41419];
export const HELPER_APP = 'diskatlas-helper';
export const HELPER_PROTOCOL = 1;
/** Opening this link asks the browser to start the installed helper. */
export const HELPER_START_URL = 'diskatlas-helper://start';
export const HELPER_DOWNLOAD_URL = 'https://github.com/lunixxx37/diskatlas/releases/latest/download/DiskAtlas-Helper.exe';

export interface HelperInfo {
  app: string;
  version: string;
  protocol: number;
  os: string;
  arch: string;
  elevated: boolean;
  pid: number;
  idleTimeoutSeconds: number;
  /** What this helper can do: "scan", and in newer versions "reveal" and "recycle". */
  features: string[];
}

/** Optional abilities a helper lists in /v1/info `features`. */
export type HelperFeature = 'scan' | 'reveal' | 'recycle';

export function hasFeature(info: Pick<HelperInfo, 'features'> | undefined | null, feature: HelperFeature): boolean {
  return !!info && info.features.includes(feature);
}

/**
 * One item for POST /v1/recycle: where it is and what the scan saw there. Files carry
 * `size` and `mtime` exactly as the scan result had them; folders carry neither.
 */
export interface RecycleItem {
  path: string;
  isDir: boolean;
  size?: number;
  mtime?: number;
}

/**
 * The helper's verdict on an item: `ok` (dry run: would go), `recycled`, `failed` (with a
 * message, e.g. Windows' "delete permanently?" was declined), or the first check that
 * failed: `invalid`, `not_found`, `changed`, `protected`, `unsupported`.
 */
export type RecycleStatus = 'ok' | 'recycled' | 'failed' | 'invalid' | 'not_found' | 'changed' | 'protected' | 'unsupported';

const RECYCLE_STATUSES: readonly RecycleStatus[] = ['ok', 'recycled', 'failed', 'invalid', 'not_found', 'changed', 'protected', 'unsupported'];

export interface RecycleResult {
  path: string;
  status: RecycleStatus;
  message: string;
}

/**
 * An entry's full Windows path for the helper, in the exact clean form /v1/recycle accepts:
 * upper-case drive letter, backslashes only, no trailing separator, no "." or "..", no
 * prefix. A helper scan's root name is the scanned path itself ("C:" for a drive, so its
 * children are "C:\\…"); the bare "C:" of a drive root is not a valid item path.
 */
export function helperPath(tree: ScanTree, i: number): string {
  return tree.path(i, '\\').replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`);
}

/** A bare drive letter ("C:"): the root of a drive scan. */
export function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:$/.test(path);
}

/** The recycle item for an entry: files with size and date exactly as scanned, folders without. */
export function recycleItem(tree: ScanTree, i: number): RecycleItem {
  const path = helperPath(tree, i);
  return tree.isDir(i) ? { path, isDir: true } : { path, isDir: false, size: tree.size(i), mtime: tree.mtime(i) };
}

export type HelperDriveType = 'fixed' | 'removable' | 'network' | 'cdrom' | 'ramdisk' | 'unknown';

export interface HelperDrive {
  /** "C:\\" */
  path: string;
  label: string;
  fileSystem: string;
  type: HelperDriveType;
  /** false for e.g. an empty card reader; label, file system and sizes are then empty. */
  ready: boolean;
  totalBytes: number;
  freeBytes: number;
  clusterBytes: number;
}

export type HelperScanState = 'running' | 'done' | 'cancelled' | 'failed';

export interface HelperProgress {
  id: string;
  state: HelperScanState;
  path: string;
  /** Every entry so far, the root included. */
  entries: number;
  files: number;
  dirs: number;
  /** Logical size found so far. */
  bytes: number;
  errors: number;
  currentPath: string;
  elapsedMs: number;
  /** Set when the state is 'failed'. */
  error: string;
}

/** The answer to POST /v1/elevate. */
export type HelperElevation =
  /** Already running with administrator rights. */
  | { outcome: 'elevated' }
  /** The user accepted the Windows prompt; the elevated helper takes over the same port. */
  | { outcome: 'restarting' }
  /** The user declined; the helper keeps running as it was. */
  | { outcome: 'declined' };

/**
 * Why a helper request failed:
 * - 'not-running': nothing answered (connection refused, timed out, or a response the browser blocked);
 * - 'denied': the browser's loopback-network permission is denied, so it blocks every request;
 * - 'wrong-server': something answered, but not as the DiskAtlas Helper (protocol 1);
 * - 'http': the helper answered with an error (`status` and `code` from its error body).
 */
export type HelperFailure = 'not-running' | 'denied' | 'wrong-server' | 'http';

export class HelperError extends Error {
  constructor(
    readonly kind: HelperFailure,
    message: string,
    /** HTTP status for 'http'. */
    readonly status = 0,
    /** The helper's error code for 'http' (`not_found`, `not_a_directory`, …); 'scan_failed' for a failed scan. */
    readonly code = '',
  ) {
    super(message);
    this.name = 'HelperError';
  }
}

export type LoopbackPermission = 'granted' | 'denied' | 'prompt';

/** What the client uses from the page; tests pass their own. */
export interface HelperEnvironment {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  permissions?: { query(descriptor: PermissionDescriptor): Promise<{ state: string }> };
}

export function pageEnvironment(): HelperEnvironment {
  return {
    fetch: (input, init) => fetch(input, init),
    permissions: typeof navigator !== 'undefined' ? navigator.permissions : undefined,
  };
}

/**
 * The browser's loopback-network permission ("Loopback network" in the site settings).
 * Any error, including browsers that do not know the permission, counts as 'prompt'.
 * Never asks for 'local-network-access': querying it crashes older Chrome renderers.
 */
export async function loopbackPermission(env: HelperEnvironment = pageEnvironment()): Promise<LoopbackPermission> {
  try {
    const status = await env.permissions!.query({ name: 'loopback-network' } as unknown as PermissionDescriptor);
    return status.state === 'granted' || status.state === 'denied' ? status.state : 'prompt';
  } catch {
    return 'prompt';
  }
}

interface CallOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Aborts the request after this long (counts as 'not-running'). */
  timeoutMs?: number;
}

async function call(env: HelperEnvironment, port: number, path: string, options: CallOptions = {}): Promise<Response> {
  const method = options.method ?? 'GET';
  // No headers and a string body: a simple CORS request (text/plain;charset=UTF-8), so no preflight.
  const init: RequestInit = { method, targetAddressSpace: 'loopback' };
  if (method === 'POST') init.body = JSON.stringify(options.body ?? {});
  if (options.timeoutMs) init.signal = AbortSignal.timeout(options.timeoutMs);
  let response: Response;
  try {
    response = await env.fetch(`http://127.0.0.1:${port}/v1${path}`, init);
  } catch (error) {
    throw await networkFailure(env, error);
  }
  if (!response.ok) throw await httpFailure(response);
  return response;
}

/** A refused connection, a blocked response and a denied permission all fail as a TypeError; the permission tells them apart. */
async function networkFailure(env: HelperEnvironment, error: unknown): Promise<HelperError> {
  if ((await loopbackPermission(env)) === 'denied') {
    return new HelperError('denied', 'The browser blocks requests to the helper: the loopback-network permission is denied.');
  }
  const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return new HelperError('not-running', timedOut ? 'The helper did not answer in time.' : 'The helper is not running.');
}

async function httpFailure(response: Response): Promise<HelperError> {
  let code = '';
  let message = '';
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    code = typeof body?.error?.code === 'string' ? body.error.code : '';
    message = typeof body?.error?.message === 'string' ? body.error.message : '';
  } catch {
    // Not the helper's error body.
  }
  return new HelperError('http', message || `HTTP ${response.status}`, response.status, code);
}

async function json<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new HelperError('wrong-server', 'The answer is not JSON.');
  }
}

/** The helper's /v1/info, or null for any other server. */
export function asHelperInfo(value: unknown): HelperInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<HelperInfo>;
  if (v.app !== HELPER_APP || v.protocol !== HELPER_PROTOCOL) return null;
  return {
    app: v.app,
    version: typeof v.version === 'string' ? v.version : '',
    protocol: v.protocol,
    os: typeof v.os === 'string' ? v.os : '',
    arch: typeof v.arch === 'string' ? v.arch : '',
    elevated: v.elevated === true,
    pid: typeof v.pid === 'number' ? v.pid : 0,
    idleTimeoutSeconds: typeof v.idleTimeoutSeconds === 'number' ? v.idleTimeoutSeconds : 0,
    // A helper without `features` only scans.
    features: Array.isArray(v.features) ? v.features.filter((f): f is string => typeof f === 'string') : ['scan'],
  };
}

async function readInfo(env: HelperEnvironment, port: number, timeoutMs?: number): Promise<HelperInfo> {
  let response: Response;
  try {
    response = await call(env, port, '/info', { timeoutMs });
  } catch (error) {
    // An HTTP error on /v1/info means some other server holds the port.
    if (error instanceof HelperError && error.kind === 'http') throw new HelperError('wrong-server', `Port ${port} answers, but not as the DiskAtlas Helper.`);
    throw error;
  }
  const info = asHelperInfo(await json<unknown>(response));
  if (!info) throw new HelperError('wrong-server', `Port ${port} answers, but not as the DiskAtlas Helper.`);
  return info;
}

export interface FindHelperOptions {
  env?: HelperEnvironment;
  ports?: readonly number[];
  /** Per port. Default 1500 ms. */
  timeoutMs?: number;
  /**
   * For the very first request. It may show the browser's loopback-network prompt and
   * wait for the user, so give it longer when the permission state is 'prompt'.
   */
  firstTimeoutMs?: number;
}

/**
 * Finds the helper on its ports, in order. Rejects with a HelperError: 'denied' at the
 * first request the browser blocks; otherwise 'wrong-server' if some port answered as
 * another program, else 'not-running'.
 */
export async function findHelper(options: FindHelperOptions = {}): Promise<HelperClient> {
  const env = options.env ?? pageEnvironment();
  const ports = options.ports ?? HELPER_PORTS;
  const timeoutMs = options.timeoutMs ?? 1500;
  let wrongServer: HelperError | null = null;
  for (const [k, port] of ports.entries()) {
    try {
      const info = await readInfo(env, port, k === 0 ? (options.firstTimeoutMs ?? timeoutMs) : timeoutMs);
      return new HelperClient(port, info, env);
    } catch (error) {
      if (!(error instanceof HelperError) || error.kind === 'denied') throw error;
      if (error.kind === 'wrong-server') wrongServer ??= error;
    }
  }
  throw wrongServer ?? new HelperError('not-running', 'The helper is not running.');
}

/** A helper found on `port`. Every method rejects with a HelperError. */
export class HelperClient {
  private current: HelperInfo;

  constructor(
    readonly port: number,
    info: HelperInfo,
    private readonly env: HelperEnvironment = pageEnvironment(),
  ) {
    this.current = info;
  }

  /** As of the last /v1/info. */
  get info(): HelperInfo {
    return this.current;
  }

  async refreshInfo(timeoutMs = 3000): Promise<HelperInfo> {
    this.current = await readInfo(this.env, this.port, timeoutMs);
    return this.current;
  }

  async drives(): Promise<HelperDrive[]> {
    const body = await json<{ drives?: unknown }>(await call(this.env, this.port, '/drives'));
    if (!Array.isArray(body.drives)) throw new HelperError('wrong-server', 'The drive list is missing.');
    return body.drives as HelperDrive[];
  }

  /** Starts a scan (the helper cancels any earlier one) and returns its id. */
  async startScan(path: string, allocated = true): Promise<string> {
    const body = await json<{ id?: unknown }>(await call(this.env, this.port, '/scans', { method: 'POST', body: { path, allocated } }));
    if (typeof body.id !== 'string' || !body.id) throw new HelperError('wrong-server', 'The scan id is missing.');
    return body.id;
  }

  async progress(id: string): Promise<HelperProgress> {
    return json<HelperProgress>(await call(this.env, this.port, `/scans/${encodeURIComponent(id)}`));
  }

  async cancel(id: string): Promise<HelperProgress> {
    return json<HelperProgress>(await call(this.env, this.port, `/scans/${encodeURIComponent(id)}/cancel`, { method: 'POST' }));
  }

  /** The binary result of a finished or cancelled scan. */
  async result(id: string): Promise<ArrayBuffer> {
    const response = await call(this.env, this.port, `/scans/${encodeURIComponent(id)}/result`);
    return response.arrayBuffer();
  }

  /** Asks Windows to restart the helper with administrator rights (the UAC prompt). */
  async elevate(): Promise<HelperElevation> {
    const body = await json<{ elevated?: unknown; restarting?: unknown; cancelled?: unknown }>(
      await call(this.env, this.port, '/elevate', { method: 'POST' }),
    );
    if (body.restarting === true) return { outcome: 'restarting' };
    if (body.elevated === true) return { outcome: 'elevated' };
    return { outcome: 'declined' };
  }

  /** Opens File Explorer with the item selected (for a folder: its parent, with the folder selected). */
  async reveal(path: string): Promise<void> {
    await call(this.env, this.port, '/reveal', { method: 'POST', body: { path } });
  }

  /**
   * Moves items to the Recycle Bin, or with `dryRun` only checks them. Call it for real only
   * after the user confirmed. One result per item, in order.
   */
  async recycle(items: RecycleItem[], dryRun: boolean): Promise<RecycleResult[]> {
    const body = await json<{ results?: unknown }>(await call(this.env, this.port, '/recycle', { method: 'POST', body: { items, dryRun } }));
    if (!Array.isArray(body.results) || body.results.length !== items.length) throw new HelperError('wrong-server', 'The recycle results do not match the items.');
    return body.results.map((r, k): RecycleResult => {
      const v = (r ?? {}) as Partial<RecycleResult>;
      const status = RECYCLE_STATUSES.includes(v.status as RecycleStatus) ? (v.status as RecycleStatus) : 'failed';
      const message = typeof v.message === 'string' ? v.message : '';
      return { path: typeof v.path === 'string' ? v.path : items[k].path, status, message: status === v.status ? message : message || `Unknown status "${String(v.status)}".` };
    });
  }

  async shutdown(): Promise<void> {
    await call(this.env, this.port, '/shutdown', { method: 'POST' });
  }

  /** Removes the diskatlas-helper:// link registration; the helper then exits. */
  async uninstall(): Promise<void> {
    await call(this.env, this.port, '/uninstall', { method: 'POST' });
  }
}

function toScanProgress(p: HelperProgress): ScanProgress {
  return {
    files: p.files ?? 0,
    dirs: p.dirs ?? 0,
    bytes: p.bytes ?? 0,
    errors: p.errors ?? 0,
    currentPath: p.currentPath || p.path || '',
    elapsedMs: p.elapsedMs ?? 0,
  };
}

export interface HelperScanOptions {
  /** The id of a scan already started with `client.startScan(path)`. */
  id?: string;
  /** Default 150 ms, as the protocol suggests. */
  pollMs?: number;
  /** Default: in the scan worker. Tests decode on the spot. */
  decode?: (buffer: ArrayBuffer, meta: ScanMeta) => Promise<ScanTree>;
}

/** Decodes on the calling thread (tests, and anything without workers). */
export async function decodeHere(buffer: ArrayBuffer, meta: ScanMeta): Promise<ScanTree> {
  const builder = decodeHelperResult(buffer);
  return new ScanTree(builder.finish({ ...meta, rootName: builder.names[0] }));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A scan by the helper, behind the same interface as a browser scan: progress about every
 * 150 ms, and `cancel()` resolving with the part read so far (`meta.complete` false).
 */
export function scanWithHelper(
  client: HelperClient,
  path: string,
  onProgress: (progress: ScanProgress) => void,
  options: HelperScanOptions = {},
): RunningScan {
  const pollMs = options.pollMs ?? 150;
  const decode = options.decode ?? decodeHelperResultInWorker;
  const startedAt = Date.now();
  let id: string | null = options.id ?? null;
  let cancelWanted = false;
  let cancelSent = false;
  const sendCancel = () => {
    if (!id || cancelSent) return;
    cancelSent = true;
    // If this fails, the next progress poll reports what happened.
    client.cancel(id).catch(() => undefined);
  };

  const result = (async () => {
    id ??= await client.startScan(path);
    if (cancelWanted) sendCancel();
    let progress: HelperProgress;
    for (;;) {
      progress = await client.progress(id);
      onProgress(toScanProgress(progress));
      if (progress.state !== 'running') break;
      await sleep(pollMs);
    }
    if (progress.state === 'failed') throw new HelperError('http', progress.error || 'The scan failed.', 0, 'scan_failed');
    const buffer = await client.result(id);
    const { version, elevated, features } = client.info;
    return decode(buffer, {
      rootName: '',
      source: 'helper',
      startedAt,
      durationMs: progress.elapsedMs ?? Date.now() - startedAt,
      complete: progress.state === 'done',
      helper: { version, elevated, features: [...features] },
    });
  })();

  return {
    result,
    cancel: () => {
      cancelWanted = true;
      sendCancel();
    },
  };
}
