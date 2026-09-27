import { validateRule } from '../core/matcher';
import { scheduleEntriesOverlap, validateEntry } from '../core/schedule';
import { isDailyDate, parseDailyAgg, parseMonthlyAgg } from '../core/stats';
import { CATEGORY_IDS, cancelPhrase, MAX_FREEZE_TOKENS } from './constants';
import {
  type ExactDataSnapshot,
  exactDataEqual,
  exactDenseArrayLength,
  hasExactKeys as hasExactKeysUnguarded,
  isDenseArray,
  isRecord as isRecordUnguarded,
  snapshotExactData,
} from './exact-data';
import type {
  Ack,
  BootFailureResponse,
  OnboardingCleanupResponse,
  OnboardingCompletionResponse,
  OnboardingDraftLoadResponse,
  OnboardingDraftWriteResponse,
  RetrySyncResponse,
  StatsBundle,
  WebsiteAccessReconciliation,
} from './messages';
import {
  isPositiveMinuteValue,
  isRelativeMillisecondDuration,
  isRelativeMinuteDuration,
  isSafeDayCount,
} from './numeric-validation';
import type {
  BootFailure,
  CategoryId,
  CycleConfig,
  EndActionLabelV2,
  EndAuthorityV2,
  EndGateConfirmLabelV2,
  EventRecord,
  GateState,
  InstallMarker,
  LegacyEventRecord,
  ListsConfig,
  NormalizedScheduleEntryV1,
  OnboardingDraft,
  PauseEconomy,
  Phase,
  Rule,
  ScheduleDuration,
  ScheduleEntryV2,
  ScheduleOccurrenceRef,
  SessionConfigV2,
  SessionDuration,
  SessionEndedEventV2,
  SessionEventRecordV2,
  SessionLifecycleV2,
  SessionMode,
  SessionRuleSnapshot,
  SessionSnapshot,
  SessionSnapshotV2,
  SessionStartedEventV2,
  SessionStateV2,
  Settings,
  SettingsV2,
  SetupState,
  SiteUnlock,
  StreakState,
  Strictness,
} from './types';
import {
  isNonBlankString,
  isNonNegativeInteger,
  isSafeTimestamp,
  isUuid,
  SESSION_CONFIG_V2_KEYS,
  SESSION_RULE_SNAPSHOT_KEYS,
  validateDetachedCanonicalSessionRuleSnapshot,
  validateDetachedCycleConfigV2,
  validateDetachedGateState,
  validateDetachedScheduleOccurrenceRef,
  validateDetachedSessionConfigV2,
  validateDetachedSessionDuration,
  validateDetachedSessionStateV2,
  validateDetachedSiteUnlock,
} from './v2-domain-intrinsics';

type UnknownRecord = Record<string, unknown>;
type StoredScheduleEntryShape = 'v1' | 'v2';

const MONTH_RE: RegExp = /^(\d{4})-(0[1-9]|1[0-2])$/;
const SCHEDULE_ENTRY_V1_KEYS: readonly string[] = [
  'id',
  'days',
  'start',
  'end',
  'mode',
  'strictness',
  'cycling',
  'intention',
  'enabled',
];
const SCHEDULE_ENTRY_V2_KEYS: readonly string[] = [
  'id',
  'days',
  'start',
  'end',
  'duration',
  'mode',
  'strictness',
  'cycling',
  'intention',
  'enabled',
];
const SETTINGS_KEYS: readonly string[] = [
  'theme',
  'presetsMin',
  'defaultMode',
  'defaultStrictness',
  'defaultCycling',
  'cyclingOnByDefault',
  'pause',
  'gate',
  'badgeCountdown',
  'sessionCompleteNotification',
  'sounds',
  'schedule',
  'streakGoalMin',
  'streakFreezeIntervalDays',
  'retentionDays',
];
/**
 * The rule lives once, in `exact-data.ts`. The catch stays here because the imported
 * intrinsics document a detached precondition and so let a hostile object throw: `Array.isArray`
 * throws on a revoked proxy and `Reflect.ownKeys` throws on a hostile `ownKeys` trap, while this
 * module runs against raw stored and messaged values. Every exported validator is wrapped in
 * `safelyValidate` today, so the catch is currently redundant. It is kept so the guarantee holds by
 * construction rather than by an audit of thirty call sites staying true.
 */
function isRecord(value: unknown): value is UnknownRecord {
  try {
    return isRecordUnguarded(value);
  } catch {
    return false;
  }
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  try {
    return hasExactKeysUnguarded(value, keys);
  } catch {
    return false;
  }
}

function exactOwnDataSnapshot(value: unknown, keys: readonly string[]): UnknownRecord | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
    const snapshot: UnknownRecord = {};
    for (const key of keys) {
      const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
        value,
        key,
      );
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function stableExactOwnDataSnapshot(value: unknown, keys: readonly string[]): UnknownRecord | null {
  try {
    if (exactOwnDataSnapshot(value, keys) === null) return null;
    const snapshot: ExactDataSnapshot | null = snapshotExactData(value);
    return snapshot === null ? null : exactOwnDataSnapshot(snapshot.value, keys);
  } catch {
    return null;
  }
}

function exactKeysMatch(actual: readonly PropertyKey[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((key: PropertyKey): boolean => typeof key === 'string' && expected.includes(key))
  );
}

function storedScheduleEntryShape(value: unknown): StoredScheduleEntryShape | null {
  if (!isRecord(value)) return null;
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  if (exactKeysMatch(keys, SCHEDULE_ENTRY_V1_KEYS)) return 'v1';
  if (exactKeysMatch(keys, SCHEDULE_ENTRY_V2_KEYS)) return 'v2';
  return null;
}

export function isSetupState(value: unknown): value is SetupState {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      hasExactKeys(value, [
        'version',
        'completed',
        'websiteAccess',
        'blockingRegistration',
        'websiteAccessNotice',
        'storageMode',
        'syncWriteStatus',
        'storageError',
        'dataClear',
        'legacyImported',
      ]) &&
      value.version === 1 &&
      typeof value.completed === 'boolean' &&
      (value.websiteAccess === 'pending' ||
        value.websiteAccess === 'granted' ||
        value.websiteAccess === 'denied') &&
      (value.blockingRegistration === 'unavailable' ||
        value.blockingRegistration === 'ready' ||
        value.blockingRegistration === 'error') &&
      (value.websiteAccessNotice === null ||
        value.websiteAccessNotice === 'revoked-during-session' ||
        value.websiteAccessNotice === 'registration-failed-during-session') &&
      (value.storageMode === null ||
        value.storageMode === 'local' ||
        value.storageMode === 'sync') &&
      (value.syncWriteStatus === 'idle' ||
        value.syncWriteStatus === 'pending' ||
        value.syncWriteStatus === 'error') &&
      (value.storageError === null ||
        value.storageError === 'legacy-migration-failed' ||
        value.storageError === 'sync-publish-failed' ||
        value.storageError === 'remote-deletion-failed' ||
        value.storageError === 'local-clear-failed' ||
        value.storageError === 'legacy-remote-policy-dropped' ||
        value.storageError === 'boot-failed' ||
        value.storageError === 'runtime-boot-failed') &&
      isRecord(value.dataClear) &&
      hasExactKeys(value.dataClear, ['status', 'scope', 'phase']) &&
      ((value.dataClear.status === 'idle' &&
        value.dataClear.scope === null &&
        value.dataClear.phase === null) ||
        ((value.dataClear.status === 'pending' || value.dataClear.status === 'error') &&
          ((value.dataClear.scope === 'synced-policy' &&
            (value.dataClear.phase === 'remote' || value.dataClear.phase === 'local')) ||
            // Only the all-data clear reaches the browser-reset phase, where the journal owns the
            // Runtime, Setup, and install-marker projections it materializes.
            (value.dataClear.scope === 'all' &&
              (value.dataClear.phase === 'remote' ||
                value.dataClear.phase === 'local' ||
                value.dataClear.phase === 'browser-reset')) ||
            (value.dataClear.scope === 'local-history' &&
              (value.dataClear.phase === 'local' || value.dataClear.phase === 'runtime'))))) &&
      typeof value.legacyImported === 'boolean',
  );
}

export function isOnboardingDraft(value: unknown): value is OnboardingDraft {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      hasExactKeys(value, [
        'version',
        'revision',
        'step',
        'settings',
        'lists',
        'websiteAccessChoice',
        'syncEnabled',
      ]) &&
      value.version === 1 &&
      isNonNegativeInteger(value.revision) &&
      (value.step === 1 || value.step === 2 || value.step === 3) &&
      isSettings(value.settings) &&
      isListsConfig(value.lists) &&
      (value.websiteAccessChoice === 'pending' ||
        value.websiteAccessChoice === 'granted' ||
        value.websiteAccessChoice === 'denied' ||
        value.websiteAccessChoice === 'deferred' ||
        value.websiteAccessChoice === 'registration-error') &&
      typeof value.syncEnabled === 'boolean',
  );
}

function isOnboardingOperationalFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['ok', 'error']) &&
    value.ok === false &&
    isNonBlankString(value.error)
  );
}

export function isOnboardingDraftLoadResponse(
  value: unknown,
): value is OnboardingDraftLoadResponse {
  return safelyValidate(
    (): boolean =>
      isOnboardingOperationalFailure(value) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'draft', 'invalid']) &&
        value.ok === true &&
        (value.draft === null || isOnboardingDraft(value.draft)) &&
        typeof value.invalid === 'boolean' &&
        (value.draft === null || value.invalid === false)),
  );
}

export function isOnboardingDraftWriteResponse(
  value: unknown,
): value is OnboardingDraftWriteResponse {
  return safelyValidate(
    (): boolean =>
      isOnboardingOperationalFailure(value) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'draft']) &&
        value.ok === true &&
        isOnboardingDraft(value.draft)) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'error', 'conflict', 'completed', 'draft']) &&
        value.ok === false &&
        isNonBlankString(value.error) &&
        value.conflict === true &&
        typeof value.completed === 'boolean' &&
        (value.draft === null || isOnboardingDraft(value.draft))),
  );
}

export function isOnboardingCleanupResponse(value: unknown): value is OnboardingCleanupResponse {
  return isOnboardingActionResponse(value);
}

export function isOnboardingCompletionResponse(
  value: unknown,
): value is OnboardingCompletionResponse {
  return safelyValidate(
    (): boolean =>
      isOnboardingActionResponse(value) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'error', 'conflict', 'completed', 'draft']) &&
        value.ok === false &&
        isNonBlankString(value.error) &&
        value.conflict === true &&
        typeof value.completed === 'boolean' &&
        (value.draft === null || isOnboardingDraft(value.draft))),
  );
}

export function isWebsiteAccessReconciliation(
  value: unknown,
): value is WebsiteAccessReconciliation {
  return safelyValidate(
    (): boolean =>
      isOnboardingOperationalFailure(value) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'granted', 'registration']) &&
        value.ok === true &&
        ((value.granted === true && value.registration === 'ready') ||
          (value.granted === false && value.registration === 'unavailable'))) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'error', 'granted', 'registration']) &&
        value.ok === false &&
        isNonBlankString(value.error) &&
        typeof value.granted === 'boolean' &&
        value.registration === 'error') ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'error', 'registration']) &&
        value.ok === false &&
        isNonBlankString(value.error) &&
        value.registration === 'error'),
  );
}

function isOnboardingActionResponse(value: unknown): boolean {
  return safelyValidate(
    (): boolean =>
      isOnboardingOperationalFailure(value) ||
      (isRecord(value) && hasExactKeys(value, ['ok']) && value.ok === true),
  );
}

export function isInstallMarker(value: unknown): value is InstallMarker {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      hasExactKeys(value, ['version', 'profile', 'latestReason', 'extensionVersion']) &&
      value.version === 1 &&
      (value.profile === 'clean' || value.profile === 'legacy') &&
      (value.latestReason === 'install' || value.latestReason === 'update') &&
      isNonBlankString(value.extensionVersion),
  );
}

function safelyValidate(validate: () => boolean): boolean {
  try {
    return validate();
  } catch {
    return false;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** The one closure journal identity: the closed session's UUID plus this suffix. */
const CLOSURE_ID_SUFFIX: string = ':close';

/** Builds a closure journal identity. `ClosureProjection.closureId` is exactly this value. */
export function closureIdFor(sessionId: string): string {
  return `${sessionId}${CLOSURE_ID_SUFFIX}`;
}

/** Accepts exactly one UUID followed by the closure suffix, and nothing else. */
function isClosureId(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith(CLOSURE_ID_SUFFIX)) return false;
  return isUuid(value.slice(0, value.length - CLOSURE_ID_SUFFIX.length));
}

/**
 * Each cleanup journal is named by its own durable identity. A transition owns a UUID. A closure
 * owns its `closureId`, which is the closed session's UUID followed by the suffix below.
 */
function isCleanupJournalId(journal: unknown, id: unknown): boolean {
  if (journal === 'transition') return isUuid(id);
  return journal === 'closure' && isClosureId(id);
}

function isCanonicalSessionRuleSnapshotValue(value: unknown): value is SessionRuleSnapshot {
  const candidate: UnknownRecord | null = stableExactOwnDataSnapshot(
    value,
    SESSION_RULE_SNAPSHOT_KEYS,
  );
  return validateDetachedCanonicalSessionRuleSnapshot(candidate);
}

export function isCanonicalSessionRuleSnapshot(value: unknown): value is SessionRuleSnapshot {
  return safelyValidate((): boolean => isCanonicalSessionRuleSnapshotValue(value));
}

function sessionDurationSnapshot(value: unknown): SessionDuration | null {
  const timed: UnknownRecord | null = stableExactOwnDataSnapshot(value, ['kind', 'minutes']);
  if (validateDetachedSessionDuration(timed)) return timed;
  const indefinite: UnknownRecord | null = stableExactOwnDataSnapshot(value, ['kind']);
  return validateDetachedSessionDuration(indefinite) ? indefinite : null;
}

function isSessionDurationValue(value: unknown): value is SessionDuration {
  return sessionDurationSnapshot(value) !== null;
}

export function isSessionDuration(value: unknown): value is SessionDuration {
  return safelyValidate((): boolean => isSessionDurationValue(value));
}

function isScheduleDurationValue(value: unknown): value is ScheduleDuration {
  const candidate: UnknownRecord | null = stableExactOwnDataSnapshot(value, ['kind']);
  return candidate !== null && (candidate.kind === 'window' || candidate.kind === 'until-stopped');
}

export function isScheduleDuration(value: unknown): value is ScheduleDuration {
  return safelyValidate((): boolean => isScheduleDurationValue(value));
}

function isScheduleOccurrenceRefValue(value: unknown): value is ScheduleOccurrenceRef {
  const candidate: UnknownRecord | null = stableExactOwnDataSnapshot(value, [
    'version',
    'token',
    'entryId',
    'localStartDate',
  ]);
  return validateDetachedScheduleOccurrenceRef(candidate);
}

export function isScheduleOccurrenceRef(value: unknown): value is ScheduleOccurrenceRef {
  return safelyValidate((): boolean => isScheduleOccurrenceRefValue(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRule(value: unknown): value is Rule {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'pattern']) ||
    (value.kind !== 'host' && value.kind !== 'regex') ||
    typeof value.pattern !== 'string'
  ) {
    return false;
  }
  return validateRule({ kind: value.kind, pattern: value.pattern }) === null;
}

/**
 * One cycle-config rule for Settings, for a v1 schedule entry, and for a v2 one. The private second
 * implementation this replaced could accept a `CycleConfig` the v2 schedule entry refused, or the
 * reverse, because both were reachable from this file.
 */
export function isCycleConfig(value: unknown): value is CycleConfig {
  return safelyValidate((): boolean => validateDetachedCycleConfigV2(value));
}

function isScheduleEntry(value: unknown): value is NormalizedScheduleEntryV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SCHEDULE_ENTRY_V1_KEYS) ||
    !isNonBlankString(value.id) ||
    !isDenseArray(value.days) ||
    value.days.length === 0 ||
    !value.days.every((day: unknown): day is number => isNonNegativeInteger(day) && day <= 6) ||
    new Set(value.days).size !== value.days.length ||
    typeof value.start !== 'string' ||
    typeof value.end !== 'string' ||
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    (value.strictness !== 'flexible' &&
      value.strictness !== 'hard' &&
      value.strictness !== 'friction') ||
    (value.cycling !== null && !isCycleConfig(value.cycling)) ||
    typeof value.intention !== 'string' ||
    typeof value.enabled !== 'boolean'
  ) {
    return false;
  }
  const entry: NormalizedScheduleEntryV1 = {
    id: value.id,
    days: value.days,
    start: value.start,
    end: value.end,
    mode: value.mode,
    strictness: value.strictness,
    cycling: value.cycling,
    intention: value.intention,
    enabled: value.enabled,
  };
  return validateEntry(entry) === null;
}

function isScheduleEntryV2Value(value: unknown): value is ScheduleEntryV2 {
  const candidate: UnknownRecord | null = stableExactOwnDataSnapshot(value, SCHEDULE_ENTRY_V2_KEYS);
  if (
    candidate === null ||
    !isScheduleDurationValue(candidate.duration) ||
    (candidate.cycling !== null && !validateDetachedCycleConfigV2(candidate.cycling))
  ) {
    return false;
  }
  const legacyShape: NormalizedScheduleEntryV1 = {
    id: candidate.id as string,
    days: candidate.days as number[],
    start: candidate.start as string,
    end: candidate.end as string,
    mode: candidate.mode as SessionMode,
    strictness: candidate.strictness as Strictness,
    cycling: candidate.cycling as CycleConfig | null,
    intention: candidate.intention as string,
    enabled: candidate.enabled as boolean,
  };
  if (!isScheduleEntry(legacyShape)) return false;
  return (
    candidate.duration.kind === 'window' ||
    (candidate.strictness !== 'hard' && candidate.cycling === null)
  );
}

export function isScheduleEntryV2(value: unknown): value is ScheduleEntryV2 {
  return safelyValidate((): boolean => isScheduleEntryV2Value(value));
}

/** The live schedule is v2: every entry carries its own duration. */
function isSchedule(value: unknown): value is ScheduleEntryV2[] {
  if (!isDenseArray(value)) return false;
  const ids: Set<string> = new Set<string>();
  for (let index: number = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
    const candidate: unknown = value[index];
    if (!isScheduleEntryV2Value(candidate)) return false;
    const entry: ScheduleEntryV2 = candidate;
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
    for (let previousIndex: number = 0; previousIndex < index; previousIndex++) {
      const previous: ScheduleEntryV2 = value[previousIndex] as ScheduleEntryV2;
      if (scheduleEntriesOverlap(previous, entry)) return false;
    }
  }
  return true;
}

function isPauseEconomyValue(value: unknown): value is PauseEconomy {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['earnRatio', 'capMs', 'pauseMs', 'unlockMs']) &&
    isNonNegativeNumber(value.earnRatio) &&
    isNonNegativeInteger(value.capMs) &&
    isRelativeMillisecondDuration(value.pauseMs, true) &&
    isRelativeMillisecondDuration(value.unlockMs, true)
  );
}

export function isPauseEconomy(value: unknown): value is PauseEconomy {
  return safelyValidate((): boolean => isPauseEconomyValue(value));
}

function isGateSettings(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['delayMs', 'requireTypedPhrase', 'allowForceEnd']) &&
    isRelativeMillisecondDuration(value.delayMs, true) &&
    typeof value.requireTypedPhrase === 'boolean' &&
    typeof value.allowForceEnd === 'boolean'
  );
}

function isThemeMode(value: unknown): boolean {
  return value === 'auto' || value === 'light' || value === 'dark';
}

function isSoundSettings(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'masterVolume',
      'sessionComplete',
      'breakStart',
      'breakEnd',
      'scheduleStart',
    ])
  ) {
    return false;
  }
  return (
    isNonNegativeNumber(value.masterVolume) &&
    value.masterVolume <= 1 &&
    typeof value.sessionComplete === 'boolean' &&
    typeof value.breakStart === 'boolean' &&
    typeof value.breakEnd === 'boolean' &&
    typeof value.scheduleStart === 'boolean'
  );
}

function isSettingsValue(value: unknown): value is Settings {
  if (!isRecord(value) || !hasExactKeys(value, SETTINGS_KEYS)) {
    return false;
  }
  return (
    isThemeMode(value.theme) &&
    isDenseArray(value.presetsMin) &&
    value.presetsMin.length === 3 &&
    value.presetsMin.every(isRelativeMinuteDuration) &&
    (value.defaultMode === 'blacklist' || value.defaultMode === 'whitelist') &&
    (value.defaultStrictness === 'hard' ||
      value.defaultStrictness === 'friction' ||
      value.defaultStrictness === 'flexible') &&
    isCycleConfig(value.defaultCycling) &&
    typeof value.cyclingOnByDefault === 'boolean' &&
    isPauseEconomy(value.pause) &&
    isGateSettings(value.gate) &&
    typeof value.badgeCountdown === 'boolean' &&
    typeof value.sessionCompleteNotification === 'boolean' &&
    isSoundSettings(value.sounds) &&
    isSchedule(value.schedule) &&
    isPositiveMinuteValue(value.streakGoalMin) &&
    isSafeDayCount(value.streakFreezeIntervalDays) &&
    isSafeDayCount(value.retentionDays)
  );
}

export function isSettings(value: unknown): value is Settings {
  return safelyValidate((): boolean => isSettingsValue(value));
}

function parseStoredScheduleEntryV2(value: unknown): ScheduleEntryV2 | null {
  try {
    const sourceShape: StoredScheduleEntryShape | null = storedScheduleEntryShape(value);
    if (sourceShape === null) return null;
    const candidate: unknown = structuredClone(value);
    if (sourceShape === 'v2') return isScheduleEntryV2Value(candidate) ? candidate : null;
    if (!isScheduleEntry(candidate)) return null;
    return { ...candidate, duration: { kind: 'window' } };
  } catch {
    return null;
  }
}

export function parseStoredSettingsV2(value: unknown): SettingsV2 | null {
  try {
    const stableSettings: UnknownRecord | null = stableExactOwnDataSnapshot(value, SETTINGS_KEYS);
    if (stableSettings === null) return null;
    const storedSchedule: unknown = stableSettings.schedule;
    if (!isDenseArray(storedSchedule)) return null;
    const baseCandidate: UnknownRecord = { ...stableSettings, schedule: [] };
    if (!isSettingsValue(baseCandidate)) return null;
    const schedule: ScheduleEntryV2[] = [];
    for (let index: number = 0; index < storedSchedule.length; index++) {
      const candidate: unknown = storedSchedule[index];
      const parsed: ScheduleEntryV2 | null = parseStoredScheduleEntryV2(candidate);
      if (parsed === null) return null;
      schedule.push(parsed);
    }
    const ids: Set<string> = new Set<string>();
    for (let index: number = 0; index < schedule.length; index++) {
      const entry: ScheduleEntryV2 = schedule[index] as ScheduleEntryV2;
      if (ids.has(entry.id)) return null;
      ids.add(entry.id);
      for (let priorIndex: number = 0; priorIndex < index; priorIndex++) {
        const prior: ScheduleEntryV2 = schedule[priorIndex] as ScheduleEntryV2;
        if (scheduleEntriesOverlap(prior, entry)) return null;
      }
    }
    const normalized: SettingsV2 = { ...(baseCandidate as Settings), schedule };
    return structuredClone(normalized);
  } catch {
    return null;
  }
}

function isValidRuleHost(value: unknown): value is string {
  return (
    isNonBlankString(value) &&
    value.trim() === value &&
    validateRule({ kind: 'host', pattern: value }) === null
  );
}

function isCategories(value: unknown): value is ListsConfig['categories'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, CATEGORY_IDS) &&
    CATEGORY_IDS.every((id: CategoryId): boolean => typeof value[id] === 'boolean')
  );
}

function isExclusions(value: unknown): value is ListsConfig['exclusions'] {
  if (!isRecord(value)) return false;
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  if (
    !keys.every(
      (key: PropertyKey): boolean =>
        typeof key === 'string' && CATEGORY_IDS.includes(key as CategoryId),
    )
  ) {
    return false;
  }
  return keys.every((key: PropertyKey): boolean => {
    const hosts: unknown = value[key as string];
    return isDenseArray(hosts) && hosts.every(isValidRuleHost);
  });
}

function isListsConfigValue(value: unknown): value is ListsConfig {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['custom', 'whitelist', 'categories', 'exclusions']) &&
    isDenseArray(value.custom) &&
    value.custom.every(isRule) &&
    isDenseArray(value.whitelist) &&
    value.whitelist.every(isRule) &&
    isCategories(value.categories) &&
    isExclusions(value.exclusions)
  );
}

export function isListsConfig(value: unknown): value is ListsConfig {
  return safelyValidate((): boolean => isListsConfigValue(value));
}

function isSessionConfigV2Value(value: unknown): value is SessionConfigV2 {
  const candidate: UnknownRecord | null = stableExactOwnDataSnapshot(value, SESSION_CONFIG_V2_KEYS);
  return validateDetachedSessionConfigV2(candidate);
}

export function isSessionConfigV2(value: unknown): value is SessionConfigV2 {
  return safelyValidate((): boolean => isSessionConfigV2Value(value));
}

function isSessionStateV2Value(value: unknown): value is SessionStateV2 {
  const candidate: UnknownRecord | null = stableExactOwnDataSnapshot(value, [
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
  ]);
  return validateDetachedSessionStateV2(candidate);
}

export function isSessionStateV2(value: unknown): value is SessionStateV2 {
  return safelyValidate((): boolean => isSessionStateV2Value(value));
}

function isExactGateState(value: unknown): value is GateState {
  return validateDetachedGateState(value);
}

function isHiddenAuthority(value: unknown): value is { kind: 'hidden' } {
  const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, ['kind']);
  return candidate !== null && candidate.kind === 'hidden';
}

type ImmediateEndAuthorityV2 = Extract<EndAuthorityV2, { kind: 'immediate' }>;
type ClosedEndGateAuthorityV2 = Extract<EndAuthorityV2, { gate: null }>;
type OpenEndGateAuthorityV2 = Extract<EndAuthorityV2, { copy: { confirm: string } }>;

/**
 * The published End and gate copy, pinned to the authority type the validator claims to prove. An
 * edit to one of these strings in `types.ts` now fails to compile here, the way it already fails in
 * both producers, instead of quietly turning this validator into a refusal of every Friction
 * snapshot. The intersection also states the rule that the immediate End label and the timed
 * Friction End label are one string.
 */
const END_ACTION_LABEL: ImmediateEndAuthorityV2['actionLabel'] &
  ClosedEndGateAuthorityV2['copy']['actionLabel'] = 'End session';
/** The Friction End of an until-stopped session, on the opening control and the gate confirm. */
const UNLOCK_ACTION_LABEL: ClosedEndGateAuthorityV2['copy']['actionLabel'] &
  OpenEndGateAuthorityV2['copy']['confirm'] = 'Unlock';
const OPEN_END_GATE_ACTION: ClosedEndGateAuthorityV2['actions']['open'] = 'open-end-gate';
const CANCEL_GATE_COPY: Readonly<Omit<OpenEndGateAuthorityV2['copy'], 'intentionReminder'>> = {
  title: 'End this session',
  back: 'Keep focusing',
  phraseLabel: 'Type this to confirm:',
  confirm: 'End the session',
};

function isEndActionLabel(value: unknown): value is EndActionLabelV2 {
  return value === END_ACTION_LABEL || value === UNLOCK_ACTION_LABEL;
}

function isEndGateConfirmLabel(value: unknown): value is EndGateConfirmLabelV2 {
  return value === CANCEL_GATE_COPY.confirm || value === UNLOCK_ACTION_LABEL;
}

/** The one label rule: a Friction until-stopped session unlocks, every other End ends. */
function expectedEndActionLabel(config: SessionConfigV2): EndActionLabelV2 {
  return config.duration.kind === 'until-stopped' ? UNLOCK_ACTION_LABEL : END_ACTION_LABEL;
}

function expectedEndGateConfirmLabel(config: SessionConfigV2): EndGateConfirmLabelV2 {
  return config.duration.kind === 'until-stopped' ? UNLOCK_ACTION_LABEL : CANCEL_GATE_COPY.confirm;
}
const CANCEL_GATE_ACTIONS: Readonly<OpenEndGateAuthorityV2['actions']> = {
  abandon: 'abandon-gate',
  confirm: 'confirm-gate',
};

function isEndAuthorityV2Value(value: unknown): value is EndAuthorityV2 {
  const hidden: UnknownRecord | null = exactOwnDataSnapshot(value, ['kind']);
  if (hidden !== null) return hidden.kind === 'hidden';

  const immediate: UnknownRecord | null = exactOwnDataSnapshot(value, ['kind', 'actionLabel']);
  if (immediate !== null) {
    return immediate.kind === 'immediate' && immediate.actionLabel === END_ACTION_LABEL;
  }

  const friction: UnknownRecord | null = exactOwnDataSnapshot(value, [
    'kind',
    'gate',
    'copy',
    'actions',
  ]);
  if (friction === null || friction.kind !== 'friction-gate') return false;

  if (friction.gate === null) {
    const copy: UnknownRecord | null = exactOwnDataSnapshot(friction.copy, ['actionLabel']);
    const actions: UnknownRecord | null = exactOwnDataSnapshot(friction.actions, ['open']);
    return (
      copy !== null &&
      isEndActionLabel(copy.actionLabel) &&
      actions !== null &&
      actions.open === OPEN_END_GATE_ACTION
    );
  }

  const copy: UnknownRecord | null = exactOwnDataSnapshot(friction.copy, [
    'title',
    'back',
    'phraseLabel',
    'confirm',
    'intentionReminder',
  ]);
  const actions: UnknownRecord | null = exactOwnDataSnapshot(friction.actions, [
    'abandon',
    'confirm',
  ]);
  return (
    isExactGateState(friction.gate) &&
    friction.gate.kind === 'cancel' &&
    copy !== null &&
    copy.title === CANCEL_GATE_COPY.title &&
    copy.back === CANCEL_GATE_COPY.back &&
    copy.phraseLabel === CANCEL_GATE_COPY.phraseLabel &&
    isEndGateConfirmLabel(copy.confirm) &&
    isNullableString(copy.intentionReminder) &&
    actions !== null &&
    actions.abandon === CANCEL_GATE_ACTIONS.abandon &&
    actions.confirm === CANCEL_GATE_ACTIONS.confirm
  );
}

export function isSessionLifecycleV2(value: unknown): value is SessionLifecycleV2 {
  return safelyValidate((): boolean => {
    const simple: UnknownRecord | null = stableExactOwnDataSnapshot(value, [
      'kind',
      'endAuthority',
    ]);
    if (simple !== null) {
      if (simple.kind === 'idle') return isHiddenAuthority(simple.endAuthority);
      return simple.kind === 'active' && isEndAuthorityV2Value(simple.endAuthority);
    }

    const starting: UnknownRecord | null = stableExactOwnDataSnapshot(value, [
      'kind',
      'operationId',
      'transition',
      'endAuthority',
    ]);
    if (starting !== null) {
      return (
        starting.kind === 'starting' &&
        isUuid(starting.operationId) &&
        (starting.transition === 'start' || starting.transition === 'resume') &&
        isEndAuthorityV2Value(starting.endAuthority)
      );
    }

    const cleanup: UnknownRecord | null = stableExactOwnDataSnapshot(value, [
      'kind',
      'journal',
      'id',
      'endAuthority',
    ]);
    if (cleanup !== null) {
      return (
        cleanup.kind === 'cleanup' &&
        isCleanupJournalId(cleanup.journal, cleanup.id) &&
        isHiddenAuthority(cleanup.endAuthority)
      );
    }

    const error: UnknownRecord | null = stableExactOwnDataSnapshot(value, [
      'kind',
      'code',
      'retryAvailable',
      'endAuthority',
    ]);
    return (
      error !== null &&
      error.kind === 'error' &&
      (error.code === 'transition-cleanup-failed' || error.code === 'closure-cleanup-failed') &&
      error.retryAvailable === true &&
      isHiddenAuthority(error.endAuthority)
    );
  });
}

function isExactSiteUnlock(value: unknown, at: number): value is SiteUnlock {
  return validateDetachedSiteUnlock(value) && value.until > at;
}

function isExactActiveUnlocks(value: unknown, at: number): value is SiteUnlock[] {
  if (!Array.isArray(value)) return false;
  const length: number | null = exactDenseArrayLength(value);
  if (length === null) return false;
  for (let index: number = 0; index < length; index++) {
    if (!isExactSiteUnlock(value[index], at)) return false;
  }
  return true;
}

function isPhaseValue(value: unknown): value is Phase {
  return value === 'idle' || value === 'focus' || value === 'break' || value === 'paused';
}

/**
 * The one intention reminder rule: the trimmed intention, or null when nothing is left. The public
 * Friction End authority carries this value and `authorityMatchesConfigAndGate` cross-checks it, so
 * the projection that builds the authority calls this function rather than repeating the rule.
 */
export function intentionReminderFor(intention: string): string | null {
  const goal: string = intention.trim();
  return goal === '' ? null : goal;
}

function intentionReminder(config: SessionConfigV2): string | null {
  return intentionReminderFor(config.intention);
}

function authorityMatchesConfigAndGate(
  authority: EndAuthorityV2,
  config: SessionConfigV2,
  gate: GateState | null,
): boolean {
  const cancelGate: (GateState & { kind: 'cancel' }) | null =
    gate?.kind === 'cancel' ? { ...gate, kind: 'cancel' } : null;
  if (config.strictness === 'flexible') {
    return authority.kind === 'immediate' && cancelGate === null;
  }
  if (config.strictness === 'hard') return authority.kind === 'hidden' && cancelGate === null;
  if (authority.kind !== 'friction-gate') return false;
  if (cancelGate === null) {
    return authority.gate === null && authority.copy.actionLabel === expectedEndActionLabel(config);
  }
  const requiredPhrase: string | null = authority.gate?.requiredPhrase ?? null;
  return (
    authority.gate !== null &&
    exactDataEqual(authority.gate, cancelGate) &&
    (requiredPhrase === null || requiredPhrase === cancelPhrase(config.intention)) &&
    authority.copy.confirm === expectedEndGateConfirmLabel(config) &&
    authority.copy.intentionReminder === intentionReminder(config)
  );
}

function isExactNextSchedule(value: unknown, at: number): boolean {
  if (value === null) return true;
  const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, ['entryId', 'startsAt']);
  return (
    candidate !== null &&
    isNonBlankString(candidate.entryId) &&
    isSafeTimestamp(candidate.startsAt) &&
    candidate.startsAt > at
  );
}

const SESSION_SNAPSHOT_V2_KEYS: readonly string[] = [
  'at',
  'theme',
  'lifecycle',
  'phase',
  'config',
  'startedAt',
  'phaseStartedAt',
  'phaseEndsAt',
  'sessionEndsAt',
  'sessionFocusedMs',
  'cycleIndex',
  'bankMs',
  'bankAccrualPerMs',
  'bankCapMs',
  'pauseCostMs',
  'unlockCostMs',
  'activeUnlocks',
  'gate',
  'attemptsToday',
  'scheduleActive',
  'nextSchedule',
];

function isSessionSnapshotV2Value(value: unknown): value is SessionSnapshotV2 {
  const candidate: UnknownRecord | null = stableExactOwnDataSnapshot(
    value,
    SESSION_SNAPSHOT_V2_KEYS,
  );
  if (
    candidate === null ||
    !isSafeTimestamp(candidate.at) ||
    !isThemeMode(candidate.theme) ||
    !isSessionLifecycleV2(candidate.lifecycle) ||
    !isPhaseValue(candidate.phase) ||
    !isSafeTimestamp(candidate.sessionFocusedMs) ||
    !isNonNegativeInteger(candidate.cycleIndex) ||
    !isNonNegativeNumber(candidate.bankMs) ||
    !isNonNegativeNumber(candidate.bankAccrualPerMs) ||
    !isSafeTimestamp(candidate.bankCapMs) ||
    candidate.bankMs > candidate.bankCapMs ||
    !isRelativeMillisecondDuration(candidate.pauseCostMs, true) ||
    !isRelativeMillisecondDuration(candidate.unlockCostMs, true) ||
    !isExactActiveUnlocks(candidate.activeUnlocks, candidate.at) ||
    (candidate.gate !== null &&
      (!isExactGateState(candidate.gate) || candidate.gate.openedAt > candidate.at)) ||
    !isNonNegativeInteger(candidate.attemptsToday) ||
    typeof candidate.scheduleActive !== 'boolean' ||
    !isExactNextSchedule(candidate.nextSchedule, candidate.at)
  ) {
    return false;
  }

  if (candidate.lifecycle.kind !== 'active') {
    return (
      candidate.phase === 'idle' &&
      candidate.config === null &&
      candidate.startedAt === null &&
      candidate.phaseStartedAt === null &&
      candidate.phaseEndsAt === null &&
      candidate.sessionEndsAt === null &&
      candidate.sessionFocusedMs === 0 &&
      candidate.cycleIndex === 0 &&
      candidate.bankAccrualPerMs === 0 &&
      candidate.gate === null &&
      candidate.scheduleActive === false &&
      candidate.activeUnlocks.length === 0
    );
  }

  if (
    candidate.phase === 'idle' ||
    !validateDetachedSessionConfigV2(candidate.config) ||
    !isSafeTimestamp(candidate.startedAt) ||
    !isSafeTimestamp(candidate.phaseStartedAt) ||
    candidate.startedAt > candidate.at ||
    candidate.phaseStartedAt < candidate.startedAt ||
    candidate.phaseStartedAt > candidate.at ||
    candidate.sessionFocusedMs > candidate.at - candidate.startedAt ||
    (candidate.phase === 'focus' &&
      candidate.sessionFocusedMs < candidate.at - candidate.phaseStartedAt) ||
    (candidate.phase !== 'focus' &&
      candidate.sessionFocusedMs > candidate.phaseStartedAt - candidate.startedAt) ||
    (candidate.phase !== 'focus' && candidate.bankAccrualPerMs !== 0) ||
    candidate.scheduleActive !== (candidate.config.source === 'schedule') ||
    !authorityMatchesConfigAndGate(
      candidate.lifecycle.endAuthority,
      candidate.config,
      candidate.gate,
    )
  ) {
    return false;
  }

  if (candidate.config.duration.kind === 'until-stopped') {
    if (candidate.sessionEndsAt !== null || candidate.phase === 'break') return false;
    return candidate.phase === 'focus'
      ? candidate.phaseEndsAt === null
      : isSafeTimestamp(candidate.phaseEndsAt) &&
          candidate.phaseEndsAt > candidate.at &&
          candidate.phaseEndsAt >= candidate.phaseStartedAt;
  }

  const durationMs: number = Math.round(candidate.config.duration.minutes * 60_000);
  const expectedSessionEndsAt: number = candidate.startedAt + durationMs;
  return (
    isSafeTimestamp(expectedSessionEndsAt) &&
    candidate.sessionEndsAt === expectedSessionEndsAt &&
    isSafeTimestamp(candidate.sessionEndsAt) &&
    isSafeTimestamp(candidate.phaseEndsAt) &&
    candidate.sessionEndsAt > candidate.at &&
    candidate.phaseEndsAt >= candidate.phaseStartedAt &&
    candidate.phaseEndsAt > candidate.at &&
    candidate.phaseEndsAt <= candidate.sessionEndsAt &&
    (candidate.phase !== 'break' || candidate.config.cycling !== null)
  );
}

export function isSessionSnapshotV2(value: unknown): value is SessionSnapshotV2 {
  return safelyValidate((): boolean => isSessionSnapshotV2Value(value));
}

/** The live snapshot contract is v2, and this name is the alias the v1 callers still spell. */
export function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  return isSessionSnapshotV2(value);
}

function isNullableDailyDate(value: unknown): value is string | null {
  return value === null || isDailyDate(value);
}

function isStreak(value: unknown): value is StreakState {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.current) ||
    !isNonNegativeInteger(value.freezeTokens) ||
    value.freezeTokens > MAX_FREEZE_TOKENS ||
    !isNullableDailyDate(value.lastCountedDate) ||
    !isNullableDailyDate(value.lastFreezeGrantDate) ||
    !isDenseArray(value.activeDays) ||
    typeof value.activeMonth !== 'string' ||
    !MONTH_RE.test(value.activeMonth)
  ) {
    return false;
  }
  const [yearText, monthText]: string[] = value.activeMonth.split('-');
  const daysInMonth: number = new Date(Number(yearText), Number(monthText), 0).getDate();
  return (
    value.activeDays.every(
      (day: unknown): boolean => isPositiveInteger(day) && day <= daysInMonth,
    ) && new Set<unknown>(value.activeDays).size === value.activeDays.length
  );
}

function hasValidSessionIdentity(value: UnknownRecord): boolean {
  return value.sessionId === undefined || isNonBlankString(value.sessionId);
}

function isEventRecordValue(value: unknown): value is EventRecord {
  if (!isRecord(value) || !isNonNegativeNumber(value.at) || !hasValidSessionIdentity(value)) {
    return false;
  }
  switch (value.t) {
    case 'sessionIdentityAssigned':
      return isNonNegativeNumber(value.startedAt) && isNonBlankString(value.sessionId);
    case 'sessionStarted':
      return (
        (value.source === 'manual' || value.source === 'schedule') &&
        (value.mode === 'blacklist' || value.mode === 'whitelist') &&
        (value.strictness === 'flexible' ||
          value.strictness === 'hard' ||
          value.strictness === 'friction') &&
        // Null is the v1 indefinite session start, which the pre-merge build recorded this way.
        (value.durationMin === null || isRelativeMinuteDuration(value.durationMin)) &&
        typeof value.intention === 'string'
      );
    case 'sessionCompleted':
    case 'sessionCanceled':
      return isNonNegativeNumber(value.focusedMs);
    case 'phase':
      return (
        (value.from === 'idle' ||
          value.from === 'focus' ||
          value.from === 'break' ||
          value.from === 'paused') &&
        (value.to === 'idle' ||
          value.to === 'focus' ||
          value.to === 'break' ||
          value.to === 'paused')
      );
    case 'attempt':
      return (
        isNonBlankString(value.url) &&
        isNonBlankString(value.host) &&
        isNonNegativeInteger(value.tabId) &&
        (value.kind === 'navigation' || value.kind === 'existing')
      );
    case 'gateOpened':
    case 'gateResisted':
      return (
        value.gate === 'pause' ||
        value.gate === 'unlockSite' ||
        value.gate === 'excludeSite' ||
        value.gate === 'cancel'
      );
    case 'budgetEarned':
    case 'pauseTaken':
      return isNonNegativeNumber(value.ms);
    case 'unlockTaken':
      return isNonBlankString(value.host) && isNonNegativeNumber(value.ms);
    default:
      return false;
  }
}

export function isLegacyEventRecord(value: unknown): value is LegacyEventRecord {
  return safelyValidate((): boolean => isEventRecordValue(value));
}

/**
 * The live event contract is the v2 union. It composes the two v2 guards with the legacy one and
 * never calls back into this function, so a mixed log validates in one pass and a legacy shape
 * wearing `version: 2` stays rejected.
 */
export function isEventRecord(value: unknown): value is EventRecord {
  return isSessionEventRecordV2(value);
}

function validSourceOccurrence(
  source: unknown,
  occurrence: unknown,
  allowMissingInvalidScheduled: boolean,
): boolean {
  if (source === 'manual') return occurrence === null;
  if (source !== 'schedule') return false;
  return (
    validateDetachedScheduleOccurrenceRef(occurrence) ||
    (allowMissingInvalidScheduled && occurrence === null)
  );
}

export function isSessionStartedEventV2(value: unknown): value is SessionStartedEventV2 {
  return safelyValidate((): boolean => {
    const candidate: UnknownRecord | null = stableExactOwnDataSnapshot(value, [
      'version',
      't',
      'eventId',
      'at',
      'sessionId',
      'source',
      'mode',
      'strictness',
      'duration',
      'intention',
      'scheduleOccurrence',
    ]);
    const detachedDuration: unknown = candidate?.duration;
    const duration: SessionDuration | null = validateDetachedSessionDuration(detachedDuration)
      ? detachedDuration
      : null;
    if (
      candidate === null ||
      candidate.version !== 2 ||
      candidate.t !== 'sessionStarted' ||
      !isUuid(candidate.sessionId) ||
      candidate.eventId !== `${candidate.sessionId}:start` ||
      !isSafeTimestamp(candidate.at) ||
      (candidate.mode !== 'blacklist' && candidate.mode !== 'whitelist') ||
      (candidate.strictness !== 'flexible' &&
        candidate.strictness !== 'friction' &&
        candidate.strictness !== 'hard') ||
      duration === null ||
      typeof candidate.intention !== 'string' ||
      !validSourceOccurrence(candidate.source, candidate.scheduleOccurrence, false)
    ) {
      return false;
    }
    return duration.kind !== 'until-stopped' || candidate.strictness !== 'hard';
  });
}

function isEndReasonOutcomeDurationValid(value: UnknownRecord, duration: SessionDuration): boolean {
  switch (value.reason) {
    case 'timer-completed':
      return value.outcome === 'completed' && duration.kind === 'timed';
    case 'manual-completed':
      return value.outcome === 'completed' && duration.kind === 'until-stopped';
    case 'manual-canceled':
      return value.outcome === 'canceled' && duration.kind === 'timed';
    case 'website-access-lost':
    case 'content-registration-failed':
    case 'alarm-failed':
    case 'tab-enforcement-failed':
    case 'invalid-active-state':
      return value.outcome === 'canceled';
    default:
      return false;
  }
}

export function isSessionEndedEventV2(value: unknown): value is SessionEndedEventV2 {
  return safelyValidate((): boolean => {
    const candidate: UnknownRecord | null = stableExactOwnDataSnapshot(value, [
      'version',
      't',
      'eventId',
      'at',
      'sessionId',
      'outcome',
      'reason',
      'focusedMs',
      'duration',
      'source',
      'scheduleOccurrence',
    ]);
    const detachedDuration: unknown = candidate?.duration;
    const duration: SessionDuration | null = validateDetachedSessionDuration(detachedDuration)
      ? detachedDuration
      : null;
    if (
      candidate === null ||
      candidate.version !== 2 ||
      candidate.t !== 'sessionEnded' ||
      !isUuid(candidate.sessionId) ||
      candidate.eventId !== `${candidate.sessionId}:end` ||
      !isSafeTimestamp(candidate.at) ||
      !isSafeTimestamp(candidate.focusedMs) ||
      duration === null ||
      !isEndReasonOutcomeDurationValid(candidate, duration)
    ) {
      return false;
    }
    const missingInvalidScheduled: boolean =
      candidate.reason === 'invalid-active-state' &&
      candidate.outcome === 'canceled' &&
      duration.kind === 'timed';
    return validSourceOccurrence(
      candidate.source,
      candidate.scheduleOccurrence,
      missingInvalidScheduled,
    );
  });
}

/**
 * A record that announces version 2 is judged only by the version 2 guards. Legacy history never
 * carries a `version` field, so a legacy shape wearing `version: 2` is a forged claim, not history.
 */
function declaresEventVersion2(value: unknown): boolean {
  return isRecord(value) && value.version === 2;
}

/**
 * The stored event union: both version 2 session events plus the complete legacy history. Legacy
 * runs last and never delegates to `isEventRecord`, so the later cutover can point `isEventRecord`
 * at this guard without mutual recursion.
 */
export function isSessionEventRecordV2(value: unknown): value is SessionEventRecordV2 {
  return safelyValidate(
    (): boolean =>
      isSessionStartedEventV2(value) ||
      isSessionEndedEventV2(value) ||
      (!declaresEventVersion2(value) && isLegacyEventRecord(value)),
  );
}

function isStatsBundleValue(value: unknown): value is StatsBundle {
  if (
    !isRecord(value) ||
    !isDenseArray(value.days) ||
    !value.days.every((day: unknown): boolean => parseDailyAgg(day) !== null) ||
    !isDenseArray(value.months) ||
    !value.months.every((month: unknown): boolean => parseMonthlyAgg(month) !== null) ||
    !isStreak(value.streak) ||
    !isDenseArray(value.recentSessions) ||
    !value.recentSessions.every(isEventRecord) ||
    !isRecord(value.totals) ||
    !hasExactKeys(value.totals, [
      'focusMsToday',
      'focusMsLast7Days',
      'attemptsToday',
      'resistedToday',
    ])
  ) {
    return false;
  }
  return (
    isNonNegativeNumber(value.totals.focusMsToday) &&
    isNonNegativeNumber(value.totals.focusMsLast7Days) &&
    isNonNegativeInteger(value.totals.attemptsToday) &&
    isNonNegativeInteger(value.totals.resistedToday)
  );
}

export function isStatsBundle(value: unknown): value is StatsBundle {
  return safelyValidate((): boolean => isStatsBundleValue(value));
}

export function ackError(value: unknown, malformedError: string): string | null {
  if (!isAck(value)) return malformedError;
  return value.ok ? null : value.error;
}

export function isRetrySyncResponse(value: unknown): value is RetrySyncResponse {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      ((value.ok === true &&
        value.syncWriteStatus === 'idle' &&
        hasExactKeys(value, ['ok', 'syncWriteStatus'])) ||
        (value.ok === false &&
          isNonBlankString(value.error) &&
          hasExactKeys(value, ['ok', 'error']))),
  );
}

export function isBootFailure(value: unknown): value is BootFailure {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      hasExactKeys(value, ['stage', 'message', 'at']) &&
      (value.stage === 'policy-storage' || value.stage === 'runtime' || value.stage === 'engine') &&
      isNonBlankString(value.message) &&
      isNonNegativeNumber(value.at),
  );
}

export function isBootFailureResponse(value: unknown): value is BootFailureResponse {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      value.ok === true &&
      hasExactKeys(value, ['ok', 'failure']) &&
      (value.failure === null || isBootFailure(value.failure)),
  );
}

export function isAck(value: unknown): value is Ack {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      ((value.ok === true && hasExactKeys(value, ['ok'])) ||
        (value.ok === false &&
          isNonBlankString(value.error) &&
          hasExactKeys(value, ['ok', 'error']))),
  );
}

export function parseEventExportResponse(value: unknown): EventRecord[] | null {
  try {
    if (!isRecord(value) || typeof value.json !== 'string') return null;
    const parsed: unknown = JSON.parse(value.json);
    return isDenseArray(parsed) && parsed.every(isEventRecord) ? parsed : null;
  } catch {
    return null;
  }
}
