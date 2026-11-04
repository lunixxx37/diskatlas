import { describe, expect, it } from 'vitest';
import { HelperError, type DeleteResult, type DeleteStatus, type RecycleResult, type RecycleStatus } from '../core';
import { controlsFor, isAccessDenied, stateFromError, stateFromResult, suggestPermanent, type CleanupDialogState } from './cleanup-state';

const result = (status: RecycleStatus, message = ''): RecycleResult => ({ path: 'X:\\Users\\Ann\\trip.mkv', status, message });
const deletion = (status: DeleteStatus, extra: Partial<DeleteResult> = {}): DeleteResult => ({
  path: 'T:\\Old\\Backup',
  status,
  message: '',
  deletedFiles: 0,
  deletedFolders: 0,
  failedEntries: 0,
  ...extra,
});
const none = { canConfirm: false, busy: false, canSwitch: true, offerRescan: false, offerReconnect: false };

describe('clean-up dialog states', () => {
  it('lets the user confirm only after a passed dry run', () => {
    // The dry run changes nothing: it can be cancelled, but not confirmed.
    expect(controlsFor({ kind: 'checking' })).toEqual(none);
    const ready = stateFromResult(result('ok'), true);
    expect(ready).toEqual({ kind: 'ready' });
    expect(controlsFor(ready).canConfirm).toBe(true);
  });

  it('refuses protected, unsupported and invalid items for good', () => {
    for (const status of ['protected', 'unsupported', 'invalid'] as const) {
      const state = stateFromResult(result(status, 'why'), true);
      expect(state).toEqual({ kind: 'refused', status, message: 'why' });
      expect(controlsFor(state)).toEqual(none);
    }
  });

  it('offers to survey again when the item changed or is gone', () => {
    for (const status of ['changed', 'not_found'] as const) {
      const state = stateFromResult(result(status), true);
      expect(state.kind).toBe('refused');
      expect(controlsFor(state)).toEqual({ ...none, offerRescan: true });
    }
  });

  it('is busy while moving, then done or failed with the message', () => {
    expect(controlsFor({ kind: 'working' })).toEqual({ ...none, busy: true, canSwitch: false });
    expect(stateFromResult(result('recycled'), false)).toEqual({ kind: 'done' });
    const declined = stateFromResult(result('failed', 'Windows would delete it permanently; that was declined.'), false);
    expect(declined).toEqual({ kind: 'failed', message: 'Windows would delete it permanently; that was declined.' });
    // Trying again is allowed: Windows asks again.
    expect(controlsFor(declined).canConfirm).toBe(true);
  });

  it('blocks an item the dry run could not even check', () => {
    const state = stateFromResult(result('failed', 'could not check the item'), true);
    expect(state).toEqual({ kind: 'blocked', message: 'could not check the item' });
    expect(controlsFor(state)).toEqual(none);
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
      expect(controlsFor(state)).toEqual({ ...none, offerReconnect: true });
    }
  });

  it('shows other errors without letting the user go on', () => {
    const state = stateFromError(new HelperError('http', 'The body is not valid JSON.', 400, 'bad_request'));
    expect(state).toEqual({ kind: 'error', message: 'The body is not valid JSON.' });
    expect(controlsFor(state).canConfirm).toBe(false);
    const all: CleanupDialogState[] = [{ kind: 'done' }, { kind: 'error', message: '' }];
    for (const s of all) expect(controlsFor(s).busy).toBe(false);
  });
});

describe('deleting permanently', () => {
  it('needs the box "I understand this can\'t be undone" on top of a passed check', () => {
    const ready = stateFromResult(deletion('ok'), true);
    expect(ready).toEqual({ kind: 'ready' });
    expect(controlsFor(ready, 'permanent', false).canConfirm).toBe(false);
    expect(controlsFor(ready, 'permanent', true).canConfirm).toBe(true);
    // The box never unlocks anything the check refused, or a check still running.
    expect(controlsFor({ kind: 'checking' }, 'permanent', true).canConfirm).toBe(false);
    expect(controlsFor(stateFromResult(deletion('protected', { message: 'the item is in a protected location' }), true), 'permanent', true).canConfirm).toBe(false);
    expect(controlsFor(stateFromResult(deletion('failed', { message: 'could not check the item' }), true), 'permanent', true)).toEqual(none);
    // Recycling doesn't ask for it.
    expect(controlsFor(ready, 'recycle', false).canConfirm).toBe(true);
  });

  it('closes when the item is deleted, and keeps a failure retryable once understood', () => {
    expect(stateFromResult(deletion('deleted', { deletedFiles: 1 }), false)).toEqual({ kind: 'done' });
    const failed = stateFromResult(deletion('failed', { message: 'the file is in use by another process' }), false);
    expect(failed).toEqual({ kind: 'failed', message: 'the file is in use by another process' });
    expect(controlsFor(failed, 'permanent', true).canConfirm).toBe(true);
    expect(controlsFor(failed, 'permanent', false).canConfirm).toBe(false);
  });

  it('reports a partial deletion with its counts and the first error, and offers a new survey only', () => {
    const state = stateFromResult(deletion('partial', { deletedFiles: 812, deletedFolders: 40, failedEntries: 3, message: '3 entries could not be deleted, first: …\\db.lock: in use' }), false);
    expect(state).toEqual({ kind: 'partial', message: '3 entries could not be deleted, first: …\\db.lock: in use', deletedFiles: 812, deletedFolders: 40, failedEntries: 3 });
    expect(controlsFor(state, 'permanent', true)).toEqual({ canConfirm: false, busy: false, canSwitch: false, offerRescan: true, offerReconnect: false });
  });

  it('never mistakes a dry run for a deletion', () => {
    expect(stateFromResult(deletion('deleted'), true).kind).toBe('blocked');
    expect(stateFromResult(deletion('partial'), true).kind).toBe('blocked');
    expect(stateFromResult(deletion('ok'), false).kind).toBe('failed');
  });

  it('keeps the mode fixed while a request runs or after a partial deletion', () => {
    expect(controlsFor({ kind: 'working' }, 'permanent', true).canSwitch).toBe(false);
    expect(controlsFor({ kind: 'ready' }, 'permanent', true).canSwitch).toBe(true);
    expect(controlsFor({ kind: 'refused', status: 'unsupported', message: '' }, 'recycle').canSwitch).toBe(true);
  });

  it('says clearly when Windows denied access (normal rights while elevated), and offers no pointless retry', () => {
    for (const mode of ['recycle', 'permanent'] as const) {
      const state = stateFromResult(mode === 'recycle' ? result('failed', 'Access is denied.') : deletion('failed', { message: 'open: Access is denied.' }), false);
      expect(state).toEqual({ kind: 'failed', message: mode === 'recycle' ? 'Access is denied.' : 'open: Access is denied.', denied: true });
      expect(controlsFor(state, mode, true).canConfirm).toBe(false);
    }
    expect(isAccessDenied('access denied')).toBe(true);
    expect(isAccessDenied('the file is in use by another process')).toBe(false);
    // A dry run that can't open the item stays "blocked".
    expect(stateFromResult(result('failed', 'Access is denied.'), true).kind).toBe('blocked');
  });

  it('points to permanent deletion only where the Recycle Bin can\'t take an item the helper may delete', () => {
    const removable = stateFromResult(result('unsupported', 'the item is on a removable drive'), true);
    expect(suggestPermanent(removable, deletion('ok'))).toBe(true);
    expect(suggestPermanent(removable, deletion('unsupported', { message: 'the item is on a network drive' }))).toBe(false);
    expect(suggestPermanent(removable, null)).toBe(false);
    expect(suggestPermanent(stateFromResult(result('protected'), true), deletion('ok'))).toBe(false);
    expect(suggestPermanent({ kind: 'ready' }, deletion('ok'))).toBe(false);
  });
});
