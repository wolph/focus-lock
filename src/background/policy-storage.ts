import { capAttempts } from '../core/stats';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  TOP_SITES_DAILY,
} from '../shared/constants';
import { isListsConfig, isSettings, isSetupState } from '../shared/runtime-validation';
import {
  LOCAL_AGGREGATE_PRUNE,
  LOCAL_AGGREGATE_TOMBSTONES,
  LOCAL_BANK,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_CACHES,
  LOCAL_DATA_CLEAR_JOURNAL,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_FIRST_SYNC_PUBLICATION,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_ONBOARDING_DRAFT,
  LOCAL_PENDING_CHANGES,
  LOCAL_POLICY_COMMIT,
  LOCAL_POLICY_GENERATION_PREFIX,
  LOCAL_RUNTIME,
  LOCAL_RUNTIME_MIGRATION,
  LOCAL_RUNTIME_REJECTED,
  LOCAL_RUNTIME_SCHEMA,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
  LOCAL_STREAK,
  LOCAL_SYNC_JOURNAL,
  LOCAL_SYNC_QUOTA_EVICTION,
  SYNC_BANK,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../shared/storage-keys';
import type {
  BankState,
  DailyAgg,
  InstallMarker,
  ListsConfig,
  Settings,
  SetupState,
  StorageMode,
  StreakState,
} from '../shared/types';
import {
  beginManualCleanupBatchV2,
  freshCleanupRetryStateV2,
  recordCleanupAttemptFailureV2,
} from './cleanup-progress-v2';
import {
  type AllDataClearJournalV2,
  type AllDataClearPublicState,
  cleanInstallMarkerProjection,
  createAllDataClearJournalV2,
  type DataClearJournal,
  type DataClearResetIdsV2,
  emptyDataClearResetProgress,
  isLegacyAllDataClearJournal,
  type LegacyAllDataClearJournal,
  type LocalHistoryClearJournal,
  parseDataClearJournal,
  projectAllDataClearPublicState,
  type SyncedPolicyClearJournal,
  upgradeLegacyAllDataClearJournal,
} from './data-clear-journal';
import {
  type AllDataClearLease,
  type DataClearLeaseToken,
  transactDataClearJournal,
} from './data-clear-lease';
import { encodeListsForSync, LIST_SYNC_KEYS, type ListsSyncEncoding } from './list-sync-codec';
import { emptyRuntimeV2 } from './runtime-store-v2';
import type { RuntimeStateV2 } from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';
import {
  hasScheduleIntentions,
  settingsForSync,
  settingsWithLocalIntentions,
} from './settings-sync';
import {
  type AggregateStorage,
  type LocalAggregatePruneCheckpoint,
  pruneAndRollup,
} from './stats-service';
import { storageValuesEqual } from './storage-value-equality';
import {
  type LegacyRuntimeStateV1,
  mergeRuntime,
  migrateRuntimeRules,
  type ParsedRuntimeState,
  parseBank,
  parseStoredSettings,
  parseStreak,
  type StoredSettingsParseResult,
} from './stores';
import { assertSyncItemWithinQuota } from './sync-item-size';
import {
  aggregateHistoryDeviceId,
  isAggregateHistoryKey,
  isAuthoritativeSyncItem,
  isFocusLockDeletionKey,
  isFocusLockSyncKey,
} from './sync-item-validation';
import {
  removeSyncItems,
  removeSyncItemsUntilClear,
  sanitizeSyncJournal,
  setSyncItemsWithinQuota,
} from './sync-quota';
import { SyncQuotaError } from './sync-quota-shared';
import { SyncEchoes, type SyncJournal, SyncWriter } from './sync-writer';

const SYNC_FLUSH_MS: number = 10_000;
const LOCAL_SCHEDULE_CLEANUP_READ: string = 'scheduleIntentionCleanupRead';

/** A failed remote read must not turn an idle profile into a full local-policy republication. */
interface ScheduleCleanupReadCheckpoint {
  reconstructPublication: boolean;
}
const POLICY_LOCAL_KEYS: readonly string[] = [
  LOCAL_SETTINGS,
  LOCAL_LISTS,
  LOCAL_BANK,
  LOCAL_STREAK,
];
const POLICY_SYNC_KEYS: readonly string[] = [
  SYNC_SETTINGS,
  ...LIST_SYNC_KEYS,
  SYNC_BANK,
  SYNC_STREAK,
];

export interface PolicySnapshot {
  settings: Settings;
  lists: ListsConfig;
  bank: BankState;
  streak: StreakState | null;
}

export interface PolicyValueByKey {
  settings: Settings;
  lists: ListsConfig;
  bank: BankState;
  streak: StreakState | null;
}

export type SetupUpdate = Pick<
  SetupState,
  'websiteAccess' | 'blockingRegistration' | 'websiteAccessNotice'
>;

export interface FirstSyncCheckpointSource {
  loadAggregateItems(): Promise<Record<string, unknown>>;
  runExclusive?<T>(operation: () => Promise<T>): Promise<T>;
}

export interface AllDataClearBarrier {
  runExclusive<T>(operation: () => Promise<T>, retainQuiescence: () => boolean): Promise<T>;
}

export interface PolicyStorage {
  initialize(): Promise<void>;
  loadSetup(): Promise<SetupState>;
  updateSetup(next: Partial<SetupUpdate>): Promise<void>;
  markSetupCompleted(): Promise<void>;
  loadSnapshot(): Promise<PolicySnapshot>;
  setPolicy<K extends keyof PolicyValueByKey>(key: K, value: PolicyValueByKey[K]): Promise<void>;
  selectLocalMode(): Promise<void>;
  enableSync(): Promise<void>;
  retrySync(): Promise<void>;
  disableSync(): Promise<void>;
  mirrorAcceptedRemotePolicy(
    changes: Record<string, unknown>,
    pendingRemoteKeys?: readonly string[],
  ): Promise<void>;
  queueVerifiedRemoteCorrections(keys: readonly (keyof PolicyValueByKey)[]): Promise<void>;
  deleteRemoteData(scope: 'synced-policy' | 'all'): Promise<void>;
  /** Returns true when local aggregate history was cleared with detailed events. */
  clearLocalHistory(): Promise<boolean>;
  finishLocalHistoryClear(): Promise<void>;
  pendingLocalHistoryClear(): Promise<{ clearAggregates: boolean } | null>;
  allDataClearCompleted(): boolean;
  /** Runs the phase the all-data journal is in and reports which one it was. */
  runAllDataClearPhase(
    token: DataClearLeaseToken,
  ): Promise<'remote' | 'local' | 'browser-reset' | 'none'>;
  materializeBrowserResetProjections(token: DataClearLeaseToken): Promise<void>;
  retryAllDataClear(token: DataClearLeaseToken): Promise<'ok' | 'retry-not-available'>;
  allDataClearPublicState(): Promise<AllDataClearPublicState>;
  storageMode(): Promise<StorageMode | null>;
  inboundSyncAllowed(): Promise<boolean>;
  consumeRemoteEcho(key: string, value: unknown): boolean;
  hasPendingRemote(key: string): boolean;
  publishRemoteItem(key: string, value: unknown): Promise<void>;
  removeRemoteItem(key: string): Promise<void>;
  remoteJournalDurable(): Promise<void>;
  pruneRemoteHistory(deviceId: string, retentionDays: number, now: number): Promise<void>;
  saveAggregate(key: string, value: unknown): Promise<void>;
  removeAggregate(key: string): Promise<void>;
  withAggregateStorage<T>(operation: (storage: AggregateStorage) => Promise<T>): Promise<T>;
  markLegacyMigrationFailed(): Promise<void>;
  /**
   * Records that the legacy import replaced one or more synced entries it could not read. Written
   * after the import, because the import itself writes a clean record.
   */
  markLegacyRemotePolicyDropped(): Promise<void>;
  importLegacy(
    snapshot: PolicySnapshot,
    runtime: LegacyRuntimeStateV1,
    journal: SyncJournal,
    storedSync?: Record<string, unknown>,
  ): Promise<void>;
}

interface PreviousValues {
  existing: Record<string, unknown>;
  missing: string[];
}

/**
 * The two journals this module still owns end to end. The all-data journal is the version 2 value
 * `data-clear-journal` defines, and every change to it runs through the shared deletion lease.
 */
type ScopedClearJournal = SyncedPolicyClearJournal | LocalHistoryClearJournal;

type StoredClearJournal = DataClearJournal | LegacyAllDataClearJournal;

/**
 * The seam Main binds so this module can transact the all-data journal under the shared lease.
 *
 * It carries no storage area on purpose: `transactDataClearJournal` reads and writes
 * `chrome.storage.local` directly, which is the Task 2 contract. The invariant that keeps the two
 * agreeing is that the `local` area this module is constructed with IS `chrome.storage.local`. An
 * instance built on any other area would write its journal somewhere else, silently.
 */
export interface PolicyStorageDataClearPorts {
  lease: AllDataClearLease;
  newId(): string;
  now(): number;
  /** `chrome.runtime.getManifest?.().version ?? 'unknown'` at the moment the journal advances. */
  manifestVersion(): string;
  /** The worker's background error report, for a fault that stops the boot before anything runs. */
  reportError(error: unknown): void;
}

interface PolicyGenerationRecord {
  id: string;
  revision: string;
  policy: PolicySnapshot;
  runtime: LegacyRuntimeStateV1;
  journal: SyncJournal;
  aggregates: Record<string, unknown>;
  aggregateTombstones: string[];
}

type PolicyCommit =
  | { source: 'generation'; id: string; revision: string }
  | { source: 'direct'; revision: string };

interface FirstSyncPublicationCheckpoint {
  version: 1;
  phase: 'publishing' | 'remote-complete';
  publication: SyncJournal;
}

const FOCUS_LOCK_LOCAL_EXACT_KEYS: readonly string[] = [
  LOCAL_SCHEDULE_CLEANUP_READ,
  LOCAL_RUNTIME,
  LOCAL_RUNTIME_SCHEMA,
  LOCAL_RUNTIME_MIGRATION,
  LOCAL_RUNTIME_REJECTED,
  LOCAL_CACHES,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_PENDING_CHANGES,
  LOCAL_SYNC_JOURNAL,
  LOCAL_FIRST_SYNC_PUBLICATION,
  LOCAL_SYNC_QUOTA_EVICTION,
  LOCAL_AGGREGATE_TOMBSTONES,
  LOCAL_AGGREGATE_PRUNE,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_INSTALL_MARKER,
  LOCAL_ONBOARDING_DRAFT,
  LOCAL_POLICY_COMMIT,
  LOCAL_SETTINGS,
  LOCAL_LISTS,
  LOCAL_BANK,
  LOCAL_STREAK,
];

/** Remote, then local: the two phases Policy Storage runs before Engine takes browser reset. */
const ALL_DATA_PHASES_THIS_SIDE_OWNS: number = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The runtime an all-data clear may delete under. A stopped runtime holds no session and no blocking
 * state, and it owes no cleanup, because a pending transition or a pending closure is a journal
 * another owner is still driving. A prepared target reservation lives inside a transition and
 * nowhere else, so refusing the transition is what covers it.
 *
 * What a stopped profile legitimately keeps is deliberately not required to be idle. The epoch
 * acknowledgements, the revisions, and the day's aggregate all survive a stop. Resetting those to
 * the idle projection `data-clear-journal` validates is the clear's own job, not a precondition
 * for running it.
 */
function isStoppedRuntimeV2(runtime: RuntimeStateV2): boolean {
  return (
    runtime.session === null &&
    runtime.gate === null &&
    runtime.unlocks.length === 0 &&
    Object.keys(runtime.tabStates).length === 0 &&
    runtime.enforcementCheckpoint === null &&
    runtime.pendingEnforcementTransition === null &&
    runtime.pendingClosure === null
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual: string[] = Object.keys(value).sort();
  const sortedExpected: string[] = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key: string, index: number): boolean => key === sortedExpected[index])
  );
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return storageValuesEqual(left, right);
}

function parseAggregateTombstones(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !isAggregateHistoryKey(candidate)) continue;
    if (!keys.includes(candidate)) keys.push(candidate);
  }
  return keys;
}

function isDailyAggregateHistoryKey(key: string): boolean {
  return (
    /^agg:[^:]+:\d{4}-\d{2}-\d{2}$/.test(key) ||
    /^archive:clock-rebase:[^:]+:\d{4}-\d{2}-\d{2}:\d+:[^:]+$/.test(key)
  );
}

function normalizeAggregateItem(key: string, value: unknown): unknown {
  if (!isAggregateHistoryKey(key) || !isAuthoritativeSyncItem(key, value)) {
    throw new Error('invalid aggregate item');
  }
  return isDailyAggregateHistoryKey(key)
    ? capAttempts(value as DailyAgg, TOP_SITES_DAILY)
    : structuredClone(value);
}

function normalizedAggregateItems(items: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(items)) {
    if (!isAggregateHistoryKey(key)) continue;
    normalized[key] = normalizeAggregateItem(key, value);
  }
  return normalized;
}

interface LegacyAggregateAuthority {
  aggregates: Record<string, unknown>;
  tombstones: string[];
  journal: SyncJournal;
}

interface BlockedAggregatePublications {
  version: 1;
  items: Record<string, unknown>;
}

function emptyBlockedAggregatePublications(): BlockedAggregatePublications {
  return { version: 1, items: {} };
}

function parseBlockedAggregatePublications(value: unknown): BlockedAggregatePublications {
  if (value === undefined) return emptyBlockedAggregatePublications();
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'items']) ||
    value.version !== 1 ||
    !isRecord(value.items)
  ) {
    throw new Error('invalid blocked aggregate publication registry');
  }
  const items: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value.items)) {
    try {
      const normalized: unknown = normalizeAggregateItem(key, candidate);
      if (!valuesEqual(normalized, candidate)) {
        throw new Error('blocked aggregate publication is not normalized');
      }
      items[key] = normalized;
    } catch (_error: unknown) {
      throw new Error('invalid blocked aggregate publication registry');
    }
  }
  return { version: 1, items };
}

function blockedAggregatePublicationsEmpty(registry: BlockedAggregatePublications): boolean {
  return Object.keys(registry.items).length === 0;
}

function effectiveLegacyAggregateAuthority(
  storedSync: Record<string, unknown>,
  journal: SyncJournal,
): LegacyAggregateAuthority {
  const aggregates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(storedSync)) {
    if (!isAggregateHistoryKey(key) || !isAuthoritativeSyncItem(key, value)) continue;
    aggregates[key] = normalizeAggregateItem(key, value);
  }
  const normalizedJournal: SyncJournal = structuredClone(journal);
  for (const [key, value] of Object.entries(journal.sets)) {
    if (!isAggregateHistoryKey(key)) continue;
    if (!isAuthoritativeSyncItem(key, value)) {
      delete normalizedJournal.sets[key];
      continue;
    }
    const normalized: unknown = normalizeAggregateItem(key, value);
    assertSyncItemWithinQuota(key, normalized);
    normalizedJournal.sets[key] = normalized;
    aggregates[key] = normalized;
  }
  const tombstones: string[] = [];
  for (const key of journal.removes) {
    if (!isAggregateHistoryKey(key)) continue;
    delete aggregates[key];
    if (!tombstones.includes(key)) tombstones.push(key);
  }
  return { aggregates, tombstones, journal: normalizedJournal };
}

function parseAggregatePrune(value: unknown): LocalAggregatePruneCheckpoint | null {
  if (!isRecord(value) || !isRecord(value.set) || !Array.isArray(value.remove)) return null;
  if (
    !Object.entries(value.set).every(
      ([key, candidate]: [string, unknown]): boolean =>
        isAggregateHistoryKey(key) && isAuthoritativeSyncItem(key, candidate),
    )
  ) {
    return null;
  }
  if (
    !value.remove.every(
      (key: unknown): key is string => typeof key === 'string' && isAggregateHistoryKey(key),
    )
  ) {
    return null;
  }
  return { set: structuredClone(value.set), remove: [...value.remove] };
}

function isPolicyKey(value: unknown): value is keyof PolicyValueByKey {
  return value === 'settings' || value === 'lists' || value === 'bank' || value === 'streak';
}

function localKey(key: keyof PolicyValueByKey): string {
  if (key === 'settings') return LOCAL_SETTINGS;
  if (key === 'lists') return LOCAL_LISTS;
  if (key === 'bank') return LOCAL_BANK;
  return LOCAL_STREAK;
}

function syncKey(key: Exclude<keyof PolicyValueByKey, 'lists'>): string {
  if (key === 'settings') return SYNC_SETTINGS;
  if (key === 'bank') return SYNC_BANK;
  return SYNC_STREAK;
}

function assertPolicyValue(key: keyof PolicyValueByKey, value: unknown): void {
  const valid: boolean =
    key === 'settings'
      ? isSettings(value)
      : key === 'lists'
        ? isListsConfig(value)
        : key === 'bank'
          ? isRecord(value) && hasExactKeys(value, ['balanceMs']) && parseBank(value) !== null
          : value === null ||
            (isRecord(value) &&
              hasExactKeys(value, [
                'current',
                'freezeTokens',
                'lastCountedDate',
                'lastFreezeGrantDate',
                'activeDays',
                'activeMonth',
              ]) &&
              parseStreak(value) !== null);
  if (!valid) throw new Error(`invalid ${key} policy`);
}

/**
 * The read side of the settings policy. Writers keep `assertPolicyValue`, so a stored record in
 * either v1 shape can only have come from a v1 install, and `repairStoredSettingsShape` rewrites
 * it canonical on the next `initialize()`. Until then every read migrates it in memory.
 */
function readStoredSettingsPolicy(value: unknown): Settings {
  const parsed: StoredSettingsParseResult = parseStoredSettings(value, DEFAULT_SETTINGS);
  if (!parsed.valid) throw new Error('invalid settings policy');
  return parsed.settings;
}

function parsePolicySnapshot(value: unknown): PolicySnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['settings', 'lists', 'bank', 'streak'])) {
    throw new Error('invalid policy snapshot');
  }
  const parsedSettings: StoredSettingsParseResult = parseStoredSettings(
    value.settings,
    DEFAULT_SETTINGS,
  );
  const lists: unknown = value.lists;
  const rawBank: unknown = value.bank;
  const rawStreak: unknown = value.streak;
  if (!parsedSettings.valid || !isListsConfig(lists)) throw new Error('invalid policy snapshot');
  const settings: Settings = parsedSettings.settings;
  const bank: BankState | null = parseBank(rawBank);
  if (!isRecord(rawBank) || !hasExactKeys(rawBank, ['balanceMs']) || bank === null) {
    throw new Error('invalid policy snapshot');
  }
  const streak: StreakState | null = rawStreak === null ? null : parseStreak(rawStreak);
  if (
    rawStreak !== null &&
    (!isRecord(rawStreak) ||
      !hasExactKeys(rawStreak, [
        'current',
        'freezeTokens',
        'lastCountedDate',
        'lastFreezeGrantDate',
        'activeDays',
        'activeMonth',
      ]) ||
      streak === null)
  ) {
    throw new Error('invalid policy snapshot');
  }
  return {
    settings: structuredClone(settings),
    lists: structuredClone(lists),
    bank: structuredClone(bank),
    streak: structuredClone(streak),
  };
}

function parseJournal(value: unknown, removalOnly: boolean): SyncJournal {
  if (value === undefined) return { sets: {}, removes: [] };
  if (!isRecord(value) || !hasExactKeys(value, ['sets', 'removes'])) {
    throw new Error('invalid local sync journal');
  }
  if (!isRecord(value.sets) || !Array.isArray(value.removes)) {
    throw new Error('invalid local sync journal');
  }
  if (!value.removes.every((key: unknown): key is string => typeof key === 'string')) {
    throw new Error('invalid local sync journal');
  }
  if (removalOnly && Object.keys(value.sets).length > 0) {
    throw new Error('invalid removal-only sync journal');
  }
  return { sets: structuredClone(value.sets), removes: [...value.removes] };
}

function journalForSync(journal: SyncJournal): SyncJournal {
  const settings: unknown = journal.sets[SYNC_SETTINGS];
  if (settings === undefined) return journal;
  const parsed: StoredSettingsParseResult = parseStoredSettings(settings);
  const sets: Record<string, unknown> = { ...journal.sets };
  if (parsed.valid) sets[SYNC_SETTINGS] = settingsForSync(parsed.settings);
  else delete sets[SYNC_SETTINGS];
  return { ...journal, sets };
}

function journalEmpty(journal: SyncJournal): boolean {
  return Object.keys(journal.sets).length === 0 && journal.removes.length === 0;
}

function parseFirstSyncPublication(value: unknown): FirstSyncPublicationCheckpoint | null {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'phase', 'publication']) ||
    value.version !== 1 ||
    (value.phase !== 'publishing' && value.phase !== 'remote-complete')
  ) {
    throw new Error('invalid first Sync publication checkpoint');
  }
  const publication: SyncJournal = parseJournal(value.publication, false);
  const removals: Set<string> = new Set();
  for (const [key, item] of Object.entries(publication.sets)) {
    if (!isFocusLockSyncKey(key) || !isAuthoritativeSyncItem(key, item)) {
      throw new Error('invalid first Sync publication checkpoint');
    }
    assertSyncItemWithinQuota(key, item);
  }
  for (const key of publication.removes) {
    if (removals.has(key) || Object.hasOwn(publication.sets, key) || !isFocusLockSyncKey(key)) {
      throw new Error('invalid first Sync publication checkpoint');
    }
    removals.add(key);
  }
  return {
    version: 1,
    phase: value.phase,
    publication,
  };
}

function publicationWithPriorAuthority(current: SyncJournal, prior: SyncJournal): SyncJournal {
  const setKeys: Set<string> = new Set(Object.keys(current.sets));
  const removes: Set<string> = new Set([...current.removes, ...prior.removes]);
  for (const key of Object.keys(prior.sets)) {
    if (!setKeys.has(key)) removes.add(key);
  }
  return {
    sets: current.sets,
    removes: [...removes]
      .filter((key: string): boolean => !setKeys.has(key))
      .sort((left: string, right: string): number => left.localeCompare(right)),
  };
}

function publicationDelta(current: SyncJournal, prior: SyncJournal): SyncJournal {
  const priorRemovals: Set<string> = new Set(prior.removes);
  return {
    sets: Object.fromEntries(
      Object.entries(current.sets).filter(
        ([key, value]: [string, unknown]): boolean =>
          priorRemovals.has(key) ||
          !Object.hasOwn(prior.sets, key) ||
          !valuesEqual(prior.sets[key], value),
      ),
    ),
    removes: current.removes.filter((key: string): boolean => !priorRemovals.has(key)),
  };
}

function publicationDeltaFromRemote(
  current: SyncJournal,
  remote: Record<string, unknown>,
): SyncJournal {
  return {
    sets: Object.fromEntries(
      Object.entries(current.sets).filter(
        ([key, value]: [string, unknown]): boolean =>
          !Object.hasOwn(remote, key) || !valuesEqual(remote[key], value),
      ),
    ),
    removes: current.removes.filter((key: string): boolean => Object.hasOwn(remote, key)),
  };
}

function setupDataClearState(
  journal: ScopedClearJournal,
  status: 'pending' | 'error',
): SetupState['dataClear'] {
  return journal.scope === 'local-history'
    ? { status, scope: 'local-history', phase: journal.phase }
    : { status, scope: 'synced-policy', phase: journal.phase };
}

/** The Setup projection of an all-data phase, which mirrors the journal the lease holder wrote. */
function allDataSetupState(
  phase: AllDataClearJournalV2['phase'],
  status: 'pending' | 'error',
): SetupState['dataClear'] {
  return { status, scope: 'all', phase };
}

function parsePolicyCommit(value: unknown): PolicyCommit | null {
  if (!isRecord(value) || typeof value.revision !== 'string') return null;
  if (value.source === 'direct' && hasExactKeys(value, ['source', 'revision'])) {
    return { source: 'direct', revision: value.revision };
  }
  if (
    value.source === 'generation' &&
    hasExactKeys(value, ['source', 'id', 'revision']) &&
    typeof value.id === 'string'
  ) {
    return { source: 'generation', id: value.id, revision: value.revision };
  }
  return null;
}

function policyRevision(snapshot: PolicySnapshot): string {
  return `policy-v1:${serialized(snapshot)}`;
}

/**
 * `dataClearPorts` is optional only until Main binds it in the wiring slice. Every all-data entry
 * point refuses to run without it, so no phase can write the journal outside the shared lease.
 */
export function createPolicyStorage(
  local: chrome.storage.StorageArea,
  sync: chrome.storage.SyncStorageArea,
  firstSyncCheckpoint: FirstSyncCheckpointSource,
  allDataClearBarrier: AllDataClearBarrier,
  dataClearPorts?: PolicyStorageDataClearPorts,
): PolicyStorage {
  let initialized: boolean = false;
  let mode: StorageMode | null = null;
  let operationQueue: Promise<void> = Promise.resolve();
  let publisher: SyncWriter | null = null;
  let firstCheckpointComplete: boolean = false;
  let firstSyncPublication: FirstSyncPublicationCheckpoint | null = null;
  let setupCache: SetupState | null = null;
  let allDataClearBarrierHeld = false;
  let allDataClearQuiescenceRequired = false;
  const completedAllDataClear = false;
  const echoes: SyncEchoes = new SyncEchoes();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const requested: Promise<T> = operationQueue.then(operation);
    operationQueue = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    return requested;
  }

  function runAllDataClearExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const requested: Promise<T> = allDataClearBarrier.runExclusive(
      async (): Promise<T> => {
        allDataClearBarrierHeld = true;
        try {
          return await operation();
        } finally {
          allDataClearBarrierHeld = false;
        }
      },
      (): boolean => allDataClearQuiescenceRequired,
    );
    return requested.finally((): void => {
      allDataClearQuiescenceRequired = false;
    });
  }

  async function previousValues(keys: readonly string[]): Promise<PreviousValues> {
    const existing: Record<string, unknown> = await local.get([...keys]);
    return {
      existing,
      missing: keys.filter((key: string): boolean => !Object.hasOwn(existing, key)),
    };
  }

  async function restore(previous: PreviousValues): Promise<void> {
    if (previous.missing.length > 0) await local.remove(previous.missing);
    if (Object.keys(previous.existing).length > 0) await local.set(previous.existing);
  }

  async function verifiedWrite(items: Record<string, unknown>, label: string): Promise<void> {
    const nextSetup: unknown = items[LOCAL_SETUP];
    if (Object.hasOwn(items, LOCAL_SETUP) && !isSetupState(nextSetup)) {
      throw new Error('invalid setup state write');
    }
    const keys: string[] = Object.keys(items);
    const previous: PreviousValues = await previousValues(keys);
    try {
      await local.set(structuredClone(items));
      const verified: Record<string, unknown> = await local.get(keys);
      if (!valuesEqual(verified, items)) throw new Error(`could not verify local ${label}`);
      if (isSetupState(nextSetup)) setupCache = structuredClone(nextSetup);
    } catch (error: unknown) {
      try {
        await restore(previous);
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], `could not roll back local ${label}`);
      }
      throw error;
    }
  }

  async function verifiedRemove(keys: readonly string[], label: string): Promise<void> {
    if (keys.length === 0) return;
    const previous: PreviousValues = await previousValues(keys);
    try {
      await local.remove([...keys]);
      const verified: Record<string, unknown> = await local.get([...keys]);
      if (Object.keys(verified).length > 0) throw new Error(`could not verify local ${label}`);
    } catch (error: unknown) {
      try {
        await restore(previous);
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], `could not roll back local ${label}`);
      }
      throw error;
    }
  }

  async function loadFirstSyncPublication(): Promise<FirstSyncPublicationCheckpoint | null> {
    const stored: Record<string, unknown> = await local.get(LOCAL_FIRST_SYNC_PUBLICATION);
    return parseFirstSyncPublication(stored[LOCAL_FIRST_SYNC_PUBLICATION]);
  }

  async function persistFirstSyncPublication(
    checkpoint: FirstSyncPublicationCheckpoint,
  ): Promise<void> {
    await verifiedWrite(
      { [LOCAL_FIRST_SYNC_PUBLICATION]: checkpoint },
      'first Sync publication checkpoint',
    );
    firstSyncPublication = structuredClone(checkpoint);
  }

  async function removeFirstSyncPublication(): Promise<void> {
    await verifiedRemove([LOCAL_FIRST_SYNC_PUBLICATION], 'first Sync publication checkpoint');
    firstSyncPublication = null;
  }

  async function markFirstSyncRemoteComplete(): Promise<void> {
    if (firstSyncPublication?.phase !== 'publishing') return;
    await persistFirstSyncPublication({
      ...firstSyncPublication,
      phase: 'remote-complete',
    });
  }

  async function loadSetupInternal(): Promise<SetupState> {
    const stored: Record<string, unknown> = await local.get(LOCAL_SETUP);
    if (!Object.hasOwn(stored, LOCAL_SETUP)) {
      setupCache = structuredClone(DEFAULT_SETUP);
      return structuredClone(setupCache);
    }
    const value: unknown = stored[LOCAL_SETUP];
    if (!isSetupState(value)) throw new Error('invalid local setup state');
    setupCache = structuredClone(value);
    return structuredClone(setupCache);
  }

  async function saveSetupInternal(next: SetupState): Promise<void> {
    if (!isSetupState(next)) throw new Error('invalid setup state');
    await verifiedWrite({ [LOCAL_SETUP]: next }, 'setup state');
    mode = next.storageMode;
  }

  async function loadBlockedAggregatePublications(): Promise<BlockedAggregatePublications> {
    const stored: Record<string, unknown> = await local.get(LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS);
    return parseBlockedAggregatePublications(stored[LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]);
  }

  async function persistPublicationJournalState(
    journal: SyncJournal,
    additionalItems: Record<string, unknown> = {},
  ): Promise<void> {
    journal = journalForSync(journal);
    const setup: SetupState = await loadSetupInternal();
    const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
    const hasBlocked: boolean = !blockedAggregatePublicationsEmpty(blocked);
    const cleanupReadPending: boolean = (await loadScheduleCleanupRead()) !== null;
    const empty: boolean = journalEmpty(journal);
    await verifiedWrite(
      {
        ...additionalItems,
        [LOCAL_SYNC_JOURNAL]: journal,
        ...(empty && mode === 'sync' ? { [LOCAL_AGGREGATE_TOMBSTONES]: [] } : {}),
        [LOCAL_SETUP]: {
          ...setup,
          syncWriteStatus: hasBlocked || cleanupReadPending ? 'error' : empty ? 'idle' : 'pending',
          storageError:
            hasBlocked || cleanupReadPending
              ? 'sync-publish-failed'
              : empty && setup.storageError === 'sync-publish-failed'
                ? null
                : setup.storageError,
        },
      },
      'sync publication journal',
    );
  }

  async function persistPublicationJournal(journal: SyncJournal): Promise<void> {
    await persistPublicationJournalState(journal);
  }

  async function persistDataClearJournal(
    journal: ScopedClearJournal,
    status: 'pending' | 'error',
    storageError: SetupState['storageError'],
  ): Promise<void> {
    const setup: SetupState = await loadSetupInternal();
    const dataClear: SetupState['dataClear'] = setupDataClearState(journal, status);
    const effectiveStorageError: SetupState['storageError'] =
      journal.scope === 'local-history'
        ? status === 'error'
          ? 'local-clear-failed'
          : journal.priorStorageError
        : storageError;
    await verifiedWrite(
      {
        [LOCAL_DATA_CLEAR_JOURNAL]: journal,
        [LOCAL_SETUP]: {
          ...setup,
          syncWriteStatus:
            journal.scope === 'local-history' && journal.priorStorageError === 'sync-publish-failed'
              ? 'error'
              : status === 'error' && journal.scope !== 'local-history'
                ? 'error'
                : setup.syncWriteStatus,
          storageError: effectiveStorageError,
          dataClear,
        },
      },
      'data clear journal',
    );
  }

  async function loadSnapshotInternal(): Promise<PolicySnapshot> {
    const pointerStored: Record<string, unknown> = await local.get(LOCAL_POLICY_COMMIT);
    const pointer: PolicyCommit | null = parsePolicyCommit(pointerStored[LOCAL_POLICY_COMMIT]);
    if (pointer?.source === 'generation') {
      const generationKey: string = `${LOCAL_POLICY_GENERATION_PREFIX}${pointer.id}`;
      const generationStored: Record<string, unknown> = await local.get(generationKey);
      const generation: unknown = generationStored[generationKey];
      if (
        !isRecord(generation) ||
        generation.id !== pointer.id ||
        generation.revision !== pointer.revision ||
        !isRecord(generation.policy)
      ) {
        throw new Error('committed policy generation is missing or invalid');
      }
      return parsePolicySnapshot(generation.policy);
    }
    const stored: Record<string, unknown> = await local.get([...POLICY_LOCAL_KEYS]);
    const storedSettings: unknown = stored[LOCAL_SETTINGS];
    const lists: unknown = stored[LOCAL_LISTS];
    const bank: unknown = stored[LOCAL_BANK];
    const streak: unknown = stored[LOCAL_STREAK];
    const settings: Settings =
      storedSettings === undefined ? DEFAULT_SETTINGS : readStoredSettingsPolicy(storedSettings);
    if (lists !== undefined) assertPolicyValue('lists', lists);
    if (bank !== undefined) assertPolicyValue('bank', bank);
    if (streak !== undefined) assertPolicyValue('streak', streak);
    return parsePolicySnapshot({
      settings,
      lists: lists === undefined ? DEFAULT_LISTS : lists,
      bank: bank === undefined ? { balanceMs: 0 } : bank,
      streak: streak === undefined ? null : streak,
    });
  }

  async function fullPublication(
    snapshot: PolicySnapshot,
    aggregateItems: Record<string, unknown> = {},
  ): Promise<SyncJournal> {
    const settings: Settings = settingsForSync(snapshot.settings);
    assertSyncItemWithinQuota(SYNC_SETTINGS, settings);
    assertSyncItemWithinQuota(SYNC_BANK, snapshot.bank);
    if (snapshot.streak !== null) assertSyncItemWithinQuota(SYNC_STREAK, snapshot.streak);
    const lists: ListsSyncEncoding = await encodeListsForSync(snapshot.lists);
    const normalizedAggregates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(aggregateItems)) {
      if (POLICY_SYNC_KEYS.includes(key)) {
        throw new Error(`first sync checkpoint item ${JSON.stringify(key)} collides with policy`);
      }
      if (!isAuthoritativeSyncItem(key, value)) {
        throw new Error(`invalid first sync checkpoint item ${JSON.stringify(key)}`);
      }
      const normalized: unknown = isAggregateHistoryKey(key)
        ? normalizeAggregateItem(key, value)
        : structuredClone(value);
      assertSyncItemWithinQuota(key, normalized);
      normalizedAggregates[key] = normalized;
    }
    const tombstoneStored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
    const aggregateRemoves: string[] = parseAggregateTombstones(
      tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES],
    );
    for (const key of aggregateRemoves) delete normalizedAggregates[key];
    return {
      sets: {
        [SYNC_SETTINGS]: settings,
        ...lists.sets,
        [SYNC_BANK]: snapshot.bank,
        ...(snapshot.streak === null ? {} : { [SYNC_STREAK]: snapshot.streak }),
        ...normalizedAggregates,
      },
      removes: [
        ...lists.removes,
        ...(snapshot.streak === null ? [SYNC_STREAK] : []),
        ...aggregateRemoves,
      ],
    };
  }

  async function loadedJournal(key: string, removalOnly: boolean): Promise<SyncJournal> {
    const stored: Record<string, unknown> = await local.get(key);
    return parseJournal(stored[key], removalOnly);
  }

  async function createPublisher(initial: SyncJournal): Promise<SyncWriter> {
    const projected: SyncJournal = journalForSync(initial);
    if (!valuesEqual(projected, initial)) await persistPublicationJournal(projected);
    initial = projected;
    const writer: SyncWriter = new SyncWriter(
      SYNC_FLUSH_MS,
      (items: Record<string, unknown>): Promise<void> =>
        setSyncItemsWithinQuota(
          Object.fromEntries(
            Object.entries(items).map(([key, value]: [string, unknown]): [string, unknown] => {
              const outgoing: unknown =
                key === SYNC_SETTINGS ? settingsForSync(readStoredSettingsPolicy(value)) : value;
              echoes.remember(key, outgoing);
              return [key, outgoing];
            }),
          ),
          sync,
          local,
        ),
      (keys: string[]): Promise<void> => {
        for (const key of keys) echoes.rememberRemoval(key);
        return removeSyncItems(keys, sync, local);
      },
      {
        initial,
        persist: persistPublicationJournal,
        onRemoteCommit: markFirstSyncRemoteComplete,
        onFlushError: async (): Promise<void> => {
          const setup: SetupState = await loadSetupInternal();
          await saveSetupInternal({
            ...setup,
            syncWriteStatus: 'error',
            storageError: 'sync-publish-failed',
          });
        },
      },
    );
    if (mode !== 'sync') await writer.pause();
    return writer;
  }

  async function ensurePublisher(initial?: SyncJournal): Promise<SyncWriter> {
    if (publisher !== null) return publisher;
    const journal: SyncJournal = initial ?? (await loadedJournal(LOCAL_SYNC_JOURNAL, false));
    publisher = await createPublisher(journal);
    return publisher;
  }

  async function reconstructPendingOutbox(
    setup: SetupState,
    throwQuotaError: boolean = false,
  ): Promise<void> {
    if (setup.syncWriteStatus === 'idle') return;
    try {
      const persisted: SyncJournal = sanitizeSyncJournal(
        journalForSync(await loadedJournal(LOCAL_SYNC_JOURNAL, false)),
      ).journal;
      if (firstSyncPublication !== null && setup.storageMode !== 'sync') {
        await persistPublicationJournal(persisted);
        await ensurePublisher(persisted);
        return;
      }
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      const aggregateItems: Record<string, unknown> =
        await firstSyncCheckpoint.loadAggregateItems();
      let blockedChanged: boolean = false;
      for (const key of Object.keys(blocked.items)) {
        if (!Object.hasOwn(aggregateItems, key)) {
          delete blocked.items[key];
          blockedChanged = true;
          continue;
        }
        const current: unknown = normalizeAggregateItem(key, aggregateItems[key]);
        if (!valuesEqual(current, blocked.items[key])) {
          delete blocked.items[key];
          blockedChanged = true;
          continue;
        }
        try {
          assertSyncItemWithinQuota(key, current);
          delete blocked.items[key];
          blockedChanged = true;
        } catch (error: unknown) {
          if (!(error instanceof SyncQuotaError)) throw error;
          delete aggregateItems[key];
        }
      }
      for (const [key, value] of Object.entries(aggregateItems)) {
        if (!isAggregateHistoryKey(key)) continue;
        const normalized: unknown = normalizeAggregateItem(key, value);
        try {
          assertSyncItemWithinQuota(key, normalized);
        } catch (error: unknown) {
          if (!(error instanceof SyncQuotaError)) throw error;
          blocked.items[key] = normalized;
          delete aggregateItems[key];
          blockedChanged = true;
        }
      }
      if (blockedChanged) {
        const current: SetupState = await loadSetupInternal();
        const hasBlocked: boolean = !blockedAggregatePublicationsEmpty(blocked);
        await verifiedWrite(
          {
            [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
            ...(hasBlocked
              ? {
                  [LOCAL_SETUP]: {
                    ...current,
                    syncWriteStatus: 'error',
                    storageError: 'sync-publish-failed',
                  },
                }
              : {}),
          },
          'reconstructed blocked aggregate publications',
        );
      }
      const complete: SyncJournal = await fullPublication(
        await loadSnapshotInternal(),
        aggregateItems,
      );
      for (const [key, value] of Object.entries(persisted.sets)) {
        if (Object.hasOwn(blocked.items, key)) continue;
        if (!POLICY_SYNC_KEYS.includes(key) && isAuthoritativeSyncItem(key, value)) {
          const normalized: unknown = isAggregateHistoryKey(key)
            ? normalizeAggregateItem(key, value)
            : structuredClone(value);
          assertSyncItemWithinQuota(key, normalized);
          complete.sets[key] = normalized;
        }
      }
      for (const key of persisted.removes) {
        if (Object.hasOwn(blocked.items, key)) continue;
        if (!POLICY_SYNC_KEYS.includes(key) && isFocusLockSyncKey(key)) {
          complete.removes.push(key);
          delete complete.sets[key];
        }
      }
      for (const key of Object.keys(blocked.items)) delete complete.sets[key];
      complete.removes = [...new Set(complete.removes)].filter(
        (key: string): boolean => !Object.hasOwn(blocked.items, key),
      );
      const normalizedLocal: Record<string, unknown> = normalizedAggregateItems(complete.sets);
      if (Object.keys(normalizedLocal).length > 0) {
        await verifiedWrite(normalizedLocal, 'normalized pending aggregate authority');
      }
      await persistPublicationJournal(complete);
      const writer: SyncWriter = await ensurePublisher(complete);
      if (setup.storageMode === 'sync') writer.resume();
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      if (setup.storageMode === 'sync' && (throwQuotaError || !(error instanceof SyncQuotaError))) {
        throw error;
      }
    }
  }

  /**
   * The shared parser returns null for both an absent and an unusable value, and a stored value no
   * parser accepts is a durable fault rather than an empty journal, so absence is checked first.
   */
  async function loadDataClearJournal(): Promise<StoredClearJournal | null> {
    const stored: Record<string, unknown> = await local.get(LOCAL_DATA_CLEAR_JOURNAL);
    if (!Object.hasOwn(stored, LOCAL_DATA_CLEAR_JOURNAL)) return null;
    const journal: StoredClearJournal | null = parseDataClearJournal(
      stored[LOCAL_DATA_CLEAR_JOURNAL],
    );
    if (journal === null) throw new Error('invalid data clear journal');
    return journal;
  }

  /**
   * The boot's own read of the journal. A stored value no parser accepts stops initialization, and
   * that rejection is the only trace the fault leaves: it reaches whoever awaited `initialize`,
   * which for the worker is the message chain's catch, so the log stays empty for a profile whose
   * journal cannot be read. The failure is reported here as well as thrown, which is what routing a
   * parse failure to the dispatcher does for every other reader of this key. The boot still refuses
   * to go on.
   */
  async function reportedDataClearJournalRead(): Promise<StoredClearJournal | null> {
    try {
      return await loadDataClearJournal();
    } catch (error: unknown) {
      dataClearPorts?.reportError(error);
      throw error;
    }
  }

  async function recoverLocalAggregatePrune(): Promise<void> {
    const stored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_PRUNE);
    if (!Object.hasOwn(stored, LOCAL_AGGREGATE_PRUNE)) return;
    const checkpoint: LocalAggregatePruneCheckpoint | null = parseAggregatePrune(
      stored[LOCAL_AGGREGATE_PRUNE],
    );
    if (checkpoint === null) throw new Error('invalid local aggregate prune checkpoint');
    if (Object.keys(checkpoint.set).length > 0) {
      await verifiedWrite(checkpoint.set, 'aggregate prune rollup');
    }
    await verifiedRemove(checkpoint.remove, 'aggregate prune removals');
    await verifiedRemove([LOCAL_AGGREGATE_PRUNE], 'aggregate prune checkpoint cleanup');
  }

  async function recoverAggregateTombstones(): Promise<void> {
    const stored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
    const tombstones: string[] = parseAggregateTombstones(stored[LOCAL_AGGREGATE_TOMBSTONES]);
    await verifiedRemove(tombstones, 'aggregate tombstones');
  }

  async function localAggregateHistoryItems(): Promise<Record<string, unknown>> {
    const stored: Record<string, unknown> = await local.get(null);
    const projected: Record<string, unknown> = Object.fromEntries(
      Object.entries(stored).filter(([key]: [string, unknown]): boolean =>
        isAggregateHistoryKey(key),
      ),
    );
    const checkpoint: LocalAggregatePruneCheckpoint | null = parseAggregatePrune(
      stored[LOCAL_AGGREGATE_PRUNE],
    );
    if (checkpoint !== null) {
      for (const key of checkpoint.remove) delete projected[key];
      Object.assign(projected, checkpoint.set);
    }
    for (const key of parseAggregateTombstones(stored[LOCAL_AGGREGATE_TOMBSTONES])) {
      delete projected[key];
    }
    return projected;
  }

  async function initializeInternal(): Promise<void> {
    if (initialized) return;
    await recoverLocalAggregatePrune();
    await recoverAggregateTombstones();
    const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
    let setup: SetupState = await loadSetupInternal();
    mode = setup.storageMode;
    firstSyncPublication = await loadFirstSyncPublication();
    const dataClearJournal: StoredClearJournal | null = await reportedDataClearJournalRead();
    if (dataClearJournal !== null) {
      if (dataClearJournal.scope === 'all') {
        if (!allDataClearBarrierHeld) {
          throw new Error('all-data clear recovery requires the runtime mutation barrier');
        }
        // Every all-data phase now runs under the shared deletion lease, which boot does not hold.
        // Initialization only quiesces the worker and leaves the journal to its dispatcher.
        allDataClearQuiescenceRequired = true;
        initialized = true;
        return;
      }
      try {
        await resumeDataClear(dataClearJournal);
      } catch (_error: unknown) {
        const currentJournal: ScopedClearJournal =
          scopedClearJournal(await loadDataClearJournal()) ?? dataClearJournal;
        const failedSetup: SetupState = await loadSetupInternal();
        const failedDataClear: SetupState['dataClear'] = setupDataClearState(
          currentJournal,
          'error',
        );
        await saveSetupInternal({
          ...failedSetup,
          dataClear: failedDataClear,
          storageError:
            currentJournal.phase === 'remote' ? 'remote-deletion-failed' : 'local-clear-failed',
        });
        initialized = true;
        mode = (await loadSetupInternal()).storageMode;
        return;
      }
      initialized = true;
      return;
    }
    if (setup.storageMode === 'sync' && firstSyncPublication !== null) {
      if (firstSyncPublication.phase !== 'remote-complete') {
        throw new Error('incomplete first Sync publication cannot own Sync mode');
      }
      await removeFirstSyncPublication();
    }
    if (
      setup.storageMode === 'sync' &&
      setup.syncWriteStatus === 'idle' &&
      !blockedAggregatePublicationsEmpty(blocked)
    ) {
      setup = {
        ...setup,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      };
      await saveSetupInternal(setup);
    }
    const pointerStored: Record<string, unknown> = await local.get(LOCAL_POLICY_COMMIT);
    const pointer: PolicyCommit | null = parsePolicyCommit(pointerStored[LOCAL_POLICY_COMMIT]);
    if (pointer?.source === 'generation') {
      const record: PolicyGenerationRecord = await generationRecord(pointer);
      if (!setup.legacyImported) {
        setup = {
          ...setup,
          storageMode: null,
          syncWriteStatus: journalEmpty(record.journal) ? 'idle' : 'pending',
          legacyImported: true,
          storageError: null,
        };
        await verifiedWrite(
          {
            [LOCAL_SYNC_JOURNAL]: journalForSync(record.journal),
            [LOCAL_SETUP]: setup,
          },
          'repaired committed legacy migration',
        );
        mode = null;
      }
      await cleanupGeneration(record);
      await cleanupStaleGenerations();
    } else if (pointer?.source === 'direct' && setup.legacyImported) {
      await cleanupStaleGenerations();
    }
    await repairStoredSettingsShape();
    if (setup.storageMode === 'sync') {
      firstCheckpointComplete = true;
      const cleanupRead: ScheduleCleanupReadCheckpoint | null = await loadScheduleCleanupRead();
      if (setup.syncWriteStatus === 'idle' || cleanupRead?.reconstructPublication === false) {
        await ensurePublisher();
      } else await reconstructPendingOutbox(setup);
      await cleanRemoteScheduleIntentions(false);
      initialized = true;
      return;
    }
    if (setup.syncWriteStatus !== 'idle') await reconstructPendingOutbox(setup);
    initialized = true;
  }

  async function loadScheduleCleanupRead(): Promise<ScheduleCleanupReadCheckpoint | null> {
    const stored: Record<string, unknown> = await local.get(LOCAL_SCHEDULE_CLEANUP_READ);
    const value: unknown = stored[LOCAL_SCHEDULE_CLEANUP_READ];
    if (value === undefined) return null;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['reconstructPublication']) ||
      typeof value.reconstructPublication !== 'boolean'
    ) {
      throw new Error('invalid schedule intention cleanup checkpoint');
    }
    return { reconstructPublication: value.reconstructPublication };
  }

  /** Include this promotion in the same verified write as the authority it must recover. */
  async function publicationRecoveryItems(): Promise<Record<string, unknown>> {
    if (mode !== 'sync') return {};
    const checkpoint: ScheduleCleanupReadCheckpoint | null = await loadScheduleCleanupRead();
    return checkpoint !== null && !checkpoint.reconstructPublication
      ? { [LOCAL_SCHEDULE_CLEANUP_READ]: { reconstructPublication: true } }
      : {};
  }

  async function cleanRemoteScheduleIntentions(throwReadError: boolean): Promise<void> {
    const checkpoint: ScheduleCleanupReadCheckpoint | null = await loadScheduleCleanupRead();
    let remote: Record<string, unknown>;
    try {
      remote = await sync.get(SYNC_SETTINGS);
    } catch (error: unknown) {
      const setup: SetupState = await loadSetupInternal();
      await verifiedWrite(
        {
          [LOCAL_SCHEDULE_CLEANUP_READ]: checkpoint ?? {
            reconstructPublication: setup.syncWriteStatus !== 'idle',
          },
          [LOCAL_SETUP]: {
            ...setup,
            syncWriteStatus: 'error',
            storageError: 'sync-publish-failed',
          },
        },
        'pending schedule intention cleanup read',
      );
      if (throwReadError) throw error;
      return;
    }
    const writer: SyncWriter = await ensurePublisher();
    if (hasScheduleIntentions(remote[SYNC_SETTINGS]) && !writer.hasPending(SYNC_SETTINGS)) {
      const parsed: StoredSettingsParseResult = parseStoredSettings(remote[SYNC_SETTINGS]);
      const settings: Settings = parsed.valid
        ? parsed.settings
        : (await loadSnapshotInternal()).settings;
      await queuePolicyInternal('settings', settings);
    }
    if (checkpoint !== null) {
      await verifiedRemove(
        [LOCAL_SCHEDULE_CLEANUP_READ],
        'completed schedule intention cleanup read',
      );
      await writer.whenJournalDurable();
    }
  }

  /**
   * Rewrites settings stored in a v1 shape as the canonical record, once. Runs after a committed
   * generation has been materialised, so the settings it sees are either canonical already or the
   * direct-authority record a v1 install left behind. A direct commit revision embeds the
   * settings JSON, so it is recomputed from the migrated snapshot in the same write: the two keys
   * stay consistent even when the worker dies between them. Runs before the Sync outbox is
   * reconstructed, so a republication carries the canonical record. The rewritten value parses
   * as canonical, which is what makes the next `initialize()` skip this. A Sync profile whose
   * status is idle keeps the v1 record in the remote area until its next settings edit: every
   * reader of that record is lenient, and the design promises convergence on the error path only.
   */
  async function repairStoredSettingsShape(): Promise<void> {
    const stored: Record<string, unknown> = await local.get(LOCAL_SETTINGS);
    if (!Object.hasOwn(stored, LOCAL_SETTINGS)) return;
    const parsed: StoredSettingsParseResult = parseStoredSettings(
      stored[LOCAL_SETTINGS],
      DEFAULT_SETTINGS,
    );
    if (!parsed.valid || !parsed.legacy) return;
    let snapshot: PolicySnapshot;
    try {
      snapshot = await loadSnapshotInternal();
    } catch (_error: unknown) {
      // Another policy record is invalid. The next loadSnapshot() reports the same error, and
      // leaving the settings alone keeps initialize(), and every recovery entry behind it, open.
      return;
    }
    const pointerStored: Record<string, unknown> = await local.get(LOCAL_POLICY_COMMIT);
    const pointer: PolicyCommit | null = parsePolicyCommit(pointerStored[LOCAL_POLICY_COMMIT]);
    const items: Record<string, unknown> = { [LOCAL_SETTINGS]: snapshot.settings };
    if (pointer?.source === 'direct') {
      items[LOCAL_POLICY_COMMIT] = { source: 'direct', revision: policyRevision(snapshot) };
    }
    await verifiedWrite(items, 'migrated settings policy shape');
  }

  async function ensureInitialized(): Promise<void> {
    if (!initialized) await initializeInternal();
  }

  async function queuePolicyInternal(key: keyof PolicyValueByKey, value: unknown): Promise<void> {
    if (key === 'lists') {
      if (!isListsConfig(value)) throw new Error('invalid lists policy');
      const encoding: ListsSyncEncoding = await encodeListsForSync(value);
      const writer: SyncWriter = await ensurePublisher();
      for (const [listKey, listValue] of Object.entries(encoding.sets)) {
        writer.queue(listKey, listValue);
      }
      for (const listKey of encoding.removes) writer.remove(listKey);
      await writer.whenJournalDurable();
      return;
    }
    const writer: SyncWriter = await ensurePublisher();
    const remoteKey: string = syncKey(key);
    if (value === null) writer.remove(remoteKey);
    else
      writer.queue(
        remoteKey,
        key === 'settings' ? settingsForSync(readStoredSettingsPolicy(value)) : value,
      );
    await writer.whenJournalDurable();
  }

  async function queueVerifiedRemoteCorrectionsInternal(
    keys: readonly (keyof PolicyValueByKey)[],
  ): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
    if (mode !== 'sync' || setup.dataClear.status !== 'idle') return;
    const unique: Set<keyof PolicyValueByKey> = new Set();
    for (const key of keys) {
      if (!isPolicyKey(key)) throw new Error('invalid corrective policy key');
      unique.add(key);
    }
    if (unique.size === 0) return;
    const snapshot: PolicySnapshot = await loadSnapshotInternal();
    try {
      await verifiedWrite(
        {
          ...(await publicationRecoveryItems()),
          [LOCAL_SETUP]: { ...setup, syncWriteStatus: 'pending' },
        },
        'corrective publication intent',
      );
      for (const key of unique) await queuePolicyInternal(key, snapshot[key]);
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    }
  }

  async function setPolicyInternal(key: unknown, value: unknown): Promise<void> {
    await ensureInitialized();
    if (!isPolicyKey(key)) throw new Error('invalid policy key');
    assertPolicyValue(key, value);
    if (mode !== 'sync') {
      await verifiedWrite({ [localKey(key)]: value }, `${key} policy`);
      return;
    }
    const setup: SetupState = await loadSetupInternal();
    await verifiedWrite(
      {
        [localKey(key)]: value,
        ...(await publicationRecoveryItems()),
        [LOCAL_SETUP]: { ...setup, syncWriteStatus: 'pending' },
      },
      `${key} policy and pending sync status`,
    );
    try {
      await queuePolicyInternal(key, value);
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    }
  }

  async function buildFirstSyncPublication(
    checkpoint: FirstSyncPublicationCheckpoint | null,
  ): Promise<SyncJournal> {
    const aggregateItems: Record<string, unknown> = await firstSyncCheckpoint.loadAggregateItems();
    let complete: SyncJournal = await fullPublication(await loadSnapshotInternal(), aggregateItems);
    if (checkpoint === null) {
      const deviceStored: Record<string, unknown> = await local.get(LOCAL_DEVICE_ID);
      const deviceId: unknown = deviceStored[LOCAL_DEVICE_ID];
      if (typeof deviceId === 'string' && deviceId !== '') {
        const remote: Record<string, unknown> = await sync.get(null);
        for (const key of Object.keys(remote)) {
          if (
            aggregateHistoryDeviceId(key) === deviceId &&
            !Object.hasOwn(complete.sets, key) &&
            !complete.removes.includes(key)
          ) {
            complete.removes.push(key);
          }
        }
      }
    } else {
      complete = publicationWithPriorAuthority(complete, checkpoint.publication);
    }
    const normalizedLocal: Record<string, unknown> = normalizedAggregateItems(complete.sets);
    if (Object.keys(normalizedLocal).length > 0) {
      await verifiedWrite(normalizedLocal, 'normalized first sync aggregate authority');
    }
    return complete;
  }

  async function firstSyncPublicationDelta(
    complete: SyncJournal,
    checkpoint: FirstSyncPublicationCheckpoint | null,
  ): Promise<SyncJournal> {
    if (checkpoint === null) return complete;
    if (checkpoint.phase === 'remote-complete') {
      return publicationDelta(complete, checkpoint.publication);
    }
    return publicationDeltaFromRemote(complete, await sync.get(null));
  }

  async function persistFirstSyncAttempt(
    complete: SyncJournal,
    pending: SyncJournal,
  ): Promise<void> {
    const setup: SetupState = await loadSetupInternal();
    const checkpoint: FirstSyncPublicationCheckpoint = {
      version: 1,
      phase: 'publishing',
      publication: complete,
    };
    await verifiedWrite(
      {
        [LOCAL_FIRST_SYNC_PUBLICATION]: checkpoint,
        [LOCAL_SYNC_JOURNAL]: pending,
        [LOCAL_SETUP]: { ...setup, syncWriteStatus: 'pending' },
      },
      'first Sync publication attempt',
    );
    firstSyncPublication = structuredClone(checkpoint);
  }

  async function finishFirstSyncPublication(writer: SyncWriter): Promise<void> {
    if (firstSyncPublication?.phase !== 'remote-complete') {
      throw new Error('first Sync publication is not durably complete');
    }
    const completedSetup: SetupState = await loadSetupInternal();
    const syncedSetup: SetupState = {
      ...completedSetup,
      storageMode: 'sync',
      syncWriteStatus: 'idle',
      storageError: null,
    };
    if (!isSetupState(syncedSetup)) throw new Error('invalid setup state');
    await verifiedWrite(
      {
        [LOCAL_SETUP]: syncedSetup,
        [LOCAL_AGGREGATE_TOMBSTONES]: [],
      },
      'sync mode and published aggregate tombstones',
    );
    mode = 'sync';
    firstCheckpointComplete = true;
    publisher = writer;
    writer.resume();
    await removeFirstSyncPublication();
  }

  async function enableSyncInternal(): Promise<void> {
    await ensureInitialized();
    const setupBeforeEnable: SetupState = await loadSetupInternal();
    if (setupBeforeEnable.dataClear.status !== 'idle') {
      throw new Error('finish the pending data deletion before enabling Sync');
    }
    if (mode === 'sync') {
      if (firstSyncPublication !== null) await removeFirstSyncPublication();
      return;
    }
    const priorMode: StorageMode | null = mode;
    let complete: SyncJournal;
    let pending: SyncJournal;
    try {
      complete = await buildFirstSyncPublication(firstSyncPublication);
      pending = await firstSyncPublicationDelta(complete, firstSyncPublication);
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    }
    try {
      const writer: SyncWriter = await ensurePublisher(pending);
      await writer.pause();
      const alreadyComplete: boolean =
        firstSyncPublication?.phase === 'remote-complete' && journalEmpty(pending);
      if (!alreadyComplete) {
        await persistFirstSyncAttempt(complete, pending);
      }
      await writer.transformPending(
        (): Promise<void> => Promise.resolve(),
        (): SyncJournal => pending,
      );
      if (!alreadyComplete) {
        if (journalEmpty(pending)) {
          await markFirstSyncRemoteComplete();
        } else {
          writer.resume();
          await writer.flushNow();
        }
      }
      await finishFirstSyncPublication(writer);
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      if (current.storageMode === 'sync') {
        mode = 'sync';
        firstCheckpointComplete = true;
        publisher?.resume();
        throw error;
      }
      mode = priorMode;
      if (publisher !== null) await publisher.pause();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    }
  }

  async function retrySyncInternal(): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
    if (mode !== 'sync' || setup.storageMode !== 'sync') {
      throw new Error('Chrome Sync retry requires authoritative Sync mode');
    }
    if (setup.dataClear.status !== 'idle') {
      throw new Error('finish or retry the pending data deletion before retrying Sync');
    }
    const cleanupRead: ScheduleCleanupReadCheckpoint | null = await loadScheduleCleanupRead();
    if (cleanupRead !== null) await cleanRemoteScheduleIntentions(true);
    if (setup.syncWriteStatus === 'idle' && cleanupRead === null) return;
    if (cleanupRead?.reconstructPublication !== false) await reconstructPendingOutbox(setup, true);
    const writer: SyncWriter = await ensurePublisher();
    writer.resume();
    await writer.flushNow();
    await writer.whenJournalDurable();
    const completed: SetupState = await loadSetupInternal();
    if (completed.syncWriteStatus !== 'idle') {
      throw new Error('Chrome Sync retry did not clear the durable pending state');
    }
  }

  async function disableSyncInternal(): Promise<void> {
    await ensureInitialized();
    if (mode !== 'sync' && publisher === null) {
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      if (blockedAggregatePublicationsEmpty(blocked) && firstSyncPublication === null) return;
      const setup: SetupState = await loadSetupInternal();
      await verifiedWrite(
        {
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: emptyBlockedAggregatePublications(),
          [LOCAL_SETUP]: {
            ...setup,
            storageMode: 'local',
            syncWriteStatus: 'idle',
            storageError: setup.storageError === 'sync-publish-failed' ? null : setup.storageError,
          },
        },
        'abandoned local aggregate publications',
      );
      mode = 'local';
      firstCheckpointComplete = false;
      if (firstSyncPublication !== null) await removeFirstSyncPublication();
      return;
    }
    const setup: SetupState = await loadSetupInternal();
    try {
      if (publisher !== null) {
        await publisher.pause();
        await publisher.drain();
      }
      const localSetup: SetupState = {
        ...setup,
        storageMode: 'local',
        syncWriteStatus: 'idle',
        storageError: null,
      };
      await verifiedWrite(
        {
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: emptyBlockedAggregatePublications(),
          [LOCAL_SYNC_JOURNAL]: { sets: {}, removes: [] },
          [LOCAL_SETUP]: localSetup,
        },
        'local mode and abandoned aggregate publications',
      );
      publisher?.discardPendingAfterDurableJournalCommit();
      mode = 'local';
      firstCheckpointComplete = false;
      await verifiedRemove(
        [LOCAL_SCHEDULE_CLEANUP_READ],
        'abandoned schedule intention cleanup read',
      );
      if (firstSyncPublication !== null) await removeFirstSyncPublication();
    } catch (error: unknown) {
      if (mode === 'sync' && publisher !== null) publisher.resume();
      throw error;
    }
  }

  async function selectLocalModeInternal(): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
    if (setup.dataClear.status !== 'idle') {
      throw new Error('finish or retry the pending data deletion before selecting Local storage');
    }
    const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
    let hasPublicationIntent: boolean = true;
    try {
      hasPublicationIntent =
        firstSyncPublication !== null ||
        !journalEmpty(await loadedJournal(LOCAL_SYNC_JOURNAL, false));
    } catch (_error: unknown) {
      // Explicit local selection also abandons a malformed failed-publish journal.
    }
    if (
      mode === 'local' &&
      setup.syncWriteStatus === 'idle' &&
      setup.storageError !== 'sync-publish-failed' &&
      blockedAggregatePublicationsEmpty(blocked) &&
      !hasPublicationIntent
    ) {
      return;
    }
    await disableSyncInternal();
    const current: SetupState = await loadSetupInternal();
    await verifiedWrite(
      {
        [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: emptyBlockedAggregatePublications(),
        [LOCAL_SYNC_JOURNAL]: { sets: {}, removes: [] },
        [LOCAL_SETUP]: {
          ...current,
          storageMode: 'local',
          syncWriteStatus: 'idle',
          storageError:
            current.storageError === 'sync-publish-failed' ? null : current.storageError,
        },
      },
      'local storage selection',
    );
    mode = 'local';
    firstCheckpointComplete = false;
  }

  async function updateSetupInternal(next: Partial<SetupUpdate>): Promise<void> {
    await ensureInitialized();
    const allowed: readonly string[] = [
      'websiteAccess',
      'blockingRegistration',
      'websiteAccessNotice',
    ];
    if (Object.keys(next).some((key: string): boolean => !allowed.includes(key))) {
      throw new Error('invalid setup update');
    }
    const current: SetupState = await loadSetupInternal();
    const updated: SetupState = { ...current, ...next };
    if (!isSetupState(updated)) throw new Error('invalid setup update');
    await saveSetupInternal(updated);
  }

  async function markSetupCompletedInternal(): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
    if (
      setup.storageMode === null ||
      setup.dataClear.status !== 'idle' ||
      (setup.storageMode === 'sync' && !firstCheckpointComplete)
    ) {
      throw new Error('cannot complete setup before storage is ready');
    }
    await saveSetupInternal({ ...setup, completed: true });
  }

  async function mirrorAcceptedRemotePolicyInternal(
    changes: Record<string, unknown>,
    pendingRemoteKeys: readonly string[],
  ): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
    if (mode !== 'sync' || setup.dataClear.status !== 'idle') {
      throw new Error('inbound sync policy is not accepted in the current storage mode');
    }
    const items: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (!isPolicyKey(key)) throw new Error(`invalid inbound policy key ${JSON.stringify(key)}`);
      assertPolicyValue(key, value);
      items[localKey(key)] =
        key === 'settings'
          ? settingsWithLocalIntentions(
              readStoredSettingsPolicy(value),
              (await loadSnapshotInternal()).settings,
            )
          : value;
    }
    if (Object.keys(items).length === 0) return;
    const writer: SyncWriter = await ensurePublisher();
    const reconcileKeys: Set<string> = new Set(pendingRemoteKeys);
    const reconcileSettings: boolean =
      changes.settings !== undefined &&
      (reconcileKeys.has(SYNC_SETTINGS) ||
        writer.hasPending(SYNC_SETTINGS) ||
        hasScheduleIntentions(changes.settings));
    const reconcileLists: boolean =
      changes.lists !== undefined &&
      LIST_SYNC_KEYS.some(
        (key: string): boolean => reconcileKeys.has(key) || writer.hasPending(key),
      );
    const reconcileBank: boolean =
      changes.bank !== undefined && (reconcileKeys.has(SYNC_BANK) || writer.hasPending(SYNC_BANK));
    const reconcileStreak: boolean =
      changes.streak !== undefined &&
      (reconcileKeys.has(SYNC_STREAK) || writer.hasPending(SYNC_STREAK));
    if (!reconcileSettings && !reconcileLists && !reconcileBank && !reconcileStreak) {
      await verifiedWrite(items, 'accepted remote policy');
      return;
    }
    const listsForReconciliation: ListsConfig | null = isListsConfig(changes.lists)
      ? changes.lists
      : null;
    if (reconcileLists && listsForReconciliation === null) {
      throw new Error('invalid lists policy reconciliation');
    }
    const listEncoding: ListsSyncEncoding | null =
      reconcileLists && listsForReconciliation !== null
        ? await encodeListsForSync(listsForReconciliation)
        : null;
    await writer.pause();
    const previous: PreviousValues = await previousValues(Object.keys(items));
    try {
      await verifiedWrite(items, 'accepted remote policy');
      await writer.transformPending(
        (): Promise<undefined> => Promise.resolve(undefined),
        (_prepared: undefined, pending: SyncJournal): SyncJournal => {
          const sets: Record<string, unknown> = { ...pending.sets };
          const removes: Set<string> = new Set(pending.removes);
          const replace = (key: string, value: unknown): void => {
            delete sets[key];
            removes.delete(key);
            if (value === null) removes.add(key);
            else sets[key] = value;
          };
          if (reconcileSettings)
            replace(
              SYNC_SETTINGS,
              settingsForSync(readStoredSettingsPolicy(items[LOCAL_SETTINGS])),
            );
          if (reconcileBank) replace(SYNC_BANK, changes.bank);
          if (reconcileStreak) replace(SYNC_STREAK, changes.streak);
          if (reconcileLists && listEncoding !== null) {
            for (const key of LIST_SYNC_KEYS) {
              delete sets[key];
              removes.delete(key);
            }
            Object.assign(sets, listEncoding.sets);
            for (const key of listEncoding.removes) removes.add(key);
          }
          return { sets, removes: [...removes] };
        },
      );
    } catch (error: unknown) {
      try {
        await restore(previous);
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          'could not roll back accepted remote policy',
        );
      }
      throw error;
    } finally {
      if (mode === 'sync') writer.resume();
    }
  }

  async function generationRecord(
    pointer: Extract<PolicyCommit, { source: 'generation' }>,
  ): Promise<PolicyGenerationRecord> {
    const key: string = `${LOCAL_POLICY_GENERATION_PREFIX}${pointer.id}`;
    const stored: Record<string, unknown> = await local.get(key);
    const value: unknown = stored[key];
    const oldRecordKeys: readonly string[] = ['id', 'revision', 'policy', 'runtime', 'journal'];
    const aggregateRecordKeys: readonly string[] = [
      ...oldRecordKeys,
      'aggregates',
      'aggregateTombstones',
    ];
    if (
      !isRecord(value) ||
      (!hasExactKeys(value, oldRecordKeys) && !hasExactKeys(value, aggregateRecordKeys)) ||
      value.id !== pointer.id ||
      value.revision !== pointer.revision ||
      !isRecord(value.runtime)
    ) {
      throw new Error('committed policy generation is missing or invalid');
    }
    const policy: PolicySnapshot = parsePolicySnapshot(value.policy);
    // A generation written by a v1 install computed its revision over the raw v1 settings, so
    // the pointer is verified against the stored record as well as its migrated reading.
    const rawRevision: string = `policy-v1:${serialized(value.policy)}`;
    if (policyRevision(policy) !== pointer.revision && rawRevision !== pointer.revision) {
      throw new Error('committed policy generation revision does not match');
    }
    const runtimeDate: unknown = value.runtime.date;
    if (typeof runtimeDate !== 'string') {
      throw new Error('committed runtime generation is invalid');
    }
    const runtimeNow: number = new Date(`${runtimeDate}T12:00:00`).getTime();
    if (!Number.isFinite(runtimeNow)) throw new Error('committed runtime generation is invalid');
    const parsedRuntime: ParsedRuntimeState = mergeRuntime(value.runtime, runtimeNow);
    if (!valuesEqual(parsedRuntime, value.runtime)) {
      throw new Error('committed runtime generation is invalid');
    }
    const runtime: LegacyRuntimeStateV1 = migrateRuntimeRules(parsedRuntime, policy.lists);
    const journal: SyncJournal = parseJournal(value.journal, false);
    const hasAggregateAuthority: boolean = value.aggregates !== undefined;
    if (hasAggregateAuthority !== (value.aggregateTombstones !== undefined)) {
      throw new Error('committed aggregate generation is invalid');
    }
    if (hasAggregateAuthority && !isRecord(value.aggregates)) {
      throw new Error('committed aggregate generation is invalid');
    }
    const rawAggregates: Record<string, unknown> = isRecord(value.aggregates)
      ? value.aggregates
      : {};
    const aggregates: Record<string, unknown> = normalizedAggregateItems(rawAggregates);
    if (Object.keys(aggregates).length !== Object.keys(rawAggregates).length) {
      throw new Error('committed aggregate generation is invalid');
    }
    const aggregateTombstones: string[] =
      value.aggregateTombstones === undefined
        ? []
        : parseAggregateTombstones(value.aggregateTombstones);
    if (
      value.aggregateTombstones !== undefined &&
      (!Array.isArray(value.aggregateTombstones) ||
        aggregateTombstones.length !== value.aggregateTombstones.length)
    ) {
      throw new Error('committed aggregate generation is invalid');
    }
    return {
      id: pointer.id,
      revision: pointer.revision,
      policy,
      runtime,
      journal,
      aggregates,
      aggregateTombstones,
    };
  }

  async function cleanupGeneration(record: PolicyGenerationRecord): Promise<void> {
    await verifiedWrite(
      {
        [LOCAL_SETTINGS]: record.policy.settings,
        [LOCAL_LISTS]: record.policy.lists,
        [LOCAL_BANK]: record.policy.bank,
        [LOCAL_STREAK]: record.policy.streak,
        [LOCAL_RUNTIME]: record.runtime,
        ...record.aggregates,
        [LOCAL_AGGREGATE_TOMBSTONES]: record.aggregateTombstones,
      },
      'materialized policy and aggregate generation',
    );
    await verifiedRemove(record.aggregateTombstones, 'legacy aggregate removals');
    // The materialised policy is canonical, so the direct pointer names its revision rather than
    // the one a v1 install computed over the raw record.
    const direct: PolicyCommit = { source: 'direct', revision: policyRevision(record.policy) };
    await verifiedWrite({ [LOCAL_POLICY_COMMIT]: direct }, 'direct policy authority');
    await local.remove(`${LOCAL_POLICY_GENERATION_PREFIX}${record.id}`);
  }

  async function cleanupStaleGenerations(): Promise<void> {
    const stored: Record<string, unknown> = await local.get(null);
    const keys: string[] = Object.keys(stored).filter((key: string): boolean =>
      key.startsWith(LOCAL_POLICY_GENERATION_PREFIX),
    );
    if (keys.length > 0) await local.remove(keys);
  }

  async function importLegacyInternal(
    snapshot: PolicySnapshot,
    runtime: LegacyRuntimeStateV1,
    journal: SyncJournal,
    storedSync: Record<string, unknown>,
  ): Promise<void> {
    await ensureInitialized();
    journal = journalForSync(journal);
    const pointerStored: Record<string, unknown> = await local.get(LOCAL_POLICY_COMMIT);
    const existingPointer: PolicyCommit | null = parsePolicyCommit(
      pointerStored[LOCAL_POLICY_COMMIT],
    );
    let record: PolicyGenerationRecord;
    let authorityCommitted: boolean = existingPointer !== null;
    try {
      if (existingPointer?.source === 'generation') {
        record = await generationRecord(existingPointer);
      } else if (existingPointer?.source === 'direct') {
        const setup: SetupState = await loadSetupInternal();
        if (!setup.legacyImported || setup.storageError !== null) {
          const repairedSetup: SetupState = {
            ...setup,
            storageMode: null,
            syncWriteStatus: journalEmpty(journal) ? 'idle' : 'pending',
            legacyImported: true,
            storageError: null,
          };
          await verifiedWrite(
            {
              [LOCAL_SYNC_JOURNAL]: journal,
              [LOCAL_SETUP]: repairedSetup,
            },
            'repaired legacy setup and publication journal',
          );
          mode = null;
        }
        await cleanupStaleGenerations();
        return;
      } else {
        assertPolicyValue('settings', snapshot.settings);
        assertPolicyValue('lists', snapshot.lists);
        assertPolicyValue('bank', snapshot.bank);
        assertPolicyValue('streak', snapshot.streak);
        const aggregateAuthority: LegacyAggregateAuthority = effectiveLegacyAggregateAuthority(
          storedSync,
          journal,
        );
        const id: string = crypto.randomUUID();
        const revision: string = policyRevision(snapshot);
        record = {
          id,
          revision,
          policy: structuredClone(snapshot),
          runtime: structuredClone(runtime),
          journal: aggregateAuthority.journal,
          aggregates: aggregateAuthority.aggregates,
          aggregateTombstones: aggregateAuthority.tombstones,
        };
        const generationKey: string = `${LOCAL_POLICY_GENERATION_PREFIX}${id}`;
        await verifiedWrite({ [generationKey]: record }, 'legacy policy generation');
        const pointer: PolicyCommit = { source: 'generation', id, revision };
        await verifiedWrite({ [LOCAL_POLICY_COMMIT]: pointer }, 'generation policy authority');
        authorityCommitted = true;
      }
      const setup: SetupState = await loadSetupInternal();
      if (!setup.legacyImported || setup.storageError !== null) {
        const committedJournal: SyncJournal = journalForSync(record.journal);
        const migratedSetup: SetupState = {
          ...setup,
          storageMode: null,
          syncWriteStatus: journalEmpty(committedJournal) ? 'idle' : 'pending',
          legacyImported: true,
          storageError: null,
        };
        await verifiedWrite(
          {
            [LOCAL_SYNC_JOURNAL]: committedJournal,
            [LOCAL_SETUP]: migratedSetup,
          },
          'legacy setup and publication journal',
        );
        mode = null;
      }
      await cleanupGeneration(record);
      await cleanupStaleGenerations();
    } catch (error: unknown) {
      if (!authorityCommitted) {
        const setup: SetupState = await loadSetupInternal();
        await saveSetupInternal({
          ...setup,
          legacyImported: false,
          storageError: 'legacy-migration-failed',
        });
      }
      throw error;
    }
  }

  async function markLegacyRemotePolicyDroppedInternal(): Promise<void> {
    await ensureInitialized();
    const setup: SetupState = await loadSetupInternal();
    if (setup.storageError === 'legacy-remote-policy-dropped') return;
    await saveSetupInternal({ ...setup, storageError: 'legacy-remote-policy-dropped' });
  }

  async function markLegacyMigrationFailedInternal(): Promise<void> {
    await ensureInitialized();
    const pointerStored: Record<string, unknown> = await local.get(LOCAL_POLICY_COMMIT);
    if (parsePolicyCommit(pointerStored[LOCAL_POLICY_COMMIT]) !== null) return;
    const setup: SetupState = await loadSetupInternal();
    await saveSetupInternal({
      ...setup,
      legacyImported: false,
      storageError: 'legacy-migration-failed',
    });
  }

  /** The Sync keys a remote deletion owns: the journal inventory plus every pending publication. */
  async function remoteDeletionKeys(inventory: readonly string[]): Promise<string[]> {
    const publication: SyncJournal = await loadedJournal(LOCAL_SYNC_JOURNAL, false);
    const checkpointPublication: SyncJournal = firstSyncPublication?.publication ?? {
      sets: {},
      removes: [],
    };
    return [
      ...new Set(
        [
          ...inventory,
          ...Object.keys(publication.sets),
          ...publication.removes,
          ...Object.keys(checkpointPublication.sets),
          ...checkpointPublication.removes,
        ].filter(isFocusLockDeletionKey),
      ),
    ].sort();
  }

  async function drainRemotePublication(): Promise<void> {
    if (publisher === null) {
      await persistPublicationJournal({ sets: {}, removes: [] });
      return;
    }
    await publisher.pause();
    await publisher.drain();
    await publisher.transformPending(
      (): Promise<void> => Promise.resolve(),
      (): SyncJournal => ({ sets: {}, removes: [] }),
    );
  }

  /** Verified Sync deletion. It returns only after a pass proves every owned key is gone. */
  async function removeRemoteInventory(
    initialKeys: string[],
    persistInventory: (inventory: string[]) => Promise<void>,
  ): Promise<void> {
    await removeSyncItemsUntilClear(
      { initialKeys, matches: isFocusLockDeletionKey, persistInventory },
      sync,
      local,
    );
    if (firstSyncPublication !== null) await removeFirstSyncPublication();
  }

  async function clearRemotePhase(
    journal: SyncedPolicyClearJournal,
  ): Promise<SyncedPolicyClearJournal> {
    const initialKeys: string[] = await remoteDeletionKeys(journal.inventory);
    const pending: SyncedPolicyClearJournal = { ...journal, inventory: initialKeys };
    await persistDataClearJournal(pending, 'pending', null);
    await drainRemotePublication();
    await removeRemoteInventory(initialKeys, async (inventory: string[]): Promise<void> => {
      await persistDataClearJournal({ ...pending, inventory }, 'pending', null);
    });
    return { ...journal, inventory: [] };
  }

  function isFocusLockLocalKey(key: string): boolean {
    return (
      FOCUS_LOCK_LOCAL_EXACT_KEYS.includes(key) ||
      key.startsWith(LOCAL_POLICY_GENERATION_PREFIX) ||
      key.startsWith('agg:') ||
      key.startsWith('aggm:') ||
      key.startsWith('archive:clock-rebase:')
    );
  }

  /** Only the synced-policy and local-history journals finish here. All-data removal is Engine's. */
  async function finishDataClear(journal: ScopedClearJournal): Promise<void> {
    const setup: SetupState = await loadSetupInternal();
    await saveSetupInternal({
      ...setup,
      syncWriteStatus:
        journal.scope === 'local-history'
          ? journal.priorStorageError === 'sync-publish-failed'
            ? 'error'
            : setup.syncWriteStatus
          : 'idle',
      storageError: journal.scope === 'local-history' ? journal.priorStorageError : null,
      dataClear: { status: 'idle', scope: null, phase: null },
    });
    try {
      await local.remove(LOCAL_DATA_CLEAR_JOURNAL);
      const verified: Record<string, unknown> = await local.get(LOCAL_DATA_CLEAR_JOURNAL);
      if (Object.hasOwn(verified, LOCAL_DATA_CLEAR_JOURNAL)) {
        throw new Error(`could not finish ${journal.scope} data clear`);
      }
    } catch (error: unknown) {
      const storageError: SetupState['storageError'] =
        journal.phase === 'remote' ? 'remote-deletion-failed' : 'local-clear-failed';
      try {
        await persistDataClearJournal(journal, 'error', storageError);
      } catch (stateError: unknown) {
        throw new AggregateError(
          [error, stateError],
          `could not restore pending ${journal.scope} data clear`,
        );
      }
      throw error;
    }
  }

  /**
   * The Focus Lock local keys an all-data clear owns. The journal itself is never one of them, and
   * `setup` is not one either: the pre-clear Setup stays on disk through the wipe and is replaced by
   * the mirror write that follows the browser-reset advance, then by the journal's own projection.
   * A crash in that window leaves a stale Setup beside an advanced journal, which spec 1327 calls
   * repair work rather than invalid state.
   */
  function focusLockLocalKeys(stored: Record<string, unknown>): string[] {
    return Object.keys(stored)
      .filter(
        (key: string): boolean =>
          key !== LOCAL_SETUP && key !== LOCAL_DATA_CLEAR_JOURNAL && isFocusLockLocalKey(key),
      )
      .sort();
  }

  /**
   * The worker persists the v2 runtime shape, so a stored value the v2 parser accepts is measured
   * against the v2 stopped rule rather than round-tripped through the v1 reader, which no v2
   * runtime can survive unchanged. Live blocking state keeps its own actionable message, and
   * everything else the stopped rule refuses reports the value itself as unusable.
   */
  async function assertStoppedRuntimeForAllDataClear(): Promise<void> {
    const stored: Record<string, unknown> = await local.get(LOCAL_RUNTIME);
    if (!Object.hasOwn(stored, LOCAL_RUNTIME)) return;
    const value: unknown = stored[LOCAL_RUNTIME];
    if (!isRecord(value) || typeof value.date !== 'string') {
      throw new Error('persisted runtime is not valid for all-data deletion');
    }
    if (
      value.session !== null ||
      value.gate !== null ||
      (Array.isArray(value.unlocks) && value.unlocks.length > 0) ||
      (isRecord(value.tabStates) && Object.keys(value.tabStates).length > 0)
    ) {
      throw new Error('stop the active session and blocking state before deleting all data');
    }
    const runtime: RuntimeStateV2 | null = parseRuntimeStateV2(value);
    if (runtime !== null) {
      if (!isStoppedRuntimeV2(runtime)) {
        throw new Error('persisted runtime is not valid for all-data deletion');
      }
      return;
    }
    await assertStoppedLegacyRuntimeForAllDataClear(value, value.date);
  }

  /**
   * The upgrade boot is the one place a stored runtime is still v1 when a clear runs: the deletion
   * dispatcher drives the phases before the v2 migration writes anything, so refusing every v1 value
   * would lose a deletion the user already asked for. The v1 reader therefore keeps the stopped
   * rule for a value only it can parse, and a value neither parser accepts is still refused.
   */
  async function assertStoppedLegacyRuntimeForAllDataClear(
    value: Record<string, unknown>,
    date: string,
  ): Promise<void> {
    const runtimeNow: number = new Date(`${date}T12:00:00`).getTime();
    if (!Number.isFinite(runtimeNow)) {
      throw new Error('persisted runtime is not valid for all-data deletion');
    }
    const snapshot: PolicySnapshot = await loadSnapshotInternal();
    const runtime: LegacyRuntimeStateV1 = migrateRuntimeRules(
      mergeRuntime(value, runtimeNow),
      snapshot.lists,
    );
    if (!valuesEqual(runtime, value)) {
      throw new Error('persisted runtime is not valid for all-data deletion');
    }
    if (
      runtime.session !== null ||
      runtime.gate !== null ||
      runtime.unlocks.length > 0 ||
      Object.keys(runtime.tabStates).length > 0
    ) {
      throw new Error('stop the active session and blocking state before deleting all data');
    }
  }

  function localHistoryRemovalKeys(
    stored: Record<string, unknown>,
    clearAggregates: boolean,
  ): string[] {
    const keys: string[] = [LOCAL_EVENTS];
    if (clearAggregates) {
      keys.push(
        ...Object.keys(stored).filter(
          (key: string): boolean =>
            key.startsWith('agg:') ||
            key.startsWith('aggm:') ||
            key.startsWith('archive:clock-rebase:'),
        ),
        LOCAL_SYNC_QUOTA_EVICTION,
        LOCAL_AGGREGATE_PRUNE,
        LOCAL_AGGREGATE_TOMBSTONES,
        LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
      );
    }
    return [...new Set(keys)];
  }

  function withoutAggregateHistory(journal: SyncJournal): SyncJournal {
    return {
      sets: Object.fromEntries(
        Object.entries(journal.sets).filter(
          ([key]: [string, unknown]): boolean => !isAggregateHistoryKey(key),
        ),
      ),
      removes: journal.removes.filter((key: string): boolean => !isAggregateHistoryKey(key)),
    };
  }

  function filteredFirstSyncPublication(): FirstSyncPublicationCheckpoint | null {
    if (firstSyncPublication === null) return null;
    return {
      ...firstSyncPublication,
      publication: withoutAggregateHistory(firstSyncPublication.publication),
    };
  }

  async function persistFilteredPublicationState(journal: SyncJournal): Promise<void> {
    const checkpoint: FirstSyncPublicationCheckpoint | null = filteredFirstSyncPublication();
    await persistPublicationJournalState(
      journal,
      checkpoint === null ? {} : { [LOCAL_FIRST_SYNC_PUBLICATION]: checkpoint },
    );
    firstSyncPublication = checkpoint === null ? null : structuredClone(checkpoint);
  }

  async function clearPendingAggregatePublications(): Promise<void> {
    if (publisher !== null) {
      await publisher.pause();
      await publisher.drain();
      const filtered: SyncJournal = withoutAggregateHistory(publisher.pendingSnapshotWhilePaused());
      await persistFilteredPublicationState(filtered);
      publisher.replacePendingAfterDurableJournalCommit(filtered);
      return;
    }
    const pending: SyncJournal = await loadedJournal(LOCAL_SYNC_JOURNAL, false);
    await persistFilteredPublicationState(withoutAggregateHistory(pending));
  }

  async function clearLocalHistoryStoragePhase(
    journal: LocalHistoryClearJournal,
  ): Promise<LocalHistoryClearJournal> {
    const stored: Record<string, unknown> = await local.get(null);
    const keys: string[] = localHistoryRemovalKeys(stored, journal.clearAggregates);
    const removing: LocalHistoryClearJournal = { ...journal, inventory: keys };
    await persistDataClearJournal(removing, 'pending', null);
    if (journal.clearAggregates) await clearPendingAggregatePublications();
    const previous: PreviousValues = await previousValues(keys);
    await verifiedRemove(keys, 'local history');
    const runtimePending: LocalHistoryClearJournal = {
      ...removing,
      phase: 'runtime',
      inventory: [],
    };
    try {
      await persistDataClearJournal(runtimePending, 'pending', null);
    } catch (error: unknown) {
      try {
        await restore(previous);
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          'could not roll back local history transaction',
        );
      }
      throw error;
    }
    return runtimePending;
  }

  async function resumeDataClear(journal: ScopedClearJournal): Promise<void> {
    try {
      if (journal.scope === 'local-history') {
        await clearLocalHistoryStoragePhase(journal);
        return;
      }
      const cleared: SyncedPolicyClearJournal =
        journal.phase === 'remote' ? await clearRemotePhase(journal) : journal;
      await finishDataClear(cleared);
    } catch (error: unknown) {
      const current: ScopedClearJournal =
        scopedClearJournal(await loadDataClearJournal()) ?? journal;
      const storageError: SetupState['storageError'] =
        current.phase === 'remote' ? 'remote-deletion-failed' : 'local-clear-failed';
      await persistDataClearJournal(current, 'error', storageError);
      throw error;
    }
  }

  function scopedClearJournal(journal: StoredClearJournal | null): ScopedClearJournal | null {
    return journal === null || journal.scope === 'all' ? null : journal;
  }

  async function deleteRemoteDataInternal(scope: 'synced-policy'): Promise<void> {
    await ensureInitialized();
    if (mode === 'sync') throw new Error('disable sync before deleting remote data');
    const existing: StoredClearJournal | null = await loadDataClearJournal();
    if (existing !== null && existing.scope !== scope) {
      throw new Error('another data clear operation is pending');
    }
    const journal: SyncedPolicyClearJournal = scopedSyncedPolicyJournal(existing, scope);
    await persistDataClearJournal(journal, 'pending', null);
    await resumeDataClear(journal);
  }

  function scopedSyncedPolicyJournal(
    existing: StoredClearJournal | null,
    scope: 'synced-policy',
  ): SyncedPolicyClearJournal {
    if (existing === null) return { scope, phase: 'remote', inventory: [] };
    if (existing.scope !== scope) throw new Error('another data clear operation is pending');
    return existing;
  }

  // The all-data clear, version 2. Policy Storage owns the remote and local phases and the write
  // that advances the journal into browser reset. It never executes reset effects, never finishes
  // the journal, and never removes it: Engine owns browser reset and Main owns the dispatcher.

  function requiredDataClearPorts(): PolicyStorageDataClearPorts {
    if (dataClearPorts === undefined) {
      throw new Error('the all-data clear needs its deletion-lease ports');
    }
    return dataClearPorts;
  }

  function freshResetIds(ports: PolicyStorageDataClearPorts): DataClearResetIdsV2 {
    return { resetEpoch: ports.newId(), resetOperationId: ports.newId() };
  }

  function assertAllDataJournal(journal: StoredClearJournal | null): AllDataClearJournalV2 {
    if (journal === null || journal.scope !== 'all' || isLegacyAllDataClearJournal(journal)) {
      throw new Error('the all-data clear journal is missing');
    }
    return journal;
  }

  /**
   * The one upgrade site. Every owner that reads the journal under the lease turns a legacy value
   * into version 2 before it writes anything else, so no phase ever transforms a legacy shape.
   */
  function upgradedAllDataJournal(
    stored: StoredClearJournal,
    ports: PolicyStorageDataClearPorts,
  ): AllDataClearJournalV2 | 'unchanged' {
    if (stored.scope !== 'all') throw new Error('another data clear operation is pending');
    if (!isLegacyAllDataClearJournal(stored)) return 'unchanged';
    return upgradeLegacyAllDataClearJournal(stored, freshResetIds(ports), ports.now());
  }

  /**
   * One change, one transaction, under the caller's token. The lease refuses a second transaction
   * while this one is in flight, so a phase that needs two changes makes them in one transform.
   */
  async function updateAllDataJournal(
    token: DataClearLeaseToken,
    transform: (journal: AllDataClearJournalV2) => AllDataClearJournalV2 | 'unchanged',
  ): Promise<AllDataClearJournalV2> {
    const ports: PolicyStorageDataClearPorts = requiredDataClearPorts();
    const written: DataClearJournal | null = await transactDataClearJournal(
      ports.lease,
      token,
      (stored: StoredClearJournal | null): DataClearJournal | 'unchanged' => {
        if (stored === null) throw new Error('the all-data clear journal is missing');
        const upgraded: AllDataClearJournalV2 | 'unchanged' = upgradedAllDataJournal(stored, ports);
        return transform(upgraded === 'unchanged' ? assertAllDataJournal(stored) : upgraded);
      },
    );
    return assertAllDataJournal(written);
  }

  /** Reads the journal under the token, upgrading a legacy value in place before anything else. */
  async function readAllDataJournal(
    token: DataClearLeaseToken,
  ): Promise<AllDataClearJournalV2 | null> {
    const ports: PolicyStorageDataClearPorts = requiredDataClearPorts();
    const current: DataClearJournal | null = await transactDataClearJournal(
      ports.lease,
      token,
      (stored: StoredClearJournal | null): DataClearJournal | 'unchanged' =>
        stored === null ? 'unchanged' : upgradedAllDataJournal(stored, ports),
    );
    return current === null ? null : assertAllDataJournal(current);
  }

  /** Creates the journal when none exists, and upgrades a legacy value, in one transaction. */
  async function openAllDataJournal(token: DataClearLeaseToken): Promise<AllDataClearJournalV2> {
    const ports: PolicyStorageDataClearPorts = requiredDataClearPorts();
    const opened: DataClearJournal | null = await transactDataClearJournal(
      ports.lease,
      token,
      (stored: StoredClearJournal | null): DataClearJournal | 'unchanged' =>
        stored === null
          ? createAllDataClearJournalV2(freshResetIds(ports), ports.now())
          : upgradedAllDataJournal(stored, ports),
    );
    return assertAllDataJournal(opened);
  }

  /** The materialized Setup mirrors the journal phase. The journal stays the authority. */
  async function publishAllDataSetupPhase(
    phase: AllDataClearJournalV2['phase'],
    status: 'pending' | 'error',
  ): Promise<void> {
    const setup: SetupState = await loadSetupInternal();
    const dataClear: SetupState['dataClear'] = allDataSetupState(phase, status);
    if (valuesEqual(setup.dataClear, dataClear)) return;
    await saveSetupInternal({ ...setup, dataClear });
  }

  function allDataAttemptStatus(journal: AllDataClearJournalV2): 'pending' | 'error' {
    return journal.retry.lastError !== null && journal.retry.nextAttemptAt === null
      ? 'error'
      : 'pending';
  }

  function failureMessage(error: unknown): string {
    const message: string = error instanceof Error ? error.message : String(error);
    return message.trim() === '' ? 'all-data clear attempt failed' : message;
  }

  /**
   * A failed attempt is durable state, so it is recorded in the journal rather than in Setup. The
   * write is best effort: it uses the storage that just failed, and the caller must still see the
   * original failure rather than a second one raised while reporting the first.
   */
  async function recordAllDataAttemptFailure(
    token: DataClearLeaseToken,
    phase: 'remote' | 'local',
    error: unknown,
  ): Promise<void> {
    const ports: PolicyStorageDataClearPorts = requiredDataClearPorts();
    const message: string = failureMessage(error);
    try {
      const journal: AllDataClearJournalV2 = await updateAllDataJournal(
        token,
        (current: AllDataClearJournalV2): AllDataClearJournalV2 | 'unchanged' =>
          current.phase !== phase || exhaustedBatch(current)
            ? 'unchanged'
            : {
                ...current,
                retry: recordCleanupAttemptFailureV2(current.retry, ports.now(), message),
              },
      );
      await publishAllDataSetupPhase(journal.phase, allDataAttemptStatus(journal));
    } catch {
      return;
    }
  }

  /**
   * A retry batch belongs to the phase that owns it. A step that fails after its own advance already
   * landed, the Setup mirror that follows the write most of all, would otherwise burn an attempt of
   * the next phase's batch, and browser reset's batch is Engine's to spend and to clear.
   */
  function exhaustedBatch(journal: AllDataClearJournalV2): boolean {
    return journal.retry.lastError !== null && journal.retry.nextAttemptAt === null;
  }

  async function runAllDataRemotePhase(
    token: DataClearLeaseToken,
    journal: AllDataClearJournalV2,
  ): Promise<void> {
    const ports: PolicyStorageDataClearPorts = requiredDataClearPorts();
    const initialKeys: string[] = await remoteDeletionKeys(journal.inventory);
    await updateAllDataJournal(
      token,
      (current: AllDataClearJournalV2): AllDataClearJournalV2 => ({
        ...current,
        inventory: initialKeys,
      }),
    );
    await drainRemotePublication();
    await removeRemoteInventory(initialKeys, async (inventory: string[]): Promise<void> => {
      await updateAllDataJournal(
        token,
        (current: AllDataClearJournalV2): AllDataClearJournalV2 => ({ ...current, inventory }),
      );
    });
    await updateAllDataJournal(
      token,
      (current: AllDataClearJournalV2): AllDataClearJournalV2 => ({
        ...current,
        phase: 'local',
        inventory: [],
        retry: freshCleanupRetryStateV2(current.retry.batch, ports.now()),
      }),
    );
    await publishAllDataSetupPhase('local', 'pending');
  }

  async function runAllDataLocalPhase(token: DataClearLeaseToken): Promise<void> {
    let previousRemainingSignature: string | null = null;
    for (;;) {
      const keys: string[] = focusLockLocalKeys(await local.get(null));
      if (keys.length === 0) break;
      await updateAllDataJournal(
        token,
        (current: AllDataClearJournalV2): AllDataClearJournalV2 => ({
          ...current,
          inventory: keys,
        }),
      );
      await local.remove(keys);
      const remaining: Record<string, unknown> = await local.get(null);
      const remainingKeys: string[] = focusLockLocalKeys(remaining);
      if (remainingKeys.length === 0) break;
      const signature: string = serialized(
        Object.fromEntries(
          remainingKeys.map((key: string): [string, unknown] => [key, remaining[key]]),
        ),
      );
      if (signature === previousRemainingSignature) {
        throw new Error('could not verify local data clear');
      }
      previousRemainingSignature = signature;
    }
    firstSyncPublication = null;
    await advanceToBrowserReset(token);
    await verifiedWrite(
      {
        [LOCAL_SETUP]: {
          ...DEFAULT_SETUP,
          dataClear: allDataSetupState('browser-reset', 'pending'),
        },
      },
      'incomplete setup after local clear',
    );
    mode = null;
  }

  /**
   * The single write that makes browser reset durable. It carries the complete projections the
   * repair path replays from, so no Runtime, Setup, or marker value is materialized before it.
   */
  async function advanceToBrowserReset(token: DataClearLeaseToken): Promise<void> {
    const ports: PolicyStorageDataClearPorts = requiredDataClearPorts();
    const extensionVersion: string = ports.manifestVersion();
    const at: number = ports.now();
    await updateAllDataJournal(
      token,
      (current: AllDataClearJournalV2): AllDataClearJournalV2 => ({
        ...current,
        phase: 'browser-reset',
        inventory: [],
        runtimeProjection: emptyRuntimeV2(at, current.resetEpoch),
        setupProjection: structuredClone(DEFAULT_SETUP),
        installMarkerProjection: cleanInstallMarkerProjection(extensionVersion),
        finalInstallMarkerProjection: cleanInstallMarkerProjection(extensionVersion),
        resetProgress: emptyDataClearResetProgress(),
        // Spec 1301: a phase advance installs a fresh retry state. The batch counter is carried
        // rather than reset to one, so a manual retry in remote or local stays visible in the batch
        // number the next phase reports. Nothing schedules from it.
        retry: freshCleanupRetryStateV2(current.retry.batch, at),
      }),
    );
  }

  async function runAllDataClearPhaseInternal(
    token: DataClearLeaseToken,
  ): Promise<'remote' | 'local' | 'browser-reset' | 'none'> {
    await ensureInitialized();
    // Recovery step 1 upgrades a legacy journal before every other read, so that write, and only
    // that write, precedes the stopped-runtime gate. It is idempotent and deletes nothing.
    const journal: AllDataClearJournalV2 | null = await readAllDataJournal(token);
    if (journal === null) return 'none';
    allDataClearQuiescenceRequired = true;
    // A clear that has reached browser reset is being continued rather than created, and the
    // journal is the authority for it: the runtime is that journal's own projection, so the
    // dispatcher repairs it. Gating here would refuse to continue over the very drift the repair
    // exists to correct, before any recorder runs, which strands the clear on a reported error.
    if (journal.phase === 'browser-reset') return 'browser-reset';
    await assertStoppedRuntimeForAllDataClear();
    const phase: 'remote' | 'local' = journal.phase;
    try {
      if (phase === 'remote') await runAllDataRemotePhase(token, journal);
      else await runAllDataLocalPhase(token);
    } catch (error: unknown) {
      await recordAllDataAttemptFailure(token, phase, error);
      throw error;
    }
    return phase;
  }

  /** The Settings request path: create or adopt the journal, then run every phase this side owns. */
  async function startAllDataClearInternal(token: DataClearLeaseToken): Promise<void> {
    await ensureInitialized();
    if (mode === 'sync') throw new Error('disable sync before deleting remote data');
    const existing: StoredClearJournal | null = await loadDataClearJournal();
    if (existing !== null && existing.scope !== 'all') {
      throw new Error('another data clear operation is pending');
    }
    if (existing !== null) allDataClearQuiescenceRequired = true;
    await assertStoppedRuntimeForAllDataClear();
    const opened: AllDataClearJournalV2 = await openAllDataJournal(token);
    allDataClearQuiescenceRequired = true;
    await publishAllDataSetupPhase(opened.phase, allDataAttemptStatus(opened));
    for (let step: number = 0; step < ALL_DATA_PHASES_THIS_SIDE_OWNS; step += 1) {
      const ran: 'remote' | 'local' | 'browser-reset' | 'none' =
        await runAllDataClearPhaseInternal(token);
      if (ran === 'browser-reset' || ran === 'none') return;
    }
  }

  async function materializeBrowserResetProjectionsInternal(
    token: DataClearLeaseToken,
  ): Promise<void> {
    await ensureInitialized();
    const journal: AllDataClearJournalV2 | null = await readAllDataJournal(token);
    if (journal === null || journal.phase !== 'browser-reset') {
      throw new Error('the all-data clear journal is not in browser reset');
    }
    const runtime: RuntimeStateV2 | null = journal.runtimeProjection;
    const setup: SetupState | null = journal.setupProjection;
    const marker: InstallMarker | null = journal.installMarkerProjection;
    if (runtime === null || setup === null || marker === null) {
      throw new Error('a browser-reset journal carries every projection it materializes');
    }
    await materializeProjection(LOCAL_RUNTIME, runtime, 'reset runtime projection');
    await materializeProjection(LOCAL_SETUP, setup, 'reset setup projection');
    await materializeProjection(LOCAL_INSTALL_MARKER, marker, 'reset install marker projection');
  }

  /** Repair, not authority: a value that already equals its projection is left alone. */
  async function materializeProjection(
    key: string,
    projection: unknown,
    label: string,
  ): Promise<void> {
    const stored: Record<string, unknown> = await local.get(key);
    if (Object.hasOwn(stored, key) && valuesEqual(stored[key], projection)) return;
    await verifiedWrite({ [key]: projection }, label);
  }

  async function retryAllDataClearInternal(
    token: DataClearLeaseToken,
  ): Promise<'ok' | 'retry-not-available'> {
    await ensureInitialized();
    const journal: AllDataClearJournalV2 | null = await readAllDataJournal(token);
    if (journal === null || journal.phase === 'browser-reset') return 'retry-not-available';
    if (journal.retry.lastError === null || journal.retry.nextAttemptAt !== null) {
      return 'retry-not-available';
    }
    const ports: PolicyStorageDataClearPorts = requiredDataClearPorts();
    const next: AllDataClearJournalV2 = await updateAllDataJournal(
      token,
      (current: AllDataClearJournalV2): AllDataClearJournalV2 => ({
        ...current,
        retry: beginManualCleanupBatchV2(current.retry, ports.now()),
      }),
    );
    await publishAllDataSetupPhase(next.phase, 'pending');
    return 'ok';
  }

  /**
   * A read-only projection of the durable journal. It is the one all-data surface that does not
   * need the lease, because no effect and no later write depends on the snapshot it returns.
   */
  async function allDataClearPublicStateInternal(): Promise<AllDataClearPublicState> {
    const journal: StoredClearJournal | null = await loadDataClearJournal();
    if (journal === null) return { status: 'idle', scope: null, phase: null };
    if (journal.scope === 'all' && isLegacyAllDataClearJournal(journal)) {
      return { status: 'pending', scope: 'all', phase: journal.phase };
    }
    return projectAllDataClearPublicState(assertScopedOrV2Journal(journal));
  }

  /** Every member but the legacy all-data shape, which the caller has already ruled out. */
  function assertScopedOrV2Journal(journal: StoredClearJournal): DataClearJournal {
    if (journal.scope === 'all' && isLegacyAllDataClearJournal(journal)) {
      throw new Error('a legacy all-data journal upgrades before it is read');
    }
    return journal;
  }

  async function clearLocalHistoryInternal(): Promise<boolean> {
    await ensureInitialized();
    const existing: StoredClearJournal | null = await loadDataClearJournal();
    if (existing !== null && existing.scope !== 'local-history') {
      throw new Error('another data clear operation is pending');
    }
    const setup: SetupState = await loadSetupInternal();
    const journal: LocalHistoryClearJournal =
      existing ??
      ({
        scope: 'local-history',
        phase: 'local',
        inventory: [],
        clearAggregates: mode !== 'sync',
        priorStorageError: setup.storageError,
      } satisfies LocalHistoryClearJournal);
    await persistDataClearJournal(journal, 'pending', null);
    await resumeDataClear(journal);
    return journal.clearAggregates;
  }

  async function finishLocalHistoryClearInternal(): Promise<void> {
    await ensureInitialized();
    const journal: StoredClearJournal | null = await loadDataClearJournal();
    if (journal === null) return;
    if (journal.scope !== 'local-history' || journal.phase !== 'runtime') {
      throw new Error('local history removal is not ready to finish');
    }
    await finishDataClear(journal);
  }

  async function pendingLocalHistoryClearInternal(): Promise<{
    clearAggregates: boolean;
  } | null> {
    await ensureInitialized();
    const journal: StoredClearJournal | null = await loadDataClearJournal();
    if (journal?.scope !== 'local-history' || journal.phase !== 'runtime') return null;
    return { clearAggregates: journal.clearAggregates };
  }

  async function saveAggregateInternal(key: string, value: unknown): Promise<void> {
    await ensureInitialized();
    const normalized: unknown = normalizeAggregateItem(key, value);
    if (mode !== 'sync') {
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      delete blocked.items[key];
      const tombstoneStored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
      const tombstones: string[] = parseAggregateTombstones(
        tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES],
      ).filter((candidate: string): boolean => candidate !== key);
      await verifiedWrite(
        {
          [key]: normalized,
          [LOCAL_AGGREGATE_TOMBSTONES]: tombstones,
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
        },
        'aggregate item',
      );
      return;
    }
    const writer: SyncWriter = await ensurePublisher();
    try {
      await writer.pause();
      const setup: SetupState = await loadSetupInternal();
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      const tombstoneStored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
      const tombstones: string[] = parseAggregateTombstones(
        tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES],
      ).filter((candidate: string): boolean => candidate !== key);
      await verifiedWrite(
        {
          [key]: normalized,
          ...(await publicationRecoveryItems()),
          [LOCAL_AGGREGATE_TOMBSTONES]: tombstones,
          [LOCAL_SETUP]: { ...setup, syncWriteStatus: 'pending' },
        },
        'aggregate item and pending sync status',
      );
      try {
        assertSyncItemWithinQuota(key, normalized);
      } catch (error: unknown) {
        if (!(error instanceof SyncQuotaError)) throw error;
        blocked.items[key] = normalized;
        await verifiedWrite(
          {
            [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
            [LOCAL_SETUP]: {
              ...setup,
              syncWriteStatus: 'error',
              storageError: 'sync-publish-failed',
            },
          },
          'blocked aggregate publication',
        );
        writer.cancelPending(key);
        await writer.whenJournalDurable();
        return;
      }
      delete blocked.items[key];
      const hasBlocked: boolean = !blockedAggregatePublicationsEmpty(blocked);
      await verifiedWrite(
        {
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
          [LOCAL_SETUP]: {
            ...setup,
            syncWriteStatus: hasBlocked ? 'error' : 'pending',
            storageError: hasBlocked ? 'sync-publish-failed' : setup.storageError,
          },
        },
        'superseded blocked aggregate publication',
      );
      writer.queue(key, normalized);
      await writer.whenJournalDurable();
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    } finally {
      writer.resume();
    }
  }

  async function removeAggregateInternal(key: string): Promise<void> {
    await ensureInitialized();
    if (!isAggregateHistoryKey(key)) throw new Error('invalid aggregate key');
    if (mode !== 'sync') {
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      delete blocked.items[key];
      await verifiedWrite(
        { [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked },
        'superseded local blocked aggregate publication',
      );
      await verifiedRemove([key], 'aggregate item');
      return;
    }
    const writer: SyncWriter = await ensurePublisher();
    try {
      await writer.pause();
      const setup: SetupState = await loadSetupInternal();
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      delete blocked.items[key];
      const hasBlocked: boolean = !blockedAggregatePublicationsEmpty(blocked);
      const tombstoneStored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
      const tombstones: string[] = [
        ...new Set([...parseAggregateTombstones(tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES]), key]),
      ];
      await verifiedWrite(
        {
          [LOCAL_AGGREGATE_TOMBSTONES]: tombstones,
          ...(await publicationRecoveryItems()),
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
          [LOCAL_SETUP]: {
            ...setup,
            syncWriteStatus: hasBlocked ? 'error' : 'pending',
            storageError: hasBlocked ? 'sync-publish-failed' : setup.storageError,
          },
        },
        'aggregate tombstone and pending sync status',
      );
      await verifiedRemove([key], 'aggregate item');
      writer.remove(key);
      await writer.whenJournalDurable();
    } catch (error: unknown) {
      const current: SetupState = await loadSetupInternal();
      await saveSetupInternal({
        ...current,
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      });
      throw error;
    } finally {
      writer.resume();
    }
  }

  async function publishRemoteItemInternal(key: string, value: unknown): Promise<void> {
    await ensureInitialized();
    if (isAggregateHistoryKey(key)) {
      await saveAggregateInternal(key, value);
      return;
    }
    if (mode !== 'sync') return;
    if (POLICY_SYNC_KEYS.includes(key)) throw new Error('policy items require typed setPolicy');
    if (!isAuthoritativeSyncItem(key, value)) throw new Error('invalid remote publication item');
    const writer: SyncWriter = await ensurePublisher();
    writer.queue(key, value);
    await writer.whenJournalDurable();
  }

  async function removeRemoteItemInternal(key: string): Promise<void> {
    await ensureInitialized();
    if (isAggregateHistoryKey(key)) {
      await removeAggregateInternal(key);
      return;
    }
    if (mode !== 'sync') return;
    if (POLICY_SYNC_KEYS.includes(key)) throw new Error('policy items require typed setPolicy');
    if (!isFocusLockSyncKey(key)) throw new Error('invalid remote removal key');
    const writer: SyncWriter = await ensurePublisher();
    writer.remove(key);
    await writer.whenJournalDurable();
  }

  async function pruneRemoteHistoryInternal(
    deviceId: string,
    retentionDays: number,
    now: number,
  ): Promise<void> {
    await ensureInitialized();
    const plan: ReturnType<typeof pruneAndRollup> = pruneAndRollup(
      deviceId,
      await localAggregateHistoryItems(),
      retentionDays,
      now,
    );
    if (Object.keys(plan.set).length === 0 && plan.remove.length === 0) return;
    const checkpoint: LocalAggregatePruneCheckpoint = {
      set: structuredClone(plan.set),
      remove: [...plan.remove],
    };
    const writer: SyncWriter | null = mode === 'sync' ? await ensurePublisher() : null;
    try {
      if (writer !== null) await writer.pause();
      const setup: SetupState = await loadSetupInternal();
      const tombstoneStored: Record<string, unknown> = await local.get(LOCAL_AGGREGATE_TOMBSTONES);
      const tombstones: string[] =
        writer === null
          ? parseAggregateTombstones(tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES])
          : [
              ...new Set([
                ...parseAggregateTombstones(tombstoneStored[LOCAL_AGGREGATE_TOMBSTONES]),
                ...plan.remove,
              ]),
            ];
      await verifiedWrite(
        {
          [LOCAL_AGGREGATE_PRUNE]: checkpoint,
          ...(await publicationRecoveryItems()),
          ...(writer === null
            ? {}
            : {
                [LOCAL_AGGREGATE_TOMBSTONES]: tombstones,
                [LOCAL_SETUP]: { ...setup, syncWriteStatus: 'pending' },
              }),
        },
        'aggregate prune checkpoint',
      );
      if (Object.keys(plan.set).length > 0) {
        await verifiedWrite(plan.set, 'aggregate prune rollup');
      }
      await verifiedRemove(plan.remove, 'aggregate prune removals');
      await verifiedRemove([LOCAL_AGGREGATE_PRUNE], 'aggregate prune checkpoint cleanup');
      if (writer === null) return;
      const blocked: BlockedAggregatePublications = await loadBlockedAggregatePublications();
      const publishableSets: Record<string, unknown> = {};
      const blockedKeys: string[] = [];
      for (const [key, value] of Object.entries(plan.set)) {
        try {
          assertSyncItemWithinQuota(key, value);
          delete blocked.items[key];
          publishableSets[key] = value;
        } catch (error: unknown) {
          if (!(error instanceof SyncQuotaError)) throw error;
          blocked.items[key] = value;
          blockedKeys.push(key);
        }
      }
      for (const key of plan.remove) delete blocked.items[key];
      const hasBlocked: boolean = !blockedAggregatePublicationsEmpty(blocked);
      await verifiedWrite(
        {
          [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: blocked,
          [LOCAL_SETUP]: {
            ...setup,
            syncWriteStatus: hasBlocked ? 'error' : 'pending',
            storageError: hasBlocked ? 'sync-publish-failed' : setup.storageError,
          },
        },
        'aggregate prune publication state',
      );
      for (const key of blockedKeys) writer.cancelPending(key);
      for (const [key, value] of Object.entries(publishableSets)) writer.queue(key, value);
      for (const key of plan.remove) writer.remove(key);
      await writer.whenJournalDurable();
    } catch (error: unknown) {
      if (writer !== null) {
        const current: SetupState = await loadSetupInternal();
        await saveSetupInternal({
          ...current,
          syncWriteStatus: 'error',
          storageError: 'sync-publish-failed',
        });
      }
      throw error;
    } finally {
      writer?.resume();
    }
  }

  return {
    initialize: async (): Promise<void> => {
      const stored: Record<string, unknown> = await local.get(LOCAL_DATA_CLEAR_JOURNAL);
      const journal: StoredClearJournal | null = parseDataClearJournal(
        stored[LOCAL_DATA_CLEAR_JOURNAL],
      );
      if (journal?.scope !== 'all') return enqueue(initializeInternal);
      allDataClearQuiescenceRequired = true;
      return runAllDataClearExclusive((): Promise<void> => enqueue(initializeInternal));
    },
    loadSetup: (): Promise<SetupState> => {
      if (initialized && setupCache !== null) return Promise.resolve(structuredClone(setupCache));
      return enqueue(async (): Promise<SetupState> => {
        await ensureInitialized();
        return loadSetupInternal();
      });
    },
    updateSetup: (next: Partial<SetupUpdate>): Promise<void> =>
      enqueue((): Promise<void> => updateSetupInternal(next)),
    markSetupCompleted: (): Promise<void> => enqueue(markSetupCompletedInternal),
    loadSnapshot: (): Promise<PolicySnapshot> =>
      enqueue(async (): Promise<PolicySnapshot> => {
        await ensureInitialized();
        return loadSnapshotInternal();
      }),
    setPolicy: <K extends keyof PolicyValueByKey>(
      key: K,
      value: PolicyValueByKey[K],
    ): Promise<void> => enqueue((): Promise<void> => setPolicyInternal(key, value)),
    selectLocalMode: (): Promise<void> =>
      firstSyncCheckpoint.runExclusive === undefined
        ? enqueue(selectLocalModeInternal)
        : firstSyncCheckpoint.runExclusive((): Promise<void> => enqueue(selectLocalModeInternal)),
    enableSync: (): Promise<void> =>
      firstSyncCheckpoint.runExclusive === undefined
        ? enqueue(enableSyncInternal)
        : firstSyncCheckpoint.runExclusive((): Promise<void> => enqueue(enableSyncInternal)),
    retrySync: (): Promise<void> =>
      firstSyncCheckpoint.runExclusive === undefined
        ? enqueue(retrySyncInternal)
        : firstSyncCheckpoint.runExclusive((): Promise<void> => enqueue(retrySyncInternal)),
    disableSync: (): Promise<void> =>
      firstSyncCheckpoint.runExclusive === undefined
        ? enqueue(disableSyncInternal)
        : firstSyncCheckpoint.runExclusive((): Promise<void> => enqueue(disableSyncInternal)),
    mirrorAcceptedRemotePolicy: (
      changes: Record<string, unknown>,
      pendingRemoteKeys: readonly string[] = [],
    ): Promise<void> =>
      enqueue((): Promise<void> => mirrorAcceptedRemotePolicyInternal(changes, pendingRemoteKeys)),
    queueVerifiedRemoteCorrections: (keys: readonly (keyof PolicyValueByKey)[]): Promise<void> =>
      enqueue((): Promise<void> => queueVerifiedRemoteCorrectionsInternal(keys)),
    deleteRemoteData: (scope: 'synced-policy' | 'all'): Promise<void> =>
      scope === 'all'
        ? requiredDataClearPorts().lease.run(
            (token: DataClearLeaseToken): Promise<void> =>
              runAllDataClearExclusive(
                (): Promise<void> => enqueue((): Promise<void> => startAllDataClearInternal(token)),
              ),
          )
        : enqueue((): Promise<void> => deleteRemoteDataInternal(scope)),
    runAllDataClearPhase: (
      token: DataClearLeaseToken,
    ): Promise<'remote' | 'local' | 'browser-reset' | 'none'> =>
      runAllDataClearExclusive(
        (): Promise<'remote' | 'local' | 'browser-reset' | 'none'> =>
          enqueue(
            (): Promise<'remote' | 'local' | 'browser-reset' | 'none'> =>
              runAllDataClearPhaseInternal(token),
          ),
      ),
    materializeBrowserResetProjections: (token: DataClearLeaseToken): Promise<void> =>
      runAllDataClearExclusive(
        (): Promise<void> =>
          enqueue((): Promise<void> => materializeBrowserResetProjectionsInternal(token)),
      ),
    retryAllDataClear: (token: DataClearLeaseToken): Promise<'ok' | 'retry-not-available'> =>
      runAllDataClearExclusive(
        (): Promise<'ok' | 'retry-not-available'> =>
          enqueue((): Promise<'ok' | 'retry-not-available'> => retryAllDataClearInternal(token)),
      ),
    allDataClearPublicState: (): Promise<AllDataClearPublicState> =>
      allDataClearPublicStateInternal(),
    clearLocalHistory: (): Promise<boolean> => enqueue(clearLocalHistoryInternal),
    finishLocalHistoryClear: (): Promise<void> => enqueue(finishLocalHistoryClearInternal),
    pendingLocalHistoryClear: (): Promise<{ clearAggregates: boolean } | null> =>
      enqueue(pendingLocalHistoryClearInternal),
    allDataClearCompleted: (): boolean => completedAllDataClear,
    storageMode: (): Promise<StorageMode | null> =>
      enqueue(async (): Promise<StorageMode | null> => {
        await ensureInitialized();
        return mode;
      }),
    inboundSyncAllowed: (): Promise<boolean> =>
      enqueue(async (): Promise<boolean> => {
        await ensureInitialized();
        const setup: SetupState = await loadSetupInternal();
        return mode === 'sync' && setup.dataClear.status === 'idle';
      }),
    consumeRemoteEcho: (key: string, value: unknown): boolean => echoes.consume(key, value),
    hasPendingRemote: (key: string): boolean => publisher?.hasPending(key) ?? false,
    publishRemoteItem: (key: string, value: unknown): Promise<void> =>
      enqueue((): Promise<void> => publishRemoteItemInternal(key, value)),
    removeRemoteItem: (key: string): Promise<void> =>
      enqueue((): Promise<void> => removeRemoteItemInternal(key)),
    remoteJournalDurable: (): Promise<void> =>
      enqueue(async (): Promise<void> => {
        await ensureInitialized();
        if (publisher !== null) await publisher.whenJournalDurable();
      }),
    pruneRemoteHistory: (deviceId: string, retentionDays: number, now: number): Promise<void> =>
      enqueue((): Promise<void> => pruneRemoteHistoryInternal(deviceId, retentionDays, now)),
    saveAggregate: (key: string, value: unknown): Promise<void> =>
      enqueue((): Promise<void> => saveAggregateInternal(key, value)),
    removeAggregate: (key: string): Promise<void> =>
      enqueue((): Promise<void> => removeAggregateInternal(key)),
    withAggregateStorage: <T>(operation: (storage: AggregateStorage) => Promise<T>): Promise<T> =>
      enqueue(async (): Promise<T> => {
        await ensureInitialized();
        return operation({ local, sync: mode === 'sync' ? sync : null });
      }),
    markLegacyMigrationFailed: (): Promise<void> => enqueue(markLegacyMigrationFailedInternal),
    markLegacyRemotePolicyDropped: (): Promise<void> =>
      enqueue(markLegacyRemotePolicyDroppedInternal),
    importLegacy: (
      snapshot: PolicySnapshot,
      runtime: LegacyRuntimeStateV1,
      journal: SyncJournal,
      storedSync: Record<string, unknown> = {},
    ): Promise<void> =>
      enqueue((): Promise<void> => importLegacyInternal(snapshot, runtime, journal, storedSync)),
  };
}
