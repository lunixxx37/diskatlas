import { describe, expect, it, vi } from 'vitest';
import { HelperError, type HelperClient, type HelperInfo } from '../core';
import { HelperLink } from './helper-link';

const INFO: HelperInfo = { app: 'diskatlas-helper', version: '0.1.0', protocol: 1, os: 'windows', arch: 'amd64', elevated: false, pid: 1, idleTimeoutSeconds: 600, features: ['scan', 'pick'], linkChanged: false };

/** A link that is connected to a client whose folder dialog answers with `pick`. */
function connected(pick: (title: string) => Promise<string | null>, features = INFO.features) {
  const link = new HelperLink();
  const client = { info: { ...INFO, features }, pickFolder: vi.fn(pick) };
  link.client = client as unknown as HelperClient;
  link.status = 'connected';
  const changes: boolean[] = [];
  link.addEventListener('change', () => changes.push(link.picking));
  return { link, client, changes };
}

describe("Windows' folder dialog through the helper", () => {
  it('picks only when connected to a helper that offers it', () => {
    expect(connected(async () => null).link.canPick).toBe(true);
    expect(connected(async () => null, ['scan']).link.canPick).toBe(false);
    const gone = connected(async () => null).link;
    gone.status = 'not-found';
    expect(gone.canPick).toBe(false);
    expect(new HelperLink().canPick).toBe(false);
  });

  it('returns the chosen folder, or null when closed, and says while the dialog is open', async () => {
    const { link, client, changes } = connected(async (title) => (title === 'Pick' ? 'X:\\Users\\Ann' : null));
    expect(await link.pickFolder('Pick')).toBe('X:\\Users\\Ann');
    expect(await link.pickFolder('Other')).toBeNull();
    expect(client.pickFolder).toHaveBeenCalledTimes(2);
    expect(changes).toEqual([true, false, true, false]);
    expect(link.picking).toBe(false);
  });

  it('opens one dialog at a time: a second request while one is open is busy, without asking the helper', async () => {
    let answer: (path: string | null) => void = () => {};
    const { link, client } = connected(() => new Promise((resolve) => (answer = resolve)));
    const first = link.pickFolder('Pick');
    const second = link.pickFolder('Pick').catch((e: unknown) => e);
    const error = (await second) as HelperError;
    expect([error.kind, error.status, error.code]).toEqual(['http', 409, 'busy']);
    expect(client.pickFolder).toHaveBeenCalledTimes(1);
    answer('C:\\');
    expect(await first).toBe('C:\\');
  });

  it('marks the helper as lost when it goes away while the dialog is open', async () => {
    const { link } = connected(async () => {
      throw new HelperError('not-running', 'The helper is not running.');
    });
    await expect(link.pickFolder('Pick')).rejects.toThrow('not running');
    expect([link.status, link.note, link.client, link.picking]).toEqual(['not-found', 'lost', null, false]);
  });

  it('keeps the connection after a busy answer of the helper itself', async () => {
    const { link } = connected(async () => {
      throw new HelperError('http', 'A folder dialog is already open.', 409, 'busy');
    });
    await expect(link.pickFolder('Pick')).rejects.toThrow('already open');
    expect(link.status).toBe('connected');
  });
});
