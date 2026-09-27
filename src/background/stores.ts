import {
  normalizeSessionRules,
  normalizeStoredSessionRules,
  type StoredMatcherCache,
  validateRule,
} from '../core/matcher';
import { capAttempts, isDailyDate, parseDailyAgg } from '../core/stats';
import {
  CATEGORY_IDS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  MAX_FREEZE_TOKENS,
  rulesFromLists,
  TOP_SITES_DAILY,
} from '../shared/constants';
import { isRelativeMinuteDuration, isSafeDayCount } from '../shared/numeric-validation';
import { parseStoredSettingsV2 } from '../shared/runtime-validation';
import {
  LOCAL_CACHES,
  LOCAL_DEVICE_ID,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_POLICY_COMMIT,
  LOCAL_POLICY_GENERATION_PREFIX,
  LOCAL_RUNTIME,
  LOCAL_SYNC_JOURNAL,
  SYNC_BANK,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type {
  BankState,
  CycleConfig,
  DailyAgg,
  GateKind,
  GateState,
  LegacyEventRecord,
  ListsConfig,
  NormalizedSessionConfigV1,
  NormalizedSessionStateV1,
  Rule,
  ScheduleEntryV2,
  SessionRuleSnapshot,
  Settings,
  SettingsV2,
  SiteUnlock,
  StreakState,
} from '../shared/types';
import {
  type DecodedListsSyncSnapshot,
  decodeListsSyncSnapshot,
  isListSyncKey,
  LIST_SYNC_KEYS,
} from './list-sync-codec';
import type { DeferredBlockClaim, RuntimeTabState } from './runtime-leaf-types';
import type { RuntimeStateV2 } from './runtime-v2-types';
import { storageValuesEqual } from './storage-value-equality';
import type { SyncJournal } from './sync-writer';

export type { DeferredBlockClaim, RuntimeTabState } from './runtime-leaf-types';

const _TIME_RE: RegExp = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Normalized background-internal state. Not part of the shared contract:
 * only the worker reads or writes it. Live sessions always carry rules.
 *
 * todayAgg stays null until the first event of the day folds in. Minting
 * an empty DailyAgg is core's job, so the boot path does not depend on it.
 */
export interface LegacyRuntimeStateV1 {
  session: NormalizedSessionStateV1 | null;
  gate: GateState | null;
  unlocks: SiteUnlock[];
  tabStates: Record<number, RuntimeTabState>;
  /** focus ms of the current session already credited to the pause bank */
  accruedFocusMs: number;
  /** "tabId:url" -> last attempt timestamp, for the 30 s attempt debounce */
  attemptDebounce: Record<string, number>;
  deferredBlockClaims: Record<string, DeferredBlockClaim>;
  removedTabTombstones: Record<number, true>;
  scheduleActiveEntryId: string | null;
  /** Scheduled occurrence already reported while website blocking was unavailable. */
  scheduleUnavailableNoticeToken: string | null;
  /** local date todayAgg belongs to, watermark for the midnight rollover */
  date: string;
  todayAgg: DailyAgg | null;
  /** last date the weekly sync prune ran, null before the first run */
  lastPruneDate: string | null;
  /** Durable recovery record cleared after events, sync journal, and runtime agree. */
  commitCheckpoint: RuntimeCommitCheckpoint | null;
}

export type LegacySessionConfig = Omit<NormalizedSessionConfigV1, 'rules'>;

export type PredecessorSessionRuleSnapshot = Omit<SessionRuleSnapshot, 'baselineCategories'>;

export type PredecessorSessionConfig = Omit<NormalizedSessionConfigV1, 'rules'> & {
  rules: PredecessorSessionRuleSnapshot;
};

export type ParsedSessionConfig =
  | NormalizedSessionConfigV1
  | LegacySessionConfig
  | PredecessorSessionConfig;

export type ParsedSessionState = Omit<NormalizedSessionStateV1, 'config'> & {
  config: ParsedSessionConfig;
};

/** Storage-boundary state. A legacy parsed session may omit rules until boot migration. */
export type ParsedRuntimeState = Omit<LegacyRuntimeStateV1, 'session'> & {
  session: ParsedSessionState | null;
};

export interface RuntimeCommitCheckpoint {
  bank: BankState;
  events: LegacyEventRecord[];
  syncBank: boolean;
  aggregateSets?: Record<string, DailyAgg>;
  aggregateRemoves?: string[];
}

export function emptyRuntime(now: number): LegacyRuntimeStateV1 {
  return {
    session: null,
    gate: null,
    unlocks: [],
    tabStates: {},
    accruedFocusMs: 0,
    attemptDebounce: {},
    deferredBlockClaims: {},
    removedTabTombstones: {},
    scheduleActiveEntryId: null,
    scheduleUnavailableNoticeToken: null,
    date: localDateStr(now),
    todayAgg: null,
    lastPruneDate: null,
    commitCheckpoint: null,
  };
}

export function sanitizeRuntimeForLocalHistory(
  runtime: RuntimeStateV2,
  clearAggregates: boolean,
): RuntimeStateV2 {
  return {
    ...structuredClone(runtime),
    todayAgg: clearAggregates ? null : structuredClone(runtime.todayAgg),
    commitCheckpoint: null,
  };
}

export async function loadSettings(journal?: SyncJournal): Promise<Settings> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_SETTINGS))[SYNC_SETTINGS];
  return mergeSettings(journalValue(journal, SYNC_SETTINGS, raw));
}

export async function loadLists(
  journal?: SyncJournal,
  storedSnapshot?: Readonly<Record<string, unknown>>,
): Promise<ListsConfig> {
  const stored: Readonly<Record<string, unknown>> =
    storedSnapshot ?? (await chrome.storage.sync.get([...LIST_SYNC_KEYS]));
  const localArea: chrome.storage.StorageArea | undefined = chrome.storage.local;
  const local: Record<string, unknown> =
    localArea === undefined ? {} : await localArea.get(LOCAL_LISTS_SNAPSHOT);
  const fallback: ListsConfig = mergeLists(local[LOCAL_LISTS_SNAPSHOT]);
  const effective: Record<string, unknown> = Object.fromEntries(
    Object.entries(stored).filter(([key]: [string, unknown]): boolean => isListSyncKey(key)),
  );
  if (journal !== undefined) {
    for (const key of journal.removes) {
      if (isListSyncKey(key)) delete effective[key];
    }
    for (const [key, value] of Object.entries(journal.sets)) {
      if (isListSyncKey(key) && !journal.removes.includes(key)) effective[key] = value;
    }
  }
  const decoded: DecodedListsSyncSnapshot = decodeListsSyncSnapshot(effective);
  if (decoded.kind === 'complete') return decoded.lists;
  return decoded.kind === 'legacy' ? mergeLists(decoded.value, fallback) : fallback;
}

export function mergeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const stored: Record<string, unknown> = isRecord(raw) ? raw : {};
  const pause: Record<string, unknown> = isRecord(stored.pause) ? stored.pause : {};
  const gate: Record<string, unknown> = isRecord(stored.gate) ? stored.gate : {};
  const sounds: Record<string, unknown> = isRecord(stored.sounds) ? stored.sounds : {};
  return {
    theme:
      stored.theme === 'auto' || stored.theme === 'light' || stored.theme === 'dark'
        ? stored.theme
        : base.theme,
    presetsMin: parsePresets(stored.presetsMin) ?? [...base.presetsMin],
    defaultMode:
      stored.defaultMode === 'blacklist' || stored.defaultMode === 'whitelist'
        ? stored.defaultMode
        : base.defaultMode,
    defaultStrictness:
      stored.defaultStrictness === 'hard' ||
      stored.defaultStrictness === 'friction' ||
      stored.defaultStrictness === 'flexible'
        ? stored.defaultStrictness
        : base.defaultStrictness,
    defaultCycling: parseCycleConfig(stored.defaultCycling) ?? { ...base.defaultCycling },
    cyclingOnByDefault:
      typeof stored.cyclingOnByDefault === 'boolean'
        ? stored.cyclingOnByDefault
        : base.cyclingOnByDefault,
    pause: {
      earnRatio: numberOrDefault(pause.earnRatio, base.pause.earnRatio),
      capMs: numberOrDefault(pause.capMs, base.pause.capMs),
      pauseMs: numberOrDefault(pause.pauseMs, base.pause.pauseMs),
      unlockMs: numberOrDefault(pause.unlockMs, base.pause.unlockMs),
    },
    gate: {
      delayMs: numberOrDefault(gate.delayMs, base.gate.delayMs),
      requireTypedPhrase:
        typeof gate.requireTypedPhrase === 'boolean'
          ? gate.requireTypedPhrase
          : base.gate.requireTypedPhrase,
      allowForceEnd:
        typeof gate.allowForceEnd === 'boolean' ? gate.allowForceEnd : base.gate.allowForceEnd,
    },
    badgeCountdown:
      typeof stored.badgeCountdown === 'boolean' ? stored.badgeCountdown : base.badgeCountdown,
    sessionCompleteNotification:
      typeof stored.sessionCompleteNotification === 'boolean'
        ? stored.sessionCompleteNotification
        : base.sessionCompleteNotification,
    sounds: {
      masterVolume: isUnitNumber(sounds.masterVolume)
        ? sounds.masterVolume
        : base.sounds.masterVolume,
      sessionComplete:
        typeof sounds.sessionComplete === 'boolean'
          ? sounds.sessionComplete
          : base.sounds.sessionComplete,
      breakStart:
        typeof sounds.breakStart === 'boolean' ? sounds.breakStart : base.sounds.breakStart,
      breakEnd: typeof sounds.breakEnd === 'boolean' ? sounds.breakEnd : base.sounds.breakEnd,
      scheduleStart:
        typeof sounds.scheduleStart === 'boolean'
          ? sounds.scheduleStart
          : base.sounds.scheduleStart,
    },
    schedule: Array.isArray(stored.schedule)
      ? parseSchedule(stored.schedule)
      : structuredClone(base.schedule),
    streakGoalMin: numberOrDefault(stored.streakGoalMin, base.streakGoalMin),
    streakFreezeIntervalDays: isSafeDayCount(stored.streakFreezeIntervalDays)
      ? stored.streakFreezeIntervalDays
      : base.streakFreezeIntervalDays,
    retentionDays: isSafeDayCount(stored.retentionDays) ? stored.retentionDays : base.retentionDays,
  };
}

export type StoredSettingsParseResult =
  | { valid: false }
  | { valid: true; changed: boolean; legacy: boolean; settings: Settings };

/**
 * Accepts three stored shapes. The canonical v2 record parses as is. The root-level v1 shape kept
 * its `allowForceEnd` boolean next to `gate` instead of inside it, and that value moves into
 * `gate.allowForceEnd`, the canonical home of the same preference, so an upgrade keeps the bypass
 * the user had chosen. The pre-force-end v1 shape has a gate of only `delayMs` and
 * `requireTypedPhrase`, written before the bypass existed, and reads as `allowForceEnd: false`,
 * the default a user who never saw the option would have kept. Both v1 shapes report
 * `legacy: true` so a caller can rewrite the record in the canonical shape. Every other record,
 * including one with an unknown key anywhere, is invalid: the exact-key discipline lives in
 * `parseStoredSettingsV2` and both legacy branches feed their migrated record through it.
 */
export function parseStoredSettings(
  value: unknown,
  current: Settings = DEFAULT_SETTINGS,
): StoredSettingsParseResult {
  try {
    // A stored or synced v1 entry reads as a window entry, which is what the v2 parser does.
    const parsed: SettingsV2 | null = parseStoredSettingsV2(value);
    if (parsed !== null) {
      return {
        valid: true,
        changed: !storageValuesEqual(parsed, current),
        legacy: false,
        settings: parsed,
      };
    }
    const legacy: Record<string, unknown> | null = migratedLegacySettingsRecord(value);
    if (legacy === null) return { valid: false };
    const legacySettings: SettingsV2 | null = parseStoredSettingsV2(legacy);
    if (legacySettings === null) return { valid: false };
    const settings: Settings = legacySettings;
    return {
      valid: true,
      changed: !storageValuesEqual(settings, current),
      legacy: true,
      settings,
    };
  } catch {
    return { valid: false };
  }
}

/**
 * Rewrites a v1 settings record into the canonical key layout without validating it, or returns
 * null when the record is neither v1 shape. The caller runs the strict parser on the result.
 */
function migratedLegacySettingsRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const gate: unknown = value.gate;
  if (!isRecord(gate)) return null;
  if (Object.hasOwn(value, 'allowForceEnd')) {
    const allowForceEnd: unknown = value.allowForceEnd;
    if (typeof allowForceEnd !== 'boolean') return null;
    // A v1 gate never carried the nested field. When a record somehow has both, the nested one
    // is the canonical field a newer writer produced, so it wins and the root value is dropped.
    const migratedGate: Record<string, unknown> = Object.hasOwn(gate, 'allowForceEnd')
      ? { ...gate }
      : { ...gate, allowForceEnd };
    const legacy: Record<string, unknown> = { ...value, gate: migratedGate };
    delete legacy.allowForceEnd;
    return legacy;
  }
  if (Object.hasOwn(gate, 'allowForceEnd')) return null;
  return { ...value, gate: { ...gate, allowForceEnd: false } };
}

export function mergeLists(raw: unknown, base: ListsConfig = DEFAULT_LISTS): ListsConfig {
  const stored: Record<string, unknown> = isRecord(raw) ? raw : {};
  return {
    custom: Array.isArray(stored.custom) ? parseRules(stored.custom) : structuredClone(base.custom),
    whitelist: Array.isArray(stored.whitelist)
      ? parseRules(stored.whitelist)
      : structuredClone(base.whitelist),
    categories: parseCategories(stored.categories, base.categories),
    exclusions: isRecord(stored.exclusions)
      ? parseExclusions(stored.exclusions)
      : structuredClone(base.exclusions),
  };
}

export function parseLiveSettings(value: unknown, current: Settings): Settings | null {
  if (!isRecord(value)) return null;
  const parsed: Settings = mergeSettings(value, current);
  parsed.schedule = parseStrictLiveSchedule(value.schedule, current.schedule);
  return JSON.stringify(parsed) === JSON.stringify(current) ? null : parsed;
}

export function parseLiveLists(value: unknown, current: ListsConfig): ListsConfig | null {
  if (!isRecord(value)) return null;
  const parsed: ListsConfig = mergeLists(value, current);
  parsed.custom = parseStrictLiveRules(value.custom, current.custom);
  parsed.whitelist = parseStrictLiveRules(value.whitelist, current.whitelist);
  parsed.exclusions = parseStrictLiveExclusions(value.exclusions, current.exclusions);
  return JSON.stringify(parsed) === JSON.stringify(current) ? null : parsed;
}

export async function loadBank(journal?: SyncJournal): Promise<BankState> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_BANK))[SYNC_BANK];
  return parseBank(journalValue(journal, SYNC_BANK, raw)) ?? { balanceMs: 0 };
}

/** Null when no streak has been persisted yet: minting one needs core's emptyStreak. */
export async function loadStreak(journal?: SyncJournal): Promise<StreakState | null> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_STREAK))[SYNC_STREAK];
  return parseStreak(journalValue(journal, SYNC_STREAK, raw));
}

export async function loadSyncJournal(): Promise<SyncJournal> {
  const raw: unknown = (await chrome.storage.local.get(LOCAL_SYNC_JOURNAL))[LOCAL_SYNC_JOURNAL];
  if (!isRecord(raw)) return { sets: {}, removes: [] };
  const sets: Record<string, unknown> = isRecord(raw.sets) ? raw.sets : {};
  const removes: string[] = Array.isArray(raw.removes)
    ? raw.removes.filter((key: unknown): key is string => typeof key === 'string')
    : [];
  return { sets, removes };
}

function journalValue(journal: SyncJournal | undefined, key: string, stored: unknown): unknown {
  if (journal === undefined) return stored;
  if (journal.removes.includes(key)) return undefined;
  return Object.hasOwn(journal.sets, key) ? journal.sets[key] : stored;
}

/** The stored runtime value behind the committed policy generation pointer, exactly as written. */
export async function readStoredRuntimeRaw(): Promise<unknown> {
  const pointerStored: Record<string, unknown> =
    await chrome.storage.local.get(LOCAL_POLICY_COMMIT);
  const pointer: unknown = pointerStored[LOCAL_POLICY_COMMIT];
  if (
    isRecord(pointer) &&
    pointer.source === 'generation' &&
    typeof pointer.id === 'string' &&
    typeof pointer.revision === 'string'
  ) {
    const generationKey: string = `${LOCAL_POLICY_GENERATION_PREFIX}${pointer.id}`;
    const stored: Record<string, unknown> = await chrome.storage.local.get(generationKey);
    const generation: unknown = stored[generationKey];
    if (
      !isRecord(generation) ||
      generation.id !== pointer.id ||
      generation.revision !== pointer.revision
    ) {
      throw new Error('committed runtime generation is missing or invalid');
    }
    return generation.runtime;
  }
  return (await chrome.storage.local.get(LOCAL_RUNTIME))[LOCAL_RUNTIME];
}

export async function loadRuntime(now: number): Promise<ParsedRuntimeState> {
  return mergeRuntime(await readStoredRuntimeRaw(), now);
}

export function mergeRuntime(raw: unknown, now: number): ParsedRuntimeState {
  const empty: LegacyRuntimeStateV1 = emptyRuntime(now);
  if (!isRecord(raw)) return empty;
  const date: string = isDailyDate(raw.date) ? raw.date : empty.date;
  const runtime: ParsedRuntimeState = {
    session: parseSession(raw.session),
    gate: parseGate(raw.gate),
    unlocks: parseUnlocks(raw.unlocks),
    tabStates: parseTabStates(raw.tabStates),
    accruedFocusMs: isNonNegativeNumber(raw.accruedFocusMs) ? raw.accruedFocusMs : 0,
    attemptDebounce: parseAttemptDebounce(raw.attemptDebounce),
    deferredBlockClaims: parseDeferredBlockClaims(raw.deferredBlockClaims),
    removedTabTombstones: parseRemovedTabTombstones(raw.removedTabTombstones),
    scheduleActiveEntryId: isNullableString(raw.scheduleActiveEntryId)
      ? raw.scheduleActiveEntryId
      : null,
    scheduleUnavailableNoticeToken: isNullableString(raw.scheduleUnavailableNoticeToken)
      ? raw.scheduleUnavailableNoticeToken
      : null,
    date,
    todayAgg: parseDailyAgg(raw.todayAgg, date),
    lastPruneDate: isDailyDate(raw.lastPruneDate) ? raw.lastPruneDate : null,
    commitCheckpoint: parseCommitCheckpoint(raw.commitCheckpoint),
  };
  applyRemovedTabTombstones(runtime);
  return runtime;
}

/** Completes the only accepted legacy NormalizedSessionConfigV1 shape at worker boot. */
export function migrateRuntimeRules(
  runtime: ParsedRuntimeState,
  lists: ListsConfig,
): LegacyRuntimeStateV1 {
  if (isNormalizedRuntimeState(runtime)) return runtime;
  const session: ParsedSessionState | null = runtime.session;
  if (session === null) {
    throw new Error('parsed runtime normalization invariant failed');
  }
  const rules: SessionRuleSnapshot | null = hasAnySessionRules(session.config)
    ? normalizeStoredSessionRules(session.config.rules)
    : normalizeSessionRules(rulesFromLists(lists));
  if (rules === null) throw new Error('cannot migrate runtime from invalid blocking lists');
  return {
    ...runtime,
    session: {
      ...session,
      config: { ...session.config, rules },
    },
  };
}

function hasAnySessionRules(
  config: ParsedSessionConfig,
): config is NormalizedSessionConfigV1 | PredecessorSessionConfig {
  return Object.hasOwn(config, 'rules');
}

function hasCurrentSessionRules(config: ParsedSessionConfig): config is NormalizedSessionConfigV1 {
  return (
    hasAnySessionRules(config) &&
    isRecord(config.rules) &&
    Object.hasOwn(config.rules, 'baselineCategories')
  );
}

function isNormalizedRuntimeState(runtime: ParsedRuntimeState): runtime is LegacyRuntimeStateV1 {
  return runtime.session === null || hasCurrentSessionRules(runtime.session.config);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys: PropertyKey[] = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key: PropertyKey): boolean => typeof key === 'string' && keys.includes(key))
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

function numberOrDefault(value: unknown, fallback: number): number {
  return isNonNegativeNumber(value) ? value : fallback;
}

function isUnitNumber(value: unknown): value is number {
  return isNonNegativeNumber(value) && value <= 1;
}

function parsePresets(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [first, second, third]: unknown[] = value;
  if (
    !isRelativeMinuteDuration(first) ||
    !isRelativeMinuteDuration(second) ||
    !isRelativeMinuteDuration(third)
  ) {
    return null;
  }
  return [first, second, third];
}

function parseCycleConfig(value: unknown): CycleConfig | null {
  if (!isRecord(value)) return null;
  if (
    !isNonNegativeNumber(value.focusMin) ||
    !isNonNegativeNumber(value.shortBreakMin) ||
    !isNonNegativeNumber(value.longBreakMin) ||
    !isNonNegativeInteger(value.longEvery) ||
    value.longEvery === 0
  ) {
    return null;
  }
  return {
    focusMin: value.focusMin,
    shortBreakMin: value.shortBreakMin,
    longBreakMin: value.longBreakMin,
    longEvery: value.longEvery,
  };
}

/**
 * One stored entry through the v2 parser, which is what reads a synced v1 entry as a window entry.
 * The parser owns the whole settings shape, so the entry rides one default settings object.
 */
function parseStoredScheduleEntry(value: unknown): ScheduleEntryV2 | null {
  const parsed: SettingsV2 | null = parseStoredSettingsV2({
    ...DEFAULT_SETTINGS,
    schedule: [value],
  });
  return parsed?.schedule[0] ?? null;
}

/** The set as a whole, so the overlap and duplicate rules the parser owns still apply. */
function parseStoredSchedule(entries: ScheduleEntryV2[]): ScheduleEntryV2[] {
  const parsed: SettingsV2 | null = parseStoredSettingsV2({
    ...DEFAULT_SETTINGS,
    schedule: entries,
  });
  return parsed === null ? [] : parsed.schedule;
}

function parseSchedule(value: unknown): ScheduleEntryV2[] {
  if (!Array.isArray(value)) return [];
  const entries: ScheduleEntryV2[] = [];
  for (const candidate of value) {
    const entry: ScheduleEntryV2 | null = parseStoredScheduleEntry(candidate);
    if (entry !== null) entries.push(entry);
  }
  return parseStoredSchedule(entries);
}

function parseStrictLiveSchedule(value: unknown, current: ScheduleEntryV2[]): ScheduleEntryV2[] {
  if (!Array.isArray(value)) return structuredClone(current);
  const entries: ScheduleEntryV2[] = [];
  for (const candidate of value) {
    const entry: ScheduleEntryV2 | null = parseStoredScheduleEntry(candidate);
    if (entry === null) return structuredClone(current);
    entries.push(entry);
  }
  return entries;
}

function parseRule(value: unknown): Rule | null {
  if (
    !isRecord(value) ||
    (value.kind !== 'host' && value.kind !== 'regex') ||
    typeof value.pattern !== 'string'
  ) {
    return null;
  }
  const rule: Rule = { kind: value.kind, pattern: value.pattern };
  return validateRule(rule) === null ? rule : null;
}

function parseRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];
  const rules: Rule[] = [];
  for (const candidate of value) {
    const rule: Rule | null = parseRule(candidate);
    if (rule !== null) rules.push(rule);
  }
  return rules;
}

function parseStrictLiveRules(value: unknown, current: Rule[]): Rule[] {
  if (!Array.isArray(value)) return structuredClone(current);
  const rules: Rule[] = [];
  for (const candidate of value) {
    const rule: Rule | null = parseRule(candidate);
    if (rule === null) return structuredClone(current);
    rules.push(rule);
  }
  return rules;
}

function parseCategories(
  value: unknown,
  base: ListsConfig['categories'] = DEFAULT_LISTS.categories,
): ListsConfig['categories'] {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  const categories: ListsConfig['categories'] = { ...base };
  for (const id of CATEGORY_IDS) {
    if (typeof stored[id] === 'boolean') categories[id] = stored[id];
  }
  return categories;
}

function parseExclusions(value: unknown): ListsConfig['exclusions'] {
  if (!isRecord(value)) return {};
  const exclusions: ListsConfig['exclusions'] = {};
  for (const id of CATEGORY_IDS) {
    const candidates: unknown = value[id];
    if (!Array.isArray(candidates)) continue;
    const hosts: string[] = [];
    for (const candidate of candidates) {
      const rule: Rule | null = parseRule({ kind: 'host', pattern: candidate });
      if (rule !== null) hosts.push(rule.pattern);
    }
    exclusions[id] = hosts;
  }
  return exclusions;
}

function parseStrictLiveExclusions(
  value: unknown,
  current: ListsConfig['exclusions'],
): ListsConfig['exclusions'] {
  const exclusions: ListsConfig['exclusions'] = structuredClone(current);
  if (!isRecord(value)) return exclusions;
  for (const id of CATEGORY_IDS) {
    if (!Object.hasOwn(value, id)) continue;
    const candidates: unknown = value[id];
    if (!Array.isArray(candidates)) continue;
    const hosts: string[] = [];
    let valid: boolean = true;
    for (const candidate of candidates) {
      const rule: Rule | null = parseRule({ kind: 'host', pattern: candidate });
      if (rule === null) {
        valid = false;
        break;
      }
      hosts.push(rule.pattern);
    }
    if (valid) exclusions[id] = hosts;
  }
  return exclusions;
}

export function parseBank(value: unknown): BankState | null {
  if (!isRecord(value) || !isNonNegativeNumber(value.balanceMs)) return null;
  return { balanceMs: value.balanceMs };
}

function isMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match: RegExpExecArray | null = /^(\d{4})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const month: number = Number(match[2]);
  return month >= 1 && month <= 12;
}

function isNullableDailyDate(value: unknown): value is string | null {
  return value === null || isDailyDate(value);
}

export function parseStreak(value: unknown): StreakState | null {
  if (!isRecord(value)) return null;
  if (
    !isNonNegativeInteger(value.current) ||
    !isNonNegativeInteger(value.freezeTokens) ||
    value.freezeTokens > MAX_FREEZE_TOKENS ||
    !isNullableDailyDate(value.lastCountedDate) ||
    !isNullableDailyDate(value.lastFreezeGrantDate) ||
    !Array.isArray(value.activeDays) ||
    !isMonth(value.activeMonth)
  ) {
    return null;
  }
  const [yearText, monthText]: string[] = value.activeMonth.split('-');
  const daysInMonth: number = new Date(Number(yearText), Number(monthText), 0).getDate();
  const activeDays: number[] = [];
  const seen: Set<number> = new Set();
  for (const day of value.activeDays) {
    if (!isNonNegativeInteger(day) || day === 0 || day > daysInMonth || seen.has(day)) return null;
    seen.add(day);
    activeDays.push(day);
  }
  return {
    current: value.current,
    freezeTokens: value.freezeTokens,
    lastCountedDate: value.lastCountedDate,
    lastFreezeGrantDate: value.lastFreezeGrantDate,
    activeDays,
    activeMonth: value.activeMonth,
  };
}

function parseSessionConfig(value: unknown): ParsedSessionConfig | null {
  if (!isRecord(value)) return null;
  const baseKeys: readonly string[] = [
    'mode',
    'strictness',
    'durationMin',
    'cycling',
    'intention',
    'source',
    'scheduleEntryId',
  ];
  const hasRules: boolean = Object.hasOwn(value, 'rules');
  if (!hasExactKeys(value, hasRules ? [...baseKeys, 'rules'] : baseKeys)) return null;
  const cycling: CycleConfig | null = parseCycleConfig(value.cycling);
  const currentRules: SessionRuleSnapshot | null = hasRules
    ? normalizeSessionRules(value.rules)
    : null;
  const storedRules: SessionRuleSnapshot | null = hasRules
    ? normalizeStoredSessionRules(value.rules)
    : null;
  if (
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    (value.strictness !== 'flexible' &&
      value.strictness !== 'hard' &&
      value.strictness !== 'friction') ||
    (value.durationMin !== null && !isRelativeMinuteDuration(value.durationMin)) ||
    (value.cycling !== null && cycling === null) ||
    typeof value.intention !== 'string' ||
    (value.source !== 'manual' && value.source !== 'schedule') ||
    !isNullableString(value.scheduleEntryId) ||
    (hasRules && storedRules === null)
  ) {
    return null;
  }
  if (
    (value.source === 'manual' && value.scheduleEntryId !== null) ||
    (value.source === 'schedule' && value.scheduleEntryId === null)
  ) {
    return null;
  }
  // The v1 indefinite session was manual and never cycled, as the pre-merge writer required. Its
  // strictness is read as stored: the v2 contract decides what an indefinite Hard session becomes,
  // and refusing it here would drop the session and its focus instead of settling them.
  if (value.durationMin === null && (value.source !== 'manual' || value.cycling !== null)) {
    return null;
  }
  const config: Omit<NormalizedSessionConfigV1, 'rules'> = {
    mode: value.mode,
    strictness: value.strictness,
    durationMin: value.durationMin,
    cycling,
    intention: value.intention,
    source: value.source,
    scheduleEntryId: value.scheduleEntryId,
  };
  if (currentRules !== null) return { ...config, rules: currentRules };
  if (storedRules !== null) {
    const predecessorRules: PredecessorSessionRuleSnapshot = {
      baselineRevision: storedRules.baselineRevision,
      categories: storedRules.categories,
      exclusions: storedRules.exclusions,
      permanentBlacklist: storedRules.permanentBlacklist,
      permanentAllowlist: storedRules.permanentAllowlist,
      sessionBlacklist: storedRules.sessionBlacklist,
      sessionAllowlist: storedRules.sessionAllowlist,
    };
    return { ...config, rules: predecessorRules };
  }
  return config;
}

function parsePausedFrom(value: unknown): ParsedSessionState['pausedFrom'] {
  if (!isRecord(value)) return null;
  if (
    (value.phase !== 'focus' && value.phase !== 'break') ||
    !isNullableDeadline(value.phaseEndsAt)
  ) {
    return null;
  }
  return { phase: value.phase, phaseEndsAt: value.phaseEndsAt };
}

/**
 * The v1 session reader, with the timing rules of the pre-merge writer. A timed session carries
 * both deadlines. The indefinite session carries a null duration, a null session end, and a null
 * focus end, and may be paused with a numeric pause end that returns to that null focus end.
 */
function parseSession(value: unknown): ParsedSessionState | null {
  if (!isRecord(value)) return null;
  const config: ParsedSessionConfig | null = parseSessionConfig(value.config);
  const pausedFrom: ParsedSessionState['pausedFrom'] = parsePausedFrom(value.pausedFrom);
  if (
    config === null ||
    (value.sessionId !== undefined && !isNonBlankString(value.sessionId)) ||
    (value.phase !== 'focus' && value.phase !== 'break' && value.phase !== 'paused') ||
    !isNonNegativeNumber(value.startedAt) ||
    !isNullableDeadline(value.sessionEndsAt) ||
    !isNonNegativeNumber(value.phaseStartedAt) ||
    !isNullableDeadline(value.phaseEndsAt) ||
    !isNonNegativeInteger(value.cycleIndex) ||
    !isNonNegativeNumber(value.focusedMs)
  ) {
    return null;
  }
  const session: ParsedSessionState = {
    config,
    startedAt: value.startedAt,
    sessionEndsAt: value.sessionEndsAt,
    phase: value.phase,
    phaseStartedAt: value.phaseStartedAt,
    phaseEndsAt: value.phaseEndsAt,
    cycleIndex: value.cycleIndex,
    pausedFrom: value.phase === 'paused' ? pausedFrom : null,
    focusedMs: value.focusedMs,
  };
  if (!validSessionTiming(session)) return null;
  if (session.phase !== 'paused' && value.pausedFrom !== null && value.pausedFrom !== undefined) {
    return null;
  }
  if (isNonBlankString(value.sessionId)) session.sessionId = value.sessionId;
  return session;
}

function isNullableDeadline(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value);
}

/**
 * The pre-merge writer's invariants, one branch per duration kind. An indefinite session has no
 * session end and no cycle, focuses with no deadline and no saved phase, and pauses with a pause
 * end at or after the pause start that returns to a focus phase with no deadline. A timed session
 * has both deadlines at or after its start, a pause that returns to a phase ending inside the
 * session, and a break only when it cycles.
 */
function validSessionTiming(session: ParsedSessionState): boolean {
  const { config, phase, startedAt, phaseStartedAt, phaseEndsAt, sessionEndsAt, pausedFrom } =
    session;
  if (phaseStartedAt < startedAt) return false;
  if (config.durationMin === null) {
    if (sessionEndsAt !== null || session.cycleIndex !== 0) return false;
    if (phase === 'focus') return phaseEndsAt === null && pausedFrom === null;
    return (
      phase === 'paused' &&
      phaseEndsAt !== null &&
      phaseEndsAt >= phaseStartedAt &&
      pausedFrom?.phase === 'focus' &&
      pausedFrom.phaseEndsAt === null
    );
  }
  if (
    sessionEndsAt === null ||
    phaseEndsAt === null ||
    sessionEndsAt < startedAt ||
    phaseEndsAt < startedAt
  ) {
    return false;
  }
  if (phase === 'paused') {
    return (
      phaseEndsAt >= phaseStartedAt &&
      pausedFrom !== null &&
      pausedFrom.phaseEndsAt !== null &&
      pausedFrom.phaseEndsAt >= phaseStartedAt &&
      pausedFrom.phaseEndsAt <= sessionEndsAt
    );
  }
  return phaseEndsAt <= sessionEndsAt && (phase !== 'break' || config.cycling !== null);
}

function parseGate(value: unknown): GateState | null {
  if (!isRecord(value)) return null;
  if (
    !isGateKind(value.kind) ||
    !isNullableString(value.host) ||
    !isNonNegativeNumber(value.openedAt) ||
    !isNonNegativeNumber(value.readyAt) ||
    value.readyAt < value.openedAt ||
    !isNullableString(value.requiredPhrase)
  ) {
    return null;
  }
  if (
    (isHostGateKind(value.kind) && (value.host === null || value.host === '')) ||
    (!isHostGateKind(value.kind) && value.host !== null)
  ) {
    return null;
  }
  return {
    kind: value.kind,
    host: value.host,
    openedAt: value.openedAt,
    readyAt: value.readyAt,
    requiredPhrase: value.requiredPhrase,
    // A v1 gate that never minted the flag reads as one that offers no bypass.
    forceEndAvailable: value.forceEndAvailable === true,
  };
}

function parseUnlock(value: unknown): SiteUnlock | null {
  if (
    !isRecord(value) ||
    typeof value.host !== 'string' ||
    value.host === '' ||
    !isNonNegativeNumber(value.until)
  ) {
    return null;
  }
  return { host: value.host, until: value.until };
}

function parseUnlocks(value: unknown): SiteUnlock[] {
  if (!Array.isArray(value)) return [];
  const unlocks: SiteUnlock[] = [];
  for (const candidate of value) {
    const unlock: SiteUnlock | null = parseUnlock(candidate);
    if (unlock !== null) unlocks.push(unlock);
  }
  return unlocks;
}

function parseAttemptDebounce(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const parsed: Record<string, number> = {};
  for (const [key, timestamp] of Object.entries(value)) {
    if (isNonNegativeNumber(timestamp)) parsed[key] = timestamp;
  }
  return parsed;
}

interface ParsedSessionIdentity {
  sessionId?: string;
}

function parseSessionIdentity(value: Record<string, unknown>): ParsedSessionIdentity | null {
  if (value.sessionId === undefined) return {};
  return isNonBlankString(value.sessionId) ? { sessionId: value.sessionId } : null;
}

function isPhase(value: unknown): value is 'idle' | 'focus' | 'break' | 'paused' {
  return value === 'idle' || value === 'focus' || value === 'break' || value === 'paused';
}

function isGateKind(value: unknown): value is GateKind {
  return (
    value === 'pause' || value === 'unlockSite' || value === 'excludeSite' || value === 'cancel'
  );
}

/** The gates that name the site they act on. */
function isHostGateKind(value: GateKind): boolean {
  return value === 'unlockSite' || value === 'excludeSite';
}

function parseEventRecord(value: unknown): LegacyEventRecord | null {
  if (!isRecord(value) || !isNonNegativeNumber(value.at)) return null;
  const identity: ParsedSessionIdentity | null = parseSessionIdentity(value);
  if (identity === null) return null;
  switch (value.t) {
    case 'sessionStarted':
      if (
        (value.source !== 'manual' && value.source !== 'schedule') ||
        (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
        (value.strictness !== 'flexible' &&
          value.strictness !== 'hard' &&
          value.strictness !== 'friction') ||
        // Null is the v1 indefinite session start, which the pre-merge build recorded this way.
        (value.durationMin !== null && !isNonNegativeNumber(value.durationMin)) ||
        typeof value.intention !== 'string'
      ) {
        return null;
      }
      return {
        t: value.t,
        at: value.at,
        source: value.source,
        mode: value.mode,
        strictness: value.strictness,
        durationMin: value.durationMin,
        intention: value.intention,
        ...identity,
      };
    case 'sessionCompleted':
    case 'sessionCanceled':
      if (!isNonNegativeNumber(value.focusedMs)) return null;
      return { t: value.t, at: value.at, focusedMs: value.focusedMs, ...identity };
    case 'sessionIdentityAssigned':
      if (!isNonNegativeNumber(value.startedAt) || identity.sessionId === undefined) return null;
      return {
        t: value.t,
        at: value.at,
        startedAt: value.startedAt,
        sessionId: identity.sessionId,
      };
    case 'phase':
      if (!isPhase(value.from) || !isPhase(value.to)) return null;
      return { t: value.t, at: value.at, from: value.from, to: value.to, ...identity };
    case 'attempt':
      if (
        typeof value.url !== 'string' ||
        typeof value.host !== 'string' ||
        !isNonNegativeInteger(value.tabId) ||
        (value.kind !== 'navigation' && value.kind !== 'existing')
      ) {
        return null;
      }
      return {
        t: value.t,
        at: value.at,
        url: value.url,
        host: value.host,
        tabId: value.tabId,
        kind: value.kind,
        ...identity,
      };
    case 'gateOpened':
    case 'gateResisted':
      if (!isGateKind(value.gate)) return null;
      return { t: value.t, at: value.at, gate: value.gate, ...identity };
    case 'budgetEarned':
    case 'pauseTaken':
      if (!isNonNegativeNumber(value.ms)) return null;
      return { t: value.t, at: value.at, ms: value.ms, ...identity };
    case 'unlockTaken':
      if (typeof value.host !== 'string' || value.host === '' || !isNonNegativeNumber(value.ms)) {
        return null;
      }
      return { t: value.t, at: value.at, host: value.host, ms: value.ms, ...identity };
    default:
      return null;
  }
}

function parseCommitCheckpoint(value: unknown): RuntimeCommitCheckpoint | null {
  if (!isRecord(value) || !isRecord(value.bank) || !Array.isArray(value.events)) return null;
  if (!isNonNegativeNumber(value.bank.balanceMs) || typeof value.syncBank !== 'boolean') {
    return null;
  }
  const events: LegacyEventRecord[] = [];
  for (const candidate of value.events) {
    const event: LegacyEventRecord | null = parseEventRecord(candidate);
    if (event === null) return null;
    events.push(event);
  }
  const aggregateSets: Record<string, DailyAgg> = {};
  if (value.aggregateSets !== undefined) {
    if (!isRecord(value.aggregateSets)) return null;
    for (const [key, candidate] of Object.entries(value.aggregateSets)) {
      const date: string | undefined =
        /^agg:[^:]+:(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1] ??
        /^archive:clock-rebase:[^:]+:(\d{4}-\d{2}-\d{2}):\d+:[^:]+$/.exec(key)?.[1];
      if (date === undefined) return null;
      const aggregate: DailyAgg | null = parseDailyAgg(candidate, date);
      if (aggregate === null) return null;
      aggregateSets[key] = capAttempts(aggregate, TOP_SITES_DAILY);
    }
  }
  const aggregateRemoves: string[] = [];
  if (value.aggregateRemoves !== undefined) {
    if (!Array.isArray(value.aggregateRemoves)) return null;
    for (const key of value.aggregateRemoves) {
      if (typeof key !== 'string' || !/^agg:[^:]+:\d{4}-\d{2}-\d{2}$/.test(key)) return null;
      aggregateRemoves.push(key);
    }
  }
  return {
    bank: { balanceMs: value.bank.balanceMs },
    events,
    syncBank: value.syncBank,
    ...(Object.keys(aggregateSets).length === 0 ? {} : { aggregateSets }),
    ...(aggregateRemoves.length === 0 ? {} : { aggregateRemoves }),
  };
}

function parseTabStates(value: unknown): Record<number, RuntimeTabState> {
  if (!isRecord(value)) return {};
  const parsed: Record<number, RuntimeTabState> = {};
  for (const [tabIdText, candidate] of Object.entries(value)) {
    const tabId: number = Number(tabIdText);
    if (!Number.isInteger(tabId) || tabId < 0) continue;
    if (!isRecord(candidate)) continue;
    const state: Record<string, unknown> = candidate;
    const priorMuted: boolean | null =
      state.priorMuted === null || typeof state.priorMuted === 'boolean' ? state.priorMuted : null;
    if (state.priorMuted !== null && typeof state.priorMuted !== 'boolean') continue;

    const legacyUrl: string | null =
      typeof state.url === 'string' && state.url !== '' ? state.url : null;
    const muteUrl: string | null =
      priorMuted === null
        ? null
        : typeof state.muteUrl === 'string' && state.muteUrl !== ''
          ? state.muteUrl
          : legacyUrl;
    if (priorMuted !== null && muteUrl === null) continue;

    const stoppedDocumentId: string | null =
      state.stoppedDocumentId === null || state.stoppedDocumentId === undefined
        ? null
        : typeof state.stoppedDocumentId === 'string' && state.stoppedDocumentId !== ''
          ? state.stoppedDocumentId
          : null;
    if (
      state.stoppedDocumentId !== null &&
      state.stoppedDocumentId !== undefined &&
      stoppedDocumentId === null
    ) {
      continue;
    }
    if (muteUrl === null && stoppedDocumentId === null) continue;
    parsed[tabId] = { muteUrl, priorMuted, stoppedDocumentId };
  }
  return parsed;
}

function parseDeferredBlockClaims(value: unknown): Record<string, DeferredBlockClaim> {
  if (!isRecord(value)) return {};
  const parsed: Record<string, DeferredBlockClaim> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)) continue;
    if (
      !isNonNegativeNumber(candidate.attemptAt) ||
      (candidate.kind !== 'navigation' && candidate.kind !== 'existing') ||
      typeof candidate.sessionId !== 'string' ||
      candidate.sessionId.trim() === '' ||
      (candidate.stage !== 'attempt' && candidate.stage !== 'stopped') ||
      !Number.isInteger(candidate.tabId) ||
      (candidate.tabId as number) < 0 ||
      typeof candidate.url !== 'string' ||
      candidate.url === ''
    ) {
      continue;
    }
    const documentId: string | undefined =
      typeof candidate.documentId === 'string' && candidate.documentId !== ''
        ? candidate.documentId
        : undefined;
    if (
      candidate.stage === 'stopped' &&
      (candidate.kind !== 'navigation' || documentId === undefined)
    ) {
      continue;
    }
    parsed[key] = {
      attemptAt: candidate.attemptAt,
      kind: candidate.kind,
      sessionId: candidate.sessionId,
      stage: candidate.stage,
      tabId: candidate.tabId as number,
      url: candidate.url,
      ...(documentId === undefined ? {} : { documentId }),
    };
  }
  return parsed;
}

function parseRemovedTabTombstones(value: unknown): Record<number, true> {
  if (!isRecord(value)) return {};
  const parsed: Record<number, true> = {};
  for (const [tabIdText, candidate] of Object.entries(value)) {
    const tabId: number = Number(tabIdText);
    if (candidate === true && Number.isInteger(tabId) && tabId >= 0) parsed[tabId] = true;
  }
  return parsed;
}

function applyRemovedTabTombstones(runtime: ParsedRuntimeState): void {
  for (const tabIdText of Object.keys(runtime.removedTabTombstones)) {
    const tabId: number = Number(tabIdText);
    delete runtime.tabStates[tabId];
    for (const key of Object.keys(runtime.attemptDebounce)) {
      if (key.startsWith(`${tabId}:`)) delete runtime.attemptDebounce[key];
    }
    for (const [key, claim] of Object.entries(runtime.deferredBlockClaims)) {
      if (claim.tabId === tabId) delete runtime.deferredBlockClaims[key];
    }
  }
}

export async function saveLegacyRuntime(r: LegacyRuntimeStateV1): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_RUNTIME]: r });
}

export async function loadMatcherCache(): Promise<unknown> {
  return (await chrome.storage.local.get(LOCAL_CACHES))[LOCAL_CACHES];
}

export async function saveMatcherCache(
  cache: StoredMatcherCache,
  _lists?: ListsConfig,
): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_CACHES]: cache });
}

export async function getDeviceId(): Promise<string> {
  const existing: unknown = (await chrome.storage.local.get(LOCAL_DEVICE_ID))[LOCAL_DEVICE_ID];
  if (isNonBlankString(existing)) return existing;
  const id: string = crypto.randomUUID();
  await chrome.storage.local.set({ [LOCAL_DEVICE_ID]: id });
  return id;
}
