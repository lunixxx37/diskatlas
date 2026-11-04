import {
  HelperError,
  findHelper,
  loopbackPermission,
  scanWithHelper,
  type HelperClient,
  type HelperDrive,
  type RunningScan,
  type ScanProgress,
} from '../core';

// The page's connection to the DiskAtlas Helper. It holds the state (the start page's
// helper section draws it and is rebuilt freely, e.g. on a language switch) and keeps
// the browser rules: the first request only after a click, never a permission prompt on
// page load, every request from the page itself.

export type HelperStatus =
  /** Nothing asked yet (or the helper was quit). */
  | 'idle'
  | 'connecting'
  /** Nothing answers on the helper's ports. */
  | 'not-found'
  /** After "Start helper": looking for it for a while. */
  | 'waiting'
  /** The browser's loopback-network permission is denied. */
  | 'denied'
  /** Some other program answers on the ports. */
  | 'wrong-server'
  | 'connected'
  /** Waiting for Windows' prompt and the restarted, elevated helper. */
  | 'elevating';

/** Something to tell about the last action. */
export type HelperNote = 'quit' | 'lost' | 'still-not-found' | 'declined' | 'elevate-failed' | null;

/** Why a path could not be surveyed: our own checks, or the helper's error code. */
export type PathProblem = 'empty' | 'relative' | 'not_found' | 'not_a_directory' | 'bad_request' | 'other';

const REMEMBER_KEY = 'diskatlas:helper';
/** Long enough to notice and answer the browser's "open this app?" prompt. */
const START_WAIT_MS = 60_000;
/** After that, keep looking now and then, so a helper started by hand is still found. */
const LATE_LOOK_MS = 5 * 60_000;
const LATE_LOOK_EVERY_MS = 3000;
const ELEVATE_WAIT_MS = 20_000;
/** The first request may wait on the browser's permission prompt. */
const PROMPT_WAIT_MS = 120_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The helper exists for Windows only; phones and other systems get no offer. */
export function isWindowsDesktop(nav: Navigator = navigator): boolean {
  const data = nav.userAgentData;
  if (data?.platform) return data.platform === 'Windows' && !data.mobile;
  return /\bWindows NT\b/.test(nav.userAgent) && !/\b(Mobile|Windows Phone)\b/.test(nav.userAgent);
}

/** "C:\\…" or "\\\\server\\share…": what the helper accepts as absolute. */
export function isAbsoluteWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:([\\/]|$)/.test(path) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(path);
}

function remembered(): boolean {
  try {
    return localStorage.getItem(REMEMBER_KEY) === '1';
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(REMEMBER_KEY, '1');
  } catch {
    // Storage blocked: no silent reconnect next time.
  }
}

export class HelperLink extends EventTarget {
  status: HelperStatus = 'idle';
  note: HelperNote = null;
  client: HelperClient | null = null;
  drives: HelperDrive[] | null = null;
  drivesFailed = false;
  /** Seconds left while waiting for a started helper. */
  waitLeft = 0;
  /** What is typed into the path field; kept while the section is rebuilt. */
  draftPath = '';
  pathProblem: PathProblem | null = null;
  /** A scan start in flight (the Survey buttons wait for it). */
  starting = false;
  /** Every new action makes the answers to older ones stale. */
  private token = 0;

  get elevated(): boolean {
    return this.client?.info.elevated ?? false;
  }

  private set(status: HelperStatus, note: HelperNote = null): void {
    this.status = status;
    this.note = note;
    this.changed();
  }

  private changed(): void {
    this.dispatchEvent(new Event('change'));
  }

  /** "Connect helper" (from a click: it may show the browser's permission prompt). */
  async connect(): Promise<void> {
    const token = ++this.token;
    this.set('connecting');
    const permission = await loopbackPermission();
    try {
      const client = await findHelper({ firstTimeoutMs: permission === 'prompt' ? PROMPT_WAIT_MS : 2000 });
      if (token === this.token) await this.adopt(client);
    } catch (error) {
      if (token === this.token) this.fail(error);
    }
  }

  /**
   * On page load: back to a helper connected on an earlier visit, but only when the
   * browser already grants loopback access, so no prompt can appear.
   */
  async reconnectSilently(): Promise<void> {
    if (!remembered() || this.status !== 'idle') return;
    if ((await loopbackPermission()) !== 'granted' || this.status !== 'idle') return;
    const token = ++this.token;
    try {
      const client = await findHelper();
      if (token === this.token && this.status === 'idle') await this.adopt(client);
    } catch {
      // Not running now: stay quiet.
    }
  }

  /** After "Start helper" opened the diskatlas-helper:// link: look for it for about 20 seconds. */
  async startAndWait(): Promise<void> {
    const token = ++this.token;
    const until = Date.now() + START_WAIT_MS;
    this.client = null;
    this.set('waiting');
    while (Date.now() < until) {
      this.waitLeft = Math.max(1, Math.ceil((until - Date.now()) / 1000));
      this.changed();
      try {
        const client = await findHelper({ timeoutMs: 800 });
        if (token === this.token) await this.adopt(client);
        return;
      } catch (error) {
        if (token !== this.token) return;
        if (error instanceof HelperError && error.kind === 'denied') {
          this.set('denied');
          return;
        }
      }
      await sleep(1000);
      if (token !== this.token) return;
    }
    this.set('not-found', 'still-not-found');
    // Keep looking quietly, so a helper started by double-click still connects on its own.
    const lateUntil = Date.now() + LATE_LOOK_MS;
    while (Date.now() < lateUntil) {
      await sleep(LATE_LOOK_EVERY_MS);
      if (token !== this.token || this.status !== 'not-found') return;
      try {
        const client = await findHelper({ timeoutMs: 800 });
        if (token === this.token && this.status === 'not-found') await this.adopt(client);
        return;
      } catch {
        // Still not running.
      }
    }
  }

  /**
   * Restarts the helper with administrator rights (Windows shows its prompt) and waits for
   * the elevated helper on the same port.
   */
  async elevate(): Promise<'elevated' | 'declined' | 'failed'> {
    const client = this.client;
    if (!client) return 'failed';
    const token = ++this.token;
    this.set('elevating');
    let outcome: 'elevated' | 'restarting' | 'declined';
    try {
      outcome = (await client.elevate()).outcome;
    } catch (error) {
      if (token !== this.token) return 'failed';
      if (error instanceof HelperError && error.kind === 'not-running') this.lost();
      else this.set('connected', 'elevate-failed');
      return 'failed';
    }
    if (token !== this.token) return 'failed';
    if (outcome === 'declined') {
      this.set('connected', 'declined');
      return 'declined';
    }
    if (outcome === 'elevated') {
      await client.refreshInfo().catch(() => undefined);
      this.set('connected');
      return 'elevated';
    }
    // The helper restarts: the old one closes the port, the elevated one binds it again.
    const until = Date.now() + ELEVATE_WAIT_MS;
    while (Date.now() < until) {
      await sleep(500);
      if (token !== this.token) return 'failed';
      try {
        const info = await client.refreshInfo(1500);
        if (info.elevated) {
          if (token !== this.token) return 'failed';
          await this.adopt(client);
          return 'elevated';
        }
      } catch {
        // Not back yet.
      }
    }
    if (token === this.token) {
      this.client = null;
      this.drives = null;
      this.set('not-found', 'elevate-failed');
    }
    return 'failed';
  }

  /** "Quit helper". */
  async quit(): Promise<void> {
    const client = this.client;
    ++this.token;
    this.client = null;
    this.drives = null;
    this.set('idle', 'quit');
    await client?.shutdown().catch(() => undefined);
  }

  /** The connected helper, after checking it still answers; looks for it again otherwise (from a click). */
  async ensureClient(): Promise<HelperClient | null> {
    if (this.client) {
      try {
        await this.client.refreshInfo(1500);
        return this.client;
      } catch {
        this.lost();
      }
    }
    const token = ++this.token;
    try {
      const client = await findHelper();
      if (token !== this.token) return null;
      await this.adopt(client);
      return client;
    } catch (error) {
      if (token === this.token) this.fail(error, 'lost');
      return null;
    }
  }

  /**
   * Starts a scan of `path`; returns its id, or null with `pathProblem` (or the status)
   * telling why not. `typed`: the path comes from the path field.
   */
  async startScan(path: string, typed = false): Promise<string | null> {
    const clean = path.trim();
    if (typed) this.draftPath = path;
    this.pathProblem = !clean ? 'empty' : !isAbsoluteWindowsPath(clean) ? 'relative' : null;
    if (this.pathProblem || !this.client || this.starting) {
      this.changed();
      return null;
    }
    this.starting = true;
    this.changed();
    try {
      return await this.client.startScan(clean);
    } catch (error) {
      if (error instanceof HelperError && error.kind === 'http') {
        const code = error.code as PathProblem;
        this.pathProblem = ['not_found', 'not_a_directory', 'bad_request'].includes(code) ? code : 'other';
      } else {
        this.fail(error, 'lost');
      }
      return null;
    } finally {
      this.starting = false;
      this.changed();
    }
  }

  /** A scan of `path` (already started when `id` is given). */
  scan(path: string, id: string | undefined, onProgress: (progress: ScanProgress) => void): RunningScan {
    if (!this.client) throw new HelperError('not-running', 'The helper is not connected.');
    return scanWithHelper(this.client, path, onProgress, { id });
  }

  /** A request found the helper gone (it quits by itself when idle). */
  lost(): void {
    this.client = null;
    this.drives = null;
    this.set('not-found', 'lost');
  }

  private async adopt(client: HelperClient): Promise<void> {
    this.client = client;
    this.drives = null;
    this.drivesFailed = false;
    remember();
    this.set('connected');
    try {
      const drives = await client.drives();
      if (this.client === client) this.drives = drives;
    } catch (error) {
      if (this.client !== client) return;
      if (error instanceof HelperError && error.kind === 'not-running') {
        this.lost();
        return;
      }
      this.drivesFailed = true;
    }
    this.changed();
  }

  private fail(error: unknown, notRunningNote: HelperNote = null): void {
    this.client = null;
    this.drives = null;
    const kind = error instanceof HelperError ? error.kind : 'not-running';
    if (kind === 'denied') this.set('denied');
    else if (kind === 'wrong-server') this.set('wrong-server');
    else this.set('not-found', notRunningNote);
  }
}
