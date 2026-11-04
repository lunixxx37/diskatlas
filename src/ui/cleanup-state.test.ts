import { describe, expect, it } from 'vitest';
import { HelperError, type RecycleResult, type RecycleStatus } from '../core';
import { controlsFor, stateFromError, stateFromResult, type RecycleDialogState } from './cleanup-state';

const result = (status: RecycleStatus, message = ''): RecycleResult => ({ path: 'X:\\Users\\Ann\\trip.mkv', status, message });

describe('recycle dialog states', () => {
  it('lets the user confirm only after a passed dry run', () => {
    // The dry run changes nothing: it can be cancelled, but not confirmed.
    expect(controlsFor({ kind: 'checking' })).toEqual({ canConfirm: false, busy: false, offerRescan: false, offerReconnect: false });
    const ready = stateFromResult(result('ok'), true);
    expect(ready).toEqual({ kind: 'ready' });
    expect(controlsFor(ready).canConfirm).toBe(true);
  });

  it('refuses protected, unsupported and invalid items for good', () => {
    for (const status of ['protected', 'unsupported', 'invalid'] as const) {
      const state = stateFromResult(result(status, 'why'), true);
      expect(state).toEqual({ kind: 'refused', status, message: 'why' });
      expect(controlsFor(state)).toEqual({ canConfirm: false, busy: false, offerRescan: false, offerReconnect: false });
    }
  });

  it('offers to survey again when the item changed or is gone', () => {
    for (const status of ['changed', 'not_found'] as const) {
      const state = stateFromResult(result(status), true);
      expect(state.kind).toBe('refused');
      expect(controlsFor(state)).toEqual({ canConfirm: false, busy: false, offerRescan: true, offerReconnect: false });
    }
  });

  it('is busy while moving, then done or failed with the message', () => {
    expect(controlsFor({ kind: 'working' }).busy).toBe(true);
    expect(controlsFor({ kind: 'working' }).canConfirm).toBe(false);
    expect(stateFromResult(result('recycled'), false)).toEqual({ kind: 'recycled' });
    const declined = stateFromResult(result('failed', 'Windows would delete it permanently; that was declined.'), false);
    expect(declined).toEqual({ kind: 'failed', message: 'Windows would delete it permanently; that was declined.' });
    // Trying again is allowed: Windows asks again.
    expect(controlsFor(declined).canConfirm).toBe(true);
  });

  it('blocks an item the dry run could not even check', () => {
    const state = stateFromResult(result('failed', 'could not check the item'), true);
    expect(state).toEqual({ kind: 'blocked', message: 'could not check the item' });
    expect(controlsFor(state)).toEqual({ canConfirm: false, busy: false, offerRescan: false, offerReconnect: false });
  });

  it('reports an item that is still there after a reported success as failed', () => {
    expect(stateFromResult(result('failed', 'the item is still there'), false)).toEqual({ kind: 'failed', message: 'the item is still there' });
  });

  it('treats a check that changes its mind on the real request like the dry run', () => {
    expect(stateFromResult(result('changed'), false)).toEqual({ kind: 'refused', status: 'changed', message: '' });
    expect(stateFromResult(result('ok'), false).kind).toBe('failed');
  });

  it('says the helper is gone and offers to reconnect', () => {
    for (const kind of ['not-running', 'denied'] as const) {
      const state = stateFromError(new HelperError(kind, 'gone'));
      expect(state).toEqual({ kind: 'offline' });
      expect(controlsFor(state)).toEqual({ canConfirm: false, busy: false, offerRescan: false, offerReconnect: true });
    }
  });

  it('shows other errors without letting the user go on', () => {
    const state = stateFromError(new HelperError('http', 'The body is not valid JSON.', 400, 'bad_request'));
    expect(state).toEqual({ kind: 'error', message: 'The body is not valid JSON.' });
    expect(controlsFor(state).canConfirm).toBe(false);
    const all: RecycleDialogState[] = [{ kind: 'recycled' }, { kind: 'error', message: '' }];
    for (const s of all) expect(controlsFor(s).busy).toBe(false);
  });
});
