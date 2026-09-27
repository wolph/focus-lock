import { normalizeSessionRules } from '../core/matcher';
import { exactDataEqual, hasExactKeys, isDenseArray, isRecord } from './exact-data';

/**
 * Both primitives are implemented in `exact-data.ts`, which imports nothing and so is reachable
 * from `src/core` without inverting the layer direction. They are re-exported here because this is
 * the intrinsics surface every consumer of the validators below already imports.
 */
export { hasExactKeys, isRecord } from './exact-data';

import { isRelativeMinuteDuration } from './numeric-validation';
import type {
  CycleConfig,
  GateState,
  PausedFromStateV2,
  ScheduleOccurrenceRef,
  SessionConfigV2,
  SessionDuration,
  SessionRuleSnapshot,
  SessionStateV2,
  SiteUnlock,
} from './types';

type UnknownRecord = Record<string, unknown>;

export const SESSION_RULE_SNAPSHOT_KEYS: readonly string[] = [
  'baselineRevision',
  'baselineCategories',
  'categories',
  'exclusions',
  'permanentBlacklist',
  'permanentAllowlist',
  'sessionBlacklist',
  'sessionAllowlist',
];
const CYCLE_CONFIG_KEYS: readonly string[] = [
  'focusMin',
  'shortBreakMin',
  'longBreakMin',
  'longEvery',
];
export const SESSION_CONFIG_V2_KEYS: readonly string[] = [
  'mode',
  'strictness',
  'duration',
  'cycling',
  'intention',
  'source',
  'scheduleOccurrence',
  'rules',
];
const SESSION_STATE_V2_KEYS: readonly string[] = [
  'version',
  'sessionId',
  'config',
  'startedAt',
  'sessionEndsAt',
  'phase',
  'phaseStartedAt',
  'phaseEndsAt',
  'cycleIndex',
  'pausedFrom',
  'focusedMs',
];
const UUID_RE: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedCanonicalSessionRuleSnapshot(
  value: unknown,
): value is SessionRuleSnapshot {
  const candidate: UnknownRecord | null = exactRecord(value, SESSION_RULE_SNAPSHOT_KEYS);
  if (candidate === null) return false;
  const normalized: SessionRuleSnapshot | null = normalizeSessionRules(candidate);
  return normalized !== null && exactDataEqual(candidate, normalized);
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedCycleConfigV2(value: unknown): value is CycleConfig {
  const candidate: UnknownRecord | null = exactRecord(value, CYCLE_CONFIG_KEYS);
  return (
    candidate !== null &&
    isRelativeMinuteDuration(candidate.focusMin) &&
    isRelativeMinuteDuration(candidate.shortBreakMin) &&
    isRelativeMinuteDuration(candidate.longBreakMin) &&
    isPositiveInteger(candidate.longEvery)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedSessionDuration(value: unknown): value is SessionDuration {
  const timed: UnknownRecord | null = exactRecord(value, ['kind', 'minutes']);
  if (timed !== null) {
    return timed.kind === 'timed' && isRelativeMinuteDuration(timed.minutes);
  }
  const indefinite: UnknownRecord | null = exactRecord(value, ['kind']);
  return indefinite !== null && indefinite.kind === 'until-stopped';
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedScheduleOccurrenceRef(
  value: unknown,
): value is ScheduleOccurrenceRef {
  const candidate: UnknownRecord | null = exactRecord(value, [
    'version',
    'token',
    'entryId',
    'localStartDate',
  ]);
  return (
    candidate !== null &&
    candidate.version === 1 &&
    isNonBlankString(candidate.entryId) &&
    isLocalDateValue(candidate.localStartDate) &&
    candidate.token === `${candidate.entryId}@${candidate.localStartDate}`
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedSessionConfigV2(value: unknown): value is SessionConfigV2 {
  const candidate: UnknownRecord | null = exactRecord(value, SESSION_CONFIG_V2_KEYS);
  const duration: unknown = candidate?.duration;
  if (
    candidate === null ||
    (candidate.mode !== 'blacklist' && candidate.mode !== 'whitelist') ||
    (candidate.strictness !== 'flexible' &&
      candidate.strictness !== 'friction' &&
      candidate.strictness !== 'hard') ||
    !validateDetachedSessionDuration(duration) ||
    (candidate.cycling !== null && !validateDetachedCycleConfigV2(candidate.cycling)) ||
    typeof candidate.intention !== 'string' ||
    (candidate.source !== 'manual' && candidate.source !== 'schedule') ||
    !validateDetachedCanonicalSessionRuleSnapshot(candidate.rules)
  ) {
    return false;
  }
  // An indefinite session keeps the Flexible or Friction type the user chose. Hard has no manual
  // end, so with no timer it would never end at all, and cycling needs a finite session end.
  if (duration.kind === 'until-stopped') {
    if (candidate.strictness === 'hard' || candidate.cycling !== null) return false;
  }
  return candidate.source === 'manual'
    ? candidate.scheduleOccurrence === null
    : validateDetachedScheduleOccurrenceRef(candidate.scheduleOccurrence);
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedPausedFromStateV2(value: unknown): value is PausedFromStateV2 {
  const candidate: UnknownRecord | null = exactRecord(value, ['phase', 'phaseEndsAt']);
  return (
    candidate !== null &&
    (candidate.phase === 'focus' || candidate.phase === 'break') &&
    (candidate.phaseEndsAt === null || isSafeTimestamp(candidate.phaseEndsAt))
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedSessionStateV2(value: unknown): value is SessionStateV2 {
  const candidate: UnknownRecord | null = exactRecord(value, SESSION_STATE_V2_KEYS);
  const config: unknown = candidate?.config;
  if (
    candidate === null ||
    candidate.version !== 2 ||
    !isUuid(candidate.sessionId) ||
    !validateDetachedSessionConfigV2(config) ||
    !isSafeTimestamp(candidate.startedAt) ||
    !isSafeTimestamp(candidate.phaseStartedAt) ||
    candidate.phaseStartedAt < candidate.startedAt ||
    !isNonNegativeInteger(candidate.cycleIndex) ||
    !isSafeTimestamp(candidate.focusedMs) ||
    (candidate.phase !== 'focus' && candidate.phase !== 'break' && candidate.phase !== 'paused')
  ) {
    return false;
  }
  if (config.duration.kind === 'until-stopped') {
    // An indefinite session never enters break, so the producer never advances its cycle index.
    if (candidate.sessionEndsAt !== null || candidate.phase === 'break') return false;
    if (candidate.cycleIndex !== 0) return false;
    if (candidate.phase === 'focus') {
      return candidate.phaseEndsAt === null && candidate.pausedFrom === null;
    }
    return (
      isSafeTimestamp(candidate.phaseEndsAt) &&
      candidate.phaseEndsAt >= candidate.phaseStartedAt &&
      validateDetachedPausedFromStateV2(candidate.pausedFrom) &&
      candidate.pausedFrom.phase === 'focus' &&
      candidate.pausedFrom.phaseEndsAt === null
    );
  }
  const durationMs: number = Math.round(config.duration.minutes * 60_000);
  const expectedSessionEndsAt: number = candidate.startedAt + durationMs;
  if (
    !isSafeTimestamp(expectedSessionEndsAt) ||
    candidate.sessionEndsAt !== expectedSessionEndsAt ||
    !isSafeTimestamp(candidate.sessionEndsAt) ||
    !isSafeTimestamp(candidate.phaseEndsAt) ||
    candidate.phaseEndsAt < candidate.phaseStartedAt ||
    candidate.phaseEndsAt > candidate.sessionEndsAt
  ) {
    return false;
  }
  if (candidate.phase === 'focus') return candidate.pausedFrom === null;
  if (candidate.phase === 'break') {
    // The cycling tail rule is strict. A break is started only when it ends before the session
    // does, so a break landing exactly on the session end is a state no producer can reach. A
    // focus phase may run through that end, which is why the comparison above stays inclusive.
    return (
      config.cycling !== null &&
      candidate.pausedFrom === null &&
      candidate.phaseEndsAt < candidate.sessionEndsAt
    );
  }
  return (
    validateDetachedPausedFromStateV2(candidate.pausedFrom) &&
    isSafeTimestamp(candidate.pausedFrom.phaseEndsAt) &&
    candidate.pausedFrom.phaseEndsAt >= candidate.phaseStartedAt &&
    candidate.pausedFrom.phaseEndsAt <= candidate.sessionEndsAt &&
    (candidate.pausedFrom.phase !== 'break' || config.cycling !== null)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedGateState(value: unknown): value is GateState {
  const candidate: UnknownRecord | null = exactRecord(value, [
    'kind',
    'host',
    'openedAt',
    'readyAt',
    'requiredPhrase',
    'forceEndAvailable',
  ]);
  if (
    candidate === null ||
    (candidate.kind !== 'pause' &&
      candidate.kind !== 'unlockSite' &&
      candidate.kind !== 'excludeSite' &&
      candidate.kind !== 'cancel') ||
    !isNullableString(candidate.host) ||
    !isSafeTimestamp(candidate.openedAt) ||
    !isSafeTimestamp(candidate.readyAt) ||
    candidate.readyAt < candidate.openedAt ||
    !isNullableString(candidate.requiredPhrase) ||
    typeof candidate.forceEndAvailable !== 'boolean'
  ) {
    return false;
  }
  return candidate.kind === 'unlockSite' || candidate.kind === 'excludeSite'
    ? isNonBlankString(candidate.host)
    : candidate.host === null;
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedSiteUnlock(value: unknown): value is SiteUnlock {
  const candidate: UnknownRecord | null = exactRecord(value, ['host', 'until']);
  return candidate !== null && isNonBlankString(candidate.host) && isSafeTimestamp(candidate.until);
}

/** Detached exact record gate: rejects unknown keys, symbol keys, and non-plain containers. */
export function exactRecord(value: unknown, keys: readonly string[]): UnknownRecord | null {
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  return value;
}

/** Dense-array gate plus per-entry validation for already-detached exact plain data. */
export function everyDenseEntry<T>(
  value: unknown,
  validateEntry: (entry: unknown) => entry is T,
): value is T[] {
  return isDenseArray(value) && value.every((entry: unknown): boolean => validateEntry(entry));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

export function isNullableNonBlankString(value: unknown): value is string | null {
  return value === null || isNonBlankString(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isLocalDateValue(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [yearText, monthText, dayText]: string[] = value.split('-');
  const year: number = Number(yearText);
  const month: number = Number(monthText);
  const day: number = Number(dayText);
  const candidate: Date = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}
