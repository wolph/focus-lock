import { parseDailyAgg, parseMonthlyAgg } from '../core/stats';
import { emptyStreak } from '../core/streak';
import { DEFAULT_SETTINGS, DEFAULT_SETUP } from '../shared/constants';
import type { DocumentContentCommand } from '../shared/enforcement-v2';
import { CoreError } from '../shared/errors';
import { exactDataEqual } from '../shared/exact-data';
import { t } from '../shared/i18n';
import type { Ack, Rejection, Request, SoundId } from '../shared/messages';
import { WEBSITE_ORIGINS } from '../shared/permissions';
import {
  isInstallMarker,
  isListsConfig,
  isSettings,
  isSetupState,
} from '../shared/runtime-validation';
import {
  LOCAL_BANK,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_CACHES,
  LOCAL_DATA_CLEAR_JOURNAL,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_FIRST_SYNC_PUBLICATION,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_ONBOARDING_DRAFT,
  LOCAL_PENDING_CHANGES,
  LOCAL_POLICY_COMMIT,
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
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../shared/storage-keys';
import { localDateStr, localMonthStr } from '../shared/time';
import type {
  BankState,
  BootFailure,
  DailyAgg,
  EventRecord,
  InstallMarker,
  LegacyEventRecord,
  ListsConfig,
  MonthlyAgg,
  PauseEconomy,
  SessionSnapshot,
  Settings,
  SetupState,
  StreakState,
} from '../shared/types';
import {
  type AlarmNameV2,
  type AlarmPortsV2,
  createAlarmWithReadBackV2,
  DATA_CLEAR_RETRY_ALARM,
  ensureTickAlarmV2,
  type ScheduledAlarmV2,
} from './alarms-v2';
import { notify, playSound } from './audio';
import {
  type ContentRegistrationState,
  contentScriptFile,
  reconcileContentRegistrationState,
} from './content-registration';
import {
  type AllDataClearJournalV2,
  type AllDataClearPublicState,
  type DataClearJournal,
  type DataClearResetIdsV2,
  type FinalInstallMarkerProjection,
  isLegacyAllDataClearJournal,
  type LegacyAllDataClearJournal,
  type PendingInstallLifecycleIntent,
  parseDataClearJournal,
  upgradeLegacyAllDataClearJournal,
} from './data-clear-journal';
import {
  type AllDataClearLease,
  createAllDataClearLease,
  type DataClearLeaseToken,
  transactDataClearJournal,
} from './data-clear-lease';
import {
  type AllDataClearFinalizationV2,
  type BrowserResetAttemptResultV2,
  type BrowserResetPortsV2,
  finalizeAllDataClearV2,
  retryBrowserResetV2,
  runBrowserResetAttemptV2,
} from './data-clear-reset-v2';
import { type BrowserResetEngineSeamV2, Engine, type EnginePorts } from './engine';
import { appendEventsV2 } from './event-log-v2';
import { updateIcon } from './icon';
import {
  appendOrApplyInstallLifecycle,
  captureInstallLifecycleIntent,
  type InstallLifecycleSubmissionV2,
  replayLifecycleIntentsV2,
} from './install-lifecycle-v2';
import {
  decodeListsSyncSnapshot,
  encodeListsForSync,
  isListSyncKey,
  LIST_SYNC_KEYS,
  type ListsSyncEncoding,
} from './list-sync-codec';
import { createOnboardingService, type OnboardingService } from './onboarding';
import { type PendingPolicyChange, parsePendingChanges } from './pending-policy-changes';
import {
  createPolicyStorage,
  type PolicySnapshot,
  type PolicyStorage,
  type PolicyStorageDataClearPorts,
} from './policy-storage';
import { parseRequest } from './request-validation';
import { routeMessage } from './router';
import {
  bootRuntimeAuthorityV2,
  migrationStoragePayload,
  type RejectedRuntimeDiagnosticV1,
  type RuntimeBootPortsV2,
  type RuntimeBootResultV2,
  truncatedJson,
} from './runtime-boot-v2';
import { emptyRuntimeV2, loadRuntimeAuthority, saveRuntimeV2 } from './runtime-store-v2';
import type {
  CleanupTabClaim,
  RuntimeMigrationCheckpointV1ToV2,
  RuntimeStateV2,
} from './runtime-v2-types';
import type { AggregateStorage } from './stats-service';
import { handleSyncChanges, missingSyncDefaults } from './storage-sync';
import {
  getDeviceId,
  type LegacyRuntimeStateV1,
  loadLists,
  loadRuntime,
  loadSyncJournal,
  mergeLists,
  migrateRuntimeRules,
  type ParsedRuntimeState,
  parseBank,
  parseStoredSettings,
  parseStreak,
  type StoredSettingsParseResult,
  sanitizeRuntimeForLocalHistory,
  saveLegacyRuntime,
  saveMatcherCache,
} from './stores';
import { chooseNewerStreak, rebaseStreakForDate, streaksEqual } from './streak-sync';
import {
  aggregateHistoryDeviceId,
  isAggregateHistoryKey,
  isAuthoritativeSyncItem,
  isFocusLockSyncKey,
} from './sync-item-validation';
import { type SanitizedSyncJournal, sanitizeSyncJournal } from './sync-quota';
import type { SyncJournal } from './sync-writer';
import {
  applyBlockingFactory,
  enforcementTargetPortsV2,
  injectIntoExistingTabs,
  invalidateRemovedTab,
  registerTabListeners,
  reloadClaimedDocuments,
  restoreClaimedTabs,
} from './tabs';
import { broadcastWorkTargetChanged, registerWorkTargetListeners } from './work-target';

const DAILY_AGG_KEY_RE: RegExp = /^agg:[^:]+:(\d{4}-\d{2}-\d{2})$/;
const MONTHLY_AGG_KEY_RE: RegExp = /^aggm:[^:]+:(\d{4}-\d{2})$/;

type AggregateKeyIdentity = { kind: 'daily'; period: string } | { kind: 'monthly'; period: string };
type StoredAggregate = DailyAgg | MonthlyAgg;

let engineInstance: Engine | null = null;

type WebsiteCapabilityCause = 'boot' | 'explicit' | 'permission-added' | 'permission-removed';
type WebsiteReconciliation = {
  capability: ContentRegistrationState;
  generation: number;
};
type WebsiteReconciliationRequest = {
  generation: number;
  promise: Promise<WebsiteReconciliation>;
};
type WebsiteAccessNotice = Exclude<SetupState['websiteAccessNotice'], null>;
type PendingWebsiteAccessNotice = { value: WebsiteAccessNotice | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The boot stage a failure is attributed to. Anything left untagged is the policy-storage stage. */
type BootStage = BootFailure['stage'];

function errorMessage(error: unknown): string {
  const message: string = error instanceof Error ? error.message : String(error);
  return message.trim().length > 0 ? message : t('notify_unknown_error');
}

/** Tags the error that escaped one boot stage. The cause keeps its own stack and message. */
class BootStageError extends Error {
  readonly stage: BootStage;

  constructor(stage: BootStage, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = 'BootStageError';
    this.stage = stage;
  }
}

/** What `ready` rejects with after a failed boot, so a listener can tell it from a route error. */
class BootFailedError extends Error {
  readonly failure: BootFailure;

  constructor(failure: BootFailure) {
    super(bootFailureRejection(failure).error);
    this.name = 'BootFailedError';
    this.failure = failure;
  }
}

async function bootStage<T>(stage: BootStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    throw error instanceof BootStageError ? error : new BootStageError(stage, error);
  }
}

function bootFailureOf(error: unknown, at: number): BootFailure {
  return error instanceof BootStageError
    ? { stage: error.stage, message: error.message, at }
    : { stage: 'policy-storage', message: errorMessage(error), at };
}

/** The one answer every request gets from a worker that did not start, with the reason attached. */
function bootFailureRejection(failure: BootFailure): Rejection {
  return { ok: false, error: t('notify_boot_not_finished', { REASON: failure.message }) };
}

function requiresWorkerControl(request: Request): boolean {
  switch (request.type) {
    case 'reconcileWebsiteAccess':
    case 'dismissWebsiteAccessNotice':
    case 'openOnboarding':
    case 'getOnboardingDraft':
    case 'cleanupOnboardingDraft':
    case 'saveOnboardingDraft':
    case 'completeOnboarding':
    case 'completeSetup':
    case 'setStorageMode':
    case 'retrySync':
    case 'clearFocusLockData':
      return true;
    default:
      return false;
  }
}

function recordWebsiteAccessNotice(
  pending: PendingWebsiteAccessNotice,
  notice: WebsiteAccessNotice,
): void {
  if (pending.value === 'revoked-during-session') return;
  pending.value = notice;
}

async function endActiveSessionForWebsiteCapabilityLoss(
  engine: Engine,
  capability: ContentRegistrationState,
  cause: WebsiteCapabilityCause,
  pendingNotice: PendingWebsiteAccessNotice,
): Promise<boolean> {
  if (!engine.hasActiveSession()) return false;
  const notice: WebsiteAccessNotice =
    capability.permission === 'denied' || cause === 'permission-removed'
      ? 'revoked-during-session'
      : 'registration-failed-during-session';
  try {
    await engine.endSessionForWebsiteBlockingLoss();
  } catch (error: unknown) {
    reportBackgroundError(error);
  }
  recordWebsiteAccessNotice(pendingNotice, notice);
  return true;
}

function isWebsitePermissionEvent(permissions: chrome.permissions.Permissions): boolean {
  return (permissions.origins ?? []).some(
    (origin: string): boolean => origin === '<all_urls>' || WEBSITE_ORIGINS.includes(origin),
  );
}

async function applyWebsiteCapability(
  storage: PolicyStorage,
  engine: Engine,
  capability: ContentRegistrationState,
  cause: WebsiteCapabilityCause,
  pendingNotice: PendingWebsiteAccessNotice,
  isCurrent: () => boolean = (): boolean => true,
): Promise<ContentRegistrationState | null> {
  if (!isCurrent()) return null;
  let effectiveCapability: ContentRegistrationState = capability;
  if (capability.status === 'ready') {
    const injectionComplete: boolean = await injectIntoExistingTabs(
      contentScriptFile,
      reportBackgroundError,
    );
    if (!isCurrent()) return null;
    if (!injectionComplete) {
      effectiveCapability = { permission: capability.permission, status: 'error' };
    }
  }
  if (effectiveCapability.status !== 'ready') {
    await endActiveSessionForWebsiteCapabilityLoss(
      engine,
      effectiveCapability,
      cause,
      pendingNotice,
    );
    if (!isCurrent()) return null;
  }
  const setup: SetupState = await storage.loadSetup();
  if (!isCurrent()) return null;
  const websiteAccess: typeof setup.websiteAccess =
    effectiveCapability.permission === 'granted'
      ? 'granted'
      : effectiveCapability.permission === 'denied' || cause === 'permission-removed'
        ? 'denied'
        : setup.websiteAccess;
  const websiteAccessNotice: typeof setup.websiteAccessNotice =
    effectiveCapability.status === 'ready'
      ? null
      : (pendingNotice.value ?? setup.websiteAccessNotice);
  await storage.updateSetup({
    websiteAccess,
    blockingRegistration: effectiveCapability.status,
    websiteAccessNotice,
  });
  if (!isCurrent()) return null;
  return effectiveCapability;
}

function currentEngine(): Engine {
  if (engineInstance === null) throw new Error('engine used before boot finished');
  return engineInstance;
}

function reportBackgroundError(error: unknown): void {
  // A settled boot failure was reported once where it settled. Every listener that finds it
  // afterwards, on each alarm, tab event, or storage change, would otherwise repeat it for the
  // life of the stopped worker.
  if (error instanceof BootFailedError) return;
  console.error('focus-lock background error', error);
}

function hasPendingSet(journal: SyncJournal, key: string): boolean {
  return !journal.removes.includes(key) && Object.hasOwn(journal.sets, key);
}

function hasPendingLists(journal: SyncJournal): boolean {
  return (
    Object.keys(journal.sets).some((key: string): boolean => isListSyncKey(key)) ||
    journal.removes.some((key: string): boolean => isListSyncKey(key))
  );
}

function replacePendingLists(journal: SyncJournal, encoding: ListsSyncEncoding): void {
  for (const key of LIST_SYNC_KEYS) delete journal.sets[key];
  journal.removes = journal.removes.filter((key: string): boolean => !isListSyncKey(key));
  Object.assign(journal.sets, encoding.sets);
  journal.removes.push(...encoding.removes);
}

function effectiveListsSnapshot(
  storedSync: Readonly<Record<string, unknown>>,
  journal: SyncJournal,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = Object.fromEntries(
    Object.entries(storedSync).filter(([key]: [string, unknown]): boolean => isListSyncKey(key)),
  );
  for (const key of journal.removes) {
    if (isListSyncKey(key)) delete snapshot[key];
  }
  for (const [key, value] of Object.entries(journal.sets)) {
    if (isListSyncKey(key) && !journal.removes.includes(key)) snapshot[key] = value;
  }
  return snapshot;
}

function aggregateKeyIdentity(key: string): AggregateKeyIdentity | null {
  const dailyDate: string | undefined = DAILY_AGG_KEY_RE.exec(key)?.[1];
  if (dailyDate !== undefined) return { kind: 'daily', period: dailyDate };
  const month: string | undefined = MONTHLY_AGG_KEY_RE.exec(key)?.[1];
  return month === undefined ? null : { kind: 'monthly', period: month };
}

function parseAggregateForKey(
  value: unknown,
  identity: AggregateKeyIdentity,
): StoredAggregate | null {
  return identity.kind === 'daily'
    ? parseDailyAgg(value, identity.period)
    : parseMonthlyAgg(value, identity.period);
}

function validatePendingAggregates(
  journal: SyncJournal,
  storedSync: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(journal.sets)) {
    if (!hasPendingSet(journal, key)) continue;
    const identity: AggregateKeyIdentity | null = aggregateKeyIdentity(key);
    if (identity === null) continue;
    const pending: StoredAggregate | null = parseAggregateForKey(value, identity);
    const corrected: StoredAggregate | null =
      pending ?? parseAggregateForKey(storedSync[key], identity);
    if (corrected !== null) journal.sets[key] = corrected;
    else delete journal.sets[key];
  }
}

function validatedPendingJournal(
  rawJournal: SyncJournal,
  storedSync: Record<string, unknown>,
  now: number,
): SyncJournal {
  // The journal is replay transport, not independent policy authority. A malformed
  // pending value may fall back only to validated remote or default policy here.
  // The complete resolved snapshot is validated again by PolicyStorage.importLegacy.
  const journal: SyncJournal = {
    sets: { ...rawJournal.sets },
    removes: [...rawJournal.removes],
  };
  if (hasPendingSet(journal, SYNC_SETTINGS)) {
    const syncedResult: StoredSettingsParseResult = parseStoredSettings(
      storedSync[SYNC_SETTINGS],
      DEFAULT_SETTINGS,
    );
    const synced: Settings = syncedResult.valid ? syncedResult.settings : DEFAULT_SETTINGS;
    const pending: StoredSettingsParseResult = parseStoredSettings(
      journal.sets[SYNC_SETTINGS],
      synced,
    );
    journal.sets[SYNC_SETTINGS] = pending.valid ? pending.settings : synced;
  }
  if (hasPendingSet(journal, SYNC_BANK)) {
    const synced: BankState = parseBank(storedSync[SYNC_BANK]) ?? { balanceMs: 0 };
    journal.sets[SYNC_BANK] = parseBank(journal.sets[SYNC_BANK]) ?? synced;
  }
  if (hasPendingSet(journal, SYNC_STREAK)) {
    const synced: StreakState =
      parseStreak(storedSync[SYNC_STREAK]) ?? emptyStreak(localMonthStr(now));
    journal.sets[SYNC_STREAK] = parseStreak(journal.sets[SYNC_STREAK]) ?? synced;
  }
  validatePendingAggregates(journal, storedSync);
  return journal;
}

/**
 * The synced policy entries a legacy import cannot read, by key. Each one is replaced by the
 * validated local value or the default and the import goes on, because one unreadable entry must
 * not keep the whole profile from booting. The pending journal is replay transport, repaired from
 * validated authority later, so only the entries it does not override are judged here.
 */
function refusedAuthoritativeRemotePolicy(
  storedSync: Record<string, unknown>,
  journal: SyncJournal,
): string[] {
  const refused: string[] = [];
  const pendingSettings: StoredSettingsParseResult | null = hasPendingSet(journal, SYNC_SETTINGS)
    ? parseStoredSettings(journal.sets[SYNC_SETTINGS], DEFAULT_SETTINGS)
    : null;
  if (
    (pendingSettings === null || !pendingSettings.valid) &&
    Object.hasOwn(storedSync, SYNC_SETTINGS) &&
    !parseStoredSettings(storedSync[SYNC_SETTINGS], DEFAULT_SETTINGS).valid
  ) {
    refused.push(SYNC_SETTINGS);
  }
  const pendingBank: BankState | null = hasPendingSet(journal, SYNC_BANK)
    ? parseBank(journal.sets[SYNC_BANK])
    : null;
  if (
    pendingBank === null &&
    Object.hasOwn(storedSync, SYNC_BANK) &&
    parseBank(storedSync[SYNC_BANK]) === null
  ) {
    refused.push(SYNC_BANK);
  }
  const pendingStreak: StreakState | null = hasPendingSet(journal, SYNC_STREAK)
    ? parseStreak(journal.sets[SYNC_STREAK])
    : null;
  if (
    pendingStreak === null &&
    Object.hasOwn(storedSync, SYNC_STREAK) &&
    parseStreak(storedSync[SYNC_STREAK]) === null
  ) {
    refused.push(SYNC_STREAK);
  }
  const remoteHasLists: boolean = Object.keys(storedSync).some(isListSyncKey);
  const journalHasLists: boolean = hasPendingLists(journal);
  if (!remoteHasLists || journalHasLists) return refused;
  const decoded = decodeListsSyncSnapshot(storedSync);
  // The strict validator refuses the whole entry for one bad rule. The local snapshot is the
  // value that stands in, never a lenient read of the refused one.
  if (
    decoded.kind === 'incomplete' ||
    (decoded.kind === 'legacy' && !isListsConfig(decoded.value))
  ) {
    refused.push(SYNC_LISTS);
  }
  return refused;
}

/** What stands in for a refused synced entry: the validated local value, or the default. */
type RemotePolicyFallbacks = {
  settings: Settings;
  bank: BankState;
  streak: StreakState | null;
  lists: ListsConfig;
};

async function localPolicyFallbacks(): Promise<RemotePolicyFallbacks> {
  const stored: Record<string, unknown> = await chrome.storage.local.get([
    LOCAL_SETTINGS,
    LOCAL_BANK,
    LOCAL_STREAK,
    LOCAL_LISTS_SNAPSHOT,
  ]);
  const settings: StoredSettingsParseResult = parseStoredSettings(
    stored[LOCAL_SETTINGS],
    DEFAULT_SETTINGS,
  );
  return {
    settings: settings.valid ? settings.settings : DEFAULT_SETTINGS,
    bank: parseBank(stored[LOCAL_BANK]) ?? { balanceMs: 0 },
    streak: parseStreak(stored[LOCAL_STREAK]),
    lists: mergeLists(stored[LOCAL_LISTS_SNAPSHOT]),
  };
}

function assertValidResolvedLegacyPolicy(snapshot: PolicySnapshot): void {
  if (!isSettings(snapshot.settings)) throw new Error('invalid resolved legacy settings');
  if (!isListsConfig(snapshot.lists)) throw new Error('invalid resolved legacy lists');
  if (parseBank(snapshot.bank) === null) throw new Error('invalid resolved legacy bank');
  if (snapshot.streak !== null && parseStreak(snapshot.streak) === null) {
    throw new Error('invalid resolved legacy streak');
  }
}

const LEGACY_EVIDENCE_KEYS: readonly string[] = [
  LOCAL_RUNTIME,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_EVENTS,
  LOCAL_DEVICE_ID,
  LOCAL_SYNC_JOURNAL,
  LOCAL_FIRST_SYNC_PUBLICATION,
  LOCAL_SYNC_QUOTA_EVICTION,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_CACHES,
];

async function classifyInstallProfile(): Promise<InstallMarker> {
  const keys: string[] = [LOCAL_INSTALL_MARKER, ...LEGACY_EVIDENCE_KEYS];
  const stored: Record<string, unknown> = await chrome.storage.local.get(keys);
  const existing: unknown = stored[LOCAL_INSTALL_MARKER];
  if (isInstallMarker(existing)) return existing;
  const profile: InstallMarker['profile'] = LEGACY_EVIDENCE_KEYS.some((key: string): boolean =>
    Object.hasOwn(stored, key),
  )
    ? 'legacy'
    : 'clean';
  const marker: InstallMarker = {
    version: 1,
    profile,
    latestReason: 'install',
    extensionVersion: chrome.runtime.getManifest?.().version ?? 'unknown',
  };
  await chrome.storage.local.set({ [LOCAL_INSTALL_MARKER]: marker });
  const verified: unknown = (await chrome.storage.local.get(LOCAL_INSTALL_MARKER))[
    LOCAL_INSTALL_MARKER
  ];
  if (!isInstallMarker(verified) || verified.profile !== profile) {
    throw new Error('could not persist install profile classification');
  }
  return verified;
}

/**
 * The normal path for a lifecycle event: classify, then record what the event meant. It runs only
 * when no all-data journal exists, because a clear owns the marker from the moment it opens one.
 */
async function applyInstallLifecycleImmediately(
  intent: PendingInstallLifecycleIntent,
): Promise<void> {
  const marker: InstallMarker = await classifyInstallProfile();
  const next: InstallMarker = {
    ...marker,
    latestReason: intent.reason === 'update' ? 'update' : 'install',
    extensionVersion: intent.currentVersion,
  };
  await chrome.storage.local.set({ [LOCAL_INSTALL_MARKER]: next });
}

/**
 * Writes the marker one replayed intent produced and proves it, which is the middle step of the
 * replay: the journal already holds this exact projection, and the intent is removed only after
 * this read comes back equal.
 */
async function materializeFinalInstallMarker(marker: FinalInstallMarkerProjection): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_INSTALL_MARKER]: marker });
  const stored: unknown = (await chrome.storage.local.get(LOCAL_INSTALL_MARKER))[
    LOCAL_INSTALL_MARKER
  ];
  if (!exactDataEqual(stored, marker)) {
    throw new CoreError('storage', 'the replayed install marker did not read back');
  }
}

/** What one dispatch of the all-data clear left behind. */
type AllDataClearDispatchV2 = 'idle' | 'busy' | 'pending' | 'removed';

/** How far the phases this worker runs under one acquisition got. */
type AllDataClearPhaseRunV2 = 'idle' | 'stable' | 'unfinished';

/** Remote, local, and the browser-reset verdict: three answers is the whole ladder. */
const ALL_DATA_PHASE_STEPS: number = 3;

/** The seam Policy Storage transacts the all-data journal through. */
function policyStorageDataClearPorts(lease: AllDataClearLease): PolicyStorageDataClearPorts {
  return {
    lease,
    newId: (): string => crypto.randomUUID(),
    now: (): number => Date.now(),
    manifestVersion: (): string => chrome.runtime.getManifest?.().version ?? 'unknown',
    reportError: reportBackgroundError,
  };
}

/**
 * The stored journal, read without the lease. It decides only how this boot publishes and which
 * phase runs next, and every effect that follows rereads it under the token that owns it.
 */
async function storedDataClearJournal(): Promise<
  DataClearJournal | LegacyAllDataClearJournal | null
> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_DATA_CLEAR_JOURNAL);
  const raw: unknown = stored[LOCAL_DATA_CLEAR_JOURNAL];
  if (raw === undefined) return null;
  const parsed: DataClearJournal | LegacyAllDataClearJournal | null = parseDataClearJournal(raw);
  if (parsed === null)
    throw new CoreError('storage', 'the stored data clear journal failed parsing');
  return parsed;
}

/**
 * True while an all-data clear is unfinished, whatever the materialized Setup happens to say.
 *
 * A stored value no parser accepts is reported and answered as unfinished. Nothing may classify a
 * profile, import legacy policy, or publish an idle lifecycle over a deletion state that cannot be
 * read, and the phases themselves raise on the same value rather than acting on it.
 */
async function allDataClearUnfinished(): Promise<boolean> {
  try {
    const journal: DataClearJournal | LegacyAllDataClearJournal | null =
      await storedDataClearJournal();
    return journal !== null && journal.scope === 'all';
  } catch (error: unknown) {
    reportBackgroundError(error);
    return true;
  }
}

/**
 * Recovery step 1: the journal is read under the token, and a legacy value becomes version 2 in
 * the same transaction, before any phase reads it again.
 */
async function readUpgradedAllDataJournal(
  lease: AllDataClearLease,
  token: DataClearLeaseToken,
): Promise<AllDataClearJournalV2 | null> {
  const ids: DataClearResetIdsV2 = {
    resetEpoch: crypto.randomUUID(),
    resetOperationId: crypto.randomUUID(),
  };
  const current: DataClearJournal | null = await transactDataClearJournal(
    lease,
    token,
    (
      stored: DataClearJournal | LegacyAllDataClearJournal | null,
    ): DataClearJournal | 'unchanged' => {
      if (stored === null || stored.scope !== 'all') return 'unchanged';
      return isLegacyAllDataClearJournal(stored)
        ? upgradeLegacyAllDataClearJournal(stored, ids, Date.now())
        : 'unchanged';
    },
  );
  if (current === null || current.scope !== 'all' || isLegacyAllDataClearJournal(current)) {
    return null;
  }
  return current;
}

/**
 * Main's half of the browser reset. `replayLifecycleIntents` is the named adapter from the port
 * Engine and the reset module call to the replay this worker owns: it runs under the token it is
 * given, never acquires, and reports a failure as a failed step rather than a thrown clear.
 */
function browserResetSeam(lease: AllDataClearLease): BrowserResetEngineSeamV2 {
  return {
    lease,
    readMaterialized: async (): Promise<{
      runtime: unknown;
      setup: unknown;
      installMarker: unknown;
    }> => {
      const stored: Record<string, unknown> = await chrome.storage.local.get([
        LOCAL_RUNTIME,
        LOCAL_SETUP,
        LOCAL_INSTALL_MARKER,
      ]);
      return {
        runtime: stored[LOCAL_RUNTIME],
        setup: stored[LOCAL_SETUP],
        installMarker: stored[LOCAL_INSTALL_MARKER],
      };
    },
    deviceIdExists: async (): Promise<boolean> => {
      const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_DEVICE_ID);
      return typeof stored[LOCAL_DEVICE_ID] === 'string';
    },
    ensureDeviceId: (): Promise<string> => getDeviceId(),
    replayLifecycleIntents: async (token: DataClearLeaseToken): Promise<'complete' | 'failed'> => {
      try {
        return await replayLifecycleIntentsV2(lease, token, materializeFinalInstallMarker);
      } catch (error: unknown) {
        reportBackgroundError(error);
        return 'failed';
      }
    },
  };
}

/** The same seam, plus the browser surfaces Engine would have contributed, for a boot with none. */
function browserResetPorts(lease: AllDataClearLease): BrowserResetPortsV2 {
  const seam: BrowserResetEngineSeamV2 = browserResetSeam(lease);
  return {
    ...seam,
    now: (): number => Date.now(),
    newId: (): string => crypto.randomUUID(),
    targets: enforcementTargetPortsV2(contentScriptFile),
    transport: {
      sendToDocument: (
        tabId: number,
        documentId: string,
        message: DocumentContentCommand,
      ): Promise<unknown> => chrome.tabs.sendMessage(tabId, message, { documentId }),
    },
    alarms: chromeAlarmPortsV2(),
    reportError: reportBackgroundError,
  };
}

/**
 * The attempt goes through Engine when one exists, because a live worker's reset must hold the
 * barrier Engine owns, and through the module directly during a boot that has not built one yet.
 */
async function runBrowserResetAttempt(
  lease: AllDataClearLease,
  token: DataClearLeaseToken,
): Promise<BrowserResetAttemptResultV2> {
  return engineInstance === null
    ? runBrowserResetAttemptV2(browserResetPorts(lease), token)
    : engineInstance.runBrowserResetAttempt(token);
}

/** Finalization acquires the lease itself, so it is called with none held. */
async function finalizeAllDataClear(lease: AllDataClearLease): Promise<AllDataClearFinalizationV2> {
  return engineInstance === null
    ? finalizeAllDataClearV2(browserResetPorts(lease))
    : engineInstance.finalizeAllDataClear();
}

/**
 * Every phase this worker owns, under the one acquisition the dispatcher made. Policy Storage runs
 * remote and local and advances the journal; browser reset materializes what the journal projects
 * and then resolves the documents. A reset that is already stable is not re-run: it only needs the
 * clean identity, which is idempotent, before finalization can read it back.
 */
async function runAllDataClearPhases(
  storage: PolicyStorage,
  lease: AllDataClearLease,
  token: DataClearLeaseToken,
): Promise<AllDataClearPhaseRunV2> {
  const opened: AllDataClearJournalV2 | null = await readUpgradedAllDataJournal(lease, token);
  if (opened === null) return 'idle';
  for (let step: number = 0; step < ALL_DATA_PHASE_STEPS; step += 1) {
    const ran: 'remote' | 'local' | 'browser-reset' | 'none' =
      await storage.runAllDataClearPhase(token);
    if (ran === 'none') return 'idle';
    if (ran === 'browser-reset') break;
  }
  const current: AllDataClearJournalV2 | null = await readUpgradedAllDataJournal(lease, token);
  if (current === null) return 'idle';
  // The repair is unconditional: spec 1355 has every browser-reset dispatch repair the runtime and
  // the setup record, and withholding that to protect the marker leaves a drifted runtime that
  // finalization can never accept. The repair writes all three from the clean projections, so an
  // advanced final marker is written back immediately after it, under the same token and before
  // anything reads either value.
  await storage.materializeBrowserResetProjections(token);
  const finalMarker: FinalInstallMarkerProjection | null = current.finalInstallMarkerProjection;
  if (finalMarker !== null && !exactDataEqual(current.installMarkerProjection, finalMarker)) {
    await materializeFinalInstallMarker(finalMarker);
  }
  if (current.resetProgress?.stablePasses === 2) {
    // The crash cell between the clean-marker read-back and the identity: a reset that is already
    // stable owes only the identity, and asking for it again is what makes that cell recoverable.
    await browserResetSeam(lease).ensureDeviceId();
    return 'stable';
  }
  const attempt: BrowserResetAttemptResultV2 = await runBrowserResetAttempt(lease, token);
  return attempt === 'stable' ? 'stable' : 'unfinished';
}

/**
 * The one entry point for the all-data clear, wherever the wake came from: this boot, the Settings
 * request that created the journal, or the retry alarm. A second arrival while the lease is held
 * answers `busy` rather than running the same phase twice.
 */
async function dispatchAllDataClear(
  storage: PolicyStorage,
  lease: AllDataClearLease,
): Promise<AllDataClearDispatchV2> {
  if (lease.held()) return 'busy';
  let reached: AllDataClearPhaseRunV2 = 'unfinished';
  let finalization: AllDataClearFinalizationV2 | null = null;
  try {
    reached = await lease.run(
      (token: DataClearLeaseToken): Promise<AllDataClearPhaseRunV2> =>
        runAllDataClearPhases(storage, lease, token),
    );
    // Finalization acquires the lease for itself, so it runs after the phases have released it.
    if (reached === 'stable') finalization = await finalizeAllDataClear(lease);
  } catch (error: unknown) {
    // A failed phase has already recorded itself in the journal's retry state, and the journal is
    // the authority for what happens next, so the throw is reported and the retry is armed.
    reportBackgroundError(error);
  }
  if (finalization === 'removed') return 'removed';
  if (reached === 'idle' && finalization === null) return 'idle';
  await armDataClearRetryAlarm();
  return (await allDataClearUnfinished()) ? 'pending' : 'idle';
}

/**
 * The wake that carries the next attempt. The browser-reset phase arms its own alarm inside its
 * retry, so this covers the phases Policy Storage owns, and re-arming an alarm that already reads
 * back at the same instant is what makes it safe to call after every dispatch.
 */
async function armDataClearRetryAlarm(): Promise<void> {
  try {
    const journal: DataClearJournal | LegacyAllDataClearJournal | null =
      await storedDataClearJournal();
    if (journal === null || journal.scope !== 'all' || isLegacyAllDataClearJournal(journal)) return;
    const at: number | null = journal.retry.nextAttemptAt;
    if (at === null) return;
    const armed: boolean = await createAlarmWithReadBackV2(
      chromeAlarmPortsV2(),
      DATA_CLEAR_RETRY_ALARM,
      at,
    );
    if (!armed) {
      reportBackgroundError(new CoreError('storage', 'the data clear retry alarm was refused'));
    }
  } catch (error: unknown) {
    reportBackgroundError(error);
  }
}

/**
 * The manual retry, phase by phase. An unfinished journal is already going to be retried on its own
 * schedule, so only an exhausted one has anything to begin, which is exactly what the popup and
 * Settings offer the button for.
 */
async function retryAllDataClear(
  storage: PolicyStorage,
  lease: AllDataClearLease,
): Promise<'ok' | 'retry-not-available'> {
  if (lease.held()) return 'retry-not-available';
  const begun: 'ok' | 'retry-not-available' = await lease.run(
    async (token: DataClearLeaseToken): Promise<'ok' | 'retry-not-available'> => {
      const journal: AllDataClearJournalV2 | null = await readUpgradedAllDataJournal(lease, token);
      if (journal === null) return 'retry-not-available';
      if (journal.retry.lastError === null || journal.retry.nextAttemptAt !== null) {
        return 'retry-not-available';
      }
      return journal.phase === 'browser-reset'
        ? retryBrowserResetV2(browserResetPorts(lease), token)
        : storage.retryAllDataClear(token);
    },
  );
  if (begun === 'retry-not-available') return begun;
  await dispatchAllDataClear(storage, lease);
  return 'ok';
}

/**
 * One captured lifecycle event, submitted once. With a journal it becomes a durable record and
 * nothing else happens; without one it takes the immediate marker path. A full list is a durable
 * failure the journal records, and it is reported here rather than swallowed.
 */
async function submitInstallLifecycle(
  lease: AllDataClearLease,
  intent: PendingInstallLifecycleIntent,
): Promise<void> {
  const submission: InstallLifecycleSubmissionV2 = await appendOrApplyInstallLifecycle(
    lease,
    intent,
    (): Promise<void> => applyInstallLifecycleImmediately(intent),
  );
  if (submission === 'capacity') {
    reportBackgroundError(
      new CoreError('storage', 'the pending install lifecycle intent list is full'),
    );
  }
}

function effectiveLegacyValue(
  journal: SyncJournal,
  stored: Record<string, unknown>,
  key: string,
): unknown {
  if (journal.removes.includes(key)) return undefined;
  return Object.hasOwn(journal.sets, key) ? journal.sets[key] : stored[key];
}

/**
 * Recovery steps 1 through 4. Policy Storage is initialized, the all-data journal decides this
 * boot, and only a read that proves the journal is gone lets classification, the legacy import,
 * and the rest of the boot run. Nothing classifies or publishes over a profile being erased.
 */
async function preparePolicyStorage(lease: AllDataClearLease): Promise<PolicyStorage> {
  const storage: PolicyStorage = createPolicyStorage(
    chrome.storage.local,
    chrome.storage.sync,
    {
      runExclusive: <T>(operation: () => Promise<T>): Promise<T> =>
        engineInstance === null
          ? operation()
          : engineInstance.runWithAggregateStorageBarrier(operation),
      loadAggregateItems: async (): Promise<Record<string, unknown>> => {
        const deviceId: string = await getDeviceId();
        const stored: Record<string, unknown> = await chrome.storage.local.get(null);
        const aggregates: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(stored)) {
          const looksOwned: boolean =
            key.startsWith(`agg:${deviceId}:`) ||
            key.startsWith(`aggm:${deviceId}:`) ||
            key.startsWith(`archive:clock-rebase:${deviceId}:`);
          if (!looksOwned) continue;
          if (
            aggregateHistoryDeviceId(key) !== deviceId ||
            !isAggregateHistoryKey(key) ||
            !isAuthoritativeSyncItem(key, value)
          ) {
            throw new Error(`invalid local aggregate checkpoint item ${JSON.stringify(key)}`);
          }
          aggregates[key] = value;
        }
        return aggregates;
      },
    },
    {
      runExclusive: <T>(
        operation: () => Promise<T>,
        retainQuiescence: () => boolean,
      ): Promise<T> =>
        engineInstance === null
          ? operation()
          : engineInstance.runWithDataClearBarrier(operation, retainQuiescence),
    },
    policyStorageDataClearPorts(lease),
  );
  await storage.initialize();
  await dispatchAllDataClear(storage, lease);
  if (await allDataClearUnfinished()) return storage;
  const marker: InstallMarker = await classifyInstallProfile();
  const recoveredSetup: SetupState = await storage.loadSetup();
  if (recoveredSetup.dataClear.status !== 'idle') return storage;
  if (marker.profile === 'clean') {
    return storage;
  }
  const markerAfterRecovery: InstallMarker = await classifyInstallProfile();
  if (markerAfterRecovery.profile === 'clean') return storage;
  const currentSetup = await storage.loadSetup();
  if (currentSetup.legacyImported) {
    return storage;
  }
  try {
    const now: number = Date.now();
    const rawJournal: SyncJournal = await loadSyncJournal();
    const sanitized: SanitizedSyncJournal = sanitizeSyncJournal(rawJournal);
    const storedSync: Record<string, unknown> = await chrome.storage.sync.get(null);
    const refusedRemoteKeys: string[] = refusedAuthoritativeRemotePolicy(
      storedSync,
      sanitized.journal,
    );
    const fallbacks: RemotePolicyFallbacks | null =
      refusedRemoteKeys.length > 0 ? await localPolicyFallbacks() : null;
    const journal: SyncJournal = validatedPendingJournal(sanitized.journal, storedSync, now);
    const hasRemotePolicy: boolean = Object.keys(storedSync).some((key: string): boolean =>
      isFocusLockSyncKey(key),
    );
    const hasLegacySyncIntent: boolean =
      hasRemotePolicy || Object.keys(journal.sets).length > 0 || journal.removes.length > 0;
    const journalHadLists: boolean = hasPendingLists(journal);
    const [storedLists, journalFallbackLists]: [ListsConfig, ListsConfig] = await Promise.all([
      loadLists(undefined, storedSync),
      loadLists(journal, storedSync),
    ]);
    const remoteListsIncomplete: boolean =
      Object.keys(storedSync).some(isListSyncKey) &&
      decodeListsSyncSnapshot(storedSync).kind === 'incomplete';
    const decodedLists = decodeListsSyncSnapshot(effectiveListsSnapshot(storedSync, journal));
    const lists: ListsConfig =
      fallbacks !== null && refusedRemoteKeys.includes(SYNC_LISTS)
        ? fallbacks.lists
        : !journalHadLists || decodedLists.kind === 'legacy'
          ? storedLists
          : decodedLists.kind === 'complete'
            ? decodedLists.lists
            : journalFallbackLists;
    if (journalHadLists || remoteListsIncomplete) {
      replacePendingLists(journal, await encodeListsForSync(lists));
    }
    const parsedSettings: StoredSettingsParseResult = parseStoredSettings(
      effectiveLegacyValue(journal, storedSync, SYNC_SETTINGS),
      DEFAULT_SETTINGS,
    );
    // Each entry falls back on its own refusal only. An entry that is merely absent remotely
    // takes what a clean import gives it, whatever else was refused beside it.
    const settings: Settings = parsedSettings.valid
      ? parsedSettings.settings
      : fallbacks !== null && refusedRemoteKeys.includes(SYNC_SETTINGS)
        ? fallbacks.settings
        : DEFAULT_SETTINGS;
    const bank: BankState =
      parseBank(effectiveLegacyValue(journal, storedSync, SYNC_BANK)) ??
      (fallbacks !== null && refusedRemoteKeys.includes(SYNC_BANK)
        ? fallbacks.bank
        : { balanceMs: 0 });
    const syncedStreak: StreakState | null =
      parseStreak(storedSync[SYNC_STREAK]) ??
      (fallbacks !== null && refusedRemoteKeys.includes(SYNC_STREAK) ? fallbacks.streak : null);
    const journalHasStreak: boolean = hasPendingSet(journal, SYNC_STREAK);
    const journaledStreak: StreakState | null = journalHasStreak
      ? parseStreak(journal.sets[SYNC_STREAK])
      : null;
    const today: string = localDateStr(now);
    const rebasedSyncedStreak: StreakState | null =
      syncedStreak === null ? null : rebaseStreakForDate(syncedStreak, today);
    const rebasedJournaledStreak: StreakState | null =
      journaledStreak === null ? null : rebaseStreakForDate(journaledStreak, today);
    const streak: StreakState | null = chooseNewerStreak(
      rebasedSyncedStreak,
      rebasedJournaledStreak,
    );
    const persistedStreak: StreakState = streak ?? emptyStreak(localMonthStr(now));
    if (
      journalHasStreak &&
      (journaledStreak === null ||
        (streak !== null &&
          (!streaksEqual(streak, journaledStreak) ||
            (syncedStreak !== null && !streaksEqual(streak, syncedStreak)))))
    ) {
      journal.sets[SYNC_STREAK] = persistedStreak;
      journal.removes = journal.removes.filter((key: string): boolean => key !== SYNC_STREAK);
    }
    if (hasLegacySyncIntent) {
      const effectiveStoredSync: Record<string, unknown> = { ...storedSync, ...journal.sets };
      for (const key of journal.removes) delete effectiveStoredSync[key];
      const missingDefaults: Record<string, unknown> = missingSyncDefaults(effectiveStoredSync, {
        settings,
        lists,
        bank,
        streak: persistedStreak,
      });
      const listsWereMissing: boolean = Object.hasOwn(missingDefaults, SYNC_LISTS);
      delete missingDefaults[SYNC_LISTS];
      Object.assign(journal.sets, missingDefaults);
      if (listsWereMissing) replacePendingLists(journal, await encodeListsForSync(lists));
    }
    const loadedRuntime: ParsedRuntimeState = await loadRuntime(now);
    const runtime: LegacyRuntimeStateV1 = migrateRuntimeRules(loadedRuntime, lists);
    const snapshot: PolicySnapshot = { settings, lists, bank, streak: persistedStreak };
    assertValidResolvedLegacyPolicy(snapshot);
    await storage.importLegacy(snapshot, runtime, journal, storedSync);
    if (refusedRemoteKeys.length > 0) {
      // A real import outcome, so it is persisted, unlike the boot-failure overlays. Settings
      // shows it beside the other storage errors, and the log names the keys.
      reportBackgroundError(
        new Error(`legacy remote policy dropped: ${refusedRemoteKeys.join(', ')}`),
      );
      await storage.markLegacyRemotePolicyDropped();
    }
    return storage;
  } catch (error: unknown) {
    await storage.markLegacyMigrationFailed();
    throw error;
  }
}

/**
 * The one producer of the periodic tick. `ensureTickAlarmV2` answers whether the browser really
 * holds the alarm it was asked for, and a worker whose maintenance never runs is worth reporting.
 */
async function armTickAlarm(): Promise<void> {
  if ((await ensureTickAlarmV2(chromeAlarmPortsV2())) === 'alarm-failed') {
    reportBackgroundError(new Error('the periodic tick alarm was refused'));
  }
}

/** The chrome-backed alarm surface the v2 runners drive. */
function chromeAlarmPortsV2(): AlarmPortsV2 {
  return {
    create: async (name: AlarmNameV2, when: number): Promise<void> => {
      await chrome.alarms.create(name, { when });
    },
    createPeriodic: async (name: AlarmNameV2, periodInMinutes: number): Promise<void> => {
      await chrome.alarms.create(name, { periodInMinutes });
    },
    get: async (name: AlarmNameV2): Promise<ScheduledAlarmV2 | null> => {
      const alarm: chrome.alarms.Alarm | undefined = await chrome.alarms.get(name);
      if (alarm === undefined) return null;
      return {
        scheduledTime: alarm.scheduledTime,
        periodInMinutes: alarm.periodInMinutes ?? null,
      };
    },
    clear: async (name: AlarmNameV2): Promise<void> => {
      await chrome.alarms.clear(name);
    },
  };
}

/** The stored daily aggregates a closure seeds its split dates from. */
async function loadStoredAggregates(
  policyStorage: PolicyStorage,
  keys: readonly string[],
): Promise<Record<string, DailyAgg>> {
  if (keys.length === 0) return {};
  return await policyStorage.withAggregateStorage(
    async (storage: AggregateStorage): Promise<Record<string, DailyAgg>> => {
      const stored: Record<string, unknown> = await storage.local.get([...keys]);
      const aggregates: Record<string, DailyAgg> = {};
      for (const [key, value] of Object.entries(stored)) {
        const parsed: DailyAgg | null = parseDailyAgg(value);
        if (parsed !== null) aggregates[key] = parsed;
      }
      return aggregates;
    },
  );
}

/** The boot reader's ports: storage effects only, which is all it is allowed to perform. */
function runtimeBootPorts(
  policyStorage: PolicyStorage,
  snapshot: PolicySnapshot,
  deviceId: string,
): RuntimeBootPortsV2 {
  return {
    now: (): number => Date.now(),
    newId: (): string => crypto.randomUUID(),
    loadRuntimeAuthority,
    readMigrationCheckpoint: async (): Promise<unknown> => {
      const stored: Record<string, unknown> =
        await chrome.storage.local.get(LOCAL_RUNTIME_MIGRATION);
      return stored[LOCAL_RUNTIME_MIGRATION];
    },
    writeMigrationCheckpointAndMarker: async (
      checkpoint: RuntimeMigrationCheckpointV1ToV2,
    ): Promise<void> => {
      await chrome.storage.local.set(migrationStoragePayload(checkpoint));
    },
    clearMigrationCheckpoint: async (): Promise<void> => {
      await chrome.storage.local.remove(LOCAL_RUNTIME_MIGRATION);
      // The read-back is what makes the clear a fact. A checkpoint that survives its removal is
      // replayed by the next boot, which is safe on its own, but a marker outliving the checkpoint
      // it explains is not, so a removal that did not take is raised rather than believed.
      const stored: Record<string, unknown> =
        await chrome.storage.local.get(LOCAL_RUNTIME_MIGRATION);
      if (stored[LOCAL_RUNTIME_MIGRATION] !== undefined) {
        throw new CoreError('storage', 'the runtime migration checkpoint survived its removal');
      }
    },
    parkRejectedRuntime: async (diagnostic: RejectedRuntimeDiagnosticV1): Promise<void> => {
      await chrome.storage.local.set({ [LOCAL_RUNTIME_REJECTED]: diagnostic });
    },
    saveRuntime: (runtime: RuntimeStateV2): Promise<void> => saveRuntimeV2(runtime),
    saveLegacyRuntime,
    appendEvents: (events: readonly EventRecord[]): Promise<void> => appendEventsV2(events),
    appendLegacyEvents: (events: readonly LegacyEventRecord[]): Promise<void> =>
      appendEventsV2(events),
    // `setPolicy` is the typed writer, and it decides whether the bank reaches sync. Publishing a
    // policy key straight onto the remote journal is what the storage layer refuses.
    saveBank: async (bank: BankState): Promise<void> => {
      await policyStorage.setPolicy('bank', bank);
    },
    saveAggregate: (key: string, value: DailyAgg): Promise<void> =>
      policyStorage.saveAggregate(key, value),
    removeAggregate: (key: string): Promise<void> => policyStorage.removeAggregate(key),
    persistSyncJournal: (): Promise<void> => policyStorage.remoteJournalDurable(),
    loadAggregates: (keys: readonly string[]): Promise<Record<string, DailyAgg>> =>
      loadStoredAggregates(policyStorage, keys),
    lists: (): ListsConfig => snapshot.lists,
    bank: (): BankState => snapshot.bank,
    pauseEconomy: (): PauseEconomy => snapshot.settings.pause,
    deviceId: (): string => deviceId,
    reportError: reportBackgroundError,
  };
}

async function boot(
  policyStorage: PolicyStorage,
  lease: AllDataClearLease,
  initialWebsiteCapability: WebsiteReconciliation,
  websiteCapability: () => ContentRegistrationState,
  initialCapabilityIsCurrent: () => boolean,
  publishWebsiteCapability: (capability: ContentRegistrationState) => void,
  pendingWebsiteAccessNotice: PendingWebsiteAccessNotice,
  setupCompleted: () => boolean,
  publishSetupCompleted: (completed: boolean) => void,
): Promise<Engine> {
  const now: number = Date.now();
  // Checklist 2: the periodic tick exists from this boot onward, whichever path the boot takes,
  // and its read-back is the only proof the browser accepted it.
  await armTickAlarm();
  await policyStorage.initialize();
  const snapshot: PolicySnapshot = await policyStorage.loadSnapshot();
  let deviceId: string = await getDeviceId();
  const setup: SetupState = await policyStorage.loadSetup();
  if (setup.completed) {
    try {
      await chrome.storage.local.remove(LOCAL_ONBOARDING_DRAFT);
    } catch (error: unknown) {
      reportBackgroundError(error);
    }
  }
  // The journal outlives the Setup record it mirrors: browser reset materializes an idle Setup
  // from its own projection while the clear is still unfinished, so the journal is what this boot
  // asks. A clear that is still running publishes nothing and resolves no runtime authority.
  const pendingAllDataClear: boolean = await allDataClearUnfinished();
  publishSetupCompleted(setup.completed && !pendingAllDataClear);
  // One runtime authority, resolved before anything else runs. A stored migration checkpoint is
  // finished, a v2 runtime is replayed, a legacy runtime migrates once, and anything else is
  // reported and replaced by an empty v2 runtime. A throw in here is a runtime-stage failure,
  // which is the one stage the popup may offer the local runtime reset for.
  const runtime: RuntimeStateV2 = await bootStage('runtime', async (): Promise<RuntimeStateV2> => {
    const boot: RuntimeBootResultV2 = pendingAllDataClear
      ? { kind: 'v2', runtime: emptyRuntimeV2(now, crypto.randomUUID()), migrated: false }
      : await bootRuntimeAuthorityV2(runtimeBootPorts(policyStorage, snapshot, deviceId));
    if (boot.kind === 'rejected') {
      reportBackgroundError(new Error(`stored runtime rejected: ${boot.reason}`));
    }
    const localHistoryClear: { clearAggregates: boolean } | null =
      await policyStorage.pendingLocalHistoryClear();
    const resolved: RuntimeStateV2 =
      localHistoryClear === null
        ? boot.runtime
        : sanitizeRuntimeForLocalHistory(boot.runtime, localHistoryClear.clearAggregates);
    if (localHistoryClear !== null) {
      try {
        await saveRuntimeV2(resolved);
        await policyStorage.finishLocalHistoryClear();
      } catch (error: unknown) {
        reportBackgroundError(error);
      }
    } else if (!pendingAllDataClear) {
      // A fresh profile has nothing stored, and a rejected or migrated one must not read the old
      // value again, so the resolved authority is written before anything else runs.
      await saveRuntimeV2(resolved);
      await chrome.storage.local.set({ [LOCAL_RUNTIME_SCHEMA]: { runtimeSchemaVersion: 2 } });
    }
    return resolved;
  });
  const streak: StreakState = snapshot.streak ?? emptyStreak(localMonthStr(now));
  const ports: EnginePorts = {
    now: (): number => Date.now(),
    newId: (): string => crypto.randomUUID(),
    // The install marker is the journal's projection now, written when the clear materializes it
    // and advanced by the lifecycle replay, so the identity is all this port still owes.
    rehydrateAfterDataClear: async (): Promise<string> => {
      deviceId = await getDeviceId();
      return deviceId;
    },
    saveRuntime: (runtime: RuntimeStateV2): Promise<void> => saveRuntimeV2(runtime),
    saveMatcherCache,
    loadPendingChanges: async (): Promise<PendingPolicyChange[]> =>
      parsePendingChanges(
        (await chrome.storage.local.get(LOCAL_PENDING_CHANGES))[LOCAL_PENDING_CHANGES],
      ),
    savePendingChanges: async (changes: readonly PendingPolicyChange[]): Promise<void> => {
      if (changes.length === 0) {
        await chrome.storage.local.remove(LOCAL_PENDING_CHANGES);
        return;
      }
      await chrome.storage.local.set({ [LOCAL_PENDING_CHANGES]: [...changes] });
    },
    savePolicy: (key, value): Promise<void> => policyStorage.setPolicy(key, value),
    saveAggregate: (key: string, value: DailyAgg): Promise<void> =>
      policyStorage.saveAggregate(key, value),
    removeAggregate: (key: string): Promise<void> => policyStorage.removeAggregate(key),
    hasPendingSync: (key: string): boolean => policyStorage.hasPendingRemote(key),
    queueSync: (key: string, value: unknown): void => {
      void policyStorage.publishRemoteItem(key, value).catch(reportBackgroundError);
    },
    supersedeSync: (key: string, value: unknown): void => {
      void policyStorage.publishRemoteItem(key, value).catch(reportBackgroundError);
    },
    removeSync: (key: string): void => {
      void policyStorage.removeRemoteItem(key).catch(reportBackgroundError);
    },
    persistSyncJournal: (): Promise<void> => policyStorage.remoteJournalDurable(),
    // Checklist 4: the v2 writer is the only event writer, because the v1 one re-parses the whole
    // log and drops v2 records.
    appendEvents: (events: readonly EventRecord[]): Promise<void> => appendEventsV2(events),
    broadcast: (snapshot: SessionSnapshot): void => {
      // Rejects when no extension page is open to hear it, which is fine.
      chrome.runtime.sendMessage({ type: 'stateChanged', snapshot }).catch((): undefined => {
        return undefined;
      });
    },
    // Read through `engineInstance` rather than `currentEngine()`: the first publish can land
    // while boot is still assigning the instance, and an idle answer is the right one then.
    workTargetChanged: (): void =>
      broadcastWorkTargetChanged(engineInstance?.workTargetSession()?.sessionId ?? null),
    applyBlocking: applyBlockingFactory(currentEngine),
    playSound: (sound: SoundId): void => {
      void playSound(sound, currentEngine().getSettings().sounds);
    },
    notify,
    updateIcon: (snapshot: SessionSnapshot): void => {
      updateIcon(snapshot, currentEngine().getSettings().badgeCountdown);
    },
    prune: (retentionDays: number, pruneNow: number): Promise<void> =>
      policyStorage.pruneRemoteHistory(deviceId, retentionDays, pruneNow),
    reportError: reportBackgroundError,
    websiteBlockingReady: (): boolean => setupCompleted() && websiteCapability().status === 'ready',
    auditEnforcement: async (): Promise<
      'ready' | 'website-access-lost' | 'content-registration-failed'
    > => {
      if (!setupCompleted()) return 'website-access-lost';
      const state: ContentRegistrationState =
        await reconcileContentRegistrationState(reportBackgroundError);
      if (state.permission !== 'granted') return 'website-access-lost';
      return state.status === 'ready' ? 'ready' : 'content-registration-failed';
    },
    targets: enforcementTargetPortsV2(contentScriptFile),
    transport: {
      sendToDocument: (
        tabId: number,
        documentId: string,
        message: DocumentContentCommand,
      ): Promise<unknown> => chrome.tabs.sendMessage(tabId, message, { documentId }),
    },
    alarms: chromeAlarmPortsV2(),
    browserReset: browserResetSeam(lease),
    loadAggregates: (keys: readonly string[]): Promise<Record<string, DailyAgg>> =>
      loadStoredAggregates(policyStorage, keys),
    clearBlockingForNonBlockingPhase: (): Promise<void> => currentEngine().applyBlockingNow(),
    restoreTabClaims: (claims: readonly CleanupTabClaim[]): Promise<number[]> =>
      restoreClaimedTabs(claims),
    reloadStoppedDocuments: (claims: readonly CleanupTabClaim[]): Promise<void> =>
      reloadClaimedDocuments(claims),
  };
  const engine: Engine = new Engine(
    ports,
    snapshot.settings,
    snapshot.lists,
    snapshot.bank,
    streak,
    runtime,
    deviceId,
  );
  engineInstance = engine;
  // Everything from here on runs against a built Engine, so a throw is an engine-stage failure.
  return bootStage('engine', async (): Promise<Engine> => {
    let appliedCapability: ContentRegistrationState | null = null;
    try {
      appliedCapability = await applyWebsiteCapability(
        policyStorage,
        engine,
        initialWebsiteCapability.capability,
        'boot',
        pendingWebsiteAccessNotice,
        initialCapabilityIsCurrent,
      );
    } catch (error: unknown) {
      reportBackgroundError(error);
    }
    if (appliedCapability === null || !initialCapabilityIsCurrent()) {
      const failClosedCapability: ContentRegistrationState = websiteCapability();
      await endActiveSessionForWebsiteCapabilityLoss(
        engine,
        failClosedCapability.status === 'ready'
          ? { permission: failClosedCapability.permission, status: 'error' }
          : failClosedCapability,
        'boot',
        pendingWebsiteAccessNotice,
      );
    } else {
      pendingWebsiteAccessNotice.value = null;
      publishWebsiteCapability(appliedCapability);
    }
    if (pendingAllDataClear) {
      // The journals resolve on this boot too. A controller that never recovers publishes nothing
      // for the life of the worker, so the retry that finishes the clear would leave the popup and
      // the badge dark until the next eviction.
      await engine.recover();
      await engine.retainDataClearQuiescence();
      return engine;
    }
    // Checklist 6: the journals resolve before any alarm, message, or publication reaches the
    // controller.
    await engine.recover();
    await engine.tick();
    // A window that is already open belongs to this boot, not to the minute after it.
    await engine.checkSchedule();
    await engine.applyBlockingNow();
    return engine;
  });
}

/**
 * Worker entry. Listener registration happens synchronously at the top
 * level (MV3 requirement), state loading hides behind the ready promise
 * every listener awaits.
 */
export function main(): void {
  engineInstance = null;
  let listChangeApplyQueue: Promise<void> = Promise.resolve();
  let policyStorageReady: Promise<PolicyStorage>;
  let ready: Promise<Engine>;
  /** Set when a boot settles in failure, cleared when the next one starts. */
  let bootFailure: BootFailure | null = null;
  let websiteCapability: ContentRegistrationState = {
    permission: 'unknown',
    status: 'unavailable',
  };
  let websiteReconciliationGeneration: number = 0;
  let websiteReconciliationLatest: WebsiteReconciliationRequest | null = null;
  let websiteReconciliationTail: Promise<void> = Promise.resolve();
  let workerControlTail: Promise<void> = Promise.resolve();
  let setupCompleted: boolean = false;
  const pendingWebsiteAccessNotice: PendingWebsiteAccessNotice = { value: null };
  // One deletion lease per worker, built before Policy Storage, Engine, install classification and
  // the lifecycle listener, because every one of them is a caller. The predicate reads the Engine
  // slot this module owns, which is empty until boot fills it.
  const dataClearLease: AllDataClearLease = createAllDataClearLease((): boolean =>
    engineInstance === null ? false : engineInstance.runtimeMutationFrameHeld(),
  );
  const onboardingService: OnboardingService = createOnboardingService({
    loadSetup: async (): Promise<SetupState> => (await policyStorageReady).loadSetup(),
  });

  const reconcileWebsiteCapability = (
    cause: WebsiteCapabilityCause,
    applyToEngine: boolean,
    propagateErrors: boolean = false,
  ): Promise<WebsiteReconciliation> => {
    websiteReconciliationGeneration += 1;
    const generation: number = websiteReconciliationGeneration;
    if (cause === 'permission-removed') {
      websiteCapability = { permission: 'denied', status: 'unavailable' };
    } else if (cause === 'permission-added') {
      websiteCapability = {
        permission: websiteCapability.permission,
        status: websiteCapability.permission === 'denied' ? 'unavailable' : 'error',
      };
    }
    const isCurrent: () => boolean = (): boolean => generation === websiteReconciliationGeneration;
    const reconcile: () => Promise<WebsiteReconciliation> =
      async (): Promise<WebsiteReconciliation> => {
        // A reconcile that a newer generation has already superseded steps aside before it waits
        // on the boot. A retried boot queues its own reconcile behind this one, and its `ready`
        // waits on that, so waiting here would be waiting on itself. The newer generation applies
        // the capability it was minted for, the boot through its own fail-closed cleanup.
        if (!isCurrent()) return { capability: websiteCapability, generation };
        if (cause === 'permission-removed' && applyToEngine) {
          // Permission loss is a fail-closed safety event. A later permission
          // generation may suppress stale setup writes, but never this cleanup.
          const engine: Engine = await ready;
          await endActiveSessionForWebsiteCapabilityLoss(
            engine,
            { permission: 'denied', status: 'unavailable' },
            'permission-removed',
            pendingWebsiteAccessNotice,
          );
        }
        const reconciled: ContentRegistrationState =
          await reconcileContentRegistrationState(reportBackgroundError);
        if (!isCurrent()) return { capability: websiteCapability, generation };
        const candidateCapability: ContentRegistrationState =
          cause === 'permission-removed' && reconciled.permission === 'unknown'
            ? { ...reconciled, permission: 'denied' }
            : reconciled;
        if (!applyToEngine) return { capability: candidateCapability, generation };
        const storage: PolicyStorage = await policyStorageReady;
        if (!isCurrent()) return { capability: websiteCapability, generation };
        const engine: Engine = await ready;
        if (!isCurrent()) return { capability: websiteCapability, generation };
        const appliedCapability: ContentRegistrationState | null = await applyWebsiteCapability(
          storage,
          engine,
          candidateCapability,
          cause,
          pendingWebsiteAccessNotice,
          isCurrent,
        );
        if (!isCurrent() || appliedCapability === null) {
          return { capability: websiteCapability, generation };
        }
        websiteCapability = appliedCapability;
        pendingWebsiteAccessNotice.value = null;
        return { capability: websiteCapability, generation };
      };
    const requested: Promise<WebsiteReconciliation> = websiteReconciliationTail.then(
      reconcile,
      reconcile,
    );
    const settled: Promise<WebsiteReconciliation> = requested.catch(
      (error: unknown): WebsiteReconciliation => {
        reportBackgroundError(error);
        return { capability: websiteCapability, generation };
      },
    );
    websiteReconciliationLatest = { generation, promise: requested };
    websiteReconciliationTail = settled.then((): void => undefined);
    if (!propagateErrors) return settled;
    return (async (): Promise<WebsiteReconciliation> => {
      let current: WebsiteReconciliationRequest = { generation, promise: requested };
      while (true) {
        try {
          const result: WebsiteReconciliation = await current.promise;
          if (current.generation === websiteReconciliationGeneration) return result;
        } catch (error: unknown) {
          if (current.generation === websiteReconciliationGeneration) throw error;
        }
        const latest: WebsiteReconciliationRequest | null = websiteReconciliationLatest;
        if (latest === null || latest.generation === current.generation) {
          throw new Error('website reconciliation generation is unavailable');
        }
        current = latest;
      }
    })();
  };

  const runWorkerControl = <T>(operation: () => Promise<T>): Promise<T> => {
    const requested: Promise<T> = workerControlTail.then(operation, operation);
    workerControlTail = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    return requested;
  };

  const dismissWebsiteAccessNotice = (): Promise<void> => {
    const dismiss = async (): Promise<void> => {
      const storage: PolicyStorage = await policyStorageReady;
      await storage.updateSetup({ websiteAccessNotice: null });
    };
    const requested: Promise<void> = websiteReconciliationTail.then(dismiss, dismiss);
    websiteReconciliationTail = requested.catch((error: unknown): void => {
      reportBackgroundError(error);
    });
    return requested;
  };

  const reconcileAfterPermissionEvent = (cause: WebsiteCapabilityCause): void => {
    void reconcileWebsiteCapability(cause, true).catch(reportBackgroundError);
  };

  chrome.runtime.onInstalled.addListener((details: chrome.runtime.InstalledDetails): void => {
    // Everything the record needs is read in this frame. The worker may be torn down before the
    // first write, which is Chrome's boundary and loses the event, but nothing here reads a value
    // that a later turn could have changed underneath it.
    const submitted: () => Promise<void> = async (): Promise<void> => {
      const intent: PendingInstallLifecycleIntent = captureInstallLifecycleIntent(
        details,
        Date.now(),
        crypto.randomUUID(),
        chrome.runtime.getManifest?.().version ?? 'unknown',
      );
      await submitInstallLifecycle(dataClearLease, intent);
    };
    void runWorkerControl(submitted).catch(reportBackgroundError);
    const openOnboardingIfNeeded: () => Promise<void> = async (): Promise<void> => {
      if (
        details.reason !== 'install' &&
        (await (await policyStorageReady).loadSetup()).completed
      ) {
        return;
      }
      await onboardingService.open();
    };
    void openOnboardingIfNeeded().catch(reportBackgroundError);
  });
  chrome.permissions.onAdded.addListener((permissions: chrome.permissions.Permissions): void => {
    if (isWebsitePermissionEvent(permissions)) reconcileAfterPermissionEvent('permission-added');
  });
  chrome.permissions.onRemoved.addListener((permissions: chrome.permissions.Permissions): void => {
    if (isWebsitePermissionEvent(permissions)) reconcileAfterPermissionEvent('permission-removed');
  });
  /**
   * One boot, re-runnable. Every listener reads `ready` and `policyStorageReady` when it fires
   * rather than when it was registered, so a retry replaces both promises and the listeners follow.
   * A failure settles into `bootFailure`, is reported once here, and rejects `ready` with a typed
   * error the message listener answers from.
   */
  const startBoot = (): void => {
    bootFailure = null;
    engineInstance = null;
    // One settlement per boot. Policy Storage and the Engine promise reject with the same typed
    // error, so every listener that waits on either finds a failure that was already reported.
    let settled: BootFailedError | null = null;
    const settle = (error: unknown): BootFailedError => {
      if (error instanceof BootFailedError) return error;
      if (settled !== null) return settled;
      const failure: BootFailure = bootFailureOf(error, Date.now());
      bootFailure = failure;
      // A half-built Engine is not an authority. The paths that stay open without one, the all-data
      // clear above all, run through the module-level ports instead.
      engineInstance = null;
      reportBackgroundError(error instanceof BootStageError ? error.cause : error);
      settled = new BootFailedError(failure);
      return settled;
    };
    policyStorageReady = preparePolicyStorage(dataClearLease).catch((error: unknown): never => {
      throw settle(error);
    });
    const initialWebsiteCapability: Promise<WebsiteReconciliation> = reconcileWebsiteCapability(
      'boot',
      false,
    );
    const booted: Promise<Engine> = Promise.all([
      policyStorageReady,
      initialWebsiteCapability,
    ]).then(
      ([storage, initialCapability]: [PolicyStorage, WebsiteReconciliation]): Promise<Engine> =>
        boot(
          storage,
          dataClearLease,
          initialCapability,
          (): ContentRegistrationState => websiteCapability,
          (): boolean => initialCapability.generation === websiteReconciliationGeneration,
          (capability: ContentRegistrationState): void => {
            websiteCapability = capability;
          },
          pendingWebsiteAccessNotice,
          (): boolean => setupCompleted,
          (completed: boolean): void => {
            setupCompleted = completed;
          },
        ),
    );
    ready = booted.catch((error: unknown): never => {
      throw settle(error);
    });
    // The failure is answered by whichever request arrives first. Until one does, it must not
    // surface as an unhandled rejection on top of the report above.
    void ready.catch((): undefined => undefined);
  };
  startBoot();

  /** The stored setup, best effort, for a worker that cannot serve it through Policy Storage. */
  const bestEffortSetup = async (): Promise<SetupState> => {
    try {
      const storage: PolicyStorage = await policyStorageReady;
      const setup: SetupState = await storage.loadSetup();
      try {
        const allData: AllDataClearPublicState = await storage.allDataClearPublicState();
        return allData.status === 'idle' ? setup : { ...setup, dataClear: allData };
      } catch {
        return setup;
      }
    } catch {
      // Policy Storage is what failed, so the raw record is the next best answer.
    }
    try {
      const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_SETUP);
      const raw: unknown = stored[LOCAL_SETUP];
      if (isSetupState(raw)) return raw;
    } catch {
      // Nothing readable at all: the default record carries the overlay on its own.
    }
    return structuredClone(DEFAULT_SETUP);
  };

  /**
   * The answers a stopped worker still owes. Setup carries the failure as an overlay the popup
   * reads, never written back. The all-data clear and its retry stay reachable because they are
   * the way out of a profile that cannot boot, and they run without an Engine. Everything else is
   * refused with the reason.
   */
  const routeBootFailure = async (request: Request, failure: BootFailure): Promise<unknown> => {
    switch (request.type) {
      case 'getSetupState': {
        const setup: SetupState = await bestEffortSetup();
        return {
          ...setup,
          storageError: failure.stage === 'runtime' ? 'runtime-boot-failed' : 'boot-failed',
        };
      }
      case 'retryDataClear': {
        try {
          const storage: PolicyStorage = await policyStorageReady;
          if ((await retryAllDataClear(storage, dataClearLease)) === 'ok') {
            return { ok: true, code: 'ok' };
          }
          return {
            ok: false,
            code: 'retry-not-available',
            error: t('notify_data_clear_retry_unavailable'),
          };
        } catch (error: unknown) {
          return { ok: false, code: 'retry-not-available', error: errorMessage(error) };
        }
      }
      case 'clearFocusLockData': {
        if (request.scope !== 'all') {
          return { ...bootFailureRejection(failure), scope: request.scope, status: 'pending' };
        }
        let storage: PolicyStorage | null = null;
        try {
          storage = await policyStorageReady;
          if ((await storage.storageMode()) === 'sync') await storage.selectLocalMode();
          await storage.deleteRemoteData('all');
          await dispatchAllDataClear(storage, dataClearLease);
        } catch (error: unknown) {
          await republishSetupCompleted(storage);
          return { ok: false, error: errorMessage(error), scope: 'all', status: 'pending' };
        }
        setupCompleted = false;
        // The profile is clean now, which is the one repair a boot failure cannot survive, so the
        // worker boots over it on its own rather than waiting for a Retry. The clear succeeded
        // whatever that boot does, and a boot that fails again answers the next request itself.
        startBoot();
        await ready.catch((): undefined => undefined);
        return { ok: true, scope: 'all', status: 'cleared' };
      }
      default:
        return bootFailureRejection(failure);
    }
  };

  /** The router's error-path reload of `setupCompleted`, for a clear that did not finish. */
  const republishSetupCompleted = async (storage: PolicyStorage | null): Promise<void> => {
    if (storage === null) return;
    try {
      const setup: SetupState = await storage.loadSetup();
      const allDataClearPending: boolean =
        setup.dataClear.status !== 'idle' && setup.dataClear.scope === 'all';
      setupCompleted = setup.completed && !allDataClearPending;
    } catch (setupError: unknown) {
      reportBackgroundError(setupError);
    }
  };

  /** Runs the boot again after a failure. Answers only once the new boot has settled. */
  const retryBoot = (): Promise<Ack> =>
    runWorkerControl(async (): Promise<Ack> => {
      if (bootFailure !== null) startBoot();
      try {
        await ready;
        return { ok: true };
      } catch (error: unknown) {
        return error instanceof BootFailedError
          ? bootFailureRejection(error.failure)
          : { ok: false, error: errorMessage(error) };
      }
    });

  /**
   * Parks the stored runtime and its migration checkpoint under the diagnostic key, removes both,
   * and boots again over an empty runtime. The schema marker stays, so the next boot reads an
   * absent runtime rather than a legacy one. A runtime committed inside a policy generation lives
   * in that record, not under `LOCAL_RUNTIME`, so it is refused rather than half removed.
   */
  const resetLocalRuntime = (): Promise<Ack> =>
    runWorkerControl(async (): Promise<Ack> => {
      const failure: BootFailure | null = bootFailure;
      if (failure === null) return { ok: false, error: t('notify_nothing_to_reset') };
      if (failure.stage !== 'runtime') return bootFailureRejection(failure);
      const stored: Record<string, unknown> = await chrome.storage.local.get([
        LOCAL_POLICY_COMMIT,
        LOCAL_RUNTIME,
        LOCAL_RUNTIME_MIGRATION,
      ]);
      const pointer: unknown = stored[LOCAL_POLICY_COMMIT];
      if (isRecord(pointer) && pointer.source === 'generation') {
        return {
          ok: false,
          error: t('notify_runtime_committed_in_generation'),
        };
      }
      const parked: RejectedRuntimeDiagnosticV1 = {
        version: 1,
        reason: 'manual-reset',
        at: Date.now(),
        runtime: truncatedJson(stored[LOCAL_RUNTIME]),
        migration: truncatedJson(stored[LOCAL_RUNTIME_MIGRATION]),
      };
      await chrome.storage.local.set({ [LOCAL_RUNTIME_REJECTED]: parked });
      await chrome.storage.local.remove([LOCAL_RUNTIME, LOCAL_RUNTIME_MIGRATION]);
      startBoot();
      try {
        await ready;
        return { ok: true };
      } catch (error: unknown) {
        return error instanceof BootFailedError
          ? bootFailureRejection(error.failure)
          : { ok: false, error: errorMessage(error) };
      }
    });

  /** The normal path: wait for the boot, then route. A failed boot routes through its own table. */
  const answerRequest = async (
    request: Request,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> => {
    let engine: Engine;
    try {
      engine = await ready;
    } catch (error: unknown) {
      if (!(error instanceof BootFailedError)) throw error;
      const failure: BootFailure = error.failure;
      const failed: () => Promise<unknown> = (): Promise<unknown> =>
        routeBootFailure(request, failure);
      return requiresWorkerControl(request) ? runWorkerControl(failed) : failed();
    }
    const route: () => Promise<unknown> = async (): Promise<unknown> =>
      routeMessage(engine, request, sender, await policyStorageReady, {
        reconcileWebsiteAccess: async (): Promise<ContentRegistrationState> =>
          (await reconcileWebsiteCapability('explicit', true, true)).capability,
        dismissWebsiteAccessNotice,
        openOnboarding: onboardingService.open,
        retryDataClear: async (): Promise<'ok' | 'retry-not-available'> =>
          retryAllDataClear(await policyStorageReady, dataClearLease),
        continueAllDataClear: async (): Promise<void> => {
          await dispatchAllDataClear(await policyStorageReady, dataClearLease);
        },
        loadOnboardingDraft: onboardingService.loadDraft,
        saveOnboardingDraft: onboardingService.saveDraft,
        removeOnboardingDraft: onboardingService.removeDraft,
        reportError: reportBackgroundError,
        setupCompleted: (completed: boolean): void => {
          setupCompleted = completed;
        },
      });
    return requiresWorkerControl(request) ? runWorkerControl(route) : route();
  };

  chrome.runtime.onMessage.addListener(
    (
      msg: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      const request: Request | null = parseRequest(msg);
      if (request === null) {
        // A session command answers in its own result-code shape, which is what the popup reads.
        sendResponse(
          isRecord(msg) && msg.type === 'startSession'
            ? { ok: false, code: 'invalid-request' }
            : { ok: false, error: 'invalid request' },
        );
        return true;
      }
      // The failure channel answers before the boot is consulted: the reason is readable while
      // the worker is stopped, and the two recoveries are what start it again.
      if (request.type === 'getBootFailure') {
        sendResponse({ ok: true, failure: bootFailure });
        return true;
      }
      const answer: Promise<unknown> =
        request.type === 'retryBoot'
          ? retryBoot()
          : request.type === 'resetLocalRuntime' && bootFailure?.stage === 'runtime'
            ? resetLocalRuntime()
            : answerRequest(request, sender);
      answer
        .then((response: unknown): void => sendResponse(response))
        .catch((err: unknown): void => {
          // The asker is told, and so is the log. A boot failure is reported once where it
          // settles, so what lands here is a route that threw on a running worker.
          reportBackgroundError(err);
          sendResponse({ ok: false, error: String(err) });
        });
      return true;
    },
  );

  chrome.storage.onChanged.addListener(
    (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
      if (areaName !== 'sync') return;
      const hasListsChange: boolean = Object.keys(changes).some((key: string): boolean =>
        isListSyncKey(key),
      );
      const prepared: Promise<{
        pendingRemoteKeys: string[];
        storage: PolicyStorage;
        shouldReconcile: boolean;
        snapshot: Record<string, unknown> | undefined;
      } | null> = policyStorageReady.then(
        async (
          storage: PolicyStorage,
        ): Promise<{
          pendingRemoteKeys: string[];
          storage: PolicyStorage;
          shouldReconcile: boolean;
          snapshot: Record<string, unknown> | undefined;
        } | null> => {
          if (!(await storage.inboundSyncAllowed())) return null;
          const shouldReconcile: boolean = hasListsChange
            ? LIST_SYNC_KEYS.some((key: string): boolean => storage.hasPendingRemote(key))
            : false;
          const eventKeys: string[] = [
            ...Object.keys(changes),
            ...(hasListsChange ? LIST_SYNC_KEYS : []),
          ];
          const pendingRemoteKeys: string[] = [
            ...new Set(eventKeys.filter((key: string): boolean => storage.hasPendingRemote(key))),
          ];
          const snapshot: Record<string, unknown> | undefined = hasListsChange
            ? await chrome.storage.sync.get([...LIST_SYNC_KEYS])
            : undefined;
          return { pendingRemoteKeys, storage, shouldReconcile, snapshot };
        },
      );
      const applyChanges = async (): Promise<void> => {
        const inbound = await prepared;
        if (inbound === null) return;
        const engine: Engine = await ready;
        const { pendingRemoteKeys, storage, shouldReconcile, snapshot } = inbound;
        await handleSyncChanges(
          engine,
          changes,
          {
            consume: (key: string, value: unknown): boolean =>
              storage.consumeRemoteEcho(key, value),
          },
          async (key: string, value: unknown): Promise<void> => {
            if (key === SYNC_LISTS) {
              if (!isListsConfig(value)) throw new Error('invalid corrective lists policy');
              await storage.setPolicy('lists', value);
            } else if (key === SYNC_SETTINGS) {
              if (!isSettings(value)) throw new Error('invalid corrective settings policy');
              await storage.setPolicy('settings', value);
            } else if (key === SYNC_BANK) {
              const bank: BankState | null = parseBank(value);
              if (bank === null) throw new Error('invalid corrective bank policy');
              await storage.setPolicy('bank', bank);
            } else if (key === SYNC_STREAK) {
              const streak: StreakState | null = value === null ? null : parseStreak(value);
              if (value !== null && streak === null) {
                throw new Error('invalid corrective streak policy');
              }
              await storage.setPolicy('streak', streak);
            } else {
              await storage.publishRemoteItem(key, value);
            }
          },
          shouldReconcile,
          snapshot,
          storage,
          undefined,
          pendingRemoteKeys,
        );
      };
      const requested: Promise<void> = listChangeApplyQueue.then(applyChanges);
      listChangeApplyQueue = requested.catch((): void => {});
      void requested.catch(reportBackgroundError);
    },
  );

  // One wake, routed by the name it carries: the tick settles, a phase alarm settles its boundary,
  // and each cleanup alarm runs only the journal it belongs to.
  chrome.alarms.onAlarm.addListener((alarm: chrome.alarms.Alarm): void => {
    // The clear's retry is the one wake Engine does not own. It waits for Policy Storage rather
    // than for the Engine, because a boot that is still finishing a clear has no Engine yet, and
    // the dispatcher it enters is the same one that boot and Settings enter.
    if (alarm.name === DATA_CLEAR_RETRY_ALARM) {
      void policyStorageReady
        .then(
          (storage: PolicyStorage): Promise<AllDataClearDispatchV2> =>
            dispatchAllDataClear(storage, dataClearLease),
        )
        .catch(reportBackgroundError);
      return;
    }
    void ready
      .then((engine: Engine): Promise<void> => engine.handleAlarm(alarm.name))
      .catch(reportBackgroundError);
  });

  registerTabListeners((): Promise<Engine> => ready, reportBackgroundError);
  registerWorkTargetListeners(
    (): string | null => engineInstance?.workTargetSession()?.sessionId ?? null,
  );

  chrome.tabs.onRemoved.addListener((tabId: number): void => {
    const invalidationCleanup: Promise<void> = invalidateRemovedTab(tabId);
    void Promise.all([
      invalidationCleanup.catch(reportBackgroundError),
      ready
        .then((engine: Engine): Promise<void> => engine.dropTab(tabId))
        .catch(reportBackgroundError),
    ]);
  });
}
