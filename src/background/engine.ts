import { ALL_CATEGORIES } from '../core/categories';
import {
  buildMatcherCache,
  type CompiledMatcher,
  compileSessionMatcher,
  evaluateUrl,
  type MatcherCacheBundle,
  registrableHost,
  type StoredMatcherCache,
} from '../core/matcher';
import { windowEnd } from '../core/schedule';
import {
  type ResolvedScheduleOccurrenceV2,
  resolveOpenScheduleOccurrencesV2,
} from '../core/schedule-v2';
import { addEvent, capAttempts, emptyDaily } from '../core/stats';
import { emptyStreak } from '../core/streak';
import {
  ATTEMPT_DEBOUNCE_MS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  emptySnapshot,
  rulesFromLists,
  TOP_SITES_DAILY,
} from '../shared/constants';
import type { DocumentContentCommand } from '../shared/enforcement-v2';
import { CoreError } from '../shared/errors';
import { composeSessionRules } from '../shared/session-rules';
import { exactDataEqual } from '../shared/exact-data';
import { t } from '../shared/i18n';
import type {
  Ack,
  CommandResponseV2,
  RetryCleanupResultCodeV2,
  SessionCommandResultCodeV2,
  SoundId,
  StartSessionResponseV2,
} from '../shared/messages';
import { isListsConfig } from '../shared/runtime-validation';
import { syncAggKey } from '../shared/storage-keys';
import { localDateStr, localMonthStr } from '../shared/time';
import type {
  BankState,
  DailyAgg,
  EventRecord,
  GateSettings,
  GateState,
  ListsConfig,
  PauseEconomy,
  ScheduleEntryV2,
  ScheduleOccurrenceRef,
  SessionConfig,
  SessionMode,
  SessionRuleSnapshot,
  SessionSnapshot,
  SessionState,
  Settings,
  SiteUnlock,
  StreakState,
  Strictness,
  ThemeMode,
  Verdict,
} from '../shared/types';
import { WORK_TARGET_ACTION_STALE_ERROR, WORK_TARGET_NOT_SAVED_ERROR } from '../shared/work-target';
import { type AlarmNameV2, type AlarmPortsV2, parseAlarmNameV2, TICK_ALARM } from './alarms-v2';
import type { ContentTransportPortsV2 } from './content-transport-v2';
import type { AllDataClearLease, DataClearLeaseToken } from './data-clear-lease';
import {
  type AllDataClearFinalizationV2,
  type BrowserResetAttemptResultV2,
  type BrowserResetPortsV2,
  finalizeAllDataClearV2,
  runBrowserResetAttemptV2,
} from './data-clear-reset-v2';
import type { EnforcementTargetPortsV2 } from './enforcement-targets-v2';
import { type GuardReasonKey, listsChangeAllowed, settingsChangeAllowed } from './guard';
import {
  applyPendingToLists,
  applyPendingToSettings,
  capturePendingChange,
  LISTS_PATH,
  type PendingIntent,
  type PendingPath,
  type PendingPolicyChange,
  pathForGuardReason,
  pendingListsDelta,
  pendingSettingsValue,
} from './pending-policy-changes';
import { encodeListsForSync, LIST_SYNC_KEYS, type ListsSyncEncoding } from './list-sync-codec';
import type { PolicyValueByKey } from './policy-storage';
import {
  type BackwardDateRebasePlan,
  clockRebaseArchiveKey,
  planBackwardDateRebase,
  planRollover,
  type RolloverPlan,
} from './rollover';
import {
  commitRuntimeCheckpointV2,
  projectRuntimeDomainV2,
  type RuntimeCommitInputV2,
} from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import { emptyRuntimeV2 } from './runtime-store-v2';
import type {
  CleanupTabClaim,
  RuntimeCommitCheckpointV2,
  RuntimeStateV2,
} from './runtime-v2-types';
import type { ScheduleRunnerPortsV2 } from './schedule-runner-v2';
import {
  type DocumentCommandDeliveryV2,
  type SessionControllerEffectsV2,
  SessionControllerV2,
} from './session-controller-v2';
import { settingsWithLocalIntentions } from './settings-sync';
import {
  type DeferredBlockClaim,
  type RuntimeTabState,
  sanitizeRuntimeForLocalHistory,
} from './stores';
import { chooseNewerStreak, rebaseStreakForDate } from './streak-sync';
import { assertSyncItemWithinQuota, SyncQuotaError } from './sync-quota';
import type { WorkSession, WorkTargetFrame, WorkTargetPolicy } from './work-target';

declare const runtimeMutationLeaseBrand: unique symbol;

export interface RuntimeMutationLease {
  readonly [runtimeMutationLeaseBrand]: never;
}

export type BlockingSweepLease = RuntimeMutationLease;

interface DeferredBlockingSweep {
  promise: Promise<void>;
  reject(error: unknown): void;
  resolve(): void;
}

/**
 * What the browser reset needs that the Engine cannot own: the deletion lease, the evidence Policy
 * Storage materialized, the clean-profile identity, and Main's install-lifecycle replay.
 */
export interface BrowserResetEngineSeamV2 {
  lease: AllDataClearLease;
  readMaterialized(): Promise<{ runtime: unknown; setup: unknown; installMarker: unknown }>;
  deviceIdExists(): Promise<boolean>;
  ensureDeviceId(): Promise<string>;
  replayLifecycleIntents(token: DataClearLeaseToken): Promise<'complete' | 'failed'>;
}

export interface EnginePorts {
  now(): number;
  newId(): string;
  /** Recreate and durably store the device identity after an all-data clear. */
  rehydrateAfterDataClear(): Promise<string>;
  saveRuntime(r: RuntimeStateV2): Promise<void>;
  saveMatcherCache(cache: StoredMatcherCache, lists: ListsConfig): Promise<void>;
  /**
   * The weakening edits a hard lock refused. Optional like the other storage seams, so a test
   * harness that owns no storage keeps the queue in memory for the life of its engine.
   */
  loadPendingChanges?(): Promise<PendingPolicyChange[]>;
  savePendingChanges?(changes: readonly PendingPolicyChange[]): Promise<void>;
  savePolicy?<K extends keyof PolicyValueByKey>(key: K, value: PolicyValueByKey[K]): Promise<void>;
  saveAggregate?(key: string, value: DailyAgg): Promise<void>;
  removeAggregate?(key: string): Promise<void>;
  hasPendingSync(key: string): boolean;
  queueSync(key: string, value: unknown): void;
  supersedeSync(key: string, value: unknown): void;
  removeSync(key: string): void;
  persistSyncJournal(): Promise<void>;
  appendEvents(evs: readonly EventRecord[]): Promise<void>;
  broadcast(snapshot: SessionSnapshot): void;
  /**
   * Fired after every session publish and every committed lists change, so the work tab pickers
   * refresh under the policy that now decides which tabs are eligible. Optional, because a worker
   * without work targets owes nobody that fanout.
   */
  workTargetChanged?(): void;
  applyBlocking(lease: BlockingSweepLease): Promise<void>;
  playSound(sound: SoundId): void;
  notify(title: string, message: string): void;
  updateIcon(snapshot: SessionSnapshot): void;
  /** run the weekly sync-storage retention prune */
  prune(retentionDays: number, now: number): Promise<void>;
  reportError(error: unknown): void;
  /**
   * The Main-owned half of the browser reset. While it is unbound the all-data clear ends at its
   * storage phases, which is what every caller before this slice expected. Once Main binds it, the
   * clear keeps the barrier closed until the journal is gone.
   */
  browserReset?: BrowserResetEngineSeamV2;
  /** Live website-blocking capability. */
  websiteBlockingReady(): boolean;
  /** The v2 enforcement seam: the browser surfaces the controller drives through this engine. */
  auditEnforcement(): Promise<'ready' | 'website-access-lost' | 'content-registration-failed'>;
  targets: EnforcementTargetPortsV2;
  transport: ContentTransportPortsV2;
  alarms: AlarmPortsV2;
  /** Stored daily aggregates by `syncAggKey`, for the closure that splits across a midnight. */
  loadAggregates(keys: readonly string[]): Promise<Record<string, DailyAgg>>;
  /** Clears blocking for a phase that blocks nothing, through the existing serialized sweep. */
  clearBlockingForNonBlockingPhase(): Promise<void>;
  restoreTabClaims(claims: readonly CleanupTabClaim[]): Promise<number[]>;
  reloadStoppedDocuments(claims: readonly CleanupTabClaim[]): Promise<void>;
}

export interface LiveTabState {
  url: string;
  mutedByExtension: boolean;
  documentId?: string | null;
}

export interface EngineStatsOverlay {
  deviceId: string;
  todayAgg: DailyAgg;
  streak: StreakState | null;
  pendingEvents: EventRecord[];
}

export type SessionMatcherCompiler = (
  rules: SessionRuleSnapshot,
  categories: typeof ALL_CATEGORIES,
  mode: SessionConfig['mode'],
) => CompiledMatcher;

interface AttemptDurability {
  revision: number;
  durable: boolean;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

const _NO_SESSION_VERDICT: Verdict = {
  blocked: false,
  reason: 'no-session',
  categoryId: null,
  matchedPattern: null,
};

function _strictnessStrength(strictness: Strictness): number {
  if (strictness === 'flexible') return 0;
  if (strictness === 'friction') return 1;
  return 2;
}

function _scheduleOccurrenceToken(entry: ScheduleEntryV2, now: number): string {
  const endsAt: number = windowEnd(entry, new Date(now)).getTime();
  return `${entry.id}@${endsAt}`;
}

function _scheduleUnavailableNoticeToken(entry: ScheduleEntryV2, now: number): string {
  const [hour, minute]: number[] = entry.start.split(':').map(Number);
  const occurrenceStart: Date = new Date(now);
  occurrenceStart.setHours(hour ?? 0, minute ?? 0, 0, 0);
  if (occurrenceStart.getTime() > now) occurrenceStart.setDate(occurrenceStart.getDate() - 1);
  return `${entry.id}@${occurrenceStart.getTime()}`;
}

/**
 * The retained engine. The controller owns the session; this class owns the day, the attempt
 * bookkeeping, the tab claims, the bank, and the streak, and it wires the controller to storage and
 * to browser effects through `EnginePorts`. Every public entry point takes the policy mutation
 * queue, so one command, alarm, or navigation finishes its writes before the next one starts.
 */
/**
 * The event one aggregate fold sees. A terminal event contributes its outcome count and never its
 * focus, because the Engine credits settled focus into the day itself and folding the event's own
 * focus again would count the same minutes twice. The two v1 terminal events and the single v2 end
 * event are the same kind of event to that rule, so the rule names all three rather than the two
 * that happen to reach this path today.
 */
export function aggregatedFocusEventV2(event: EventRecord): EventRecord {
  if (event.t === 'sessionCompleted' || event.t === 'sessionCanceled') {
    return { ...event, focusedMs: 0 };
  }
  return event.t === 'sessionEnded' ? { ...event, focusedMs: 0 } : event;
}

export class Engine {
  private pendingEvents: EventRecord[] = [];
  private dirty = false;
  private needsBlocking = false;
  private commitQueue: Promise<void> = Promise.resolve();
  private blockingMutationPersistQueue: Promise<void> = Promise.resolve();
  private domainPersistRevision: number = 0;
  private attemptRevision = 0;
  private attemptPersistInFlight: Map<string, Set<AttemptDurability>> = new Map();
  private failedAttemptPersistence: Set<string> = new Set();
  /**
   * How much of `accruedFocusMs` the daily aggregate already counts. The controller advances the
   * accrual as it settles, the Engine owns the day, and the gap between the two is what a credit
   * folds in. It is a field rather than a per-call capture because the day may be closed inside a
   * settle, and the focus that settle produced belongs to the day it happened on.
   */
  private creditedFocusMs: number = 0;
  /**
   * Attempts a quiesced barrier could not write yet. The barrier is storage bookkeeping the user
   * cannot see, and a blocked navigation they made is an attempt the day owes them, so it waits
   * here rather than being dropped.
   */
  private deferredAttempts: Array<{ url: string; tabId: number; kind: 'navigation' | 'existing' }> =
    [];
  private runtimePersistQueue: Promise<void> = Promise.resolve();
  private activeRuntimeMutationLeases: Set<RuntimeMutationLease> = new Set();
  /** Depth of the synchronous frames of runtime-mutation callbacks running right now. */
  private runtimeMutationFrames: number = 0;
  private runtimeMutationsInFlight: Set<Promise<void>> = new Set();
  private deferredBlockingSweep: DeferredBlockingSweep | null = null;
  private deferredBlockingSweepRequested = false;
  private bankDirty = false;
  private streakDirty = false;
  private bankRevision = 0;
  private ownedRuntimeSnapshot: RuntimeStateV2;
  private policyMutationQueue: Promise<void> = Promise.resolve();
  private suppressPolicyPublication = false;
  private pendingAggregateSets: Map<string, DailyAgg> = new Map();
  private pendingAggregateRemoves: Set<string> = new Set();
  private dataClearBarrierState: 'open' | 'draining' | 'quiesced' = 'open';
  private dataClearOperationRunning = false;
  /**
   * True only while an all-data clear owns storage. A clear needs no session, so the pages it
   * is about to erase are served nothing. Every other barrier state, a storage-mode switch or
   * an aggregate drain, keeps serving the live frozen commands: a hard session's pages must
   * not unblock because storage is being switched.
   */
  private allDataClearPending = false;
  private websiteBlockingLossPending = false;
  private readonly controller: SessionControllerV2;
  /** Compiled work target matchers, one per policy and mode, dropped with the rules they serve. */
  private readonly workTargetMatchers: WeakMap<
    SessionRuleSnapshot,
    Map<SessionMode, CompiledMatcher>
  > = new WeakMap<SessionRuleSnapshot, Map<SessionMode, CompiledMatcher>>();
  /** Composed rules per captured snapshot, dropped whole when the saved lists are replaced. */
  private composedRulesCache: WeakMap<SessionRuleSnapshot, SessionRuleSnapshot> = new WeakMap<
    SessionRuleSnapshot,
    SessionRuleSnapshot
  >();
  private composedRulesFor: ListsConfig | null = null;
  /** Weakening edits a hard lock refused, retried whenever the guard's answer could change. */
  private pending: PendingPolicyChange[] = [];
  private flushingPending = false;

  constructor(
    private readonly ports: EnginePorts,
    private settings: Settings,
    private lists: ListsConfig,
    private bank: BankState,
    private streak: StreakState | null,
    private runtime: RuntimeStateV2,
    private deviceId: string,
    private readonly compileSessionPolicy: SessionMatcherCompiler = compileSessionMatcher,
  ) {
    this.applyRemovedTabTombstones();
    const checkpoint: RuntimeCommitCheckpointV2 | null = this.runtime.commitCheckpoint;
    if (checkpoint !== null) {
      this.pendingEvents = [...checkpoint.events];
      for (const [key, value] of Object.entries(checkpoint.aggregateSets ?? {})) {
        this.pendingAggregateSets.set(key, capAttempts(value, TOP_SITES_DAILY));
      }
      for (const key of checkpoint.aggregateRemoves ?? []) this.pendingAggregateRemoves.add(key);
      if (checkpoint.syncBank) {
        this.bank = checkpoint.bank;
        this.bankDirty = true;
        this.bankRevision = 1;
      }
      this.dirty = true;
    }
    this.setSettingsAndClampBank(this.settings);
    // A v2 runtime always carries its session identity, so the legacy assignment branch is gone
    // with the migration that mints it.
    this.controller = new SessionControllerV2(
      this.runtimePorts(),
      this.scheduleRunnerPorts(),
      this.controllerEffects(),
    );
    this.ownedRuntimeSnapshot = structuredClone(this.runtime);
    // The stored day already counts the stored accrual, so this boot credits only what it settles.
    this.creditedFocusMs = this.runtime.accruedFocusMs;
  }

  /** Everything the controller is not allowed to own, bound to this engine and its ports. */
  private runtimePorts(): RuntimePortsV2 {
    return {
      now: (): number => this.ports.now(),
      newId: (): string => this.ports.newId(),
      runtime: (): RuntimeStateV2 => this.runtime,
      writeRuntime: (next: RuntimeStateV2): Promise<void> => this.adoptRuntime(next),
      commit: (input: RuntimeCommitInputV2): Promise<RuntimeStateV2> => this.commitRuntime(input),
      auditEnforcement: (): Promise<
        'ready' | 'website-access-lost' | 'content-registration-failed'
      > => this.ports.auditEnforcement(),
      compileMatcher: (rules: SessionRuleSnapshot, mode: SessionMode): CompiledMatcher =>
        this.compileSessionPolicy(this.composedRules(rules), ALL_CATEGORIES, mode),
      verdictFor: (
        matcher: CompiledMatcher,
        url: string,
        unlocks: readonly SiteUnlock[],
      ): Verdict => evaluateUrl(matcher, url, [...unlocks], this.ports.now()),
      targets: this.ports.targets,
      transport: this.ports.transport,
      alarms: this.ports.alarms,
      theme: (): ThemeMode => this.settings.theme,
      economy: (): PauseEconomy => structuredClone(this.settings.pause),
      gateSettings: (): GateSettings => structuredClone(this.settings.gate),
      bank: (): BankState => structuredClone(this.bank),
      deviceId: (): string => this.deviceId,
      attemptsToday: (): number => attemptsTodayOf(this.runtime.todayAgg),
      openOccurrencesAt: (at: number): ScheduleOccurrenceRef[] =>
        resolveOpenScheduleOccurrencesV2(this.settings.schedule, at).map(
          (resolved: ResolvedScheduleOccurrenceV2): ScheduleOccurrenceRef => resolved.occurrence,
        ),
      loadAggregates: (keys: readonly string[]): Promise<Record<string, DailyAgg>> =>
        this.ports.loadAggregates(keys),
      rolloverCheck: (boundary: number): Promise<void> => this.rolloverCheck(boundary),
      reportError: (error: unknown): void => this.ports.reportError(error),
    };
  }

  private scheduleRunnerPorts(): ScheduleRunnerPortsV2 {
    return {
      settings: (): Settings => this.settings,
      lists: (): ListsConfig => this.lists,
      websiteBlockingReady: (): boolean => this.ports.websiteBlockingReady(),
      notify: (title: string, body: string): void => this.ports.notify(title, body),
      playSound: (sound: 'scheduleStart'): void => this.ports.playSound(sound),
    };
  }

  private controllerEffects(): SessionControllerEffectsV2 {
    return {
      broadcast: (snapshot: SessionSnapshot): void => {
        this.ports.broadcast(snapshot);
        // Every publish is a session boundary or a gate move, so it is also the moment a lock may
        // have given way and a held edit may have become allowed.
        this.requestPendingFlush();
        // Every publish is a session boundary or a gate move, and each one changes which tab can
        // be the work tab, so the pickers refresh with the same beat as the popup.
        this.ports.workTargetChanged?.();
      },
      updateBadge: (snapshot: SessionSnapshot): void => this.ports.updateIcon(snapshot),
      playSound: (sound: SoundId): void => this.ports.playSound(sound),
      notify: (title: string, body: string): void => this.ports.notify(title, body),
      // The sweep reads the controller for every target, and this effect runs inside a controller
      // command, so awaiting it here would deadlock the queue against itself. The clear is
      // requested and runs as soon as the command that asked for it lets the queue go.
      clearBlockingForNonBlockingPhase: async (): Promise<void> => {
        void this.sweepAfterPhaseChange();
      },
      // An attempt lands in today's aggregate, which is the storage a quiesced barrier is busy
      // rewriting, so the write waits for the barrier rather than joining it. The frozen command
      // still goes out either way, because a live session's pages must not unblock for a storage
      // switch. A draining barrier has not taken storage yet and waits for this write like any
      // other, so that one still runs.
      recordAttempt: (
        url: string,
        tabId: number,
        kind: 'navigation' | 'existing',
      ): Promise<void> => {
        if (this.dataClearBarrierState !== 'quiesced') {
          return this.recordAttempt(url, tabId, kind);
        }
        this.deferredAttempts.push({ url, tabId, kind });
        return Promise.resolve();
      },
      markStoppedPage: (tabId: number, url: string, documentId: string): Promise<void> =>
        this.markStopped(tabId, url, documentId),
      restoreTabClaims: (claims: readonly CleanupTabClaim[]): Promise<number[]> =>
        this.ports.restoreTabClaims(claims),
      reloadStoppedDocuments: (claims: readonly CleanupTabClaim[]): Promise<void> =>
        this.ports.reloadStoppedDocuments(claims),
      requestBlankBadge: (): void => this.ports.updateIcon(emptySnapshot(this.ports.now())),
    };
  }

  /** One durable runtime write, which the controller owns the content of. */
  private async adoptRuntime(next: RuntimeStateV2): Promise<void> {
    this.runtime = structuredClone(next);
    this.ownedRuntimeSnapshot = structuredClone(next);
    this.followAccrualReset();
    await this.ports.saveRuntime(this.runtime);
  }

  /**
   * A closure sets the accrual back to zero, and it does that inside a command rather than a
   * settle, so the watermark follows it down here. Without this the next session's focus is
   * measured against a watermark the closure already retired, and its first minutes vanish.
   */
  private followAccrualReset(): void {
    if (this.runtime.accruedFocusMs < this.creditedFocusMs) {
      this.creditedFocusMs = this.runtime.accruedFocusMs;
    }
  }

  /**
   * Folds the events one commit carries into the day they happened on, which is what the v1
   * `recordEvent` did. The ended family is left out: a closure computes those counters itself and
   * writes them as absolute aggregate values, so folding them here would count them twice.
   */
  private foldCommittedEvents(events: readonly EventRecord[]): void {
    const counted: EventRecord[] = events.filter(
      (event: EventRecord): boolean =>
        event.t !== 'sessionEnded' &&
        event.t !== 'sessionCompleted' &&
        event.t !== 'sessionCanceled',
    );
    if (counted.length === 0) return;
    let aggregate: DailyAgg = this.runtime.todayAgg ?? emptyDaily(this.runtime.date);
    for (const event of counted) aggregate = addEvent(aggregate, event);
    this.runtime.todayAgg = aggregate;
  }

  /** One durable checkpoint, through the same writers the retained engine commits with. */
  private async commitRuntime(input: RuntimeCommitInputV2): Promise<RuntimeStateV2> {
    this.foldCommittedEvents(input.events);
    const committed: RuntimeStateV2 = await commitRuntimeCheckpointV2(
      {
        saveRuntime: (runtime: RuntimeStateV2): Promise<void> => this.ports.saveRuntime(runtime),
        // The Engine holds the runtime too, and it writes its own fields onto whatever it holds.
        // Taking the checkpoint here means a write of its own during the replay carries the commit
        // forward rather than storing the state that preceded it.
        publishCheckpointRuntime: (runtime: RuntimeStateV2): void => {
          this.runtime = structuredClone(runtime);
          this.ownedRuntimeSnapshot = structuredClone(runtime);
          this.followAccrualReset();
        },
        appendEvents: (events: readonly EventRecord[]): Promise<void> =>
          this.ports.appendEvents(events),
        saveBank: (bank: BankState, syncBank: boolean): Promise<void> =>
          this.saveCommittedBank(bank, syncBank),
        saveAggregate: (key: string, value: DailyAgg): Promise<void> =>
          this.saveAggregate(key, value),
        removeAggregate: (key: string): Promise<void> => this.removeAggregate(key),
      },
      this.runtime,
      input,
    );
    this.runtime = committed;
    this.ownedRuntimeSnapshot = structuredClone(committed);
    this.followAccrualReset();
    return committed;
  }

  /**
   * The committed bank is the engine's bank. `savePolicy` is the typed writer that owns whether it
   * reaches sync, so nothing here queues a policy key onto the remote journal by hand.
   */
  private async saveCommittedBank(bank: BankState, syncBank: boolean): Promise<void> {
    this.bank = structuredClone(bank);
    this.bankDirty = this.bankDirty || syncBank;
    await this.savePolicy('bank', this.bank);
  }

  reportError(error: unknown): void {
    this.ports.reportError(error);
  }

  applyBlockingNow(): Promise<void> {
    return this.applyBlockingWithLease();
  }

  /**
   * True only inside the synchronous frame of a runtime-mutation callback. Main binds this as the
   * deletion lease's lock-order predicate, so an acquisition attempted from inside such a callback
   * is refused as the lock-order failure it is, while a mutation that is merely in flight, which
   * the barrier drains on its own, leaves a legitimate acquisition alone.
   */
  runtimeMutationFrameHeld(): boolean {
    return this.runtimeMutationFrames > 0;
  }

  runWithRuntimeMutationLease<T>(
    operation: (lease: RuntimeMutationLease) => Promise<T>,
  ): Promise<T> {
    if (this.dataClearBarrierState !== 'open') {
      return Promise.reject(
        new Error(
          'runtime mutation rejected while storage transition or data clear is in progress',
        ),
      );
    }
    return this.trackRuntimeMutation(operation);
  }

  runWithRuntimeMutationLeaseOrBlockingSweep(
    operation: (lease: RuntimeMutationLease) => Promise<void>,
  ): Promise<void> {
    if (this.dataClearBarrierState === 'open') return this.trackRuntimeMutation(operation);
    if (!this.dataClearOperationRunning) {
      // Navigation still advances the tab inventory before it reaches this gate. The pending
      // clear's next reset enumerates those tabs, so no ordinary runtime mutation is needed here.
      if (this.allDataClearPending) return Promise.resolve();
      return Promise.reject(
        new Error(
          'runtime mutation rejected while storage transition or data clear is in progress',
        ),
      );
    }
    this.deferredBlockingSweepRequested = true;
    if (this.deferredBlockingSweep !== null) return this.deferredBlockingSweep.promise;
    let resolveSweep: () => void = (): void => undefined;
    let rejectSweep: (error: unknown) => void = (): void => undefined;
    const promise: Promise<void> = new Promise<void>(
      (resolve: () => void, reject: (error: unknown) => void): void => {
        resolveSweep = resolve;
        rejectSweep = reject;
      },
    );
    this.deferredBlockingSweep = {
      promise,
      reject: rejectSweep,
      resolve: resolveSweep,
    };
    return promise;
  }

  async runWithDataClearBarrier<T>(
    operation: () => Promise<T>,
    retainQuiescence: () => boolean = (): boolean => false,
  ): Promise<T> {
    if (this.dataClearOperationRunning) throw new Error('all-data clear is already in progress');
    const startingOpen: boolean = this.dataClearBarrierState === 'open';
    this.dataClearOperationRunning = true;
    this.allDataClearPending = true;
    if (startingOpen) this.dataClearBarrierState = 'draining';
    try {
      if (startingOpen) await this.drainRuntimeMutations();
      await this.prepareRuntimeForAllDataClear();
      this.dataClearBarrierState = 'quiesced';
      const result: T = await operation();
      // The storage phases are over, and with the reset seam bound the clear is not: the browser
      // reset and its finalization own the rest, and the barrier stays closed until the journal is
      // gone, so nothing publishes or writes over a profile that is still being erased.
      if (this.ports.browserReset !== undefined) return result;
      await this.resetAfterAllDataClear();
      this.dataClearBarrierState = 'open';
      return result;
    } catch (error: unknown) {
      if (startingOpen && !retainQuiescence()) this.dataClearBarrierState = 'open';
      throw error;
    } finally {
      this.dataClearOperationRunning = false;
      this.allDataClearPending = this.dataClearBarrierState !== 'open';
      if (this.dataClearBarrierState === 'open') {
        await this.applyPendingWebsiteBlockingLoss();
        await this.flushDeferredBlockClaims();
        await this.flushRemovedTabTombstones();
        await this.flushDeferredBlockingSweep();
        await this.flushDeferredAttempts();
      } else {
        this.settleDataClearNavigation();
      }
    }
  }

  /**
   * One browser-reset attempt, under the token the caller already holds. The journal is the only
   * record of its progress, so this answers what the caller owes next and writes nothing else.
   */
  async runBrowserResetAttempt(token: DataClearLeaseToken): Promise<BrowserResetAttemptResultV2> {
    return runBrowserResetAttemptV2(this.browserResetPorts(), token);
  }

  /**
   * Ends the clear. The barrier opens only for `removed`, which is the one answer that means the
   * journal is gone, and the in-memory reset happens there rather than when the phases finished.
   */
  async finalizeAllDataClear(): Promise<AllDataClearFinalizationV2> {
    return finalizeAllDataClearV2({
      ...this.browserResetPorts(),
      // The in-memory reset runs while the deletion lease is still held, so nothing can begin a
      // second clear against an Engine that is half reset.
      afterRemoval: async (runtime: RuntimeStateV2): Promise<void> => {
        await this.resetAfterAllDataClear(runtime);
        this.openRuntimeMutationBarrier();
        await this.applyPendingWebsiteBlockingLoss();
        await this.flushDeferredAttempts();
      },
    });
  }

  /** The reset ports: Main's half, plus the browser seams the Engine already holds. */
  private browserResetPorts(): BrowserResetPortsV2 {
    const seam: BrowserResetEngineSeamV2 | undefined = this.ports.browserReset;
    if (seam === undefined) {
      throw new CoreError('invalid-rule', 'the browser reset needs its Main-owned seam');
    }
    return {
      lease: seam.lease,
      now: (): number => this.ports.now(),
      newId: (): string => this.ports.newId(),
      targets: this.ports.targets,
      transport: this.ports.transport,
      alarms: this.ports.alarms,
      readMaterialized: (): Promise<{
        runtime: unknown;
        setup: unknown;
        installMarker: unknown;
      }> => seam.readMaterialized(),
      deviceIdExists: (): Promise<boolean> => seam.deviceIdExists(),
      ensureDeviceId: (): Promise<string> => seam.ensureDeviceId(),
      replayLifecycleIntents: (token: DataClearLeaseToken): Promise<'complete' | 'failed'> =>
        seam.replayLifecycleIntents(token),
      reportError: (error: unknown): void => this.ports.reportError(error),
    };
  }

  async retainDataClearQuiescence(): Promise<void> {
    if (this.dataClearOperationRunning || this.dataClearBarrierState !== 'open') {
      throw new Error('another storage transition is already in progress');
    }
    this.dataClearOperationRunning = true;
    this.allDataClearPending = true;
    this.dataClearBarrierState = 'draining';
    try {
      await this.drainRuntimeMutations();
      this.dataClearBarrierState = 'quiesced';
    } finally {
      this.dataClearOperationRunning = false;
      this.settleDataClearNavigation();
    }
  }

  async runWithLocalHistoryClear(
    operation: () => Promise<boolean>,
    finish: () => Promise<void>,
  ): Promise<boolean> {
    return this.runWithAggregateStorageBarrier(async (): Promise<boolean> => {
      const aggregatesCleared: boolean = await operation();
      this.runtime = sanitizeRuntimeForLocalHistory(this.runtime, aggregatesCleared);
      this.pendingEvents = [];
      this.pendingAggregateSets.clear();
      this.pendingAggregateRemoves.clear();
      this.ownedRuntimeSnapshot = structuredClone(this.runtime);
      await this.persistRuntime();
      await finish();
      return aggregatesCleared;
    });
  }

  async runWithAggregateStorageBarrier<T>(operation: () => Promise<T>): Promise<T> {
    if (this.dataClearOperationRunning) {
      throw new Error('another storage transition is already in progress');
    }
    if (this.dataClearBarrierState !== 'open') {
      throw new Error('another storage transition is already in progress');
    }
    this.dataClearOperationRunning = true;
    this.dataClearBarrierState = 'draining';
    try {
      await this.drainRuntimeMutations();
      if (this.dirty) await this.commit(this.ports.now());
      await this.drainRuntimeMutations();
      this.dataClearBarrierState = 'quiesced';
      return await operation();
    } finally {
      let barrierReopened: boolean = false;
      try {
        await this.flushDeferredBlockClaims();
        await this.flushRemovedTabTombstones();
        await this.flushDeferredBlockingSweep(true);
        barrierReopened = true;
      } finally {
        if (!barrierReopened) {
          this.openRuntimeMutationBarrier();
          this.rejectDeferredBlockingSweep(
            new Error('runtime reconciliation cancelled while the storage barrier reopened'),
          );
        }
      }
      await this.applyPendingWebsiteBlockingLoss();
      await this.flushDeferredAttempts();
    }
  }

  /**
   * The public read model. The controller settles the core state through `at` in memory, so this
   * stays pure and every caller sees the phase the user is in.
   */
  snapshot(): SessionSnapshot {
    const now: number = this.ports.now();
    if (this.dataClearBarrierState === 'open' && this.dirty) this.commitInBackground(now);
    return this.controller.snapshot(now);
  }

  async snapshotPersisted(): Promise<SessionSnapshot> {
    return this.enqueuePolicyMutation((): Promise<SessionSnapshot> => this.snapshotPersistedNow());
  }

  private async snapshotPersistedNow(): Promise<SessionSnapshot> {
    const now: number = this.ports.now();
    if (this.dirty) await this.commit(now);
    else await this.commitQueue;
    return this.controller.snapshot(this.ports.now());
  }

  /** Resolves the durable journals once, before any alarm or message reaches the controller. */
  async recover(): Promise<void> {
    await this.controller.recover();
    this.pending = (await this.ports.loadPendingChanges?.()) ?? [];
    // A browser closed while a hard lock ran is the common way an edit is still owed at boot.
    await this.enqueuePolicyMutation((): Promise<void> => this.flushPendingChanges());
  }

  /**
   * `afterStart` runs inside the start's own mutation frame with the session id the controller
   * just minted, which is how the work tab picker binds its choice to the right session without
   * that id ever travelling through `SessionConfigV2`.
   */
  async startSession(
    config: SessionConfig,
    afterStart?: (sessionId: string) => Promise<Ack>,
  ): Promise<StartSessionResponseV2> {
    // A profile that is being erased has no session to start, and the queue behind this barrier
    // would refuse the write anyway, with a message the popup cannot render.
    if (this.allDataClearPending) {
      return { ok: false, code: 'data-clear-pending', error: 'data-clear-pending' };
    }
    return this.enqueuePolicyMutation(async (): Promise<StartSessionResponseV2> => {
      const started: StartSessionResponseV2 = await this.controller.startSession(config);
      const response: StartSessionResponseV2 =
        started.ok && afterStart !== undefined ? await this.settleAfterStart(afterStart) : started;
      await this.sweepAfterPhaseChange();
      return response;
    });
  }

  /**
   * The session is live by the time this runs, so a refused or failed hook cannot undo it: the
   * answer says so with its own code and the popup shows the session with the tab left to choose.
   */
  private async settleAfterStart(
    afterStart: (sessionId: string) => Promise<Ack>,
  ): Promise<StartSessionResponseV2> {
    const sessionId: string | undefined = this.runtime.session?.sessionId;
    const notSaved = (error: string): StartSessionResponseV2 => ({
      ok: false,
      code: 'work-target-not-saved',
      error,
    });
    if (sessionId === undefined) {
      this.ports.reportError(new Error('a started session has no identity to bind a work tab to'));
      return notSaved(WORK_TARGET_NOT_SAVED_ERROR);
    }
    try {
      const saved: Ack = await afterStart(sessionId);
      return saved.ok ? { ok: true, code: 'ok' } : notSaved(saved.error);
    } catch (error: unknown) {
      this.ports.reportError(error);
      return notSaved(WORK_TARGET_NOT_SAVED_ERROR);
    }
  }

  hasActiveSession(): boolean {
    return this.controller.hasActiveSession();
  }

  /**
   * The live session as the work tab pickers see it: its identity and the rules it is judged by.
   * Those are the composed rules, not the captured ones, so a tab a saved edit has just blocked
   * stops being offered as a work tab.
   */
  workTargetSession(): WorkSession | null {
    const session: SessionState | null = this.runtime.session;
    if (session === null) return null;
    return {
      sessionId: session.sessionId,
      mode: session.config.mode,
      rules: this.composedRules(session.config.rules),
    };
  }

  /** What a picker lists under before a session exists: the draft's rules, else the saved lists. */
  workTargetDraftPolicy(mode: SessionMode, rules?: SessionRuleSnapshot): WorkTargetPolicy {
    return { mode, rules: rules ?? rulesFromLists(this.lists) };
  }

  /**
   * Whether a tab at `url` may be the work tab under `policy`. Temporary unlocks never count: a
   * page that is only open because a pause or a site unlock let it through is not a place to
   * return to once the unlock ends.
   */
  workTargetAllowed(url: string, policy: WorkTargetPolicy): boolean {
    return !evaluateUrl(this.workTargetMatcher(policy), url, [], this.ports.now()).blocked;
  }

  /**
   * The live rules for one captured snapshot: the saved lists as they stand now, carrying the
   * session's own overrides. Every verdict site reaches its matcher through the `compileMatcher`
   * port, so composing here is what makes a saved list edit reach the session already running.
   * The cache is keyed by the snapshot and dropped whole when the saved lists are replaced.
   */
  private composedRules(rules: SessionRuleSnapshot): SessionRuleSnapshot {
    if (this.composedRulesFor !== this.lists) {
      this.composedRulesCache = new WeakMap<SessionRuleSnapshot, SessionRuleSnapshot>();
      this.composedRulesFor = this.lists;
    }
    const cached: SessionRuleSnapshot | undefined = this.composedRulesCache.get(rules);
    if (cached !== undefined) return cached;
    const composed: SessionRuleSnapshot = composeSessionRules(this.lists, rules);
    this.composedRulesCache.set(rules, composed);
    return composed;
  }

  private workTargetMatcher(policy: WorkTargetPolicy): CompiledMatcher {
    let byMode: Map<SessionMode, CompiledMatcher> | undefined = this.workTargetMatchers.get(
      policy.rules,
    );
    if (byMode === undefined) {
      byMode = new Map<SessionMode, CompiledMatcher>();
      this.workTargetMatchers.set(policy.rules, byMode);
    }
    let matcher: CompiledMatcher | undefined = byMode.get(policy.mode);
    if (matcher === undefined) {
      matcher = this.compileSessionPolicy(policy.rules, ALL_CATEGORIES, policy.mode);
      byMode.set(policy.mode, matcher);
    }
    return matcher;
  }

  /**
   * Runs one work target action on the policy mutation queue for the session the caller named.
   * Holding the queue is what makes the action's session checks sound: no start, end or gate
   * command can commit while it runs. The frame carries the one session command the action may
   * need in there, because the queued `abandonGate` would wait behind the frame that holds it.
   */
  async runWorkTargetAction(
    sessionId: string,
    action: (frame: WorkTargetFrame) => Promise<Ack>,
  ): Promise<Ack> {
    return this.enqueuePolicyMutation(async (): Promise<Ack> => {
      await this.snapshotPersistedNow();
      if (this.runtime.session?.sessionId !== sessionId) {
        return { ok: false, error: WORK_TARGET_ACTION_STALE_ERROR };
      }
      return action({
        gate: (): GateState | null => this.controller.snapshot(this.ports.now()).gate,
        abandonGate: (
          expectedGate: GateState,
        ): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
          this.controller.abandonGate(expectedGate),
      });
    });
  }

  async endSessionForWebsiteBlockingLoss(): Promise<boolean> {
    if (this.dataClearBarrierState !== 'open') {
      return this.endSessionForWebsiteBlockingLossDuringBarrier();
    }
    return this.enqueuePolicyMutation(async (): Promise<boolean> => {
      if (!this.controller.hasActiveSession()) return false;
      await this.controller.endForEnforcementLoss('website-access-lost');
      return true;
    });
  }

  /**
   * The barrier is closed, so no runtime write may land. The loss is remembered and applied when
   * the barrier reopens; the pages are cleared right away, because the session is over for the user.
   */
  private async endSessionForWebsiteBlockingLossDuringBarrier(): Promise<boolean> {
    if (!this.controller.hasActiveSession()) return false;
    this.domainPersistRevision += 1;
    this.websiteBlockingLossPending = true;
    const snapshot: SessionSnapshot = this.controller.snapshot(this.ports.now());
    this.ports.broadcast(snapshot);
    this.ports.updateIcon(snapshot);
    try {
      await this.applyBlockingWithLease();
    } catch (error: unknown) {
      this.ports.reportError(error);
    }
    return true;
  }

  private async applyPendingWebsiteBlockingLoss(): Promise<void> {
    if (!this.websiteBlockingLossPending) return;
    this.websiteBlockingLossPending = false;
    try {
      await this.controller.endForEnforcementLoss('website-access-lost');
    } catch (error: unknown) {
      this.websiteBlockingLossPending = true;
      this.ports.reportError(error);
    }
  }

  async requestSessionEnd(): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.commandWithSweep(
          (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
            this.controller.requestSessionEnd(),
        ),
    );
  }

  async openEndGate(): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> => this.controller.openEndGate(),
    );
  }

  /** The force end closes the session like `requestSessionEnd`, so it sweeps blocking the same way. */
  async forceEndGate(): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.commandWithSweep(
          (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
            this.controller.forceEndGate(),
        ),
    );
  }

  async openGate(
    gate: 'pause' | 'unlockSite',
    host: string | null,
  ): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.controller.openGate(gate, host),
    );
  }

  async confirmGate(
    typedPhrase: string | null,
    expectedGate?: import('../shared/types').GateState,
  ): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      async (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> => {
        const response: CommandResponseV2<SessionCommandResultCodeV2> =
          await this.controller.confirmGate(typedPhrase, expectedGate);
        if (response.ok) await this.sweepAfterPhaseChange();
        return response;
      },
    );
  }

  async abandonGate(
    expectedGate?: import('../shared/types').GateState,
  ): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.controller.abandonGate(expectedGate),
    );
  }

  async resumeFromPause(): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.commandWithSweep(
          (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
            this.controller.resumeFromPause(),
        ),
    );
  }

  async startNextFocusEarly(): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.commandWithSweep(
          (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
            this.controller.startNextFocusEarly(),
        ),
    );
  }

  async retryTransitionCleanup(): Promise<CommandResponseV2<RetryCleanupResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<RetryCleanupResultCodeV2>> =>
        this.controller.retryTransitionCleanup(),
    );
  }

  async retryClosureCleanup(): Promise<CommandResponseV2<RetryCleanupResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<RetryCleanupResultCodeV2>> =>
        this.controller.retryClosureCleanup(),
    );
  }

  /** One alarm, routed by name to the journal or the settlement that owns it. */
  async handleAlarm(name: string): Promise<void> {
    // A name no alarm owns wakes nothing, sweep included.
    const alarm: AlarmNameV2 | null = parseAlarmNameV2(name);
    if (alarm === null) return;
    await this.enqueuePolicyMutation(async (): Promise<void> => {
      await this.controller.handleAlarm(name);
      this.creditSettledFocus();
      if (this.dirty) await this.commit(this.ports.now());
      // The minute alarm is the Engine's maintenance window as well as the controller's. It runs
      // second, so a session boundary is never held behind a prune, and it cannot fail the tick:
      // a settled session must not be lost because a retention prune was refused.
      if (alarm === TICK_ALARM) {
        try {
          await this.runEngineMaintenance(this.ports.now());
        } catch (error: unknown) {
          this.ports.reportError(error);
        }
      }
      await this.sweepAfterPhaseChange();
    });
  }

  /**
   * One command, then the tab sweep it implies. The frozen commands the controller sends are what a
   * document renders; the mute a blocked tab wears and the reload a stopped one needs are browser
   * effects the sweep owns, and a phase change moves both.
   */
  private async commandWithSweep<T>(command: () => Promise<T>): Promise<T> {
    const response: T = await command();
    await this.sweepAfterPhaseChange();
    return response;
  }

  /**
   * What a phase change owes every open document: the frozen views are refrozen for the phase the
   * session is in now, and then the browser effects the sweep owns follow them.
   */
  private async sweepAfterPhaseChange(): Promise<void> {
    try {
      await this.controller.refreshLiveViews();
      await this.applyBlockingWithLease();
    } catch (error: unknown) {
      this.ports.reportError(error);
    }
  }

  /** The commands one document must apply, and the attempt the blocked ones record. */
  async documentCommandsFor(
    target: { tabId: number; documentId: string; url: string },
    attemptKind: 'navigation' | 'existing' | null,
    delivery: DocumentCommandDeliveryV2 = 'read',
  ): Promise<DocumentContentCommand[]> {
    // An all-data clear needs no session, so its pending erase answers nothing and writes nothing.
    // Every other closed state, a mode switch or an aggregate drain, still serves the live command.
    if (this.allDataClearPending) return [];
    return await this.controller.documentCommandsFor(target, attemptKind, delivery);
  }

  async handleNavigation(
    target: { tabId: number; documentId: string; url: string },
    attemptKind: 'navigation' | 'existing' | null,
  ): Promise<void> {
    if (this.allDataClearPending) return;
    await this.controller.handleNavigation(target, attemptKind);
  }

  /** Refreezes every live document view, for a change the frozen views must carry. */
  async refreshLiveViews(): Promise<void> {
    await this.controller.refreshLiveViews();
  }

  /**
   * The same refresh, for the policy paths that only need it while a session is live. An idle
   * profile holds no frozen view worth refreezing.
   */
  private async refreshLiveViewsIfLive(): Promise<void> {
    if (!this.controller.hasActiveSession()) return;
    await this.controller.refreshLiveViews();
  }

  async recordAttempt(
    url: string,
    tabId: number,
    kind: 'navigation' | 'existing',
    lease?: BlockingSweepLease,
  ): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    const now: number = this.ports.now();
    const key: string = `${tabId}:${url}`;
    const last: number | undefined = this.runtime.attemptDebounce[key];
    const persistenceFailed: boolean = this.failedAttemptPersistence.delete(key);
    const retryFailedPersistence: boolean =
      persistenceFailed && last !== undefined && now - last < ATTEMPT_DEBOUNCE_MS;
    if (!retryFailedPersistence && last !== undefined && now - last < ATTEMPT_DEBOUNCE_MS) {
      const inFlight: Set<AttemptDurability> | undefined = this.attemptPersistInFlight.get(key);
      let latest: AttemptDurability | undefined;
      if (inFlight !== undefined) {
        for (const durability of inFlight) latest = durability;
      }
      if (latest !== undefined) await latest.promise;
      return;
    }
    const attemptMarker: number = retryFailedPersistence ? (last ?? now) : now;
    if (!retryFailedPersistence) {
      this.runtime.attemptDebounce[key] = attemptMarker;
      this.recordEvent({
        t: 'attempt',
        at: now,
        url,
        host: hostOf(url),
        tabId,
        kind,
        ...sessionIdentity(this.runtime.session),
      });
      this.dirty = true;
    }
    this.attemptRevision += 1;
    const revision: number = this.attemptRevision;
    let resolveDurability: () => void = (): void => undefined;
    let rejectDurability: (error: unknown) => void = (): void => undefined;
    const durabilityPromise: Promise<void> = new Promise(
      (resolve: () => void, reject: (error: unknown) => void): void => {
        resolveDurability = resolve;
        rejectDurability = reject;
      },
    );
    const durability: AttemptDurability = {
      revision,
      durable: false,
      promise: durabilityPromise,
      resolve: resolveDurability,
      reject: rejectDurability,
    };
    const inFlight: Set<AttemptDurability> =
      this.attemptPersistInFlight.get(key) ?? new Set<AttemptDurability>();
    inFlight.add(durability);
    this.attemptPersistInFlight.set(key, inFlight);
    const leasedSweepMutation: boolean =
      lease !== undefined && this.activeRuntimeMutationLeases.has(lease);
    const persistence: Promise<void> = leasedSweepMutation
      ? this.persistBlockingMutation(revision)
      : this.commit(now);
    void persistence.catch((error: unknown): void => {
      if (durability.durable) {
        this.ports.reportError(error);
      } else {
        if (this.runtime.attemptDebounce[key] === attemptMarker) {
          this.failedAttemptPersistence.add(key);
        }
        durability.reject(error);
      }
    });
    try {
      await durability.promise;
    } finally {
      inFlight.delete(durability);
      if (inFlight.size === 0 && this.attemptPersistInFlight.get(key) === inFlight) {
        this.attemptPersistInFlight.delete(key);
      }
    }
    // Every open overlay shows the day's attempt count, frozen into the command it is rendering,
    // so a count that just moved is a live update like a theme or a lists change.
    if (!retryFailedPersistence) await this.refreshLiveViewsIfLive();
  }

  async markStopped(
    tabId: number,
    _url: string,
    documentId?: string,
    lease?: BlockingSweepLease,
  ): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    if (typeof documentId !== 'string' || documentId === '') return;
    const state: RuntimeTabState | null = this.ensureTabState(tabId);
    if (state === null) return;
    state.stoppedDocumentId = documentId;
    await this.persistRuntime();
  }

  /** Mute and stopped-tab facts for one tab, for tabs.ts action planning. */
  tabFacts(
    tabId: number,
    url: string,
    documentId: string | null = null,
  ): { wasMutedByUs: boolean; priorMuted: boolean; wasStopped: boolean } {
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined) {
      return { wasMutedByUs: false, priorMuted: false, wasStopped: false };
    }
    const wasMutedByUs: boolean = state.priorMuted !== null && state.muteUrl === url;
    return {
      wasMutedByUs,
      priorMuted: wasMutedByUs ? (state.priorMuted ?? false) : false,
      wasStopped:
        documentId !== null && state.stoppedDocumentId !== null
          ? state.stoppedDocumentId === documentId
          : false,
    };
  }

  async claimMute(
    tabId: number,
    url: string,
    priorMuted: boolean,
    lease?: BlockingSweepLease,
  ): Promise<boolean> {
    this.assertRuntimeMutationAllowed(lease);
    if (this.runtime.removedTabTombstones[tabId] === true) return false;
    const existing: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (existing !== undefined && existing.priorMuted !== null && existing.muteUrl !== url) {
      return false;
    }
    const state: RuntimeTabState | null = this.ensureTabState(tabId);
    if (state === null) return false;
    state.muteUrl = url;
    state.priorMuted = priorMuted;
    await this.persistRuntime();
    return true;
  }

  async releaseMuteClaim(tabId: number, url: string, lease?: BlockingSweepLease): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.muteUrl !== url) return;
    state.muteUrl = null;
    state.priorMuted = null;
    this.dropEmptyTabState(tabId, state);
    await this.persistRuntime();
  }

  async transferMuteClaim(
    tabId: number,
    fromUrl: string,
    toUrl: string,
    lease?: BlockingSweepLease,
  ): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined) return;
    if (state.muteUrl === fromUrl) state.muteUrl = toUrl;
    if (state.muteUrl !== toUrl || state.priorMuted === null) return;
    await this.persistRuntime();
  }

  async settleMuteClaim(
    tabId: number,
    finalUrl: string | null,
    lease?: BlockingSweepLease,
  ): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.priorMuted === null) return;
    if (finalUrl === null) {
      state.muteUrl = null;
      state.priorMuted = null;
      this.dropEmptyTabState(tabId, state);
    } else {
      state.muteUrl = finalUrl;
    }
    await this.persistRuntime();
  }

  /** In-memory bookkeeping mutators for tabs.ts, persisted by flushRuntime. */
  noteMuteRestored(tabId: number, url: string, lease?: BlockingSweepLease): void {
    if (!this.runtimeMutationAllowed(lease)) return;
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.muteUrl !== url) return;
    state.muteUrl = null;
    state.priorMuted = null;
    this.dropEmptyTabState(tabId, state);
  }

  noteReloaded(tabId: number, documentId: string, lease?: BlockingSweepLease): void {
    if (!this.runtimeMutationAllowed(lease)) return;
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.stoppedDocumentId !== documentId) return;
    state.stoppedDocumentId = null;
    this.dropEmptyTabState(tabId, state);
  }

  reconcileTabs(
    liveTabs: ReadonlyMap<number, LiveTabState>,
    protectedTabIds: ReadonlySet<number> = new Set(),
    lease?: BlockingSweepLease,
  ): void {
    if (!this.runtimeMutationAllowed(lease)) return;
    for (const [tabIdText, state] of Object.entries(this.runtime.tabStates)) {
      const tabId: number = Number(tabIdText);
      const live: LiveTabState | undefined = liveTabs.get(tabId);
      if (live === undefined) {
        if (protectedTabIds.has(tabId)) continue;
        delete this.runtime.tabStates[tabId];
        continue;
      }
      if (state.priorMuted !== null) {
        if (live.mutedByExtension) state.muteUrl = live.url;
        else {
          state.muteUrl = null;
          state.priorMuted = null;
        }
      }
      if (
        typeof live.documentId === 'string' &&
        state.stoppedDocumentId !== null &&
        live.documentId !== state.stoppedDocumentId
      ) {
        state.stoppedDocumentId = null;
      }
      this.dropEmptyTabState(tabId, state);
    }
  }

  rebindTab(tabId: number, url: string, lease?: BlockingSweepLease): void {
    if (!this.runtimeMutationAllowed(lease)) return;
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state !== undefined && state.priorMuted !== null) state.muteUrl = url;
  }

  flushRuntime(lease?: BlockingSweepLease): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    return this.persistRuntime();
  }

  /**
   * Purges a closed tab from mute, stopped, and debounce bookkeeping, and asks the controller to
   * forget the tab's epoch acknowledgements. Those records are projected domain, so the controller
   * owns the write: an Engine-side edit would be laid over by the controller's snapshot on the
   * next persist. A pending all-data clear is about to replace the runtime, so it writes nothing.
   */
  async dropTab(tabId: number): Promise<void> {
    this.runtime.removedTabTombstones[tabId] = true;
    delete this.runtime.tabStates[tabId];
    for (const key of Object.keys(this.runtime.attemptDebounce)) {
      if (key.startsWith(`${tabId}:`)) {
        delete this.runtime.attemptDebounce[key];
        this.failedAttemptPersistence.delete(key);
      }
    }
    for (const [key, claim] of Object.entries(this.runtime.deferredBlockClaims)) {
      if (claim.tabId === tabId) delete this.runtime.deferredBlockClaims[key];
    }
    await this.persistRuntime();
    if (!this.allDataClearPending) await this.controller.forgetTab(tabId);
  }

  private ensureTabState(tabId: number): RuntimeTabState | null {
    if (this.runtime.removedTabTombstones[tabId] === true) return null;
    const existing: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (existing !== undefined) return existing;
    const created: RuntimeTabState = {
      muteUrl: null,
      priorMuted: null,
      stoppedDocumentId: null,
    };
    this.runtime.tabStates[tabId] = created;
    return created;
  }

  private dropEmptyTabState(tabId: number, state: RuntimeTabState): void {
    if (state.priorMuted === null && state.stoppedDocumentId === null) {
      delete this.runtime.tabStates[tabId];
    }
  }

  /** The 1-minute tick alarm and exact phase alarms both land here. */
  async tick(): Promise<void> {
    return this.enqueuePolicyMutation((): Promise<void> => this.tickNow());
  }

  /**
   * One schedule check, on the queue and in the order the tick uses. The boot runs it once the
   * journals are resolved, and a settings write that moved the schedule runs it as soon as the new
   * schedule is durable, so an open window does not wait for the next minute.
   */
  async checkSchedule(): Promise<void> {
    return this.enqueuePolicyMutation((): Promise<void> => this.checkScheduleNow());
  }

  private async checkScheduleNow(): Promise<void> {
    await this.controller.checkSchedule();
    this.creditSettledFocus();
    if (this.dirty) await this.commit(this.ports.now());
    await this.sweepAfterPhaseChange();
  }

  private async tickNow(): Promise<void> {
    this.creditSettledFocus();
    await this.runEngineMaintenance(this.ports.now());
  }

  /**
   * Everything the minute owes the Engine rather than a session: the claims and tombstones a tab
   * left behind, the attempt debounce, and the weekly retention prune. None of it touches the
   * session, so a boundary never waits for it.
   */
  private async runEngineMaintenance(now: number): Promise<void> {
    await this.flushDeferredBlockClaims();
    await this.flushRemovedTabTombstones();
    this.pruneDebounce(now);
    await this.commit(now);
    await this.maybePrune(now);
    if (this.dirty) await this.commit(now);
    if (this.websiteBlockingLossPending && this.runtime.session === null) {
      this.websiteBlockingLossPending = false;
    }
  }

  /** The weakening edits this profile is still owed, newest last. */
  pendingChanges(): readonly PendingPolicyChange[] {
    return this.pending;
  }

  /** Drops one held edit, for a person who has changed their mind before the lock ends. */
  async cancelPendingChange(path: PendingPath): Promise<Ack> {
    const before: number = this.pending.length;
    this.pending = this.pending.filter((c: PendingPolicyChange): boolean => c.path !== path);
    if (this.pending.length === before) return { ok: false, error: t('options_error_save_settings') };
    await this.persistPendingChanges();
    return { ok: true };
  }

  /**
   * Keeps a refused edit instead of discarding it. A replay is not allowed to rewrite the entry
   * it is replaying: the refusal it meets is the same one already held, and rewriting it would
   * move the time the person asked for it.
   */
  private async holdPendingChange(change: PendingPolicyChange): Promise<void> {
    if (this.flushingPending) return;
    this.pending = capturePendingChange(this.pending, change);
    await this.persistPendingChanges();
  }

  private async persistPendingChanges(): Promise<void> {
    await this.ports.savePendingChanges?.(this.pending);
  }

  /**
   * A held edit applies as soon as it is allowed. The retry is the same write through the same
   * guard, so nothing reaches a hard lock that is still running, and an edit the person made by
   * hand in the meantime is carried by the delta rather than overwritten by it.
   */
  private async flushPendingChanges(): Promise<void> {
    if (this.pending.length === 0 || this.flushingPending) return;
    this.flushingPending = true;
    try {
      for (const change of [...this.pending]) {
        const ack: Ack = await this.replayPendingChange(change);
        if (!ack.ok) continue;
        this.pending = this.pending.filter((c: PendingPolicyChange): boolean => c.path !== change.path);
      }
    } finally {
      this.flushingPending = false;
    }
    await this.persistPendingChanges();
  }

  private async replayPendingChange(change: PendingPolicyChange): Promise<Ack> {
    if (change.path === LISTS_PATH) {
      const intent: PendingIntent = change.intent;
      return this.updateListsNow(applyPendingToLists(this.lists, intent), null, true, false);
    }
    return this.updateSettingsNow(applyPendingToSettings(this.settings, change));
  }

  /** Runs a flush on its own turn of the policy queue, for a caller that cannot await one. */
  private requestPendingFlush(): void {
    if (this.pending.length === 0) return;
    void this.enqueuePolicyMutation((): Promise<void> => this.flushPendingChanges()).catch(
      (error: unknown): void => this.ports.reportError(error),
    );
  }

  async updateSettings(s: Settings): Promise<Ack> {
    return this.enqueuePolicyMutation((): Promise<Ack> => this.updateSettingsNow(s));
  }

  private async updateSettingsNow(s: Settings): Promise<Ack> {
    if (this.ports.savePolicy === undefined) {
      try {
        assertSyncItemWithinQuota('settings', s);
      } catch (error: unknown) {
        if (!(error instanceof SyncQuotaError)) throw error;
        return {
          ok: false,
          error: t('notify_settings_sync_limit'),
        };
      }
    }
    const now: number = this.ports.now();
    const reason: GuardReasonKey | null = settingsChangeAllowed(
      this.runtime.session,
      this.settings,
      s,
    );
    if (reason !== null) {
      const path: PendingPath = pathForGuardReason(reason);
      await this.holdPendingChange({
        path,
        intent: { kind: 'value', value: pendingSettingsValue(s, path) },
        reasonKey: reason,
        at: now,
      });
      return this.fail(now, t(reason));
    }
    const scheduleMoved: boolean = !exactDataEqual(this.settings.schedule, s.schedule);
    try {
      await this.savePolicy('settings', s);
    } catch (error: unknown) {
      if (!(error instanceof SyncQuotaError)) throw error;
      return {
        ok: false,
        error: t('notify_settings_sync_limit'),
      };
    }
    this.setSettingsAndClampBank(s);
    this.dirty = true;
    await this.commit(now);
    // A window the user just saved may already be open, and the schedule check is what starts it.
    // This runs inside the same policy mutation, so the new schedule is durable before it is read.
    if (scheduleMoved) await this.checkScheduleNow();
    return { ok: true };
  }

  async updateTheme(theme: ThemeMode): Promise<Ack> {
    return this.enqueuePolicyMutation(async (): Promise<Ack> => {
      const ack: Ack = await this.updateSettingsNow({ ...this.settings, theme });
      // The frozen views carry the theme, so a change of it is a live update for every document.
      if (ack.ok) await this.refreshLiveViewsIfLive();
      return ack;
    });
  }

  async updateLists(l: ListsConfig): Promise<Ack> {
    return this.enqueuePolicyMutation(async (): Promise<Ack> => {
      if (this.ports.savePolicy === undefined) {
        try {
          await encodeListsForSync(l);
        } catch (error: unknown) {
          if (!(error instanceof SyncQuotaError)) throw error;
          return {
            ok: false,
            error: t('notify_lists_sync_limit'),
          };
        }
      }
      return this.updateListsNow(l, null, true, false);
    });
  }

  private async updateListsNow(
    l: ListsConfig,
    encoding: ListsSyncEncoding | null,
    queueForSync: boolean,
    reconcilePendingSync: boolean,
  ): Promise<Ack> {
    const now: number = this.ports.now();
    const reason: GuardReasonKey | null = listsChangeAllowed(
      this.runtime.session,
      this.runtime.session?.config.mode ?? null,
      this.lists,
      l,
    );
    if (reason !== null) {
      await this.holdPendingChange({
        path: LISTS_PATH,
        intent: pendingListsDelta(this.lists, l),
        reasonKey: reason,
        at: now,
      });
      return this.fail(now, t(reason));
    }
    const bundle: MatcherCacheBundle = buildMatcherCache(l, ALL_CATEGORIES);
    await this.ports.saveMatcherCache(bundle.stored, l);
    if (queueForSync) {
      try {
        await this.savePolicy('lists', l);
      } catch (error: unknown) {
        if (!(error instanceof SyncQuotaError)) throw error;
        return {
          ok: false,
          error: t('notify_lists_sync_limit'),
        };
      }
    }
    this.lists = l;
    if (reconcilePendingSync && encoding !== null) this.queueListsEncoding(encoding);
    this.dirty = true;
    this.needsBlocking = this.runtime.session !== null;
    const committedAt: number = this.ports.now();
    await this.commit(committedAt);
    // A lists change moves what every open document must show, so the frozen views follow it.
    await this.refreshLiveViewsIfLive();
    // It also moves which tabs a pre-start picker may offer, so the pickers refresh too.
    this.ports.workTargetChanged?.();
    return { ok: true };
  }

  async applySyncedSettings(settings: Settings): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    const reason: GuardReasonKey | null = settingsChangeAllowed(
      this.runtime.session,
      this.settings,
      settings,
    );
    if (reason !== null) return this.fail(now, t(reason));
    this.setSettingsAndClampBank(settings);
    this.dirty = true;
    await this.commit(now);
    return { ok: true };
  }

  async applySyncedLists(lists: ListsConfig, reconcilePendingSync?: boolean): Promise<Ack> {
    const pendingSyncAtArrival: boolean = reconcilePendingSync ?? this.hasPendingListsSync();
    return this.enqueuePolicyMutation(async (): Promise<Ack> => {
      let encoding: ListsSyncEncoding;
      try {
        encoding = await encodeListsForSync(lists);
      } catch (error: unknown) {
        if (!(error instanceof SyncQuotaError)) throw error;
        return {
          ok: false,
          error: t('notify_lists_sync_limit'),
        };
      }
      return this.updateListsNow(
        lists,
        encoding,
        false,
        pendingSyncAtArrival || this.hasPendingListsSync(),
      );
    });
  }

  private hasPendingListsSync(): boolean {
    return LIST_SYNC_KEYS.some((key: string): boolean => this.ports.hasPendingSync(key));
  }

  private queueListsEncoding(encoding: ListsSyncEncoding): void {
    for (const [key, value] of Object.entries(encoding.sets)) {
      this.ports.queueSync(key, value);
    }
    for (const key of encoding.removes) this.ports.removeSync(key);
  }

  async applySyncedBank(bank: BankState): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    if (!Number.isFinite(bank.balanceMs) || bank.balanceMs < 0) {
      return this.fail(now, 'invalid synced pause bank');
    }
    this.bank = { balanceMs: Math.min(bank.balanceMs, this.settings.pause.capMs) };
    this.bankRevision += 1;
    this.dirty = true;
    await this.commit(now);
    return { ok: true };
  }

  async applySyncedStreak(streak: StreakState): Promise<void> {
    this.assertRuntimeMutationAllowed();
    const sanitized: StreakState = rebaseStreakForDate(streak, localDateStr(this.ports.now()));
    const chosen: StreakState | null = chooseNewerStreak(sanitized, this.streak);
    this.streak = chosen;
    if (chosen === null) return;
  }

  private async previewSyncedPolicyNow(
    changes: Partial<PolicyValueByKey>,
    _reconcilePendingLists: boolean,
  ): Promise<Ack & { accepted?: Partial<PolicyValueByKey> }> {
    if (changes.settings !== undefined) {
      const reason: GuardReasonKey | null = settingsChangeAllowed(
        this.runtime.session,
        this.settings,
        changes.settings,
      );
      if (reason !== null) return { ok: false, error: t(reason) };
    }
    if (changes.lists !== undefined) {
      const reason: GuardReasonKey | null = listsChangeAllowed(
        this.runtime.session,
        this.runtime.session?.config.mode ?? null,
        this.lists,
        changes.lists,
      );
      if (reason !== null) return { ok: false, error: t(reason) };
      try {
        await encodeListsForSync(changes.lists);
      } catch (error: unknown) {
        if (!(error instanceof SyncQuotaError)) throw error;
        return {
          ok: false,
          error: t('notify_lists_sync_limit'),
        };
      }
    }
    if (
      changes.bank !== undefined &&
      (!Number.isFinite(changes.bank.balanceMs) || changes.bank.balanceMs < 0)
    ) {
      return { ok: false, error: 'invalid synced pause bank' };
    }
    const accepted: Partial<PolicyValueByKey> = { ...changes };
    const effectiveSettings: Settings = changes.settings ?? this.settings;
    if (changes.bank !== undefined) {
      accepted.bank = {
        balanceMs: Math.min(changes.bank.balanceMs, effectiveSettings.pause.capMs),
      };
    } else if (
      changes.settings !== undefined &&
      this.bank.balanceMs > effectiveSettings.pause.capMs
    ) {
      accepted.bank = { balanceMs: effectiveSettings.pause.capMs };
    }
    if (changes.streak !== undefined && changes.streak !== null) {
      const sanitized: StreakState = rebaseStreakForDate(
        changes.streak,
        localDateStr(this.ports.now()),
      );
      accepted.streak = chooseNewerStreak(sanitized, this.streak);
    }
    return { ok: true, accepted };
  }

  async transactSyncedPolicy(
    changes: Partial<PolicyValueByKey>,
    reconcilePendingLists: boolean,
    mirror: (accepted: Partial<PolicyValueByKey>) => Promise<void>,
  ): Promise<Ack> {
    return this.enqueuePolicyMutation(async (): Promise<Ack> => {
      const admittedAt: number = this.ports.now();
      try {
        if (this.dirty) await this.commit(admittedAt);
        if (changes.settings !== undefined) {
          changes = {
            ...changes,
            settings: settingsWithLocalIntentions(changes.settings, this.settings),
          };
        }
        const preview: Ack & { accepted?: Partial<PolicyValueByKey> } =
          await this.previewSyncedPolicyNow(changes, reconcilePendingLists);
        if (!preview.ok) return preview;
        const accepted: Partial<PolicyValueByKey> = preview.accepted ?? changes;
        const listBundle: MatcherCacheBundle | undefined =
          accepted.lists === undefined
            ? undefined
            : await this.prepareSyncedListBundle(accepted.lists);
        await mirror(accepted);
        await this.commitSyncedPolicyNow(accepted, listBundle);
        return { ok: true };
      } finally {
        const completedAt: number = this.ports.now();
        if (this.dirty) await this.commit(completedAt);
      }
    });
  }

  private async prepareSyncedListBundle(lists: ListsConfig): Promise<MatcherCacheBundle> {
    const bundle: MatcherCacheBundle = buildMatcherCache(lists, ALL_CATEGORIES);
    await this.ports.saveMatcherCache(bundle.stored, lists);
    return bundle;
  }

  private async commitSyncedPolicyNow(
    changes: Partial<PolicyValueByKey>,
    preparedListBundle?: MatcherCacheBundle,
  ): Promise<void> {
    const listBundle: MatcherCacheBundle | null =
      changes.lists === undefined
        ? null
        : (preparedListBundle ?? (await this.prepareSyncedListBundle(changes.lists)));
    const now: number = this.ports.now();
    this.suppressPolicyPublication = true;
    try {
      if (changes.settings !== undefined) this.setSettingsAndClampBank(changes.settings);
      if (changes.lists !== undefined && listBundle !== null) {
        this.lists = changes.lists;
        this.needsBlocking = this.runtime.session !== null;
        this.dirty = true;
      }
      if (changes.bank !== undefined) {
        this.bank = {
          balanceMs: Math.min(changes.bank.balanceMs, this.settings.pause.capMs),
        };
        this.bankRevision += 1;
        this.bankDirty = true;
        this.dirty = true;
      }
      if (changes.streak !== undefined) {
        const sanitized: StreakState | null =
          changes.streak === null
            ? null
            : rebaseStreakForDate(changes.streak, localDateStr(this.ports.now()));
        this.streak = sanitized === null ? null : chooseNewerStreak(sanitized, this.streak);
        this.streakDirty = this.streak !== null;
        this.dirty = true;
      }
      await this.commit(now);
    } finally {
      this.suppressPolicyPublication = false;
    }
  }

  getSettings(): Settings {
    return this.settings;
  }

  private setSettingsAndClampBank(settings: Settings): void {
    const balanceMs: number = Math.min(this.bank.balanceMs, settings.pause.capMs);
    if (this.settings.theme !== settings.theme) this.needsBlocking = true;
    this.settings = settings;
    if (balanceMs === this.bank.balanceMs) return;
    this.bank = { balanceMs };
    this.bankDirty = true;
    this.bankRevision += 1;
    this.dirty = true;
  }

  getLists(): ListsConfig {
    return this.lists;
  }

  /** Task 8's rollover and stats service read and update this. */
  getStreak(): StreakState | null {
    return this.streak;
  }

  statsOverlay(): EngineStatsOverlay {
    const now: number = this.ports.now();
    if (this.dataClearBarrierState === 'open' && this.dirty) this.commitInBackground(now);
    return {
      deviceId: this.deviceId,
      todayAgg: capAttempts(
        this.runtime.todayAgg ?? emptyDaily(this.runtime.date),
        TOP_SITES_DAILY,
      ),
      streak: this.streak,
      pendingEvents: [...this.pendingEvents],
    };
  }

  /**
   * Closes the day the boundary just left: the finished aggregate is credited, the streak moves,
   * and `todayAgg` and `date` advance to the day the boundary belongs to. The controller's tick
   * owns the settlement that precedes it, so this only does the bookkeeping the Engine retains.
   */
  async rolloverCheck(boundary: number): Promise<void> {
    const now: number = boundary;
    const today: string = localDateStr(now);
    if (today === this.runtime.date) return;
    if (this.runtime.date > today) {
      await this.rebaseDateBackward(today, now);
      return;
    }
    // The focus settled up to this boundary belongs to the day the boundary ends, so it is credited
    // before that day is written. Crediting after would hand every minute to the day after it.
    this.creditSettledFocus();
    const streak: StreakState = this.streak ?? emptyStreak(localMonthStr(now));
    const plan: RolloverPlan = planRollover(
      this.runtime.date,
      now,
      this.runtime.todayAgg,
      streak,
      this.settings.streakGoalMin,
      this.settings.streakFreezeIntervalDays,
    );
    this.recordAggregateSet(syncAggKey(this.deviceId, plan.finished.date), plan.finished);
    this.streak = plan.streak;
    this.streakDirty = true;
    this.runtime.todayAgg = plan.newAgg;
    this.runtime.date = today;
    // The controller calls this from inside its own queue, so the write is left to the caller that
    // runs after it returns. Committing here would sweep whenever blocking work is pending, the
    // sweep would ask the controller for a target, and the queue would wait for itself forever.
    this.dirty = true;
  }

  /**
   * A `date` in the future is a clock that ran ahead and has been put back, so that day was never
   * lived. Crediting it would count focus and a streak day that never happened, so the aggregate
   * is quarantined under an archive key instead, its daily key is removed, and the streak drops
   * every marker the future day left. The controller hands this case one backward call.
   */
  private async rebaseDateBackward(today: string, now: number): Promise<void> {
    const futureDate: string = this.runtime.date;
    const plan: BackwardDateRebasePlan = planBackwardDateRebase(
      today,
      this.runtime.todayAgg ?? emptyDaily(futureDate),
    );
    this.recordAggregateRemoval(syncAggKey(this.deviceId, futureDate));
    this.recordAggregateSet(
      clockRebaseArchiveKey(this.deviceId, futureDate, now, this.ports.newId()),
      plan.archive,
    );
    this.runtime.date = today;
    this.runtime.todayAgg = plan.newAgg;
    this.runtime.attemptDebounce = {};
    this.failedAttemptPersistence.clear();
    this.runtime.lastPruneDate = null;
    if (this.streak !== null) {
      this.streak = rebaseStreakForDate(this.streak, today);
      this.streakDirty = true;
    }
    // Left to the caller for the reason the forward rollover states.
    this.dirty = true;
  }

  /**
   * The day is credited with whatever focus has settled since the last credit. A closure resets the
   * accrual to zero, so the watermark follows the accrual down as well as up and the next session
   * starts counting from nothing.
   */
  private creditSettledFocus(): void {
    const delta: number = Math.max(0, this.runtime.accruedFocusMs - this.creditedFocusMs);
    this.creditedFocusMs = this.runtime.accruedFocusMs;
    if (delta === 0) return;
    const aggregate: DailyAgg = this.runtime.todayAgg ?? emptyDaily(this.runtime.date);
    this.runtime.todayAgg = { ...aggregate, focusMs: aggregate.focusMs + delta };
    this.dirty = true;
  }

  /** Weekly retention prune, marked only after storage operations finish. */
  private async maybePrune(now: number): Promise<void> {
    const today: string = localDateStr(now);
    const last: string | null = this.runtime.lastPruneDate;
    if (last !== null) {
      const elapsedDays: number =
        (new Date(today).getTime() - new Date(last).getTime()) / 86_400_000;
      if (elapsedDays < 7) return;
    }
    try {
      await this.ports.prune(this.settings.retentionDays, now);
    } catch (error: unknown) {
      this.ports.reportError(error);
      return;
    }
    this.runtime.lastPruneDate = today;
    this.dirty = true;
  }

  // --- the commit tail: fold events, persist, broadcast, icon, wake ---

  private async fail(now: number, error: string): Promise<Ack> {
    if (this.dirty) await this.commit(now);
    return { ok: false, error };
  }

  private recordEvent(event: EventRecord): void {
    const aggregateEvent: EventRecord = aggregatedFocusEventV2(event);
    const aggregate: DailyAgg = this.runtime.todayAgg ?? emptyDaily(this.runtime.date);
    this.runtime.todayAgg = addEvent(aggregate, aggregateEvent);
    this.pendingEvents.push(event);
    this.dirty = true;
  }

  private recordAggregateSet(key: string, value: DailyAgg): void {
    this.pendingAggregateRemoves.delete(key);
    this.pendingAggregateSets.set(key, capAttempts(value, TOP_SITES_DAILY));
  }

  private recordAggregateRemoval(key: string): void {
    this.pendingAggregateSets.delete(key);
    this.pendingAggregateRemoves.add(key);
  }

  private async saveAggregate(key: string, value: DailyAgg): Promise<void> {
    if (this.ports.saveAggregate !== undefined) {
      await this.ports.saveAggregate(key, value);
      return;
    }
    this.ports.queueSync(key, value);
  }

  private async removeAggregate(key: string): Promise<void> {
    if (this.ports.removeAggregate !== undefined) {
      await this.ports.removeAggregate(key);
      return;
    }
    this.ports.removeSync(key);
  }

  private async flushEvents(batch: EventRecord[]): Promise<void> {
    if (batch.length === 0) return;
    await this.ports.appendEvents(batch);
  }

  private commit(now: number): Promise<void> {
    const queued: Promise<void> = this.commitQueue.then(
      (): Promise<void> => this.performCommit(now),
    );
    this.commitQueue = queued.catch((): void => {
      // Keep later commits usable. The caller still receives the rejection.
    });
    return queued;
  }

  private commitInBackground(now: number): void {
    void this.commit(now).catch((error: unknown): void => this.ports.reportError(error));
  }

  private persistBlockingMutation(attemptRevision: number): Promise<void> {
    const queued: Promise<void> = this.blockingMutationPersistQueue.then(
      async (): Promise<void> => {
        await this.persistDomainState();
        this.resolveAttemptDurability(attemptRevision);
      },
    );
    this.blockingMutationPersistQueue = queued.catch((): void => {
      // Keep later in-sweep persistence usable. The caller still receives the rejection.
    });
    return queued;
  }

  private resolveAttemptDurability(revision: number): void {
    for (const inFlight of this.attemptPersistInFlight.values()) {
      for (const durability of inFlight) {
        if (durability.revision <= revision) {
          durability.durable = true;
          durability.resolve();
        }
      }
    }
  }

  private async performCommit(now: number): Promise<void> {
    const attemptRevision: number = this.attemptRevision;
    await this.persistDomainState();
    this.dirty = false;
    const block: boolean = this.needsBlocking;
    this.needsBlocking = false;
    const snap: SessionSnapshot = this.controller.snapshot(now);
    this.resolveAttemptDurability(attemptRevision);
    this.ports.broadcast(snap);
    this.ports.updateIcon(snap);
    // No wake is scheduled here. The `phase` alarm belongs to the durable session and holds its
    // next boundary alone, which indefinite focus does not have at all, so a commit that wrote an
    // unlock expiry into it would delete the boundary the controller created and read back. An
    // expiring unlock is enforced by instant instead: the verdict ignores an unlock the read
    // instant has passed, and the minute tick sweeps the tabs that then owe an overlay again.
    if (block) {
      try {
        await this.applyBlockingWithLease();
      } catch (error: unknown) {
        this.needsBlocking = true;
        throw error;
      }
    }
    if (this.dirty) {
      const updatedAttemptRevision: number = this.attemptRevision;
      await this.persistDomainState();
      this.dirty = false;
      const updated: SessionSnapshot = this.controller.snapshot(this.ports.now());
      this.resolveAttemptDurability(updatedAttemptRevision);
      this.ports.broadcast(updated);
      this.ports.updateIcon(updated);
    }
  }

  private async persistDomainState(): Promise<void> {
    this.domainPersistRevision += 1;
    const domainPersistRevision: number = this.domainPersistRevision;
    const bank: BankState = structuredClone(this.bank);
    const events: EventRecord[] = [...this.pendingEvents];
    const aggregate: DailyAgg | null = structuredClone(this.runtime.todayAgg);
    const date: string = this.runtime.date;
    const syncBank: boolean = this.bankDirty;
    const bankRevision: number = this.bankRevision;
    const aggregateSets: Record<string, DailyAgg> = Object.fromEntries(
      [...this.pendingAggregateSets.entries()].map(
        ([key, value]: [string, DailyAgg]): [string, DailyAgg] => [key, structuredClone(value)],
      ),
    );
    if (aggregate !== null) {
      aggregateSets[syncAggKey(this.deviceId, date)] = capAttempts(aggregate, TOP_SITES_DAILY);
    }
    const aggregateRemoves: string[] = [...this.pendingAggregateRemoves];
    // The retained engine writes a v2 checkpoint, because the runtime it persists is a v2 runtime
    // and replay reads it back through the v2 reader.
    this.runtime.commitCheckpoint = {
      version: 2,
      checkpointId: `${this.runtime.enforcementEpoch}:engine-${this.domainPersistRevision}`,
      projection: projectRuntimeDomainV2(this.runtime),
      bank,
      events,
      syncBank,
      aggregateSets,
      aggregateRemoves,
    };
    await this.persistRuntime();
    if (syncBank) await this.savePolicy('bank', bank);
    if (this.streakDirty && this.streak !== null) {
      await this.savePolicy('streak', this.streak);
      this.streakDirty = false;
    }
    for (const [key, value] of Object.entries(aggregateSets)) {
      await this.saveAggregate(key, value);
    }
    for (const key of aggregateRemoves) await this.removeAggregate(key);
    await this.flushEvents(events);
    await this.ports.persistSyncJournal();
    for (const event of events) {
      const index: number = this.pendingEvents.indexOf(event);
      if (index >= 0) this.pendingEvents.splice(index, 1);
    }
    if (this.bankRevision === bankRevision) this.bankDirty = false;
    for (const [key, value] of Object.entries(aggregateSets)) {
      const pending: DailyAgg | undefined = this.pendingAggregateSets.get(key);
      if (pending !== undefined && JSON.stringify(pending) === JSON.stringify(value)) {
        this.pendingAggregateSets.delete(key);
      }
    }
    for (const key of aggregateRemoves) this.pendingAggregateRemoves.delete(key);
    if (this.domainPersistRevision === domainPersistRevision) {
      // The checkpoint this commit replayed is retired, and the write that retires it composes the
      // current runtime, so a session the controller ended while this ran stays ended.
      this.runtime.commitCheckpoint = null;
      await this.persistRuntime();
    }
  }

  private async savePolicy<K extends keyof PolicyValueByKey>(
    key: K,
    value: PolicyValueByKey[K],
  ): Promise<void> {
    if (this.suppressPolicyPublication) return;
    if (this.ports.savePolicy !== undefined) {
      await this.ports.savePolicy(key, value);
      return;
    }
    if (key === 'lists') {
      if (!isListsConfig(value)) throw new Error('invalid lists policy');
      this.queueListsEncoding(await encodeListsForSync(value));
    } else if (key === 'settings') {
      assertSyncItemWithinQuota('settings', value);
      this.ports.queueSync('settings', value);
    } else if (key === 'bank') {
      this.ports.queueSync('bank', value);
    } else {
      this.ports.queueSync('streak', value);
    }
    await this.ports.persistSyncJournal();
  }

  /**
   * The one durable runtime write the Engine makes. It never writes a value it captured before its
   * awaits: the runtime is composed inside the write queue, from the controller's latest value plus
   * the fields the Engine owns, so a controller write that lands while this one is in flight is
   * carried forward rather than reverted. The controller owns the session and everything projected
   * with it, and this write must never be the reason an ended session comes back.
   */
  private persistRuntime(): Promise<void> {
    return this.queueRuntimeSnapshot();
  }

  /** The controller's latest durable runtime, with the fields the Engine owns laid over it. */
  private composeOwnedRuntime(): RuntimeStateV2 {
    const owned: RuntimeStateV2 = this.ownedRuntimeSnapshot;
    owned.tabStates = structuredClone(this.runtime.tabStates);
    owned.attemptDebounce = structuredClone(this.runtime.attemptDebounce);
    owned.deferredBlockClaims = structuredClone(this.runtime.deferredBlockClaims);
    owned.removedTabTombstones = structuredClone(this.runtime.removedTabTombstones);
    owned.todayAgg = structuredClone(this.runtime.todayAgg);
    owned.date = this.runtime.date;
    owned.lastPruneDate = this.runtime.lastPruneDate;
    owned.commitCheckpoint = structuredClone(this.runtime.commitCheckpoint);
    return structuredClone(owned);
  }

  private queueRuntimeSnapshot(): Promise<void> {
    const requested: Promise<void> = this.runtimePersistQueue.then(
      (): Promise<void> => this.ports.saveRuntime(this.composeOwnedRuntime()),
    );
    this.runtimePersistQueue = requested.catch((): void => {});
    return requested.catch((error: unknown): never => {
      this.dirty = true;
      throw error;
    });
  }

  private enqueuePolicyMutation<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.dataClearBarrierState !== 'open') {
      return Promise.reject(
        new Error(
          'runtime mutation rejected while storage transition or data clear is in progress',
        ),
      );
    }
    const requested: Promise<T> = this.policyMutationQueue.then(mutation, mutation);
    this.policyMutationQueue = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    return requested;
  }

  private runtimeMutationAllowed(lease?: BlockingSweepLease): boolean {
    if (this.dataClearBarrierState === 'open') return true;
    if (lease !== undefined && this.activeRuntimeMutationLeases.has(lease)) return true;
    // Only a pending all-data clear refuses outright: it is about to erase the profile, so nothing
    // may be written behind it. Every other transition moves where policy is stored while the
    // session keeps enforcing, and new mutations are already refused at the admission points, so
    // what still arrives here is enforcement the drain waits for.
    return !this.allDataClearPending;
  }

  private assertRuntimeMutationAllowed(lease?: BlockingSweepLease): void {
    if (!this.runtimeMutationAllowed(lease)) {
      throw new Error(
        'runtime mutation rejected while storage transition or data clear is in progress',
      );
    }
  }

  private async applyBlockingWithLease(): Promise<void> {
    return this.trackRuntimeMutation(
      (lease: RuntimeMutationLease): Promise<void> => this.ports.applyBlocking(lease),
    );
  }

  private async flushDeferredBlockingSweep(openBarrierAfter: boolean = false): Promise<void> {
    const deferred: DeferredBlockingSweep | null = this.deferredBlockingSweep;
    if (deferred === null) {
      if (openBarrierAfter) this.openRuntimeMutationBarrier();
      return;
    }
    let retryFailure: unknown = null;
    while (this.deferredBlockingSweepRequested) {
      this.deferredBlockingSweepRequested = false;
      try {
        await this.applyBlockingWithLease();
      } catch (error: unknown) {
        this.ports.reportError(error);
        try {
          await this.applyBlockingWithLease();
        } catch (retryError: unknown) {
          this.needsBlocking = true;
          retryFailure = retryError;
          break;
        }
      }
    }
    this.deferredBlockingSweep = null;
    this.deferredBlockingSweepRequested = false;
    if (openBarrierAfter) this.openRuntimeMutationBarrier();
    if (retryFailure === null) deferred.resolve();
    else deferred.reject(retryFailure);
  }

  private openRuntimeMutationBarrier(): void {
    this.dataClearBarrierState = 'open';
    this.dataClearOperationRunning = false;
    this.allDataClearPending = false;
  }

  /** The reset resolver owns these targets while deletion is pending. No mutation is admitted. */
  private settleDataClearNavigation(): void {
    const deferred: DeferredBlockingSweep | null = this.deferredBlockingSweep;
    this.deferredBlockingSweep = null;
    this.deferredBlockingSweepRequested = false;
    deferred?.resolve();
  }

  private rejectDeferredBlockingSweep(error: Error): void {
    const deferred: DeferredBlockingSweep | null = this.deferredBlockingSweep;
    if (deferred === null) return;
    this.deferredBlockingSweep = null;
    this.deferredBlockingSweepRequested = false;
    deferred.reject(error);
  }

  private trackRuntimeMutation<T>(
    operation: (lease: RuntimeMutationLease) => Promise<T>,
  ): Promise<T> {
    const lease: RuntimeMutationLease = {} as RuntimeMutationLease;
    this.activeRuntimeMutationLeases.add(lease);
    // The frame counter covers the callback's synchronous prefix and nothing else, which is the
    // one window where a nested deletion-lease acquisition is distinguishable from a second
    // acquirer that legitimately queues. Counting mutations still in flight instead would refuse a
    // clear the user asked for whenever an unrelated commit happened to overlap it.
    this.runtimeMutationFrames += 1;
    let requested: Promise<T>;
    try {
      requested = (async (): Promise<T> => {
        try {
          return await operation(lease);
        } finally {
          this.activeRuntimeMutationLeases.delete(lease);
        }
      })();
    } finally {
      this.runtimeMutationFrames -= 1;
    }
    const settled: Promise<void> = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.runtimeMutationsInFlight.add(settled);
    void settled.then((): void => {
      this.runtimeMutationsInFlight.delete(settled);
    });
    return requested;
  }

  private async resetAfterAllDataClear(projection?: RuntimeStateV2): Promise<void> {
    const now: number = this.ports.now();
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.lists = structuredClone(DEFAULT_LISTS);
    this.bank = { balanceMs: 0 };
    this.streak = null;
    this.runtime =
      projection === undefined
        ? emptyRuntimeV2(now, this.ports.newId())
        : structuredClone(projection);
    this.deviceId = await this.ports.rehydrateAfterDataClear();
    this.pendingEvents = [];
    // An erased profile owes nobody the edits the lock it no longer has once refused.
    this.pending = [];
    await this.persistPendingChanges();
    this.dirty = false;
    this.needsBlocking = false;
    this.bankDirty = false;
    this.streakDirty = false;
    this.bankRevision = 0;
    this.attemptRevision = 0;
    this.attemptPersistInFlight.clear();
    this.failedAttemptPersistence.clear();
    // The day those attempts belonged to has just been erased, so they go with it.
    this.deferredAttempts = [];
    this.websiteBlockingLossPending = false;
    this.ownedRuntimeSnapshot = structuredClone(this.runtime);
    await this.persistRuntime();
  }

  private async prepareRuntimeForAllDataClear(): Promise<void> {
    const hadTabStates: boolean = Object.keys(this.runtime.tabStates).length > 0;
    const hadBlockingState: boolean =
      this.runtime.session !== null ||
      this.runtime.gate !== null ||
      this.runtime.unlocks.length > 0 ||
      hadTabStates;
    if (!hadBlockingState) return;
    const now: number = this.ports.now();
    // The all-data clear takes the session with it, and the controller owns how it ends.
    if (this.runtime.session !== null) {
      await this.controller.endForEnforcementLoss('website-access-lost');
    }
    this.runtime.gate = null;
    this.runtime.unlocks = [];
    this.dirty = true;
    this.needsBlocking = true;
    await this.commit(now);
    await this.drainRuntimeMutations();
    if (hadTabStates) {
      this.runtime.tabStates = {};
      await this.persistRuntime();
      await this.drainRuntimeMutations();
    }
  }

  /**
   * The attempts a quiesced barrier held. Each one is replayed through the ordinary path once the
   * barrier is open, so the debounce and the day's aggregate see them exactly as they would have.
   * An attempt whose replay fails is reported and dropped rather than retried forever.
   */
  private async flushDeferredAttempts(): Promise<void> {
    if (this.deferredAttempts.length === 0) return;
    const pending: Array<{ url: string; tabId: number; kind: 'navigation' | 'existing' }> = [
      ...this.deferredAttempts,
    ];
    this.deferredAttempts = [];
    for (const attempt of pending) {
      try {
        await this.recordAttempt(attempt.url, attempt.tabId, attempt.kind);
      } catch (error: unknown) {
        this.ports.reportError(error);
      }
    }
  }

  private async flushDeferredBlockClaims(): Promise<void> {
    await this.runtimePersistQueue;
    if (Object.keys(this.runtime.deferredBlockClaims).length === 0) return;
    if (this.dirty) {
      try {
        await this.commit(this.ports.now());
      } catch (error: unknown) {
        this.ports.reportError(error);
        return;
      }
    }
    while (Object.keys(this.runtime.deferredBlockClaims).length > 0) {
      let replayed: boolean = false;
      for (const [key, storedClaim] of Object.entries(this.runtime.deferredBlockClaims)) {
        const claim: DeferredBlockClaim | undefined = this.runtime.deferredBlockClaims[key];
        if (claim === undefined || claim !== storedClaim) continue;
        if (this.runtime.removedTabTombstones[claim.tabId] === true) {
          delete this.runtime.deferredBlockClaims[key];
          await this.persistRuntime();
          replayed = true;
          continue;
        }
        try {
          await this.replayDeferredBlockClaim(key, claim);
          replayed = true;
        } catch (error: unknown) {
          this.ports.reportError(error);
        }
      }
      if (!replayed) {
        if (!this.dirty) return;
        try {
          await this.commit(this.ports.now());
        } catch (error: unknown) {
          this.ports.reportError(error);
          return;
        }
      }
    }
  }

  private async replayDeferredBlockClaim(key: string, claim: DeferredBlockClaim): Promise<void> {
    if (claim.stage === 'attempt') {
      const nextStage: 'stopped' | null =
        claim.kind === 'navigation' && claim.documentId !== undefined ? 'stopped' : null;
      if (nextStage === null) delete this.runtime.deferredBlockClaims[key];
      else this.runtime.deferredBlockClaims[key] = { ...claim, stage: nextStage };
      this.runtime.attemptDebounce[`${claim.tabId}:${claim.url}`] = claim.attemptAt;
      this.recordEvent({
        t: 'attempt',
        at: claim.attemptAt,
        url: claim.url,
        host: hostOf(claim.url),
        tabId: claim.tabId,
        kind: claim.kind,
        sessionId: claim.sessionId,
      });
      this.attemptRevision += 1;
      await this.commit(this.ports.now());
    }
    const stoppedClaim: DeferredBlockClaim | undefined = this.runtime.deferredBlockClaims[key];
    if (stoppedClaim?.stage !== 'stopped' || stoppedClaim.documentId === undefined) return;
    const state: RuntimeTabState | null = this.ensureTabState(stoppedClaim.tabId);
    if (state === null) {
      delete this.runtime.deferredBlockClaims[key];
      await this.persistRuntime();
      return;
    }
    state.stoppedDocumentId = stoppedClaim.documentId;
    delete this.runtime.deferredBlockClaims[key];
    try {
      await this.persistRuntime();
    } catch (error: unknown) {
      this.runtime.deferredBlockClaims[key] = stoppedClaim;
      throw error;
    }
  }

  private applyRemovedTabTombstones(): void {
    for (const tabIdText of Object.keys(this.runtime.removedTabTombstones)) {
      const tabId: number = Number(tabIdText);
      delete this.runtime.tabStates[tabId];
      for (const key of Object.keys(this.runtime.attemptDebounce)) {
        if (key.startsWith(`${tabId}:`)) {
          delete this.runtime.attemptDebounce[key];
          this.failedAttemptPersistence.delete(key);
        }
      }
      for (const [key, claim] of Object.entries(this.runtime.deferredBlockClaims)) {
        if (claim.tabId === tabId) delete this.runtime.deferredBlockClaims[key];
      }
    }
  }

  private async flushRemovedTabTombstones(): Promise<void> {
    if (Object.keys(this.runtime.removedTabTombstones).length === 0) return;
    await this.drainRuntimePersistence();
    this.applyRemovedTabTombstones();
    const flushing: Record<number, true> = this.runtime.removedTabTombstones;
    this.runtime.removedTabTombstones = {};
    try {
      await this.persistRuntime();
    } catch (error: unknown) {
      this.runtime.removedTabTombstones = {
        ...flushing,
        ...this.runtime.removedTabTombstones,
      };
      this.ownedRuntimeSnapshot.removedTabTombstones = structuredClone(
        this.runtime.removedTabTombstones,
      );
      this.applyRemovedTabTombstones();
      throw error;
    }
  }

  private async drainRuntimePersistence(): Promise<void> {
    while (true) {
      const commits: Promise<void> = this.commitQueue;
      const blocking: Promise<void> = this.blockingMutationPersistQueue;
      const runtime: Promise<void> = this.runtimePersistQueue;
      const leasedMutations: Promise<void>[] = [...this.runtimeMutationsInFlight];
      const attempts: Promise<void>[] = [...this.attemptPersistInFlight.values()].flatMap(
        (durabilities: Set<AttemptDurability>): Promise<void>[] =>
          [...durabilities].map(
            (durability: AttemptDurability): Promise<void> => durability.promise,
          ),
      );
      await Promise.all([commits, blocking, runtime, ...leasedMutations, ...attempts]);
      if (
        commits === this.commitQueue &&
        blocking === this.blockingMutationPersistQueue &&
        runtime === this.runtimePersistQueue &&
        this.runtimeMutationsInFlight.size === 0 &&
        this.attemptPersistInFlight.size === 0
      ) {
        return;
      }
    }
  }

  private async drainRuntimeMutations(): Promise<void> {
    while (true) {
      const policy: Promise<void> = this.policyMutationQueue;
      const commits: Promise<void> = this.commitQueue;
      const blocking: Promise<void> = this.blockingMutationPersistQueue;
      const runtime: Promise<void> = this.runtimePersistQueue;
      const leasedMutations: Promise<void>[] = [...this.runtimeMutationsInFlight];
      const attempts: Promise<void>[] = [...this.attemptPersistInFlight.values()].flatMap(
        (durabilities: Set<AttemptDurability>): Promise<void>[] =>
          [...durabilities].map(
            (durability: AttemptDurability): Promise<void> => durability.promise,
          ),
      );
      await Promise.all([policy, commits, blocking, runtime, ...leasedMutations, ...attempts]);
      if (
        policy === this.policyMutationQueue &&
        commits === this.commitQueue &&
        blocking === this.blockingMutationPersistQueue &&
        runtime === this.runtimePersistQueue &&
        this.runtimeMutationsInFlight.size === 0 &&
        this.attemptPersistInFlight.size === 0
      ) {
        return;
      }
    }
  }

  private pruneDebounce(now: number): void {
    for (const [key, at] of Object.entries(this.runtime.attemptDebounce)) {
      if (now - at >= ATTEMPT_DEBOUNCE_MS) {
        delete this.runtime.attemptDebounce[key];
        this.failedAttemptPersistence.delete(key);
      }
    }
  }
}

/** The attempts the current day has recorded, which the frozen views report. */
function attemptsTodayOf(todayAgg: DailyAgg | null): number {
  if (todayAgg === null) return 0;
  return Object.values(todayAgg.attempts).reduce(
    (total: number, count: number): number => total + count,
    0,
  );
}

function hostOf(url: string): string {
  try {
    const registrable: string | null = registrableHost(url);
    if (registrable !== null) return registrable;
  } catch {
    // Malformed external input falls through to URL parsing.
  }
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Focus through one instant, capped by whichever finite boundary the phase carries. */
function _focusedMsAt(session: SessionState, now: number): number {
  if (session.phase !== 'focus') return session.focusedMs;
  const boundaries: number[] = [now, session.phaseEndsAt, session.sessionEndsAt].filter(
    (boundary: number | null): boundary is number => boundary !== null,
  );
  return session.focusedMs + Math.max(0, Math.min(...boundaries) - session.phaseStartedAt);
}

function sessionIdentity(session: SessionState | null): { sessionId?: string } {
  return session?.sessionId === undefined ? {} : { sessionId: session.sessionId };
}
