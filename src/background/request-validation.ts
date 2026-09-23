import { normalizeSessionRules, validateRule } from '../core/matcher';
import { scheduleEntriesOverlap } from '../core/schedule';
import { CATEGORY_IDS } from '../shared/constants';
import { isDenseArray, snapshotExactData } from '../shared/exact-data';
import type { Request, SessionStartRequestV2 } from '../shared/messages';
import {
  isPositiveMinuteValue,
  isRelativeMillisecondDuration,
  isRelativeMinuteDuration,
  isSafeDayCount,
} from '../shared/numeric-validation';
import {
  isOnboardingDraft,
  isScheduleEntryV2,
  isSessionConfigV2,
  isSessionDuration,
} from '../shared/runtime-validation';
import { SYNC_SETTINGS } from '../shared/storage-keys';
import type {
  CategoryId,
  CycleConfig,
  ListsConfig,
  Rule,
  ScheduleEntryV2,
  SessionConfigV2,
  SessionDuration,
  SessionRuleSnapshot,
  Settings,
} from '../shared/types';
import { isUuid, validateDetachedGateState } from '../shared/v2-domain-intrinsics';
import { isBrowserTabId } from '../shared/work-target';
import { canEncodeListsForSync } from './list-sync-codec';
import { isPendingPath } from './pending-policy-changes';
import { assertSyncItemWithinQuota } from './sync-quota';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys: PropertyKey[] = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key: PropertyKey): boolean => {
      return typeof key === 'string' && keys.includes(key);
    })
  );
}

function exactOwnDataSnapshot(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
    const snapshot: Record<string, unknown> = {};
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

function hasOnlyOwnDataPropertiesDeep(
  value: unknown,
  visiting: WeakSet<object> = new WeakSet<object>(),
  complete: WeakSet<object> = new WeakSet<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return typeof value !== 'function';
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  } else if (Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  if (complete.has(value)) return true;
  if (visiting.has(value)) return false;
  visiting.add(value);
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      !hasOnlyOwnDataPropertiesDeep(descriptor.value, visiting, complete)
    ) {
      return false;
    }
  }
  visiting.delete(value);
  complete.add(value);
  return true;
}

function exactDenseArrayLength(value: unknown[]): number | null {
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  if (keys.some((key: PropertyKey): boolean => typeof key === 'symbol')) return null;
  const lengthDescriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
    value,
    'length',
  );
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return null;
  }
  const length: number = lengthDescriptor.value;
  if (keys.length !== length + 1) return null;
  for (let index: number = 0; index < length; index++) {
    if (!Object.hasOwn(value, index)) return null;
  }
  return length;
}

function wasPairCompared(
  left: object,
  right: object,
  compared: WeakMap<object, WeakSet<object>>,
): boolean {
  const existing: WeakSet<object> | undefined = compared.get(left);
  if (existing?.has(right) === true) return true;
  const matches: WeakSet<object> = existing ?? new WeakSet<object>();
  matches.add(right);
  if (existing === undefined) compared.set(left, matches);
  return false;
}

function exactValueEqual(
  left: unknown,
  right: unknown,
  compared: WeakMap<object, WeakSet<object>> = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (wasPairCompared(left, right, compared)) return true;
    const leftLength: number | null = exactDenseArrayLength(left);
    const rightLength: number | null = exactDenseArrayLength(right);
    if (leftLength === null || rightLength === null || leftLength !== rightLength) return false;
    for (let index: number = 0; index < leftLength; index++) {
      if (!exactValueEqual(left[index], right[index], compared)) return false;
    }
    return true;
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  if (wasPairCompared(left, right, compared)) return true;
  const leftKeys: PropertyKey[] = Reflect.ownKeys(left);
  const rightKeys: PropertyKey[] = Reflect.ownKeys(right);
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key: PropertyKey): boolean => typeof key !== 'string') ||
    rightKeys.some((key: PropertyKey): boolean => typeof key !== 'string')
  ) {
    return false;
  }
  const rightKeySet: Set<PropertyKey> = new Set<PropertyKey>(rightKeys);
  for (const key of leftKeys) {
    if (typeof key !== 'string' || !rightKeySet.has(key)) return false;
    const leftDescriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
      left,
      key,
    );
    const rightDescriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
      right,
      key,
    );
    if (
      leftDescriptor === undefined ||
      rightDescriptor === undefined ||
      !Object.hasOwn(leftDescriptor, 'value') ||
      !Object.hasOwn(rightDescriptor, 'value') ||
      !exactValueEqual(leftDescriptor.value, rightDescriptor.value, compared)
    ) {
      return false;
    }
  }
  return true;
}

function stableExactOwnDataSnapshot(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    const candidate: Record<string, unknown> | null = exactOwnDataSnapshot(value, keys);
    if (candidate === null || !hasOnlyOwnDataPropertiesDeep(candidate)) return null;
    const clonedCandidate: unknown = structuredClone(candidate);
    const clonedValue: unknown = structuredClone(value);
    if (
      !exactValueEqual(candidate, clonedCandidate) ||
      !exactValueEqual(clonedCandidate, clonedValue)
    ) {
      return null;
    }
    return exactOwnDataSnapshot(clonedCandidate, keys);
  } catch {
    return null;
  }
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isWithinSyncQuota(key: string, value: unknown): boolean {
  try {
    assertSyncItemWithinQuota(key, value);
    return true;
  } catch {
    return false;
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isValidUrl(value: unknown): value is string {
  if (!isNonBlankString(value) || value.trim() !== value) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isValidRuleHost(value: unknown): value is string {
  return (
    isNonBlankString(value) &&
    value.trim() === value &&
    validateRule({ kind: 'host', pattern: value }) === null
  );
}

function isBrowserHostname(value: unknown): value is string {
  if (!isNonBlankString(value) || value.trim() !== value) return false;
  try {
    const parsed: URL = new URL(`http://${value}/`);
    return parsed.hostname === value;
  } catch {
    return false;
  }
}

function isCycleConfig(value: unknown): value is CycleConfig {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['focusMin', 'shortBreakMin', 'longBreakMin', 'longEvery'])
  ) {
    return false;
  }
  return (
    isRelativeMinuteDuration(value.focusMin) &&
    isRelativeMinuteDuration(value.shortBreakMin) &&
    isRelativeMinuteDuration(value.longBreakMin) &&
    isPositiveInteger(value.longEvery)
  );
}

const SESSION_CONFIG_V2_KEYS: readonly string[] = [
  'mode',
  'strictness',
  'duration',
  'cycling',
  'intention',
  'source',
  'scheduleOccurrence',
  'rules',
];

type ManualSessionConfigEnvelope = Record<string, unknown> & {
  mode: 'blacklist' | 'whitelist';
  strictness: 'flexible' | 'friction' | 'hard';
  intention: string;
  source: 'manual';
  scheduleOccurrence: null;
};

function isManualSessionConfigEnvelope(
  value: Record<string, unknown>,
): value is ManualSessionConfigEnvelope {
  return (
    (value.mode === 'blacklist' || value.mode === 'whitelist') &&
    (value.strictness === 'flexible' ||
      value.strictness === 'friction' ||
      value.strictness === 'hard') &&
    typeof value.intention === 'string' &&
    value.source === 'manual' &&
    value.scheduleOccurrence === null
  );
}

const START_REQUEST_KEYS: readonly string[] = ['type', 'config'];
const WORK_TAB_START_REQUEST_KEYS: readonly string[] = ['type', 'config', 'workTabId', 'windowId'];

/**
 * Which start shape the raw value claims, decided from its own key count alone, so no getter and
 * no proxy trap runs before the exact snapshot below refuses it.
 */
function startRequestKeys(value: unknown): readonly string[] | null {
  if (!isRecord(value)) return null;
  const count: number = Reflect.ownKeys(value).length;
  if (count === START_REQUEST_KEYS.length) return START_REQUEST_KEYS;
  return count === WORK_TAB_START_REQUEST_KEYS.length ? WORK_TAB_START_REQUEST_KEYS : null;
}

export function parseSessionStartRequestV2(value: unknown): SessionStartRequestV2 | null {
  try {
    const keys: readonly string[] | null = startRequestKeys(value);
    if (keys === null) return null;
    const requestCandidate: Record<string, unknown> | null = exactOwnDataSnapshot(value, keys);
    if (requestCandidate === null || requestCandidate.type !== 'startSession') return null;
    const configCandidate: Record<string, unknown> | null = exactOwnDataSnapshot(
      requestCandidate.config,
      SESSION_CONFIG_V2_KEYS,
    );
    if (configCandidate === null || !isManualSessionConfigEnvelope(configCandidate)) return null;

    const request: Record<string, unknown> | null = stableExactOwnDataSnapshot(value, keys);
    if (request === null || request.type !== 'startSession') return null;
    const configInput: Record<string, unknown> | null = exactOwnDataSnapshot(
      request.config,
      SESSION_CONFIG_V2_KEYS,
    );
    if (
      configInput === null ||
      !isManualSessionConfigEnvelope(configInput) ||
      !isSessionDuration(configInput.duration) ||
      (configInput.cycling !== null && !isCycleConfig(configInput.cycling))
    ) {
      return null;
    }
    const rules: SessionRuleSnapshot | null = normalizeSessionRules(configInput.rules);
    if (rules === null) return null;
    const duration: SessionDuration = structuredClone(configInput.duration);
    const config: SessionConfigV2 = {
      mode: configInput.mode,
      strictness: configInput.strictness,
      duration,
      cycling: configInput.cycling === null ? null : structuredClone(configInput.cycling),
      intention: configInput.intention,
      source: 'manual',
      scheduleOccurrence: null,
      rules,
    };
    if (!isSessionConfigV2(config)) return null;
    if (keys === START_REQUEST_KEYS) return { type: 'startSession', config };
    if (!isBrowserTabId(request.workTabId) || !isBrowserTabId(request.windowId)) return null;
    return {
      type: 'startSession',
      config,
      workTabId: request.workTabId,
      windowId: request.windowId,
    };
  } catch {
    return null;
  }
}

/** Exactly `keys`, or `keys` plus a browser `windowId`: the popup names its window, content never does. */
function hasOptionalWindow(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    hasExactKeys(value, keys) ||
    (hasExactKeys(value, [...keys, 'windowId']) && isBrowserTabId(value.windowId))
  );
}

function parseWorkTabsRequest(value: Record<string, unknown>): Request | null {
  if (hasExactKeys(value, ['type', 'sessionId'])) {
    return isUuid(value.sessionId) ? { type: 'getWorkTabs', sessionId: value.sessionId } : null;
  }
  const withRules: boolean = hasExactKeys(value, ['type', 'mode', 'windowId', 'rules']);
  if (!withRules && !hasExactKeys(value, ['type', 'mode', 'windowId'])) return null;
  if (
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    !isBrowserTabId(value.windowId)
  ) {
    return null;
  }
  if (!withRules) return { type: 'getWorkTabs', mode: value.mode, windowId: value.windowId };
  // The draft's rules take the same road as a start request's: normalized, or refused.
  const rules: SessionRuleSnapshot | null = normalizeSessionRules(value.rules);
  return rules === null
    ? null
    : { type: 'getWorkTabs', mode: value.mode, windowId: value.windowId, rules };
}

/**
 * The work target requests are detached before any field is read, the way the gate requests are,
 * so an accessor or a proxy on the wire never reaches a check and the router gets plain data.
 */
function parseWorkTargetRequest(value: Record<string, unknown>): Request | null {
  const detached: unknown = snapshotExactData(value)?.value;
  if (!isRecord(detached)) return null;
  switch (detached.type) {
    case 'getWorkTabs':
      return parseWorkTabsRequest(detached);
    case 'getWorkTabIcon':
      return hasExactKeys(detached, ['type', 'sessionId', 'tabId']) &&
        isUuid(detached.sessionId) &&
        isBrowserTabId(detached.tabId)
        ? (detached as Request)
        : null;
    case 'getWorkTarget':
      return hasOptionalWindow(detached, ['type']) ? (detached as Request) : null;
    case 'setWorkTarget':
      return hasOptionalWindow(detached, ['type', 'sessionId', 'tabId']) &&
        isUuid(detached.sessionId) &&
        isBrowserTabId(detached.tabId)
        ? (detached as Request)
        : null;
    case 'returnToWork':
      return hasOptionalWindow(detached, ['type', 'sessionId']) && isUuid(detached.sessionId)
        ? (detached as Request)
        : null;
    default:
      return null;
  }
}

function isPauseSettings(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['earnRatio', 'capMs', 'pauseMs', 'unlockMs'])) {
    return false;
  }
  return (
    isNonNegativeNumber(value.earnRatio) &&
    // The cap is a relative millisecond span like the two costs beside it, not merely a safe
    // integer, so it is bounded by the same rule rather than by the integer range.
    isRelativeMillisecondDuration(value.capMs, true) &&
    isRelativeMillisecondDuration(value.pauseMs, true) &&
    isRelativeMillisecondDuration(value.unlockMs, true)
  );
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

/** The request contract is the live one: every entry carries its own duration. */
function isSchedule(value: unknown): value is ScheduleEntryV2[] {
  if (!isDenseArray(value) || !value.every(isScheduleEntryV2)) return false;
  const ids: Set<string> = new Set<string>();
  for (let index: number = 0; index < value.length; index++) {
    const entry: ScheduleEntryV2 = value[index] as ScheduleEntryV2;
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
    for (let previousIndex: number = 0; previousIndex < index; previousIndex++) {
      const previous: ScheduleEntryV2 = value[previousIndex] as ScheduleEntryV2;
      if (scheduleEntriesOverlap(previous, entry)) return false;
    }
  }
  return true;
}

function isSettings(value: unknown): value is Settings {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
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
    ])
  ) {
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
    isPauseSettings(value.pause) &&
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

function isRule(value: unknown): value is Rule {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'pattern']) ||
    (value.kind !== 'host' && value.kind !== 'regex') ||
    typeof value.pattern !== 'string'
  ) {
    return false;
  }
  const rule: Rule = { kind: value.kind, pattern: value.pattern };
  return validateRule(rule) === null;
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
    !keys.every((key: PropertyKey): boolean => {
      return typeof key === 'string' && CATEGORY_IDS.includes(key as CategoryId);
    })
  ) {
    return false;
  }
  return keys.every((key: PropertyKey): boolean => {
    const hosts: unknown = value[key as string];
    return isDenseArray(hosts) && hosts.every(isValidRuleHost);
  });
}

function isListsConfig(value: unknown): value is ListsConfig {
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

function parseListsConfigForSync(value: unknown): ListsConfig | null {
  let snapshot: unknown;
  try {
    const serialized: string | undefined = JSON.stringify(value);
    if (serialized === undefined) return null;
    snapshot = JSON.parse(serialized) as unknown;
  } catch (_error: unknown) {
    return null;
  }
  return isListsConfig(snapshot) && canEncodeListsForSync(snapshot) ? snapshot : null;
}

function parseRecord(value: Record<string, unknown>): Request | null {
  switch (value.type) {
    case 'getSnapshot':
    case 'getSetupState':
    case 'openOnboarding':
    case 'getOnboardingDraft':
    case 'cleanupOnboardingDraft':
    case 'reconcileWebsiteAccess':
    case 'dismissWebsiteAccessNotice':
    case 'requestSessionEnd':
    case 'resumeFromPause':
    case 'startNextFocusEarly':
    case 'getSettings':
    case 'getLists':
    case 'getPendingChanges':
    case 'exportEvents':
      return hasExactKeys(value, ['type']) ? (value as Request) : null;
    case 'saveOnboardingDraft':
      return hasExactKeys(value, ['type', 'draft']) && isOnboardingDraft(value.draft)
        ? (value as Request)
        : null;
    case 'completeOnboarding':
      return hasExactKeys(value, ['type', 'revision', 'storageMode']) &&
        isPositiveInteger(value.revision) &&
        (value.storageMode === 'local' || value.storageMode === 'sync')
        ? (value as Request)
        : null;
    case 'completeSetup':
      return hasExactKeys(value, ['type', 'storageMode', 'settings', 'lists']) &&
        (value.storageMode === 'local' || value.storageMode === 'sync') &&
        isSettings(value.settings) &&
        isListsConfig(value.lists)
        ? (value as Request)
        : null;
    case 'setStorageMode':
      return hasExactKeys(value, ['type', 'storageMode', 'deleteRemote']) &&
        (value.storageMode === 'local' || value.storageMode === 'sync') &&
        typeof value.deleteRemote === 'boolean' &&
        !(value.storageMode === 'sync' && value.deleteRemote)
        ? (value as Request)
        : null;
    case 'retrySync':
    case 'getBootFailure':
    case 'retryBoot':
    case 'resetLocalRuntime':
      return hasExactKeys(value, ['type']) ? (value as Request) : null;
    case 'clearFocusLockData':
      return hasExactKeys(value, ['type', 'scope']) &&
        (value.scope === 'local-history' ||
          value.scope === 'synced-policy' ||
          value.scope === 'all')
        ? (value as Request)
        : null;
    case 'getBlockState':
      return hasExactKeys(value, ['type', 'url', 'docState']) &&
        isValidUrl(value.url) &&
        (value.docState === 'fresh' || value.docState === 'loaded')
        ? (value as Request)
        : null;
    case 'startSession':
      // The live start request is the v2 one, which owns the tagged duration and the exact keys.
      return parseSessionStartRequestV2(value);
    case 'openEndGate':
    case 'forceEndGate':
    case 'retryTransitionCleanup':
    case 'retryClosureCleanup':
    case 'retryDataClear':
      return hasExactKeys(value, ['type']) ? (value as Request) : null;
    case 'openGate':
      if (
        !hasExactKeys(value, ['type', 'gate', 'host']) ||
        (value.gate !== 'pause' && value.gate !== 'unlockSite')
      ) {
        return null;
      }
      return value.gate === 'unlockSite'
        ? isBrowserHostname(value.host)
          ? (value as Request)
          : null
        : value.host === null
          ? (value as Request)
          : null;
    case 'abandonGate':
    case 'confirmGate': {
      const detached: unknown = snapshotExactData(value)?.value;
      if (!isRecord(detached)) return null;
      const keys: string[] =
        detached.type === 'confirmGate'
          ? ['type', 'typedPhrase', 'expectedGate']
          : ['type', 'expectedGate'];
      return hasExactKeys(detached, keys) &&
        validateDetachedGateState(detached.expectedGate) &&
        (detached.type === 'abandonGate' || isNullableString(detached.typedPhrase))
        ? (detached as Request)
        : null;
    }
    case 'updateSettings':
      return hasExactKeys(value, ['type', 'settings']) &&
        isWithinSyncQuota(SYNC_SETTINGS, value.settings) &&
        isSettings(value.settings)
        ? (value as Request)
        : null;
    case 'updateTheme':
      return hasExactKeys(value, ['type', 'theme']) && isThemeMode(value.theme)
        ? (value as Request)
        : null;
    case 'updateLists': {
      if (!hasExactKeys(value, ['type', 'lists'])) return null;
      const lists: ListsConfig | null = parseListsConfigForSync(value.lists);
      return lists === null ? null : { type: 'updateLists', lists };
    }
    case 'cancelPendingChange':
      return hasExactKeys(value, ['type', 'path']) && isPendingPath(value.path)
        ? (value as Request)
        : null;
    case 'getStats':
      return hasExactKeys(value, ['type', 'days']) && isSafeDayCount(value.days)
        ? (value as Request)
        : null;
    case 'previewSound':
      return hasExactKeys(value, ['type', 'sound']) &&
        (value.sound === 'sessionComplete' ||
          value.sound === 'breakStart' ||
          value.sound === 'breakEnd' ||
          value.sound === 'scheduleStart')
        ? (value as Request)
        : null;
    case 'getWorkTabs':
    case 'getWorkTabIcon':
    case 'getWorkTarget':
    case 'setWorkTarget':
    case 'returnToWork':
      return parseWorkTargetRequest(value);
    default:
      return null;
  }
}

export function parseRequest(value: unknown): Request | null {
  try {
    return isRecord(value) ? parseRecord(value) : null;
  } catch {
    return null;
  }
}
