import { type ExactDataSnapshot, snapshotExactData } from '../shared/exact-data';
import { t } from '../shared/i18n';
import type {
  RetryCleanupResultCodeV2,
  SessionCommandResultCodeV2,
  StartSessionResponseV2,
  TransitionFailureReasonV2,
} from '../shared/messages';
import { hasExactKeys, isRecord } from '../shared/v2-domain-intrinsics';

/** Shown when the worker's start answer is not an exact data response. */
export const START_FAILED_COPY: string = t('popup_start_failed');

type UnknownRecord = Record<string, unknown>;
type CodeSet = Readonly<Record<string, true>>;

type StartFailureCode = Exclude<StartSessionResponseV2, { ok: true }>['code'];
type CommandFailureCode = Exclude<SessionCommandResultCodeV2 | RetryCleanupResultCodeV2, 'ok'>;

/** Every rejected start code from the result table. A new code breaks this record. */
const START_FAILURE_CODES: Readonly<Record<StartFailureCode, true>> = {
  'invalid-request': true,
  'website-access-lost': true,
  'content-registration-failed': true,
  'alarm-failed': true,
  'tab-enforcement-failed': true,
  'transition-cleanup-pending': true,
  'closure-cleanup-pending': true,
  'data-clear-pending': true,
  'work-target-not-saved': true,
};

/** Only a failed transition step reports that its effects still need cleanup. */
const CLEANUP_PENDING_CODES: Readonly<Record<TransitionFailureReasonV2, true>> = {
  'website-access-lost': true,
  'content-registration-failed': true,
  'alarm-failed': true,
  'tab-enforcement-failed': true,
};

/** Every rejected session command and retry code from the result table. */
const COMMAND_FAILURE_CODES: Readonly<Record<CommandFailureCode, true>> = {
  'no-active-session': true,
  'end-not-allowed': true,
  'no-active-gate': true,
  'gate-not-ready': true,
  'confirmation-mismatch': true,
  'transition-cleanup-pending': true,
  'closure-cleanup-pending': true,
  'data-clear-pending': true,
  'retry-not-available': true,
};

const NO_CLEANUP_PENDING_CODES: CodeSet = {};

function isKnownCode(codes: CodeSet, code: unknown): boolean {
  return typeof code === 'string' && Object.hasOwn(codes, code);
}

/**
 * The transport carries no runtime guard, so every answer is validated here: an exact
 * data response with a known code reports the worker's own text, and anything else,
 * including a response that hides an accessor behind `code`, reports the fallback.
 */
function resultErrorMessage(
  response: unknown,
  failureCodes: CodeSet,
  cleanupPendingCodes: CodeSet,
  fallback: string,
): string | null {
  const snapshot: ExactDataSnapshot | null = snapshotExactData(response);
  if (snapshot === null || !isRecord(snapshot.value)) return fallback;
  const value: UnknownRecord = snapshot.value;

  if (value.ok === true) {
    return value.code === 'ok' && hasExactKeys(value, ['ok', 'code']) ? null : fallback;
  }
  if (value.ok !== false) return fallback;
  if (!isKnownCode(failureCodes, value.code)) return fallback;
  if (typeof value.error !== 'string' || value.error.trim() === '') return fallback;
  if (hasExactKeys(value, ['ok', 'code', 'error'])) return value.error;

  const cleanupPending: boolean =
    value.cleanupPending === true &&
    isKnownCode(cleanupPendingCodes, value.code) &&
    hasExactKeys(value, ['ok', 'code', 'error', 'cleanupPending']);
  return cleanupPending ? value.error : fallback;
}

/**
 * True for the exact answer that says the session started and only its work tab was not saved.
 * The form hands that message to the view that outlives it, because the active view is about to
 * take over on the next snapshot.
 */
export function startedWithoutWorkTarget(response: unknown): boolean {
  const snapshot: ExactDataSnapshot | null = snapshotExactData(response);
  if (snapshot === null || !isRecord(snapshot.value)) return false;
  const value: UnknownRecord = snapshot.value;
  return (
    value.ok === false &&
    value.code === 'work-target-not-saved' &&
    typeof value.error === 'string' &&
    value.error.trim() !== '' &&
    hasExactKeys(value, ['ok', 'code', 'error'])
  );
}

/** null while the start was accepted, the message to show otherwise. */
export function startErrorMessage(response: StartSessionResponseV2): string | null {
  return resultErrorMessage(
    response,
    START_FAILURE_CODES,
    CLEANUP_PENDING_CODES,
    START_FAILED_COPY,
  );
}

/**
 * null while the command was accepted, the message to show otherwise. The parameter is
 * `unknown` because every caller reads an answer that crossed a message port, and this
 * function is the guard that answer passes through.
 */
export function commandErrorMessage(response: unknown, fallback: string): string | null {
  return resultErrorMessage(response, COMMAND_FAILURE_CODES, NO_CLEANUP_PENDING_CODES, fallback);
}
