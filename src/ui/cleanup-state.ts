import { HelperError, type DeleteResult, type RecycleResult } from '../core';

// The clean-up dialog as states, apart from the DOM, so the rules can be tested: what the
// user sees and may do after each answer from the helper, in either mode.

/** "recycle": into the Recycle Bin (the default). "permanent": deleted for good, without it. */
export type CleanupMode = 'recycle' | 'permanent';

/** The checks the helper refuses with, before anything is moved or deleted. */
export type RefusedStatus = 'protected' | 'changed' | 'unsupported' | 'not_found' | 'invalid';

export type CleanupDialogState =
  /** The dry run is running. */
  | { kind: 'checking' }
  /** The dry run passed: the item may go. */
  | { kind: 'ready' }
  | { kind: 'refused'; status: RefusedStatus; message: string }
  /** The helper is gone (or the browser blocks it). */
  | { kind: 'offline' }
  /** The real request is running. */
  | { kind: 'working' }
  /**
   * Nothing happened: Windows didn't move it (e.g. "delete permanently?" was declined, or
   * it is still there), or nothing could be deleted (e.g. a file in use). `denied`: Windows
   * refused access; the helper changes files only with the user's normal rights, so trying
   * again can't help.
   */
  | { kind: 'failed'; message: string; denied?: true }
  /** The dry run could not even check it (e.g. "could not check the item"): it can't go. */
  | { kind: 'blocked'; message: string }
  /** Something unexpected (an HTTP error from the helper). */
  | { kind: 'error'; message: string }
  /** A folder deleted in part: these counts are gone, `failedEntries` are still there. */
  | { kind: 'partial'; message: string; deletedFiles: number; deletedFolders: number; failedEntries: number }
  /** Recycled or deleted: the dialog closes. */
  | { kind: 'done' };

const REFUSED: readonly RefusedStatus[] = ['protected', 'changed', 'unsupported', 'not_found', 'invalid'];

/** The helper's (English) message says Windows denied access. */
export function isAccessDenied(message: string): boolean {
  return /access (is )?denied/i.test(message);
}

const failed = (message: string): CleanupDialogState => (isAccessDenied(message) ? { kind: 'failed', message, denied: true } : { kind: 'failed', message });

/** The dialog's state after the dry run (`dryRun`) or the real request answered, in either mode. */
export function stateFromResult(result: RecycleResult | DeleteResult, dryRun: boolean): CleanupDialogState {
  const status: string = result.status;
  if ((REFUSED as readonly string[]).includes(status)) return { kind: 'refused', status: status as RefusedStatus, message: result.message };
  if (status === 'failed') return dryRun ? { kind: 'blocked', message: result.message } : failed(result.message);
  if (dryRun) return status === 'ok' ? { kind: 'ready' } : { kind: 'blocked', message: result.message };
  if (status === 'recycled' || status === 'deleted') return { kind: 'done' };
  if (status === 'partial' && 'deletedFiles' in result) {
    return { kind: 'partial', message: result.message, deletedFiles: result.deletedFiles, deletedFolders: result.deletedFolders, failedEntries: result.failedEntries };
  }
  // A real request answers recycled, deleted or partial; 'ok' would mean nothing happened.
  return failed(result.message);
}

/** The dialog's state after a request failed. */
export function stateFromError(error: unknown): CleanupDialogState {
  if (error instanceof HelperError && (error.kind === 'not-running' || error.kind === 'denied')) return { kind: 'offline' };
  return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
}

export interface DialogControls {
  /** The primary button ("Move to Recycle Bin" or "Delete permanently") can be used. */
  canConfirm: boolean;
  /** The move or deletion runs: nothing can be pressed, and Escape does nothing. (A dry run changes nothing, so it can be cancelled.) */
  busy: boolean;
  /** The mode can be switched (not while the request runs, nor once something was deleted). */
  canSwitch: boolean;
  /** Offer "Survey again" (the item changed, is gone, or was deleted in part). */
  offerRescan: boolean;
  /** Offer "Reconnect" (the helper is not connected). */
  offerReconnect: boolean;
}

/**
 * What the dialog offers in `state`. Deleting permanently also needs `understood`: the box
 * "I understand this can't be undone" is ticked.
 */
export function controlsFor(state: CleanupDialogState, mode: CleanupMode = 'recycle', understood = false): DialogControls {
  const none: DialogControls = { canConfirm: false, busy: false, canSwitch: true, offerRescan: false, offerReconnect: false };
  switch (state.kind) {
    case 'checking':
      return none;
    case 'working':
      return { ...none, busy: true, canSwitch: false };
    case 'ready':
      return { ...none, canConfirm: mode === 'recycle' || understood };
    case 'failed':
      // After a failure the user may try again (Windows asks again if it must delete
      // permanently), but not after "access denied": the rights stay the same.
      return { ...none, canConfirm: !state.denied && (mode === 'recycle' || understood) };
    case 'refused':
      return { ...none, offerRescan: state.status === 'changed' || state.status === 'not_found' };
    case 'offline':
      return { ...none, offerReconnect: true };
    case 'partial':
      // Part of it is gone: only a new survey shows what is left.
      return { ...none, canSwitch: false, offerRescan: true };
    case 'blocked':
    case 'error':
      return none;
    case 'done':
      return { ...none, canSwitch: false };
  }
}

/**
 * In recycle mode, whether to point to permanent deletion instead: the Recycle Bin can't
 * take the item (e.g. on a removable drive, or with a path over 259 characters), and the
 * helper's permanent-delete check passed for it.
 */
export function suggestPermanent(recycle: CleanupDialogState, permanentCheck: DeleteResult | null): boolean {
  return recycle.kind === 'refused' && recycle.status === 'unsupported' && permanentCheck?.status === 'ok';
}
