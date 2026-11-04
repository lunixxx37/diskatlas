import { HelperError, type RecycleResult } from '../core';

// The confirmation dialog for "Move to Recycle Bin" as states, apart from the DOM, so the
// rules can be tested: what the user sees and may do after each answer from the helper.

/** The checks the helper refuses with, before anything is moved. */
export type RefusedStatus = 'protected' | 'changed' | 'unsupported' | 'not_found' | 'invalid';

export type RecycleDialogState =
  /** The dry run is running. */
  | { kind: 'checking' }
  /** The dry run passed: the item may go. */
  | { kind: 'ready' }
  | { kind: 'refused'; status: RefusedStatus; message: string }
  /** The helper is gone (or the browser blocks it). */
  | { kind: 'offline' }
  /** The real request is running. */
  | { kind: 'working' }
  /** Windows did not move it, e.g. the user declined "delete permanently?", or it is still there. */
  | { kind: 'failed'; message: string }
  /** The dry run could not even check it (e.g. "could not check the item"): it can't be moved. */
  | { kind: 'blocked'; message: string }
  /** Something unexpected (an HTTP error from the helper). */
  | { kind: 'error'; message: string }
  | { kind: 'recycled' };

const REFUSED: readonly RefusedStatus[] = ['protected', 'changed', 'unsupported', 'not_found', 'invalid'];

/** The dialog's state after the dry run (`dryRun`) or the real request answered. */
export function stateFromResult(result: RecycleResult, dryRun: boolean): RecycleDialogState {
  if ((REFUSED as readonly string[]).includes(result.status)) return { kind: 'refused', status: result.status as RefusedStatus, message: result.message };
  if (result.status === 'failed') return dryRun ? { kind: 'blocked', message: result.message } : { kind: 'failed', message: result.message };
  if (dryRun) return { kind: 'ready' };
  // A real request answers 'recycled'; 'ok' would mean nothing happened.
  return result.status === 'recycled' ? { kind: 'recycled' } : { kind: 'failed', message: result.message };
}

/** The dialog's state after a request failed. */
export function stateFromError(error: unknown): RecycleDialogState {
  if (error instanceof HelperError && (error.kind === 'not-running' || error.kind === 'denied')) return { kind: 'offline' };
  return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
}

export interface DialogControls {
  /** The danger button "Move to Recycle Bin" can be used. */
  canConfirm: boolean;
  /** The move runs: nothing can be pressed, and Escape does nothing. (The dry run changes nothing, so it can be cancelled.) */
  busy: boolean;
  /** Offer "Survey again" (the item changed or is gone). */
  offerRescan: boolean;
  /** Offer "Reconnect" (the helper is not connected). */
  offerReconnect: boolean;
}

export function controlsFor(state: RecycleDialogState): DialogControls {
  const none: DialogControls = { canConfirm: false, busy: false, offerRescan: false, offerReconnect: false };
  switch (state.kind) {
    case 'checking':
      return none;
    case 'working':
      return { ...none, busy: true };
    case 'ready':
    case 'failed':
      // After a failure the user may try again (Windows asks again if it must delete permanently).
      return { ...none, canConfirm: true };
    case 'refused':
      return { ...none, offerRescan: state.status === 'changed' || state.status === 'not_found' };
    case 'offline':
      return { ...none, offerReconnect: true };
    case 'blocked':
    case 'error':
    case 'recycled':
      return none;
  }
}
