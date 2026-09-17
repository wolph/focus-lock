import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileContentRegistrationState } from '../../../src/background/content-registration';
import type { AllDataClearJournalV2 } from '../../../src/background/data-clear-journal';
import type { BrowserResetPortsV2 } from '../../../src/background/data-clear-reset-v2';
import {
  finalizeAllDataClearV2,
  runBrowserResetAttemptV2,
} from '../../../src/background/data-clear-reset-v2';
import type { BrowserResetEngineSeamV2, Engine, EnginePorts } from '../../../src/background/engine';
import { encodeListsForSync, LIST_SYNC_SHARD_KEYS } from '../../../src/background/list-sync-codec';
import { main } from '../../../src/background/main';
import type { PolicyStorage } from '../../../src/background/policy-storage';
import { routeMessage } from '../../../src/background/router';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { handleSyncChanges, missingSyncDefaults } from '../../../src/background/storage-sync';
import {
  emptyRuntime,
  type LegacyRuntimeStateV1,
  type ParsedRuntimeState,
} from '../../../src/background/stores';
import { SYNC_QUOTA_BYTES_TOTAL, syncItemBytes } from '../../../src/background/sync-quota';
import type { SyncJournal } from '../../../src/background/sync-writer';
import type { StoredMatcherCache } from '../../../src/core/matcher';
import { emptyDaily, rollupMonth } from '../../../src/core/stats';
import { emptyStreak } from '../../../src/core/streak';
import {
  CATEGORY_IDS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  rulesFromLists,
} from '../../../src/shared/constants';
import { t } from '../../../src/shared/i18n';
import type { Request } from '../../../src/shared/messages';
import { isSetupState } from '../../../src/shared/runtime-validation';
import {
  LOCAL_BANK,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_CACHES,
  LOCAL_DATA_CLEAR_JOURNAL,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_ONBOARDING_DRAFT,
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
} from '../../../src/shared/storage-keys';
import { localDateStr, localMonthStr } from '../../../src/shared/time';
import type {
  BankState,
  DailyAgg,
  ListsConfig,
  MonthlyAgg,
  Settings,
  SetupState,
  StreakState,
} from '../../../src/shared/types';
import {
  type LegacyUpgradeProfile,
  type LegacyUpgradeRuntimeV1,
  type LegacyUpgradeSessionV1,
  legacyIndefiniteCancelGateV1,
  legacyIndefiniteSessionV1,
  legacyIndefiniteStartedEventV1,
  legacyUpgradeEventsV1,
  legacyUpgradeProfile,
  legacyUpgradeRuntimeV1,
  legacyUpgradeSettingsMigrated,
} from '../../fixtures/legacy-upgrade-profile';

interface BootScenario {
  journal: SyncJournal;
  localCache?: unknown;
  runtime?: ParsedRuntimeState;
  storedSync: Record<string, unknown>;
}

type RuntimeListener = (
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean;
type AlarmListener = (alarm: chrome.alarms.Alarm) => void;
type RemovedListener = (tabId: number) => void;
type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;
type PermissionListener = (permissions: chrome.permissions.Permissions) => void;
type InstalledListener = (details: chrome.runtime.InstalledDetails) => void;
type MockRegistrationResult =
  | 'unavailable'
  | 'ready'
  | 'error'
  | Error
  | {
      permission: 'granted' | 'denied' | 'unknown';
      status: 'unavailable' | 'ready' | 'error';
    };

const mocks = vi.hoisted(
  (): {
    engineArguments: unknown[] | null;
    alarms: Map<string, chrome.alarms.Alarm>;
    handledAlarms: string[];
    recoverCalls: number;
    recoverError: Error | null;
    alarmError: Error | null;
    alarmListener: AlarmListener | null;
    bootGate: Promise<void> | null;
    dropTabCalls: number[];
    dropTabSignal: (() => void) | null;
    removedListener: RemovedListener | null;
    removedListeners: RemovedListener[];
    runtimeListener: RuntimeListener | null;
    storageListener: StorageListener | null;
    savedJournals: SyncJournal[];
    savedMatcherCaches: StoredMatcherCache[];
    savedRuntimes: LegacyRuntimeStateV1[];
    matcherCacheSaveAttempts: number;
    matcherCacheSaveError: Error | null;
    scenario: BootScenario;
    bootTrace: string[];
    tickCalls: number;
    tickGate: Promise<void> | null;
    tickError: Error | null;
    dropTabError: Error | null;
    invalidationError: Error | null;
    invalidatedTabIds: number[];
    localState: Record<string, unknown>;
    permissionAddedListener: PermissionListener | null;
    permissionRemovedListener: PermissionListener | null;
    installedListener: InstalledListener | null;
    registrationStatuses: MockRegistrationResult[];
    registrationReconcileGates: Array<Promise<void> | null>;
    websiteLossEndCalls: number;
    websiteLossEndGate: Promise<void> | null;
    websiteLossEndStarted: (() => void) | null;
    setupWriteError: Error | null;
    setupReadError: Error | null;
    setupWriteGate: Promise<void> | null;
    setupWriteStarted: (() => void) | null;
    runtimeSaveError: Error | null;
    injectionGate: Promise<void> | null;
    injectionResult: boolean;
    persistDeviceIdOnGet: boolean;
    localRemoveError: Error | null;
    localRemoveDropKeys: string[];
    syncRemoveError: Error | null;
    tickActiveSessionStates: boolean[];
    applyBlockingActiveSessionStates: boolean[];
    aggregateBarrierCalls: number;
  } => ({
    engineArguments: null,
    alarms: new Map<string, chrome.alarms.Alarm>(),
    handledAlarms: [] as string[],
    recoverCalls: 0,
    recoverError: null as Error | null,
    alarmError: null as Error | null,
    alarmListener: null,
    bootGate: null,
    dropTabCalls: [],
    dropTabSignal: null,
    removedListener: null,
    removedListeners: [],
    runtimeListener: null,
    storageListener: null,
    savedJournals: [],
    savedMatcherCaches: [],
    savedRuntimes: [],
    matcherCacheSaveAttempts: 0,
    matcherCacheSaveError: null,
    scenario: {
      journal: { sets: {}, removes: [] },
      storedSync: {},
    },
    tickCalls: 0,
    tickGate: null,
    bootTrace: [],
    tickError: null,
    dropTabError: null,
    invalidationError: null,
    invalidatedTabIds: [],
    localState: {},
    permissionAddedListener: null,
    permissionRemovedListener: null,
    installedListener: null,
    registrationStatuses: ['unavailable'],
    registrationReconcileGates: [],
    websiteLossEndCalls: 0,
    websiteLossEndGate: null,
    websiteLossEndStarted: null,
    setupWriteError: null,
    setupReadError: null,
    setupWriteGate: null,
    setupWriteStarted: null,
    runtimeSaveError: null,
    injectionGate: null,
    injectionResult: true,
    persistDeviceIdOnGet: false,
    localRemoveError: null,
    localRemoveDropKeys: [] as string[],
    syncRemoveError: null,
    tickActiveSessionStates: [],
    applyBlockingActiveSessionStates: [],
    aggregateBarrierCalls: 0,
  }),
);

vi.mock('../../../src/background/audio', () => ({
  notify: vi.fn(),
  playSound: vi.fn(),
}));

vi.mock('../../../src/background/engine', () => ({
  Engine: class EngineMock {
    /** The arguments this instance was built with, so a routed engine can be told apart. */
    readonly constructedWith: unknown[];

    constructor(...args: unknown[]) {
      mocks.engineArguments = args;
      this.constructedWith = args;
    }

    async tick(): Promise<void> {
      mocks.bootTrace.push('tick');
      mocks.tickCalls += 1;
      const runtime: LegacyRuntimeStateV1 | undefined = mocks.engineArguments?.[5] as
        | LegacyRuntimeStateV1
        | undefined;
      mocks.tickActiveSessionStates.push(runtime?.session !== null && runtime !== undefined);
      if (mocks.tickCalls === 1 && mocks.tickGate !== null) await mocks.tickGate;
      if (mocks.tickCalls > 1 && mocks.tickError !== null) throw mocks.tickError;
    }

    async dropTab(tabId: number): Promise<void> {
      mocks.dropTabCalls.push(tabId);
      mocks.dropTabSignal?.();
      if (mocks.dropTabError !== null) throw mocks.dropTabError;
    }

    async runWithDataClearBarrier<T>(
      operation: () => Promise<T>,
      _retainQuiescence?: () => boolean,
    ): Promise<T> {
      const result: T = await operation();
      const ports: EnginePorts | undefined = mocks.engineArguments?.[0] as EnginePorts | undefined;
      await ports?.rehydrateAfterDataClear();
      mocks.localState[LOCAL_DEVICE_ID] = 'device-id';
      return result;
    }

    async runWithAggregateStorageBarrier<T>(operation: () => Promise<T>): Promise<T> {
      mocks.aggregateBarrierCalls += 1;
      return operation();
    }

    async retainDataClearQuiescence(): Promise<void> {
      return Promise.resolve();
    }

    async applyBlockingNow(): Promise<void> {
      const ports: EnginePorts | undefined = mocks.engineArguments?.[0] as EnginePorts | undefined;
      await ports?.applyBlocking({} as never);
    }

    async endSessionForWebsiteBlockingLoss(): Promise<boolean> {
      const runtime: LegacyRuntimeStateV1 | undefined = mocks.engineArguments?.[5] as
        | LegacyRuntimeStateV1
        | undefined;
      if (runtime?.session === null || runtime === undefined) return false;
      runtime.session = null;
      mocks.websiteLossEndStarted?.();
      if (mocks.websiteLossEndGate !== null) await mocks.websiteLossEndGate;
      mocks.websiteLossEndCalls += 1;
      await this.applyBlockingNow();
      return true;
    }

    hasActiveSession(): boolean {
      const runtime: LegacyRuntimeStateV1 | undefined = mocks.engineArguments?.[5] as
        | LegacyRuntimeStateV1
        | undefined;
      return runtime?.session !== null && runtime !== undefined;
    }

    /** No test here chooses a work tab, so the listeners always read an idle worker. */
    workTargetSession(): null {
      return null;
    }

    /** The boot resolves the durable authority here before any listener may act. */
    async recover(): Promise<void> {
      mocks.bootTrace.push('recover');
      mocks.recoverCalls += 1;
      if (mocks.recoverError !== null) throw mocks.recoverError;
    }

    async checkSchedule(): Promise<void> {
      mocks.bootTrace.push('checkSchedule');
    }

    async handleAlarm(name: string): Promise<void> {
      mocks.handledAlarms.push(name);
      if (mocks.alarmError !== null) throw mocks.alarmError;
    }

    /** The lock-order predicate Main binds. No mocked call runs inside a mutation frame. */
    runtimeMutationFrameHeld(): boolean {
      return false;
    }

    /**
     * The two browser-reset entry points delegate to the real module over the seam Main bound,
     * exactly as the Engine does, so a live worker's clear is the same code path as a boot's.
     */
    async runBrowserResetAttempt(token: unknown): Promise<unknown> {
      return runBrowserResetAttemptV2(
        engineBrowserResetPorts(),
        token as Parameters<typeof runBrowserResetAttemptV2>[1],
      );
    }

    async finalizeAllDataClear(): Promise<unknown> {
      const outcome: unknown = await finalizeAllDataClearV2(engineBrowserResetPorts());
      if (outcome === 'removed') {
        const ports: EnginePorts | undefined = mocks.engineArguments?.[0] as
          | EnginePorts
          | undefined;
        await ports?.rehydrateAfterDataClear();
      }
      return outcome;
    }
  },
}));

/** The reset ports the Engine composes: Main's seam plus the browser surfaces Engine holds. */
function engineBrowserResetPorts(): BrowserResetPortsV2 {
  const ports: EnginePorts | undefined = mocks.engineArguments?.[0] as EnginePorts | undefined;
  const seam: BrowserResetEngineSeamV2 | undefined = ports?.browserReset;
  if (ports === undefined || seam === undefined) {
    throw new Error('the engine mock has no browser-reset seam bound');
  }
  return {
    ...seam,
    now: (): number => Date.now(),
    newId: (): string => crypto.randomUUID(),
    targets: ports.targets,
    transport: ports.transport,
    alarms: ports.alarms,
    reportError: ports.reportError,
  };
}

vi.mock('../../../src/background/content-registration', () => ({
  contentScriptFile: 'assets/content-runtime.js',
  reconcileContentRegistrationState: vi.fn(
    async (): Promise<{
      permission: 'granted' | 'denied' | 'unknown';
      status: 'unavailable' | 'ready' | 'error';
    }> => {
      const result: MockRegistrationResult = mocks.registrationStatuses.shift() ?? 'unavailable';
      const gate: Promise<void> | null = mocks.registrationReconcileGates.shift() ?? null;
      if (gate !== null) await gate;
      if (result instanceof Error) throw result;
      if (typeof result !== 'string') return result;
      if (result === 'ready') return { permission: 'granted', status: 'ready' };
      if (result === 'error') return { permission: 'granted', status: 'error' };
      return { permission: 'denied', status: 'unavailable' };
    },
  ),
}));

vi.mock('../../../src/background/icon', () => ({ updateIcon: vi.fn() }));
vi.mock('../../../src/background/router', () => ({
  routeMessage: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../src/background/stats-service', () => ({
  pruneAndRollup: vi.fn(() => ({ remove: [], set: {} })),
}));
vi.mock('../../../src/background/storage-sync', () => ({
  handleSyncChanges: vi.fn(),
  missingSyncDefaults: vi.fn((): Record<string, unknown> => ({})),
}));
vi.mock('../../../src/background/stores', async () => {
  const actual: typeof import('../../../src/background/stores') = await vi.importActual(
    '../../../src/background/stores',
  );
  // The boot reads more of this module than the worker used to, so the mock keeps the real
  // module and replaces only what a test drives.
  return {
    ...actual,
    appendEvents: vi.fn(),
    getDeviceId: vi.fn().mockImplementation(async (): Promise<string> => {
      if (mocks.persistDeviceIdOnGet) mocks.localState[LOCAL_DEVICE_ID] = 'device-id';
      return 'device-id';
    }),
    loadBank: actual.loadBank,
    loadLists: actual.loadLists,
    loadMatcherCache: vi.fn().mockImplementation(async (): Promise<unknown> => {
      return structuredClone(mocks.scenario.localCache);
    }),
    loadRuntime: vi.fn().mockImplementation(async (): Promise<ParsedRuntimeState> => {
      return structuredClone(mocks.scenario.runtime ?? actual.emptyRuntime(Date.now()));
    }),
    loadSettings: actual.loadSettings,
    loadStreak: actual.loadStreak,
    loadSyncJournal: vi.fn().mockImplementation(async (): Promise<SyncJournal> => {
      if (mocks.bootGate !== null) await mocks.bootGate;
      return structuredClone(mocks.scenario.journal);
    }),
    mergeLists: actual.mergeLists,
    mergeRuntime: actual.mergeRuntime,
    mergeSettings: actual.mergeSettings,
    migrateRuntimeRules: actual.migrateRuntimeRules,
    parseBank: actual.parseBank,
    parseLiveLists: actual.parseLiveLists,
    parseLiveSettings: actual.parseLiveSettings,
    parseStoredSettings: actual.parseStoredSettings,
    parseStreak: actual.parseStreak,
    sanitizeRuntimeForLocalHistory: actual.sanitizeRuntimeForLocalHistory,
    saveLegacyRuntime: vi
      .fn()
      .mockImplementation(async (runtime: LegacyRuntimeStateV1): Promise<void> => {
        if (mocks.runtimeSaveError !== null) throw mocks.runtimeSaveError;
        mocks.savedRuntimes.push(structuredClone(runtime));
      }),
    saveMatcherCache: vi
      .fn()
      .mockImplementation(async (cache: StoredMatcherCache): Promise<void> => {
        mocks.bootTrace.push('saveMatcherCache');
        mocks.matcherCacheSaveAttempts += 1;
        if (mocks.matcherCacheSaveError !== null) throw mocks.matcherCacheSaveError;
        mocks.savedMatcherCaches.push(structuredClone(cache));
      }),
    saveSyncJournal: vi.fn().mockImplementation(async (journal: SyncJournal): Promise<void> => {
      mocks.savedJournals.push(structuredClone(journal));
    }),
  };
});
vi.mock('../../../src/background/tabs', async () => ({
  ...(await vi.importActual<typeof import('../../../src/background/tabs')>(
    '../../../src/background/tabs',
  )),
  applyBlockingFactory: vi.fn((): (() => Promise<void>) => async (): Promise<void> => {
    const runtime: LegacyRuntimeStateV1 | undefined = mocks.engineArguments?.[5] as
      | LegacyRuntimeStateV1
      | undefined;
    mocks.applyBlockingActiveSessionStates.push(runtime?.session !== null && runtime !== undefined);
  }),
  invalidateRemovedTab: vi.fn((tabId: number): Promise<void> => {
    mocks.invalidatedTabIds.push(tabId);
    if (mocks.invalidationError !== null) return Promise.reject(mocks.invalidationError);
    return Promise.resolve();
  }),
  injectIntoExistingTabs: vi.fn(async (): Promise<boolean> => {
    if (mocks.injectionGate !== null) await mocks.injectionGate;
    return mocks.injectionResult;
  }),
  registerTabListeners: vi.fn(),
}));

function setScenario(journaledStreak: StreakState, syncedStreak: StreakState): void {
  mocks.scenario = {
    journal: { sets: { [SYNC_STREAK]: journaledStreak }, removes: [] },
    storedSync: { [SYNC_STREAK]: syncedStreak },
  };
}

function setCompleteSyncedPolicy(): void {
  const streak: StreakState = {
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: '2026-08',
  };
  const policy: Record<string, unknown> = {
    [SYNC_SETTINGS]: DEFAULT_SETTINGS,
    [SYNC_LISTS]: DEFAULT_LISTS,
    [SYNC_BANK]: { balanceMs: 0 },
    [SYNC_STREAK]: streak,
  };
  mocks.scenario.storedSync = policy;
  Object.assign(mocks.localState, {
    [LOCAL_SETUP]: {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
      legacyImported: true,
    },
    [LOCAL_SETTINGS]: DEFAULT_SETTINGS,
    [LOCAL_LISTS]: DEFAULT_LISTS,
    [LOCAL_BANK]: { balanceMs: 0 },
    [LOCAL_STREAK]: streak,
  });
}

function setCompleteLocalPolicy(): void {
  Object.assign(mocks.localState, {
    [LOCAL_SETUP]: {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
      legacyImported: true,
    },
    [LOCAL_SETTINGS]: DEFAULT_SETTINGS,
    [LOCAL_LISTS]: DEFAULT_LISTS,
    [LOCAL_BANK]: { balanceMs: 0 },
    [LOCAL_STREAK]: null,
  });
}

function oversizedHostRules(prefix: string): ListsConfig['custom'] {
  return Array.from({ length: 600 }, (_value: unknown, index: number) => ({
    kind: 'host' as const,
    pattern: `${prefix}-${index}.example`,
  }));
}

function oversizedSettings(id: string): Settings {
  return {
    ...DEFAULT_SETTINGS,
    schedule: [
      {
        id,
        days: [1],
        start: '09:00',
        end: '10:00',
        duration: { kind: 'window' },
        mode: 'blacklist',
        strictness: 'friction',
        cycling: null,
        intention: 'x'.repeat(8_192),
        enabled: true,
      },
    ],
  };
}

function stubChrome(): void {
  vi.stubGlobal('chrome', {
    alarms: {
      clear: vi.fn(async (name: string): Promise<boolean> => mocks.alarms.delete(name)),
      // The worker reads every alarm it creates back, so this fake remembers what it was given.
      create: vi.fn(
        async (name: string, info: { when?: number; periodInMinutes?: number }): Promise<void> => {
          mocks.alarms.set(name, {
            name,
            scheduledTime: info.when ?? Date.now(),
            periodInMinutes: info.periodInMinutes,
            persistAcrossSessions: false,
          } as chrome.alarms.Alarm);
        },
      ),
      get: vi.fn(
        async (name: string): Promise<chrome.alarms.Alarm | undefined> => mocks.alarms.get(name),
      ),
      onAlarm: {
        addListener: vi.fn((listener: AlarmListener): void => {
          mocks.alarmListener = listener;
        }),
      },
    },
    runtime: {
      id: 'test-id',
      getURL: vi.fn((path: string): string => `chrome-extension://test-id/${path}`),
      onInstalled: {
        addListener: vi.fn((listener: InstalledListener): void => {
          mocks.installedListener = listener;
        }),
      },
      onMessage: {
        addListener: vi.fn((listener: RuntimeListener): void => {
          mocks.runtimeListener = listener;
        }),
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    permissions: {
      contains: vi.fn().mockResolvedValue(false),
      onAdded: {
        addListener: vi.fn((listener: PermissionListener): void => {
          mocks.permissionAddedListener = listener;
        }),
      },
      onRemoved: {
        addListener: vi.fn((listener: PermissionListener): void => {
          mocks.permissionRemovedListener = listener;
        }),
      },
    },
    storage: {
      onChanged: {
        addListener: vi.fn((listener: StorageListener): void => {
          mocks.storageListener = listener;
        }),
      },
      // The work target lives here for the browser's lifetime. Nothing in these tests chooses
      // one, so the store answers empty and accepts writes.
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
      local: {
        get: vi.fn(async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
          if (
            keys === LOCAL_SETUP &&
            mocks.engineArguments !== null &&
            mocks.setupReadError !== null
          ) {
            const setupReadError: Error = mocks.setupReadError;
            mocks.setupReadError = null;
            throw setupReadError;
          }
          if (keys === null) return structuredClone(mocks.localState);
          const requested: string[] = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key: string): boolean => Object.hasOwn(mocks.localState, key))
              .map((key: string): [string, unknown] => [key, mocks.localState[key]]),
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          // The worker writes its runtime through the v2 store now, so a test that fails or
          // records a runtime write does it here rather than through the stores module. The
          // failure is aimed at the sanitized write a local-history clear makes, which is the one
          // that carries neither aggregate nor checkpoint.
          if (Object.hasOwn(items, LOCAL_RUNTIME)) {
            const written: { commitCheckpoint: unknown; todayAgg: unknown } = items[
              LOCAL_RUNTIME
            ] as { commitCheckpoint: unknown; todayAgg: unknown };
            if (
              mocks.runtimeSaveError !== null &&
              written.todayAgg === null &&
              written.commitCheckpoint === null
            ) {
              throw mocks.runtimeSaveError;
            }
            mocks.savedRuntimes.push(structuredClone(items[LOCAL_RUNTIME]) as LegacyRuntimeStateV1);
          }
          if (Object.hasOwn(items, LOCAL_SETUP)) {
            mocks.setupWriteStarted?.();
            if (mocks.setupWriteGate !== null) await mocks.setupWriteGate;
            if (mocks.setupWriteError !== null) {
              const setupWriteError: Error = mocks.setupWriteError;
              mocks.setupWriteError = null;
              throw setupWriteError;
            }
          }
          Object.assign(mocks.localState, structuredClone(items));
          if (Object.hasOwn(items, LOCAL_SYNC_JOURNAL)) {
            mocks.savedJournals.push(structuredClone(items[LOCAL_SYNC_JOURNAL]) as SyncJournal);
          }
        }),
        remove: vi.fn(async (keys: string | string[]): Promise<void> => {
          if (mocks.localRemoveError !== null) {
            const localRemoveError: Error = mocks.localRemoveError;
            mocks.localRemoveError = null;
            mocks.localRemoveDropKeys = [];
            throw localRemoveError;
          }
          const requested: string[] = typeof keys === 'string' ? [keys] : keys;
          for (const key of requested) {
            // A storage layer that accepts a removal and keeps the value is what a read-back is
            // for, so the stub can answer that way on request.
            if (mocks.localRemoveDropKeys.includes(key)) continue;
            delete mocks.localState[key];
          }
        }),
      },
      sync: {
        get: vi
          .fn()
          .mockImplementation(
            async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
              if (keys === null) return structuredClone(mocks.scenario.storedSync);
              const requested: string[] = Array.isArray(keys) ? keys : [keys];
              return Object.fromEntries(
                requested
                  .filter((key: string): boolean => Object.hasOwn(mocks.scenario.storedSync, key))
                  .map((key: string): [string, unknown] => [key, mocks.scenario.storedSync[key]]),
              );
            },
          ),
        getBytesInUse: vi.fn(
          async (): Promise<number> =>
            Object.entries(mocks.scenario.storedSync).reduce(
              (total: number, [key, value]: [string, unknown]): number =>
                total + syncItemBytes(key, value),
              0,
            ),
        ),
        remove: vi.fn(async (keys: string | string[]): Promise<void> => {
          if (mocks.syncRemoveError !== null) throw mocks.syncRemoveError;
          const requested: string[] = typeof keys === 'string' ? [keys] : keys;
          for (const key of requested) delete mocks.scenario.storedSync[key];
        }),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          Object.assign(mocks.scenario.storedSync, structuredClone(items));
        }),
      },
    },
    tabs: {
      create: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockRejectedValue(new Error('No tab with that id.')),
      query: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({}),
      onCreated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onReplaced: { addListener: vi.fn() },
      // The worker registers two removal listeners, its own tab drop and the work target
      // refresh, so a removal in these tests reaches both in registration order.
      onRemoved: {
        addListener: vi.fn((listener: RemovedListener): void => {
          mocks.removedListeners.push(listener);
          mocks.removedListener = (tabId: number): void => {
            for (const registered of mocks.removedListeners) registered(tabId);
          };
        }),
      },
    },
    windows: {
      get: vi.fn().mockResolvedValue({ id: 1, incognito: false }),
      getCurrent: vi.fn().mockResolvedValue({ id: 1, incognito: false }),
      update: vi.fn().mockResolvedValue({}),
    },
  });
}

async function finishBoot(): Promise<void> {
  main();
  const listener: RuntimeListener | null = mocks.runtimeListener;
  if (listener === null) throw new Error('runtime listener was not registered');
  await new Promise<void>((resolve: () => void): void => {
    listener({ type: 'getSnapshot' }, {}, (): void => resolve());
  });
}

function runtimeListener(): RuntimeListener {
  const listener: RuntimeListener | null = mocks.runtimeListener;
  if (listener === null) throw new Error('runtime listener was not registered');
  return listener;
}

function installedListener(): InstalledListener {
  const listener: InstalledListener | null = mocks.installedListener;
  if (listener === null) throw new Error('installed listener was not registered');
  return listener;
}

async function dispatchRuntime(
  request: unknown,
  sender: chrome.runtime.MessageSender = {},
): Promise<unknown> {
  return new Promise<unknown>((resolve: (response: unknown) => void): void => {
    expect(runtimeListener()(request, sender, resolve)).toBe(true);
  });
}

function engineStreak(): StreakState | null {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[4] as StreakState | null;
}

function engineSettings(): Settings {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[1] as Settings;
}

function engineLists(): ListsConfig {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[2] as ListsConfig;
}

function engineBank(): BankState {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[3] as BankState;
}

function engineRuntime(): LegacyRuntimeStateV1 {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[5] as LegacyRuntimeStateV1;
}

function enginePorts(): EnginePorts {
  if (mocks.engineArguments === null) throw new Error('engine was not constructed');
  return mocks.engineArguments[0] as EnginePorts;
}

function expectJournaled(streak: StreakState): void {
  expect(mocks.savedJournals).toContainEqual({
    sets: { [SYNC_STREAK]: streak },
    removes: [],
  });
}

beforeEach((): void => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 29, 12, 0));
  vi.mocked(handleSyncChanges).mockClear();
  mocks.engineArguments = null;
  mocks.alarms.clear();
  mocks.alarmListener = null;
  mocks.handledAlarms = [];
  mocks.recoverCalls = 0;
  mocks.recoverError = null;
  mocks.bootGate = null;
  mocks.dropTabCalls = [];
  mocks.dropTabSignal = null;
  mocks.removedListener = null;
  mocks.removedListeners = [];
  mocks.runtimeListener = null;
  mocks.storageListener = null;
  mocks.savedJournals = [];
  mocks.savedMatcherCaches = [];
  mocks.savedRuntimes = [];
  mocks.matcherCacheSaveAttempts = 0;
  mocks.matcherCacheSaveError = null;
  mocks.scenario = { journal: { sets: {}, removes: [] }, storedSync: {} };
  mocks.tickCalls = 0;
  mocks.tickGate = null;
  mocks.bootTrace = [];
  mocks.tickError = null;
  mocks.dropTabError = null;
  mocks.invalidationError = null;
  mocks.invalidatedTabIds = [];
  mocks.localState = { [LOCAL_RUNTIME]: {} };
  mocks.permissionAddedListener = null;
  mocks.permissionRemovedListener = null;
  mocks.installedListener = null;
  mocks.registrationStatuses = ['unavailable'];
  mocks.registrationReconcileGates = [];
  mocks.websiteLossEndCalls = 0;
  mocks.websiteLossEndGate = null;
  mocks.websiteLossEndStarted = null;
  mocks.setupWriteError = null;
  mocks.setupReadError = null;
  mocks.setupWriteGate = null;
  mocks.setupWriteStarted = null;
  mocks.runtimeSaveError = null;
  mocks.injectionGate = null;
  mocks.injectionResult = true;
  mocks.persistDeviceIdOnGet = false;
  mocks.localRemoveError = null;
  mocks.localRemoveDropKeys = [];
  mocks.syncRemoveError = null;
  mocks.tickActiveSessionStates = [];
  mocks.applyBlockingActiveSessionStates = [];
  mocks.aggregateBarrierCalls = 0;
  vi.mocked(reconcileContentRegistrationState).mockClear();
  stubChrome();
});

afterEach((): void => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const TEST_EPOCH: string = '30000000-0000-4000-8000-0000000000ee';

/** A stored v2 runtime holding one live focus session, which is what a boot now reads back. */
function liveSessionRuntimeV2(now: number, strictness: 'friction' | 'hard' = 'friction'): unknown {
  return {
    ...emptyRuntimeV2(now, TEST_EPOCH),
    session: {
      version: 2,
      sessionId: '10000000-0000-4000-8000-0000000000aa',
      config: {
        mode: 'blacklist',
        strictness,
        duration: { kind: 'timed', minutes: 25 },
        cycling: null,
        intention: 'protected work',
        source: 'manual',
        scheduleOccurrence: null,
        rules: rulesFromLists(DEFAULT_LISTS),
      },
      startedAt: now,
      sessionEndsAt: now + 25 * 60_000,
      phase: 'focus',
      phaseStartedAt: now,
      phaseEndsAt: now + 25 * 60_000,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 0,
    },
  };
}

describe('background runtime request boundary', () => {
  it('opens onboarding for a fresh install even when setup was previously complete', async (): Promise<void> => {
    setCompleteLocalPolicy();
    main();

    installedListener()({ reason: 'install' });

    await vi.waitFor((): void => {
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'chrome-extension://test-id/src/onboarding/onboarding.html',
      });
    });
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toEqual({ ok: true });
  });

  it('opens onboarding on update only when setup is incomplete', async (): Promise<void> => {
    main();

    installedListener()({ reason: 'update', previousVersion: '0.0.9' });

    await vi.waitFor((): void => {
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'chrome-extension://test-id/src/onboarding/onboarding.html',
      });
    });
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toEqual({ ok: true });
  });

  it('does not open onboarding on update after setup completion', async (): Promise<void> => {
    setCompleteLocalPolicy();
    main();

    installedListener()({ reason: 'update', previousVersion: '0.0.9' });
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toEqual({ ok: true });

    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('keeps website blocking disabled until authoritative setup completion', async (): Promise<void> => {
    mocks.registrationStatuses = ['ready'];

    await finishBoot();

    expect(enginePorts().websiteBlockingReady()).toBe(false);
    const services = vi.mocked(routeMessage).mock.calls.at(-1)?.[4];
    if (services === undefined) throw new Error('onboarding services were not provided');
    services.setupCompleted?.(true);
    expect(enginePorts().websiteBlockingReady()).toBe(true);
    services.setupCompleted?.(false);
    expect(enginePorts().websiteBlockingReady()).toBe(false);
  });

  it('removes a stale onboarding draft after completed setup boots', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.localState[LOCAL_ONBOARDING_DRAFT] = { version: 1, step: 2 };

    await finishBoot();

    expect(mocks.localState[LOCAL_ONBOARDING_DRAFT]).toBeUndefined();
  });

  it('marks a live all-data reset clean before the next boot creates legacy evidence', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.localState[LOCAL_RUNTIME] = emptyRuntimeV2(Date.now(), TEST_EPOCH);
    mocks.registrationStatuses = ['ready', 'unavailable'];
    const actualRouter: typeof import('../../../src/background/router') = await vi.importActual(
      '../../../src/background/router',
    );
    vi.mocked(routeMessage).mockImplementationOnce(actualRouter.routeMessage);

    main();
    await expect(dispatchRuntime({ type: 'clearFocusLockData', scope: 'all' })).resolves.toEqual({
      ok: true,
      scope: 'all',
      status: 'cleared',
    });

    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toMatchObject({ profile: 'clean' });
    expect(mocks.localState[LOCAL_DEVICE_ID]).toBe('device-id');

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.sync.getBytesInUse).mockClear();
    vi.mocked(chrome.storage.sync.set).mockClear();
    vi.mocked(chrome.storage.sync.remove).mockClear();
    mocks.scenario.storedSync = { [SYNC_SETTINGS]: DEFAULT_SETTINGS };

    main();
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });

    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    expect(chrome.storage.sync.getBytesInUse).not.toHaveBeenCalled();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
  });

  it('keeps worker requests responsive when boot cannot resume pending all-data deletion', async (): Promise<void> => {
    mocks.localState = {
      [LOCAL_SETUP]: {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        dataClear: { status: 'pending', scope: 'all', phase: 'remote' },
      },
      [LOCAL_RUNTIME]: emptyRuntimeV2(Date.now(), TEST_EPOCH),
      [LOCAL_DATA_CLEAR_JOURNAL]: {
        scope: 'all',
        phase: 'remote',
        inventory: [SYNC_SETTINGS],
      },
      [LOCAL_SETTINGS]: DEFAULT_SETTINGS,
      [LOCAL_LISTS]: DEFAULT_LISTS,
      [LOCAL_BANK]: { balanceMs: 0 },
      [LOCAL_STREAK]: null,
    };
    mocks.scenario.storedSync = { [SYNC_SETTINGS]: DEFAULT_SETTINGS };
    mocks.syncRemoveError = new Error('remote removal unavailable');

    main();
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toEqual({ ok: true });

    const storage: unknown = vi.mocked(routeMessage).mock.calls.at(-1)?.[3];
    expect(storage).toBeDefined();
    // The first failure is one attempt of twelve, so the clear is still pending and its retry is
    // scheduled. The journal's own retry state is the failure authority for this scope, which is
    // why Setup carries no storage error of its own.
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      dataClear: { status: 'pending', scope: 'all', phase: 'remote' },
      storageError: null,
    });
    const journal: AllDataClearJournalV2 = mocks.localState[
      LOCAL_DATA_CLEAR_JOURNAL
    ] as AllDataClearJournalV2;
    expect(journal.version).toBe(2);
    expect(journal.phase).toBe('remote');
    expect(journal.retry.lastError).toContain('remote removal unavailable');
    expect(journal.retry.nextAttemptAt).toBeGreaterThan(0);
    expect(mocks.alarms.get('data-clear-retry')?.scheduledTime).toBe(journal.retry.nextAttemptAt);
  });

  it('routes explicit Sync retry through the engine-owned aggregate checkpoint barrier', async (): Promise<void> => {
    setCompleteSyncedPolicy();
    const aggregateKey: string = 'agg:device-id:2026-08-29';
    const aggregate: DailyAgg = { ...emptyDaily('2026-08-29'), focusMs: 42_000 };
    mocks.localState[LOCAL_SETUP] = {
      ...(mocks.localState[LOCAL_SETUP] as object),
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    };
    mocks.localState[aggregateKey] = aggregate;
    mocks.localState[LOCAL_SYNC_JOURNAL] = {
      sets: { [aggregateKey]: aggregate },
      removes: [],
    };
    const actualRouter: typeof import('../../../src/background/router') = await vi.importActual(
      '../../../src/background/router',
    );
    vi.mocked(routeMessage).mockImplementationOnce(actualRouter.routeMessage);

    main();

    await expect(dispatchRuntime({ type: 'retrySync' })).resolves.toEqual({
      ok: true,
      syncWriteStatus: 'idle',
    });
    expect(mocks.scenario.storedSync[aggregateKey]).toEqual(aggregate);
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      storageMode: 'sync',
      syncWriteStatus: 'idle',
      storageError: null,
    });
    expect(mocks.aggregateBarrierCalls).toBe(1);
  });

  it('retries a boot-restored local-phase all-data clear through the runtime router', async (): Promise<void> => {
    mocks.localState = {
      [LOCAL_SETUP]: {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: null,
        dataClear: { status: 'pending', scope: 'all', phase: 'local' },
      },
      [LOCAL_RUNTIME]: emptyRuntimeV2(Date.now(), TEST_EPOCH),
      [LOCAL_DATA_CLEAR_JOURNAL]: {
        scope: 'all',
        phase: 'local',
        inventory: [],
      },
      [LOCAL_SETTINGS]: DEFAULT_SETTINGS,
      [LOCAL_LISTS]: DEFAULT_LISTS,
      [LOCAL_BANK]: { balanceMs: 0 },
      [LOCAL_STREAK]: null,
    };
    mocks.localRemoveError = new Error('local removal unavailable during boot');
    const actualRouter: typeof import('../../../src/background/router') = await vi.importActual(
      '../../../src/background/router',
    );
    vi.mocked(routeMessage).mockImplementationOnce(actualRouter.routeMessage);

    main();
    await expect(dispatchRuntime({ type: 'clearFocusLockData', scope: 'all' })).resolves.toEqual({
      ok: true,
      scope: 'all',
      status: 'cleared',
    });

    expect(mocks.localState[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
    expect(mocks.localState[LOCAL_SETUP]).toEqual({
      ...DEFAULT_SETUP,
      websiteAccess: 'denied',
    });
    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toMatchObject({ profile: 'clean' });
  });

  it('sanitizes runtime before Engine boot resumes a removed local-history transaction', async (): Promise<void> => {
    const now: number = Date.now();
    const runtime: LegacyRuntimeStateV1 = {
      ...emptyRuntime(now),
      unlocks: [{ host: 'allowed.example', until: now + 60_000 }],
      todayAgg: { ...emptyDaily(new Date(now).toISOString().slice(0, 10)), focusMs: 60_000 },
      commitCheckpoint: {
        bank: { balanceMs: 42_000 },
        events: [{ t: 'budgetEarned', at: now, ms: 1_000 }],
        syncBank: false,
        aggregateSets: {
          'agg:device:stale': { ...emptyDaily('2026-08-31'), focusMs: 60_000 },
        },
      },
    };
    mocks.scenario.runtime = runtime;
    mocks.localState = {
      [LOCAL_SETUP]: {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        dataClear: { status: 'pending', scope: 'local-history', phase: 'runtime' },
      },
      [LOCAL_DATA_CLEAR_JOURNAL]: {
        scope: 'local-history',
        phase: 'runtime',
        inventory: [],
        clearAggregates: true,
      },
      [LOCAL_SETTINGS]: DEFAULT_SETTINGS,
      [LOCAL_LISTS]: DEFAULT_LISTS,
      [LOCAL_BANK]: { balanceMs: 42_000 },
      [LOCAL_STREAK]: null,
      [LOCAL_RUNTIME]: runtime,
    };
    mocks.runtimeSaveError = new Error('sanitized runtime unavailable');

    main();
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });

    const failedBootRuntime: LegacyRuntimeStateV1 | undefined = mocks.engineArguments?.[5] as
      | LegacyRuntimeStateV1
      | undefined;
    expect(failedBootRuntime).toMatchObject({
      unlocks: runtime.unlocks,
      todayAgg: null,
      commitCheckpoint: null,
    });
    // The boot persists the runtime it migrated; what must not land is the sanitized one.
    expect(
      mocks.savedRuntimes.filter(
        (saved: LegacyRuntimeStateV1): boolean =>
          saved.todayAgg === null && saved.commitCheckpoint === null,
      ),
    ).toEqual([]);
    expect(mocks.localState[LOCAL_DATA_CLEAR_JOURNAL]).toMatchObject({
      scope: 'local-history',
      phase: 'runtime',
    });
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      dataClear: { status: 'pending', scope: 'local-history', phase: 'runtime' },
    });

    mocks.runtimeSaveError = null;
    main();
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });

    const recoveredBootRuntime: LegacyRuntimeStateV1 | undefined = mocks.engineArguments?.[5] as
      | LegacyRuntimeStateV1
      | undefined;
    expect(recoveredBootRuntime).toMatchObject({
      unlocks: runtime.unlocks,
      todayAgg: null,
      commitCheckpoint: null,
    });
    expect(mocks.savedRuntimes).toContainEqual(
      expect.objectContaining({ todayAgg: null, commitCheckpoint: null }),
    );
    expect(mocks.localState[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      completed: true,
      storageMode: 'local',
      dataClear: { status: 'idle', scope: null, phase: null },
    });
  });

  it('propagates explicit website reconciliation persistence failures', async (): Promise<void> => {
    mocks.registrationStatuses = ['unavailable'];
    await finishBoot();
    const services = vi.mocked(routeMessage).mock.calls.at(-1)?.[4];
    if (services === undefined) throw new Error('onboarding services were not provided');
    mocks.registrationStatuses = ['ready'];
    mocks.setupWriteError = new Error('setup persistence failed');

    await expect(services.reconcileWebsiteAccess()).rejects.toThrow('setup persistence failed');
  });

  it('waits for a newer permission generation before returning explicit reconciliation', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.registrationStatuses = ['unavailable'];
    await finishBoot();
    const services = vi.mocked(routeMessage).mock.calls.at(-1)?.[4];
    if (services === undefined) throw new Error('onboarding services were not provided');
    vi.mocked(reconcileContentRegistrationState).mockClear();
    let releaseExplicit: () => void = (): void => undefined;
    const explicitGate: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseExplicit = resolve;
    });
    mocks.registrationStatuses = ['unavailable', 'ready'];
    mocks.registrationReconcileGates = [explicitGate, null];

    const explicit: Promise<{
      permission: 'granted' | 'denied' | 'unknown';
      status: 'unavailable' | 'ready' | 'error';
    }> = services.reconcileWebsiteAccess();
    await vi.waitFor((): void => expect(reconcileContentRegistrationState).toHaveBeenCalledOnce());
    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });
    releaseExplicit();

    await expect(explicit).resolves.toEqual({ permission: 'granted', status: 'ready' });
    expect(reconcileContentRegistrationState).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale explicit reconciliation failure after permission-added succeeds', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.registrationStatuses = ['unavailable'];
    await finishBoot();
    const services = vi.mocked(routeMessage).mock.calls.at(-1)?.[4];
    if (services === undefined) throw new Error('onboarding services were not provided');
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    vi.mocked(reconcileContentRegistrationState).mockClear();
    let releaseExplicit: () => void = (): void => undefined;
    const explicitGate: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseExplicit = resolve;
    });
    mocks.registrationStatuses = [new Error('stale reconciliation failed'), 'ready'];
    mocks.registrationReconcileGates = [explicitGate, null];

    const explicit: Promise<{
      permission: 'granted' | 'denied' | 'unknown';
      status: 'unavailable' | 'ready' | 'error';
    }> = services.reconcileWebsiteAccess();
    await vi.waitFor((): void => expect(reconcileContentRegistrationState).toHaveBeenCalledOnce());
    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });
    releaseExplicit();

    await expect(explicit).resolves.toEqual({ permission: 'granted', status: 'ready' });
    expect(reconcileContentRegistrationState).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(
      'focus-lock background error',
      expect.objectContaining({ message: 'stale reconciliation failed' }),
    );
  });

  it('propagates persistence failure from the latest superseding permission generation', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.registrationStatuses = ['unavailable'];
    await finishBoot();
    const services = vi.mocked(routeMessage).mock.calls.at(-1)?.[4];
    if (services === undefined) throw new Error('onboarding services were not provided');
    let releaseExplicit: () => void = (): void => undefined;
    const explicitGate: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseExplicit = resolve;
    });
    mocks.registrationStatuses = ['unavailable', 'ready'];
    mocks.registrationReconcileGates = [explicitGate, null];

    const explicit: Promise<{
      permission: 'granted' | 'denied' | 'unknown';
      status: 'unavailable' | 'ready' | 'error';
    }> = services.reconcileWebsiteAccess();
    await vi.waitFor((): void =>
      expect(reconcileContentRegistrationState).toHaveBeenCalledTimes(2),
    );
    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });
    mocks.setupWriteError = new Error('latest setup persistence failed');
    releaseExplicit();

    await expect(explicit).rejects.toThrow('latest setup persistence failed');
  });

  it('reconciles website blocking before Engine construction and injects only when ready', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.registrationStatuses = ['ready'];

    await finishBoot();

    expect(reconcileContentRegistrationState).toHaveBeenCalledOnce();
    expect(enginePorts().websiteBlockingReady?.()).toBe(true);
    const { injectIntoExistingTabs } = await import('../../../src/background/tabs');
    expect(injectIntoExistingTabs).toHaveBeenCalledWith(
      'assets/content-runtime.js',
      expect.any(Function),
    );
  });

  it('ignores unrelated permission events', async (): Promise<void> => {
    await finishBoot();
    vi.mocked(reconcileContentRegistrationState).mockClear();

    mocks.permissionAddedListener?.({ origins: ['https://calendar.example/*'] });
    mocks.permissionRemovedListener?.({ permissions: ['notifications'] });
    await Promise.resolve();

    expect(reconcileContentRegistrationState).not.toHaveBeenCalled();
  });

  it('does not inject before registration and restores capability after relevant access is added', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.registrationStatuses = ['unavailable', 'ready'];
    const { injectIntoExistingTabs } = await import('../../../src/background/tabs');
    vi.mocked(injectIntoExistingTabs).mockClear();

    await finishBoot();
    expect(injectIntoExistingTabs).not.toHaveBeenCalled();

    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });
    await vi.waitFor((): void =>
      expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
        websiteAccess: 'granted',
        blockingRegistration: 'ready',
        websiteAccessNotice: null,
      }),
    );

    expect(enginePorts().websiteBlockingReady()).toBe(true);
    expect(injectIntoExistingTabs).toHaveBeenCalledWith(
      'assets/content-runtime.js',
      expect.any(Function),
    );
  });

  it('keeps blocking unavailable until existing-tab injection and setup persistence finish', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.registrationStatuses = ['unavailable', 'ready'];
    const { injectIntoExistingTabs } = await import('../../../src/background/tabs');
    await finishBoot();
    vi.mocked(injectIntoExistingTabs).mockClear();

    let releaseSetupWrite: () => void = (): void => undefined;
    let signalSetupWriteStarted: () => void = (): void => undefined;
    mocks.setupWriteGate = new Promise<void>((resolve: () => void): void => {
      releaseSetupWrite = resolve;
    });
    const setupWriteStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalSetupWriteStarted = resolve;
    });
    mocks.setupWriteStarted = signalSetupWriteStarted;

    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });
    await setupWriteStarted;
    const injectedBeforeSetupFinished: boolean =
      vi.mocked(injectIntoExistingTabs).mock.calls.length === 1;
    const readyWhileSetupBlocked: boolean = enginePorts().websiteBlockingReady();
    releaseSetupWrite();

    await vi.waitFor((): void => expect(enginePorts().websiteBlockingReady()).toBe(true));
    expect(injectedBeforeSetupFinished).toBe(true);
    expect(readyWhileSetupBlocked).toBe(false);
  });

  it('injects existing tabs but keeps blocking unavailable when setup persistence fails', async (): Promise<void> => {
    mocks.registrationStatuses = ['unavailable', 'ready'];
    const { injectIntoExistingTabs } = await import('../../../src/background/tabs');
    const setupFailure: Error = new Error('setup write failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    await finishBoot();
    vi.mocked(injectIntoExistingTabs).mockClear();
    mocks.setupWriteError = setupFailure;

    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });

    await vi.waitFor((): void => expect(consoleError).toHaveBeenCalled());
    expect(injectIntoExistingTabs).toHaveBeenCalledOnce();
    expect(enginePorts().websiteBlockingReady()).toBe(false);
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      websiteAccess: 'denied',
      blockingRegistration: 'unavailable',
    });
  });

  it('keeps blocking unavailable while existing-tab injection is still pending', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.registrationStatuses = ['unavailable', 'ready'];
    const { injectIntoExistingTabs } = await import('../../../src/background/tabs');
    await finishBoot();
    vi.mocked(injectIntoExistingTabs).mockClear();

    let releaseInjection: () => void = (): void => undefined;
    mocks.injectionGate = new Promise<void>((resolve: () => void): void => {
      releaseInjection = resolve;
    });
    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });
    await vi.waitFor((): void => expect(injectIntoExistingTabs).toHaveBeenCalledOnce());

    expect(enginePorts().websiteBlockingReady()).toBe(false);
    releaseInjection();
    await vi.waitFor((): void => expect(enginePorts().websiteBlockingReady()).toBe(true));
  });

  it('does not publish stale readiness when removal supersedes pending injection', async (): Promise<void> => {
    mocks.registrationStatuses = ['unavailable', 'ready', 'unavailable'];
    const { injectIntoExistingTabs } = await import('../../../src/background/tabs');
    await finishBoot();
    vi.mocked(injectIntoExistingTabs).mockClear();

    let releaseInjection: () => void = (): void => undefined;
    mocks.injectionGate = new Promise<void>((resolve: () => void): void => {
      releaseInjection = resolve;
    });
    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });
    await vi.waitFor((): void => expect(injectIntoExistingTabs).toHaveBeenCalledOnce());
    mocks.permissionRemovedListener?.({ origins: ['https://*/*'] });
    releaseInjection();

    await vi.waitFor((): void =>
      expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
        websiteAccess: 'denied',
        blockingRegistration: 'unavailable',
      }),
    );
    expect(enginePorts().websiteBlockingReady()).toBe(false);
  });

  it('persists registration error and keeps blocking unavailable when existing-tab injection fails', async (): Promise<void> => {
    mocks.registrationStatuses = ['unavailable', 'ready'];
    await finishBoot();
    mocks.injectionResult = false;

    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });

    await vi.waitFor((): void =>
      expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
        websiteAccess: 'granted',
        blockingRegistration: 'error',
      }),
    );
    expect(enginePorts().websiteBlockingReady()).toBe(false);
  });

  it('fails blocking readiness synchronously and ends an active session after access removal', async (): Promise<void> => {
    mocks.registrationStatuses = ['ready', { permission: 'denied', status: 'error' }];
    const now: number = Date.now();
    mocks.scenario.runtime = {
      ...emptyRuntime(now),
      session: {
        config: {
          mode: 'blacklist',
          strictness: 'hard',
          durationMin: 25,
          cycling: null,
          intention: 'protected work',
          source: 'manual',
          scheduleEntryId: null,
          rules: rulesFromLists(DEFAULT_LISTS),
        },
        startedAt: now,
        sessionEndsAt: now + 25 * 60_000,
        phase: 'focus',
        phaseStartedAt: now,
        phaseEndsAt: now + 25 * 60_000,
        cycleIndex: 0,
        pausedFrom: null,
        focusedMs: 0,
      },
    };
    await finishBoot();

    mocks.permissionRemovedListener?.({ origins: ['http://*/*'] });
    expect(enginePorts().websiteBlockingReady?.()).toBe(false);
    await vi.waitFor((): void => expect(mocks.websiteLossEndCalls).toBe(1));

    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      websiteAccess: 'denied',
      blockingRegistration: 'error',
      websiteAccessNotice: 'revoked-during-session',
    });
  });

  it('does not claim website access when the boot permission query is unknown', async (): Promise<void> => {
    mocks.registrationStatuses = [{ permission: 'unknown', status: 'error' }];

    await finishBoot();

    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      websiteAccess: 'pending',
      blockingRegistration: 'error',
      websiteAccessNotice: null,
    });
  });

  it('persists denied access when boot cleanup fails after missing permission', async (): Promise<void> => {
    mocks.registrationStatuses = [{ permission: 'denied', status: 'error' }];

    await finishBoot();

    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      websiteAccess: 'denied',
      blockingRegistration: 'error',
      websiteAccessNotice: null,
    });
  });

  it('serializes rapid removal and addition through setup persistence', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.registrationStatuses = ['ready', 'unavailable', 'ready'];
    const now: number = Date.now();
    mocks.localState[LOCAL_RUNTIME] = liveSessionRuntimeV2(now, 'hard');
    let releaseEnd: () => void = (): void => undefined;
    let signalEndStarted: () => void = (): void => undefined;
    const endGate: Promise<void> = new Promise((resolve: () => void): void => {
      releaseEnd = resolve;
    });
    const endStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalEndStarted = resolve;
    });
    mocks.websiteLossEndGate = endGate;
    mocks.websiteLossEndStarted = signalEndStarted;
    await finishBoot();

    mocks.permissionRemovedListener?.({ origins: ['http://*/*'] });
    expect(enginePorts().websiteBlockingReady()).toBe(false);
    await endStarted;
    mocks.permissionAddedListener?.({ origins: ['http://*/*'] });
    for (let turn: number = 0; turn < 10; turn += 1) await Promise.resolve();
    releaseEnd();

    await vi.waitFor((): void =>
      expect(reconcileContentRegistrationState).toHaveBeenCalledTimes(3),
    );
    await vi.waitFor((): void => expect(mocks.websiteLossEndCalls).toBe(1));
    await vi.waitFor((): void =>
      expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
        websiteAccess: 'granted',
        blockingRegistration: 'ready',
        websiteAccessNotice: null,
      }),
    );
    expect(enginePorts().websiteBlockingReady()).toBe(true);
  });

  it('does not generation-cancel active-session cleanup after permission removal', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.registrationStatuses = ['ready', 'unavailable', 'ready'];
    const now: number = Date.now();
    mocks.localState[LOCAL_RUNTIME] = liveSessionRuntimeV2(now, 'hard');
    let releaseRemovalReconcile: () => void = (): void => undefined;
    const removalReconcileGate: Promise<void> = new Promise((resolve: () => void): void => {
      releaseRemovalReconcile = resolve;
    });
    mocks.registrationReconcileGates = [null, removalReconcileGate, null];
    await finishBoot();

    mocks.permissionRemovedListener?.({ origins: ['https://*/*'] });
    await vi.waitFor((): void =>
      expect(reconcileContentRegistrationState).toHaveBeenCalledTimes(2),
    );
    expect(mocks.websiteLossEndCalls).toBe(1);
    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });
    expect(enginePorts().websiteBlockingReady()).toBe(false);
    releaseRemovalReconcile();

    await vi.waitFor((): void => expect(mocks.websiteLossEndCalls).toBe(1));
    await vi.waitFor((): void =>
      expect(reconcileContentRegistrationState).toHaveBeenCalledTimes(3),
    );
    await vi.waitFor((): void =>
      expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
        websiteAccess: 'granted',
        blockingRegistration: 'ready',
        websiteAccessNotice: null,
      }),
    );
    expect(enginePorts().websiteBlockingReady()).toBe(true);
  });

  it('retains the ended-session notice across two superseding permission removals', async (): Promise<void> => {
    mocks.registrationStatuses = ['ready', 'unavailable', 'unavailable'];
    const now: number = Date.now();
    mocks.scenario.runtime = {
      ...emptyRuntime(now),
      session: {
        config: {
          mode: 'blacklist',
          strictness: 'hard',
          durationMin: 25,
          cycling: null,
          intention: 'protected work',
          source: 'manual',
          scheduleEntryId: null,
          rules: rulesFromLists(DEFAULT_LISTS),
        },
        startedAt: now,
        sessionEndsAt: now + 25 * 60_000,
        phase: 'focus',
        phaseStartedAt: now,
        phaseEndsAt: now + 25 * 60_000,
        cycleIndex: 0,
        pausedFrom: null,
        focusedMs: 0,
      },
    };
    let releaseFirstCleanup: () => void = (): void => undefined;
    let signalFirstCleanupStarted: () => void = (): void => undefined;
    mocks.websiteLossEndGate = new Promise<void>((resolve: () => void): void => {
      releaseFirstCleanup = resolve;
    });
    const firstCleanupStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalFirstCleanupStarted = resolve;
    });
    mocks.websiteLossEndStarted = signalFirstCleanupStarted;
    await finishBoot();

    mocks.permissionRemovedListener?.({ origins: ['http://*/*'] });
    await firstCleanupStarted;
    mocks.permissionRemovedListener?.({ origins: ['https://*/*'] });
    releaseFirstCleanup();

    await vi.waitFor((): void =>
      expect(reconcileContentRegistrationState).toHaveBeenCalledTimes(3),
    );
    await vi.waitFor((): void =>
      expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
        websiteAccess: 'denied',
        blockingRegistration: 'unavailable',
        websiteAccessNotice: 'revoked-during-session',
      }),
    );
    expect(mocks.websiteLossEndCalls).toBe(1);
  });

  it('ends a restored active session when boot registration fails despite retained access', async (): Promise<void> => {
    mocks.registrationStatuses = ['error'];
    const now: number = Date.now();
    mocks.scenario.runtime = {
      ...emptyRuntime(now),
      session: {
        config: {
          mode: 'blacklist',
          strictness: 'friction',
          durationMin: 25,
          cycling: null,
          intention: 'protected work',
          source: 'manual',
          scheduleEntryId: null,
          rules: rulesFromLists(DEFAULT_LISTS),
        },
        startedAt: now,
        sessionEndsAt: now + 25 * 60_000,
        phase: 'focus',
        phaseStartedAt: now,
        phaseEndsAt: now + 25 * 60_000,
        cycleIndex: 0,
        pausedFrom: null,
        focusedMs: 0,
      },
    };

    await finishBoot();

    expect(mocks.websiteLossEndCalls).toBe(1);
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      websiteAccess: 'granted',
      blockingRegistration: 'error',
      websiteAccessNotice: 'registration-failed-during-session',
    });
  });

  it('clears a restored session before a failing setup read and retains its later notice', async (): Promise<void> => {
    mocks.registrationStatuses = ['error', 'error'];
    const setupReadFailure: Error = new Error('setup read failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const now: number = Date.now();
    mocks.scenario.runtime = {
      ...emptyRuntime(now),
      session: {
        config: {
          mode: 'blacklist',
          strictness: 'hard',
          durationMin: 25,
          cycling: null,
          intention: 'protected work',
          source: 'manual',
          scheduleEntryId: null,
          rules: rulesFromLists(DEFAULT_LISTS),
        },
        startedAt: now,
        sessionEndsAt: now + 25 * 60_000,
        phase: 'focus',
        phaseStartedAt: now,
        phaseEndsAt: now + 25 * 60_000,
        cycleIndex: 0,
        pausedFrom: null,
        focusedMs: 0,
      },
    };
    mocks.setupReadError = setupReadFailure;

    await finishBoot();

    expect(consoleError).toHaveBeenCalledWith('focus-lock background error', setupReadFailure);
    expect(mocks.websiteLossEndCalls).toBe(1);
    expect(engineRuntime().session).toBeNull();
    expect(mocks.tickActiveSessionStates).toEqual([false]);
    expect(mocks.applyBlockingActiveSessionStates.length).toBeGreaterThan(0);
    expect(mocks.applyBlockingActiveSessionStates).not.toContain(true);

    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });
    await vi.waitFor((): void =>
      expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
        websiteAccess: 'granted',
        blockingRegistration: 'error',
        websiteAccessNotice: 'registration-failed-during-session',
      }),
    );
    expect(mocks.websiteLossEndCalls).toBe(1);
  });

  it('clears a restored session before boot enforcement when a permission event supersedes boot', async (): Promise<void> => {
    mocks.registrationStatuses = ['error', 'error'];
    const now: number = Date.now();
    mocks.scenario.runtime = {
      ...emptyRuntime(now),
      session: {
        config: {
          mode: 'blacklist',
          strictness: 'hard',
          durationMin: 25,
          cycling: null,
          intention: 'protected work',
          source: 'manual',
          scheduleEntryId: null,
          rules: rulesFromLists(DEFAULT_LISTS),
        },
        startedAt: now,
        sessionEndsAt: now + 25 * 60_000,
        phase: 'focus',
        phaseStartedAt: now,
        phaseEndsAt: now + 25 * 60_000,
        cycleIndex: 0,
        pausedFrom: null,
        focusedMs: 0,
      },
    };
    let releaseBoot: () => void = (): void => undefined;
    mocks.bootGate = new Promise<void>((resolve: () => void): void => {
      releaseBoot = resolve;
    });

    main();
    await vi.waitFor((): void => expect(reconcileContentRegistrationState).toHaveBeenCalledOnce());
    mocks.permissionAddedListener?.({ origins: ['https://*/*'] });
    await vi.waitFor((): void =>
      expect(reconcileContentRegistrationState).toHaveBeenCalledTimes(2),
    );
    releaseBoot();
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });

    expect(mocks.websiteLossEndCalls).toBe(1);
    expect(engineRuntime().session).toBeNull();
    expect(mocks.tickActiveSessionStates).toEqual([false]);
    expect(mocks.applyBlockingActiveSessionStates).not.toContain(true);
  });

  it('classifies a clean install before boot and performs zero Sync calls', async (): Promise<void> => {
    mocks.localState = {};
    mocks.scenario.storedSync = { [SYNC_SETTINGS]: { ...DEFAULT_SETTINGS, retentionDays: 30 } };

    main();
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });

    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toMatchObject({ profile: 'clean' });
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    expect(chrome.storage.sync.getBytesInUse).not.toHaveBeenCalled();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
    expect(
      vi.mocked(chrome.runtime.onInstalled.addListener).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(chrome.storage.local.get).mock.invocationCallOrder[0] ?? 0);
  });

  it('finishes a resumed all-data clear at boot and leaves a clean profile', async (): Promise<void> => {
    const now: number = Date.now();
    mocks.persistDeviceIdOnGet = true;
    mocks.localState = {
      [LOCAL_SETUP]: {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        dataClear: { status: 'pending', scope: 'all', phase: 'remote' },
      },
      [LOCAL_RUNTIME]: emptyRuntime(now),
      [LOCAL_DATA_CLEAR_JOURNAL]: {
        scope: 'all',
        phase: 'remote',
        inventory: [SYNC_SETTINGS],
      },
    };
    mocks.scenario.storedSync = { [SYNC_SETTINGS]: DEFAULT_SETTINGS };

    main();
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });

    // The local wipe removes the stored runtime, and browser reset materializes the journal's own
    // projection in its place, so the profile a completed clear leaves is a clean one rather than
    // an absent one.
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(
      expect.arrayContaining([LOCAL_RUNTIME]),
    );
    expect(mocks.localState[LOCAL_RUNTIME]).toMatchObject({
      runtimeSchemaVersion: 2,
      session: null,
      todayAgg: null,
    });
    expect(mocks.localState[LOCAL_DEVICE_ID]).toBe('device-id');
    expect(mocks.scenario.storedSync[SYNC_SETTINGS]).toBeUndefined();
    expect(mocks.localState[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
    expect(mocks.localState[LOCAL_SETUP]).toEqual({
      ...DEFAULT_SETUP,
      websiteAccess: 'denied',
    });
    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toMatchObject({ profile: 'clean' });

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.sync.getBytesInUse).mockClear();
    vi.mocked(chrome.storage.sync.set).mockClear();
    vi.mocked(chrome.storage.sync.remove).mockClear();
    mocks.scenario.storedSync = { [SYNC_SETTINGS]: DEFAULT_SETTINGS };

    main();
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });

    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    expect(chrome.storage.sync.getBytesInUse).not.toHaveBeenCalled();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
  });

  it('recreates a clean marker after recovered all-data clear across two restarts', async (): Promise<void> => {
    const now: number = Date.now();
    mocks.persistDeviceIdOnGet = true;
    mocks.localState = {
      [LOCAL_INSTALL_MARKER]: {
        version: 1,
        profile: 'clean',
        latestReason: 'install',
        extensionVersion: '0.1.0',
      },
      [LOCAL_SETUP]: {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        dataClear: { status: 'pending', scope: 'all', phase: 'remote' },
      },
      [LOCAL_RUNTIME]: emptyRuntime(now),
      [LOCAL_DATA_CLEAR_JOURNAL]: {
        scope: 'all',
        phase: 'remote',
        inventory: [SYNC_SETTINGS],
      },
    };
    mocks.scenario.storedSync = { [SYNC_SETTINGS]: DEFAULT_SETTINGS };

    main();
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });

    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toMatchObject({ profile: 'clean' });
    expect(mocks.localState[LOCAL_DEVICE_ID]).toBe('device-id');

    for (let restart: number = 0; restart < 2; restart += 1) {
      vi.mocked(chrome.storage.sync.get).mockClear();
      vi.mocked(chrome.storage.sync.getBytesInUse).mockClear();
      vi.mocked(chrome.storage.sync.set).mockClear();
      vi.mocked(chrome.storage.sync.remove).mockClear();
      mocks.scenario.storedSync = { [SYNC_SETTINGS]: DEFAULT_SETTINGS };

      main();
      await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });

      expect(chrome.storage.sync.get).not.toHaveBeenCalled();
      expect(chrome.storage.sync.getBytesInUse).not.toHaveBeenCalled();
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
      expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
      expect(mocks.localState[LOCAL_INSTALL_MARKER]).toMatchObject({ profile: 'clean' });
    }
  });

  it.each([
    LOCAL_RUNTIME,
    LOCAL_LISTS_SNAPSHOT,
    LOCAL_EVENTS,
    LOCAL_DEVICE_ID,
    LOCAL_SYNC_JOURNAL,
    LOCAL_SYNC_QUOTA_EVICTION,
    LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
    LOCAL_CACHES,
  ])('classifies recognized legacy evidence %s before migration', async (key: string) => {
    const evidence: unknown =
      key === LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS
        ? { version: 1, items: {} }
        : key === LOCAL_SYNC_QUOTA_EVICTION
          ? {
              evicted: { 'aggm:legacy:2026-07': rollupMonth('2026-07', []) },
              setKeys: [],
            }
          : {};
    mocks.localState = { [key]: evidence };

    await finishBoot();

    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toMatchObject({ profile: 'legacy' });
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({ storageMode: null });
    expect(chrome.storage.sync.get).toHaveBeenCalledWith(null);
    expect(chrome.storage.sync.getBytesInUse).not.toHaveBeenCalled();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
  });

  it('keeps a persisted clean profile clean after a later update', async (): Promise<void> => {
    mocks.localState = {
      [LOCAL_INSTALL_MARKER]: {
        version: 1,
        profile: 'clean',
        latestReason: 'update',
        extensionVersion: '0.2.0',
      },
    };
    mocks.scenario.storedSync = { [SYNC_SETTINGS]: { ...DEFAULT_SETTINGS, retentionDays: 30 } };

    await finishBoot();

    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toMatchObject({ profile: 'clean' });
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('rejects invalid input before the worker is ready', async (): Promise<void> => {
    let releaseBoot: () => void = (): void => undefined;
    mocks.bootGate = new Promise<void>((resolve: () => void): void => {
      releaseBoot = resolve;
    });
    vi.mocked(routeMessage).mockClear();
    main();
    const responses: unknown[] = [];
    const sendResponse: (response: unknown) => void = (response: unknown): void => {
      responses.push(response);
    };

    try {
      expect(runtimeListener()({}, {}, sendResponse)).toBe(true);
      await Promise.resolve();

      expect(responses).toEqual([{ ok: false, error: 'invalid request' }]);
      expect(routeMessage).not.toHaveBeenCalled();
      expect(mocks.engineArguments).toBeNull();
    } finally {
      releaseBoot();
      await dispatchRuntime({ type: 'getSnapshot' });
    }
  });

  it('rejects invalid input after the worker is ready', async (): Promise<void> => {
    await finishBoot();
    vi.mocked(routeMessage).mockClear();

    await expect(dispatchRuntime({ type: 'unknown' })).resolves.toEqual({
      ok: false,
      error: 'invalid request',
    });
  });

  it('does not route invalid input', async (): Promise<void> => {
    await finishBoot();
    vi.mocked(routeMessage).mockClear();

    await dispatchRuntime(null);

    expect(routeMessage).not.toHaveBeenCalled();
  });

  it('dispatches one valid parsed request', async (): Promise<void> => {
    const request: Request = { type: 'getSnapshot' };
    const sender: chrome.runtime.MessageSender = { id: 'extension-id' };
    vi.mocked(routeMessage).mockClear();
    main();

    await expect(dispatchRuntime(request, sender)).resolves.toEqual({ ok: true });
    expect(routeMessage).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      request,
      sender,
      expect.anything(),
      expect.anything(),
    );
    expect(vi.mocked(routeMessage).mock.calls[0]?.[1]).toBe(request);
  });

  it('keeps reads responsive while onboarding controls remain ordered', async (): Promise<void> => {
    await finishBoot();
    vi.mocked(routeMessage).mockClear();
    let releaseFirstControl: () => void = (): void => undefined;
    let signalFirstControlStarted: () => void = (): void => undefined;
    const firstControlBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseFirstControl = resolve;
    });
    const firstControlStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalFirstControlStarted = resolve;
    });
    const routed: Request['type'][] = [];
    vi.mocked(routeMessage).mockImplementation(
      async (_engine: Engine, request: Request): Promise<unknown> => {
        routed.push(request.type);
        if (request.type === 'completeSetup') {
          signalFirstControlStarted();
          await firstControlBlocked;
        }
        return { ok: true };
      },
    );

    const firstControl: Promise<unknown> = dispatchRuntime({
      type: 'completeSetup',
      storageMode: 'local',
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
    });
    await firstControlStarted;
    const blockRead: Promise<unknown> = dispatchRuntime({
      type: 'getBlockState',
      url: 'https://example.com',
      docState: 'loaded',
    });
    const setupRead: Promise<unknown> = dispatchRuntime({ type: 'getSetupState' });
    const secondControl: Promise<unknown> = dispatchRuntime({
      type: 'dismissWebsiteAccessNotice',
    });
    for (let index: number = 0; index < 10; index += 1) await Promise.resolve();

    try {
      expect(routed).toContain('getBlockState');
      expect(routed).toContain('getSetupState');
      expect(routed).not.toContain('dismissWebsiteAccessNotice');
    } finally {
      releaseFirstControl();
      await Promise.all([firstControl, blockRead, setupRead, secondControl]);
    }

    expect(
      routed.filter((type: Request['type']): boolean => type === 'completeSetup'),
    ).toHaveLength(1);
    expect(
      routed.filter((type: Request['type']): boolean => type === 'dismissWebsiteAccessNotice'),
    ).toHaveLength(1);
    expect(routed.indexOf('completeSetup')).toBeLessThan(
      routed.indexOf('dismissWebsiteAccessNotice'),
    );
  });
});

describe('background session policy boot', () => {
  it('does not restore or rebuild the obsolete permanent-list matcher cache', async (): Promise<void> => {
    mocks.scenario.localCache = { version: 2, modes: {} };

    await finishBoot();

    expect(mocks.savedMatcherCaches).toEqual([]);
    expect(mocks.matcherCacheSaveAttempts).toBe(0);
    expect(mocks.engineArguments).toHaveLength(7);
    // The durable authority is resolved before the first tick, which is the new boot order.
    expect(mocks.bootTrace).toEqual(['recover', 'tick', 'checkSchedule']);
  });
});

describe('background pending lists tracking', () => {
  it('applies complete live list snapshots in listener arrival order', async () => {
    setCompleteSyncedPolicy();
    await finishBoot();
    vi.mocked(handleSyncChanges).mockClear();
    const first = await encodeListsForSync({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'first.example' }],
    });
    const second = await encodeListsForSync({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'second.example' }],
    });
    let releaseFirstRead: () => void = (): void => {
      throw new Error('first list snapshot read did not start');
    };
    let signalFirstRead: () => void = (): void => {
      throw new Error('first list snapshot signal was not initialized');
    };
    const firstReadStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalFirstRead = resolve;
    });
    let listReads: number = 0;
    const syncGetMock = vi.mocked(chrome.storage.sync.get) as unknown as {
      mockImplementation: (
        implementation: (
          keys: string | string[] | Record<string, unknown> | null | undefined,
        ) => Promise<Record<string, unknown>>,
      ) => void;
    };
    syncGetMock.mockImplementation(
      async (
        keys: string | string[] | Record<string, unknown> | null | undefined,
      ): Promise<Record<string, unknown>> => {
        if (Array.isArray(keys) && keys.includes(SYNC_LISTS)) {
          listReads += 1;
          if (listReads === 1) {
            signalFirstRead();
            await new Promise<void>((resolve: () => void): void => {
              releaseFirstRead = resolve;
            });
            return structuredClone(first.sets);
          }
          return structuredClone(second.sets);
        }
        return {};
      },
    );
    const listener: StorageListener | null = mocks.storageListener;
    if (listener === null) throw new Error('storage listener was not registered');

    listener({ [SYNC_LISTS]: { newValue: first.sets[SYNC_LISTS] } }, 'sync');
    await firstReadStarted;
    listener({ [SYNC_LISTS]: { newValue: second.sets[SYNC_LISTS] } }, 'sync');
    await vi.waitFor((): void => expect(listReads).toBe(2));
    await Promise.resolve();
    await Promise.resolve();
    releaseFirstRead();
    await vi.waitFor((): void => expect(handleSyncChanges).toHaveBeenCalledTimes(2));

    expect(
      vi.mocked(handleSyncChanges).mock.calls.map((call: unknown[]): unknown => call[5]),
    ).toEqual([first.sets, second.sets]);
  });

  it('reads the complete list snapshot when a category shard changes', async () => {
    setCompleteSyncedPolicy();
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const lists: ListsConfig = { ...DEFAULT_LISTS, exclusions };
    const encoding = await encodeListsForSync(lists);
    mocks.scenario.storedSync = structuredClone(encoding.sets);
    await finishBoot();
    vi.mocked(handleSyncChanges).mockClear();
    const shardKey: string = LIST_SYNC_SHARD_KEYS[0] as string;
    const listener: StorageListener | null = mocks.storageListener;
    if (listener === null) throw new Error('storage listener was not registered');

    listener({ [shardKey]: { newValue: encoding.sets[shardKey] } }, 'sync');

    await vi.waitFor((): void => expect(handleSyncChanges).toHaveBeenCalled());
    expect(vi.mocked(handleSyncChanges).mock.calls.at(-1)?.[5]).toEqual(encoding.sets);
  });

  it('reports a local lists write pending until SyncWriter flushes it', async () => {
    setCompleteSyncedPolicy();
    await finishBoot();
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };

    await enginePorts().savePolicy?.('lists', localLists);
    expect(enginePorts().hasPendingSync(SYNC_LISTS)).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(enginePorts().hasPendingSync(SYNC_LISTS)).toBe(false);
  });

  it('tracks a replayed lists journal before the worker becomes ready', async () => {
    setCompleteSyncedPolicy();
    const pendingLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replayed.example' }],
    };
    mocks.scenario.journal = { sets: { [SYNC_LISTS]: pendingLists }, removes: [] };
    mocks.localState[LOCAL_SYNC_JOURNAL] = mocks.scenario.journal;

    await finishBoot();

    expect(enginePorts().hasPendingSync(SYNC_LISTS)).toBe(true);
  });

  it('captures replayed lists pending state when a live event arrives during slow boot', async () => {
    setCompleteSyncedPolicy();
    vi.mocked(handleSyncChanges).mockClear();
    let releaseTick: () => void = (): void => {};
    mocks.tickGate = new Promise((resolve: () => void): void => {
      releaseTick = resolve;
    });
    const replayedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replayed.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };
    mocks.scenario.journal = { sets: { [SYNC_LISTS]: replayedLists }, removes: [] };
    mocks.localState[LOCAL_SYNC_JOURNAL] = mocks.scenario.journal;

    main();
    await vi.waitFor((): void => expect(mocks.engineArguments).not.toBeNull());
    const listener: StorageListener | null = mocks.storageListener;
    if (listener === null) throw new Error('storage listener was not registered');
    expect(enginePorts().hasPendingSync(SYNC_LISTS)).toBe(true);
    listener({ [SYNC_LISTS]: { newValue: liveLists } }, 'sync');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(enginePorts().hasPendingSync(SYNC_LISTS)).toBe(false);

    releaseTick();
    await vi.waitFor((): void => expect(handleSyncChanges).toHaveBeenCalled());
    expect(vi.mocked(handleSyncChanges).mock.calls.at(-1)?.[4]).toBe(true);
  });

  it('ignores a pre-consent Sync event that arrives during legacy import', async () => {
    let releaseJournalLoad: () => void = (): void => {};
    mocks.bootGate = new Promise((resolve: () => void): void => {
      releaseJournalLoad = resolve;
    });
    const replayedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replayed.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };
    mocks.scenario.journal = { sets: { [SYNC_LISTS]: replayedLists }, removes: [] };

    main();
    const listener: StorageListener | null = mocks.storageListener;
    if (listener === null) throw new Error('storage listener was not registered');
    listener({ [SYNC_LISTS]: { newValue: liveLists } }, 'sync');
    releaseJournalLoad();

    await vi.waitFor((): void => expect(mocks.engineArguments).not.toBeNull());
    expect(handleSyncChanges).not.toHaveBeenCalled();
  });

  it('does not reconcile a pre-writer live event when the journal has no pending lists', async () => {
    setCompleteSyncedPolicy();
    const priorHandleCalls: number = vi.mocked(handleSyncChanges).mock.calls.length;
    let releaseJournalLoad: () => void = (): void => {};
    mocks.bootGate = new Promise((resolve: () => void): void => {
      releaseJournalLoad = resolve;
    });
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    main();
    const listener: StorageListener | null = mocks.storageListener;
    if (listener === null) throw new Error('storage listener was not registered');
    listener({ [SYNC_LISTS]: { newValue: liveLists } }, 'sync');
    releaseJournalLoad();

    await vi.waitFor((): void => {
      expect(vi.mocked(handleSyncChanges).mock.calls.length).toBeGreaterThan(priorHandleCalls);
    });
    expect(vi.mocked(handleSyncChanges).mock.calls[priorHandleCalls]?.[4]).toBe(false);
  });
});

describe('background boot state convergence', () => {
  it('degrades an invalid remote split-list authority to the local snapshot and records the drop', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'keep-local.example' }],
    };
    mocks.localState[LOCAL_LISTS_SNAPSHOT] = localLists;
    mocks.scenario.storedSync = {
      [SYNC_SETTINGS]: { ...DEFAULT_SETTINGS, retentionDays: 30 },
      [SYNC_LISTS]: {
        format: 'category-shards-v1',
        revision: '0'.repeat(64),
        custom: [{ kind: 'host', pattern: 'must-not-apply.example' }],
        whitelist: [],
        unexpected: true,
      },
    };

    await finishBoot();

    // The refused entry is replaced by the local snapshot, the readable one is imported, and the
    // profile boots. The record says what happened so Settings can show it.
    expect(engineLists()).toEqual(localLists);
    expect(engineSettings().retentionDays).toBe(30);
    expect(mocks.localState[LOCAL_LISTS_SNAPSHOT]).toEqual(localLists);
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      legacyImported: true,
      storageError: 'legacy-remote-policy-dropped',
    });
    expect(consoleError).toHaveBeenCalledWith(
      'focus-lock background error',
      expect.objectContaining({ message: expect.stringContaining('lists') }),
    );
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
  });

  it('repairs an incomplete sharded journal from the local canonical snapshot', async () => {
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local-canonical.example' }],
    };
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const incomplete = await encodeListsForSync({ ...DEFAULT_LISTS, exclusions });
    delete incomplete.sets[LIST_SYNC_SHARD_KEYS[0] as string];
    mocks.scenario.journal = { sets: incomplete.sets, removes: [] };
    mocks.localState[LOCAL_LISTS_SNAPSHOT] = localLists;

    await finishBoot();

    expect(engineLists()).toEqual(localLists);
    const expected = await encodeListsForSync(localLists);
    expect(mocks.savedJournals.at(-1)).toEqual({
      sets: expected.sets,
      removes: expected.removes,
    });
  });

  it('degrades incomplete remote split-list shards to the local snapshot and records the drop', async () => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'keep-local.example' }],
    };
    mocks.localState[LOCAL_LISTS_SNAPSHOT] = localLists;
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const encoding = await encodeListsForSync({ ...DEFAULT_LISTS, exclusions });
    const staleShards: Record<string, unknown> = { ...encoding.sets };
    delete staleShards[SYNC_LISTS];
    mocks.scenario.storedSync = staleShards;
    vi.mocked(missingSyncDefaults).mockReturnValueOnce({ [SYNC_LISTS]: DEFAULT_LISTS });

    await finishBoot();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(engineLists()).toEqual(localLists);
    expect(mocks.scenario.storedSync).toEqual(staleShards);
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      legacyImported: true,
      storageError: 'legacy-remote-policy-dropped',
    });
    // Nothing reaches Chrome Sync before the person chooses a storage mode again.
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
  });

  it('preserves a quota eviction checkpoint until explicit Sync consent', async () => {
    const evictedMonthKey: string = 'aggm:old-device:2024-01';
    const evictedMonth = rollupMonth('2024-01', []);
    mocks.localState[LOCAL_SYNC_QUOTA_EVICTION] = {
      evicted: { [evictedMonthKey]: evictedMonth },
      setKeys: [SYNC_SETTINGS],
    };

    await finishBoot();

    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(mocks.localState[LOCAL_SYNC_QUOTA_EVICTION]).toEqual({
      evicted: { [evictedMonthKey]: evictedMonth },
      setKeys: [SYNC_SETTINGS],
    });
  });

  it('keeps an oversized legacy replay paused before explicit consent', async () => {
    const evictedMonthKey: string = 'aggm:old-device:2024-01';
    const pendingSettings: Settings = { ...DEFAULT_SETTINGS, retentionDays: 14 };
    const evictedMonth = rollupMonth('2024-01', []);
    evictedMonth.attempts = { ['m'.repeat(3_750)]: 1 };
    const storedSync: Record<string, unknown> = {
      [evictedMonthKey]: evictedMonth,
    };
    for (let index: number = 0; index < 12; index++) {
      storedSync[`agg:old-device:2026-08-${String(index + 1).padStart(2, '0')}`] = 'd'.repeat(
        7_600,
      );
    }
    const bytesBeforePadding: number = Object.entries(storedSync).reduce(
      (total: number, [key, value]: [string, unknown]): number => total + syncItemBytes(key, value),
      0,
    );
    const paddingKey: string = 'plugin:padding';
    const incomingBytes: number = syncItemBytes(SYNC_SETTINGS, pendingSettings);
    const paddingLength: number =
      SYNC_QUOTA_BYTES_TOTAL -
      Math.floor(incomingBytes / 2) -
      bytesBeforePadding -
      syncItemBytes(paddingKey, '');
    storedSync[paddingKey] = 'p'.repeat(paddingLength);
    mocks.scenario = {
      journal: { sets: { [SYNC_SETTINGS]: pendingSettings }, removes: [] },
      storedSync,
    };

    await finishBoot();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.scenario.storedSync[evictedMonthKey]).toEqual(evictedMonth);
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({ storageMode: null });
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('stages valid Sync settings over malformed pending state without publishing', async () => {
    const synced: Settings = {
      ...DEFAULT_SETTINGS,
      defaultMode: 'whitelist',
      retentionDays: 30,
    };
    mocks.scenario = {
      journal: { sets: { [SYNC_SETTINGS]: null }, removes: [] },
      storedSync: { [SYNC_SETTINGS]: synced },
    };

    await finishBoot();

    expect(engineSettings()).toEqual(synced);
    expect(mocks.savedJournals).toContainEqual({
      sets: { [SYNC_SETTINGS]: synced },
      removes: [],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('stages valid Sync lists over malformed pending state without publishing', async () => {
    const synced: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'synced.example' }],
    };
    mocks.scenario = {
      journal: { sets: { [SYNC_LISTS]: null }, removes: [] },
      storedSync: { [SYNC_LISTS]: synced },
    };

    await finishBoot();

    expect(engineLists()).toEqual(synced);
    expect(mocks.savedJournals).toContainEqual({
      sets: { [SYNC_LISTS]: synced },
      removes: [...LIST_SYNC_SHARD_KEYS],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('stages valid Sync bank over malformed pending state without publishing', async () => {
    const synced: BankState = { balanceMs: 42_000 };
    mocks.scenario = {
      journal: { sets: { [SYNC_BANK]: { balanceMs: -1 } }, removes: [] },
      storedSync: { [SYNC_BANK]: synced },
    };

    await finishBoot();

    expect(engineBank()).toEqual(synced);
    expect(mocks.savedJournals).toContainEqual({
      sets: { [SYNC_BANK]: synced },
      removes: [],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('sanitizes malformed transient pending base state when no remote policy exists', async () => {
    const fallbackStreak: StreakState = {
      current: 0,
      freezeTokens: 0,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [],
      activeMonth: '2026-08',
    };
    const expectedSets: Record<string, unknown> = {
      [SYNC_SETTINGS]: DEFAULT_SETTINGS,
      [SYNC_LISTS]: DEFAULT_LISTS,
      [SYNC_BANK]: { balanceMs: 0 },
      [SYNC_STREAK]: fallbackStreak,
    };
    mocks.scenario = {
      journal: {
        sets: {
          [SYNC_SETTINGS]: null,
          [SYNC_LISTS]: null,
          [SYNC_BANK]: { balanceMs: -1 },
          [SYNC_STREAK]: { current: 3, activeDays: null },
        },
        removes: [],
      },
      storedSync: {},
    };

    await finishBoot();

    expect(engineSettings()).toEqual(DEFAULT_SETTINGS);
    expect(engineLists()).toEqual(DEFAULT_LISTS);
    expect(engineBank()).toEqual({ balanceMs: 0 });
    expect(engineStreak()).toEqual(fallbackStreak);
    expect(mocks.savedJournals).toContainEqual({
      sets: expectedSets,
      removes: [...LIST_SYNC_SHARD_KEYS],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('degrades an invalid authoritative remote policy without mutating remote data', async () => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const evictedKey: string = 'aggm:legacy-device:2026-07';
    const evictedMonth = rollupMonth('2026-07', []);
    const invalidRemote: Record<string, unknown> = {
      [SYNC_SETTINGS]: 'invalid',
      [SYNC_BANK]: { balanceMs: -2 },
    };
    const checkpoint = {
      evicted: { [evictedKey]: evictedMonth },
      setKeys: [SYNC_SETTINGS],
    };
    const originalJournal: SyncJournal = {
      sets: { [SYNC_SETTINGS]: null },
      removes: [],
    };
    mocks.localState[LOCAL_SYNC_QUOTA_EVICTION] = checkpoint;
    mocks.localState[LOCAL_SYNC_JOURNAL] = originalJournal;
    mocks.scenario = {
      journal: originalJournal,
      storedSync: invalidRemote,
    };

    await finishBoot();

    // Both refused entries fall back to their defaults, the boot finishes, and the remote copies
    // are left exactly as they were: nothing repairs Chrome Sync without consent.
    expect(engineSettings()).toEqual(DEFAULT_SETTINGS);
    expect(engineBank()).toEqual({ balanceMs: 0 });
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      legacyImported: true,
      storageError: 'legacy-remote-policy-dropped',
    });
    expect(mocks.scenario.storedSync).toEqual(invalidRemote);
    expect(mocks.localState[LOCAL_SYNC_QUOTA_EVICTION]).toEqual(checkpoint);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
  });

  it('drops a refused remote rule with the lists entry and keeps the local snapshot', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'keep-local.example' }],
    };
    mocks.localState[LOCAL_LISTS_SNAPSHOT] = localLists;
    mocks.scenario.storedSync = {
      [SYNC_SETTINGS]: { ...DEFAULT_SETTINGS, retentionDays: 30 },
      [SYNC_BANK]: { balanceMs: 90_000 },
      [SYNC_LISTS]: {
        ...DEFAULT_LISTS,
        custom: [
          { kind: 'host', pattern: 'readable.example' },
          { kind: 'bogus', pattern: 'refused.example' },
        ],
      },
    };

    await finishBoot();

    // The strict validator refuses the whole lists entry for its one bad rule, so the local
    // snapshot stands in, while the readable entries beside it are imported as they are.
    expect(engineLists()).toEqual(localLists);
    expect(engineSettings().retentionDays).toBe(30);
    expect(engineBank()).toEqual({ balanceMs: 90_000 });
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      legacyImported: true,
      storageError: 'legacy-remote-policy-dropped',
    });
    expect(consoleError).toHaveBeenCalledWith(
      'focus-lock background error',
      expect.objectContaining({ message: expect.stringContaining('lists') }),
    );
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('drops a refused remote streak and boots on the fresh one', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    mocks.scenario.storedSync = {
      [SYNC_SETTINGS]: { ...DEFAULT_SETTINGS, retentionDays: 30 },
      [SYNC_STREAK]: { current: -1 },
    };

    await finishBoot();

    expect(engineStreak()).toEqual(emptyStreak(localMonthStr(Date.now())));
    expect(engineSettings().retentionDays).toBe(30);
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      legacyImported: true,
      storageError: 'legacy-remote-policy-dropped',
    });
    expect(consoleError).toHaveBeenCalledWith(
      'focus-lock background error',
      expect.objectContaining({ message: expect.stringContaining('streak') }),
    );
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('records no drop when every remote entry is readable', async () => {
    mocks.scenario.storedSync = {
      [SYNC_SETTINGS]: { ...DEFAULT_SETTINGS, retentionDays: 30 },
      [SYNC_LISTS]: DEFAULT_LISTS,
      [SYNC_BANK]: { balanceMs: 90_000 },
    };

    await finishBoot();

    expect(engineSettings().retentionDays).toBe(30);
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      legacyImported: true,
      storageError: null,
    });
  });

  it('keeps the defaults for absent remote entries when one entry is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const now: number = Date.now();
    const localStreak: StreakState = {
      current: 2,
      freezeTokens: 1,
      lastCountedDate: localDateStr(now),
      lastFreezeGrantDate: null,
      activeDays: [new Date(now).getDate()],
      activeMonth: localMonthStr(now),
    };
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'keep-local.example' }],
    };
    // Every local value is present, so a fallback that reaches for local values by mistake shows.
    mocks.localState[LOCAL_SETTINGS] = { ...DEFAULT_SETTINGS, retentionDays: 45 };
    mocks.localState[LOCAL_BANK] = { balanceMs: 777 };
    mocks.localState[LOCAL_STREAK] = localStreak;
    mocks.localState[LOCAL_LISTS_SNAPSHOT] = localLists;
    mocks.scenario.storedSync = { [SYNC_STREAK]: { current: -1 } };

    await finishBoot();

    // The refused streak takes the local streak. The entries that are merely absent remotely
    // take what a clean import gives them: the defaults, and the local lists snapshot that is the
    // v1 compatibility authority for lists.
    expect(engineStreak()).toEqual(localStreak);
    expect(engineSettings()).toEqual(DEFAULT_SETTINGS);
    expect(engineBank()).toEqual({ balanceMs: 0 });
    expect(engineLists()).toEqual(localLists);
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      legacyImported: true,
      storageError: 'legacy-remote-policy-dropped',
    });
  });

  it('boots again after a local-history clear over a degraded import', async () => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    mocks.scenario.storedSync = {
      [SYNC_SETTINGS]: { ...DEFAULT_SETTINGS, retentionDays: 30 },
      [SYNC_STREAK]: { current: -1 },
    };
    await finishBoot();
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      storageError: 'legacy-remote-policy-dropped',
    });
    const storage: PolicyStorage = vi.mocked(routeMessage).mock.calls.at(-1)?.[3] as PolicyStorage;

    // "Delete local history" copies the record's storage error into its journal. Every code the
    // record can carry has to parse back, or the clear strands the profile behind a journal the
    // next boot refuses to read.
    await storage.clearLocalHistory();
    await storage.finishLocalHistoryClear();
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({
      dataClear: { status: 'idle', scope: null, phase: null },
    });

    vi.mocked(routeMessage).mockClear();
    main();
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toEqual({ ok: true });
    expect(routeMessage).toHaveBeenCalledOnce();
    await expect(dispatchRuntime({ type: 'getBootFailure' })).resolves.toEqual({
      ok: true,
      failure: null,
    });
  });

  it.each([
    ['old defaults', DEFAULT_SETTINGS, false],
    ['old customized settings', { ...DEFAULT_SETTINGS, retentionDays: 30 }, true],
  ] as const)(
    'imports %s with the root-level boolean moved into the gate',
    async (_label, settings, allowForceEnd) => {
      // A v1 record carries the boolean beside `gate`, never inside it.
      const { allowForceEnd: _nested, ...v1Gate } = settings.gate;
      mocks.scenario.storedSync = {
        [SYNC_SETTINGS]: { ...structuredClone(settings), gate: v1Gate, allowForceEnd },
      };

      await finishBoot();

      expect(engineSettings()).toEqual({
        ...settings,
        gate: { ...settings.gate, allowForceEnd },
      });
      expect(engineSettings()).not.toHaveProperty('allowForceEnd');
    },
  );

  it.each([false, true])(
    'serves setup after importing canonical gate.allowForceEnd=%s from the legacy layout',
    async (allowForceEnd: boolean): Promise<void> => {
      const settings: Settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        retentionDays: 30,
        gate: { ...DEFAULT_SETTINGS.gate, allowForceEnd },
      };
      mocks.scenario.storedSync = { [SYNC_SETTINGS]: settings };
      const actualRouter: typeof import('../../../src/background/router') = await vi.importActual(
        '../../../src/background/router',
      );
      vi.mocked(routeMessage).mockImplementationOnce(actualRouter.routeMessage);

      main();
      // `legacyImported` names the storage layout that was imported, not the settings shape.
      await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toMatchObject({
        version: 1,
        legacyImported: true,
        storageError: null,
      });
      expect(engineSettings()).toEqual(settings);
      expect(engineSettings().gate.allowForceEnd).toBe(allowForceEnd);
      expect(mocks.localState[LOCAL_SETUP]).toMatchObject({ legacyImported: true });
    },
  );

  it('preserves valid pending base state over older sync state', async () => {
    const pendingSettings: Settings = { ...DEFAULT_SETTINGS, retentionDays: 14 };
    const syncedSettings: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const pendingLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'pending.example' }],
    };
    const syncedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'synced.example' }],
    };
    const pendingBank: BankState = { balanceMs: 42_000 };
    const syncedBank: BankState = { balanceMs: 21_000 };
    const pendingStreak: StreakState = {
      current: 3,
      freezeTokens: 1,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [26, 27, 28],
      activeMonth: '2026-08',
    };
    const syncedStreak: StreakState = {
      ...pendingStreak,
      current: 2,
      lastCountedDate: '2026-08-27',
      activeDays: [26, 27],
    };
    const pendingSets: Record<string, unknown> = {
      [SYNC_SETTINGS]: pendingSettings,
      [SYNC_LISTS]: pendingLists,
      [SYNC_BANK]: pendingBank,
      [SYNC_STREAK]: pendingStreak,
    };
    mocks.scenario = {
      journal: { sets: pendingSets, removes: [] },
      storedSync: {
        [SYNC_SETTINGS]: syncedSettings,
        [SYNC_LISTS]: syncedLists,
        [SYNC_BANK]: syncedBank,
        [SYNC_STREAK]: syncedStreak,
      },
    };

    await finishBoot();

    expect(engineSettings()).toEqual(pendingSettings);
    expect(engineLists()).toEqual(pendingLists);
    expect(engineBank()).toEqual(pendingBank);
    expect(engineStreak()).toEqual(pendingStreak);
    expect(mocks.savedJournals).toContainEqual({
      sets: pendingSets,
      removes: [...LIST_SYNC_SHARD_KEYS],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('drops oversized pending settings and lists before selecting valid stored Sync', async () => {
    const pendingSettings: Settings = oversizedSettings('pending');
    const pendingLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('pending'),
    };
    const syncedSettings: Settings = { ...DEFAULT_SETTINGS, retentionDays: 14 };
    const syncedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'synced.example' }],
    };
    mocks.scenario = {
      journal: {
        sets: {
          [SYNC_SETTINGS]: pendingSettings,
          [SYNC_LISTS]: pendingLists,
        },
        removes: [],
      },
      storedSync: {
        [SYNC_SETTINGS]: syncedSettings,
        [SYNC_LISTS]: syncedLists,
      },
    };

    await finishBoot();

    expect(engineSettings()).toEqual(syncedSettings);
    expect(engineLists()).toEqual(syncedLists);
    expect(mocks.savedJournals).toContainEqual({ sets: {}, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [SYNC_SETTINGS]: expect.anything() }),
    );
    expect(chrome.storage.sync.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [SYNC_LISTS]: expect.anything() }),
    );
  });

  it('replaces oversized pending settings and lists with bounded defaults when Sync is absent', async () => {
    const pendingSettings: Settings = oversizedSettings('pending');
    const pendingLists: ListsConfig = {
      ...DEFAULT_LISTS,
      whitelist: oversizedHostRules('pending'),
    };
    mocks.scenario = {
      journal: {
        sets: {
          [SYNC_SETTINGS]: pendingSettings,
          [SYNC_LISTS]: pendingLists,
        },
        removes: [],
      },
      storedSync: {},
    };

    await finishBoot();

    expect(engineSettings()).toEqual(DEFAULT_SETTINGS);
    expect(engineLists()).toEqual(DEFAULT_LISTS);
    expect(mocks.savedJournals).toContainEqual({ sets: {}, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('accepts oversized schema-valid values already stored in Sync without rewriting them', async () => {
    const syncedSettings: Settings = oversizedSettings('synced');
    const syncedLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('synced'),
    };
    mocks.scenario = {
      journal: { sets: {}, removes: [] },
      storedSync: {
        [SYNC_SETTINGS]: syncedSettings,
        [SYNC_LISTS]: syncedLists,
      },
    };

    await finishBoot();

    expect(engineSettings()).toEqual(syncedSettings);
    expect(engineLists()).toEqual(syncedLists);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('drops oversized pending aggregate and archive values before local import', async () => {
    const aggregateKey: string = 'agg:device-a:2026-08-28';
    const archiveKey: string = 'archive:clock-rebase:device-a:2026-08-28:1:test';
    const oversizedAggregate: DailyAgg = {
      ...emptyDaily('2026-08-28'),
      attempts: { [`${'x'.repeat(8_192)}.example`]: 1 },
    };
    const oversizedArchive: DailyAgg = {
      ...emptyDaily('2026-08-28'),
      attempts: { [`${'y'.repeat(8_192)}.example`]: 1 },
    };
    mocks.scenario = {
      journal: {
        sets: {
          [aggregateKey]: oversizedAggregate,
          [archiveKey]: oversizedArchive,
        },
        removes: [],
      },
      storedSync: {},
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: {}, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    for (const [items] of vi.mocked(chrome.storage.sync.set).mock.calls) {
      expect(items).not.toHaveProperty(aggregateKey);
      expect(items).not.toHaveProperty(archiveKey);
    }
  });

  it('replaces a malformed pending daily aggregate with valid sync history', async () => {
    const key: string = 'agg:device-a:2026-08-28';
    const synced: DailyAgg = { ...emptyDaily('2026-08-28'), focusMs: 60_000 };
    mocks.scenario = {
      journal: {
        sets: { [key]: { ...synced, sessionsStarted: 0.5 } },
        removes: [],
      },
      storedSync: { [key]: synced },
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: { [key]: synced }, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('replaces a malformed pending monthly aggregate with valid sync history', async () => {
    const key: string = 'aggm:device-a:2026-08';
    const synced: MonthlyAgg = rollupMonth('2026-08', [
      { ...emptyDaily('2026-08-28'), focusMs: 60_000 },
    ]);
    mocks.scenario = {
      journal: {
        sets: { [key]: { ...synced, sessionsCompleted: 0.5 } },
        removes: [],
      },
      storedSync: { [key]: synced },
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: { [key]: synced }, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('drops malformed pending aggregates when sync has no valid history', async () => {
    const dailyKey: string = 'agg:device-a:2026-08-28';
    const monthlyKey: string = 'aggm:device-a:2026-08';
    mocks.scenario = {
      journal: {
        sets: {
          [dailyKey]: { ...emptyDaily('2026-08-28'), sessionsStarted: 0.5 },
          [monthlyKey]: {
            ...rollupMonth('2026-08', []),
            sessionsCompleted: 0.5,
          },
        },
        removes: [],
      },
      storedSync: {
        [dailyKey]: { ...emptyDaily('2026-08-28'), attemptsOther: 0.5 },
        [monthlyKey]: { ...rollupMonth('2026-08', []), unlocksTaken: 0.5 },
      },
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: {}, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('rejects pending aggregates whose embedded period does not match the key', async () => {
    const dailyKey: string = 'agg:device-a:2026-08-28';
    const monthlyKey: string = 'aggm:device-a:2026-08';
    const syncedDaily: DailyAgg = emptyDaily('2026-08-28');
    const syncedMonthly: MonthlyAgg = rollupMonth('2026-08', []);
    const expectedSets: Record<string, unknown> = {
      [dailyKey]: syncedDaily,
      [monthlyKey]: syncedMonthly,
    };
    mocks.scenario = {
      journal: {
        sets: {
          [dailyKey]: emptyDaily('2026-08-27'),
          [monthlyKey]: rollupMonth('2026-07', []),
        },
        removes: [],
      },
      storedSync: expectedSets,
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: expectedSets, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('preserves valid pending aggregates with matching key periods', async () => {
    const dailyKey: string = 'agg:device-a:2026-08-28';
    const monthlyKey: string = 'aggm:device-a:2026-08';
    const pendingDaily: DailyAgg = { ...emptyDaily('2026-08-28'), focusMs: 60_000 };
    const syncedDaily: DailyAgg = { ...pendingDaily, focusMs: 30_000 };
    const pendingMonthly: MonthlyAgg = rollupMonth('2026-08', [pendingDaily]);
    const syncedMonthly: MonthlyAgg = rollupMonth('2026-08', [syncedDaily]);
    const pendingSets: Record<string, unknown> = {
      [dailyKey]: pendingDaily,
      [monthlyKey]: pendingMonthly,
    };
    mocks.scenario = {
      journal: { sets: pendingSets, removes: [] },
      storedSync: {
        [dailyKey]: syncedDaily,
        [monthlyKey]: syncedMonthly,
      },
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({ sets: pendingSets, removes: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('preserves unknown pending keys and aggregate removals', async () => {
    const unknownKey: string = 'plugin:opaque-state';
    const removedKey: string = 'agg:device-a:2026-08-27';
    const unknownValue: Record<string, unknown> = { opaque: true };
    mocks.scenario = {
      journal: {
        sets: { [unknownKey]: unknownValue },
        removes: [removedKey],
      },
      storedSync: {},
    };

    await finishBoot();

    expect(mocks.savedJournals).toContainEqual({
      sets: { [unknownKey]: unknownValue },
      removes: [removedKey],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
  });

  it('replaces an older journal streak with newer sync progress before engine creation', async () => {
    const journaled: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-27',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [26, 27],
      activeMonth: '2026-08',
    };
    const synced: StreakState = {
      ...journaled,
      current: 3,
      lastCountedDate: '2026-08-28',
      activeDays: [26, 27, 28],
    };
    setScenario(journaled, synced);

    await finishBoot();

    expect(engineStreak()).toEqual(synced);
    expectJournaled(synced);
  });

  it('merges equal-marker journal and sync progress before engine creation', async () => {
    const journaled: StreakState = {
      current: 3,
      freezeTokens: 2,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 28],
      activeMonth: '2026-08',
    };
    const synced: StreakState = {
      ...journaled,
      current: 5,
      freezeTokens: 1,
      activeDays: [24, 25, 26, 27],
    };
    const merged: StreakState = {
      ...synced,
      freezeTokens: 2,
      activeDays: [24, 25, 26, 27, 28],
    };
    setScenario(journaled, synced);

    await finishBoot();

    expect(engineStreak()).toEqual(merged);
    expectJournaled(merged);
  });

  it('rebases future boot streak data to today before engine creation', async () => {
    const future: StreakState = {
      current: 5,
      freezeTokens: 2,
      lastCountedDate: '2026-09-01',
      lastFreezeGrantDate: '2026-09-01',
      activeDays: [1],
      activeMonth: '2026-09',
    };
    const corrected: StreakState = {
      current: 0,
      freezeTokens: 2,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [],
      activeMonth: '2026-08',
    };
    setScenario(future, future);

    await finishBoot();

    expect(engineStreak()).toEqual(corrected);
    expectJournaled(corrected);
  });

  it('ignores malformed journal streak data before rebasing boot state', async () => {
    const synced: StreakState = {
      current: 3,
      freezeTokens: 1,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [26, 27, 28],
      activeMonth: '2026-08',
    };
    setScenario(synced, synced);
    mocks.scenario.journal.sets[SYNC_STREAK] = {
      ...synced,
      activeDays: null,
    };

    await finishBoot();

    expect(engineStreak()).toEqual(synced);
    expectJournaled(synced);
  });

  it('defaults malformed journal streak data when sync has no valid streak', async () => {
    const fallback: StreakState = {
      current: 0,
      freezeTokens: 0,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [],
      activeMonth: '2026-08',
    };
    mocks.scenario = {
      journal: {
        sets: { [SYNC_STREAK]: { current: 3, activeDays: null } },
        removes: [],
      },
      storedSync: {},
    };

    await finishBoot();

    expect(engineStreak()).toEqual(fallback);
    expectJournaled(fallback);
  });
});

describe('background detached listener errors', () => {
  it('invalidates a removed tab synchronously before boot finishes', async () => {
    let releaseBoot: () => void = (): void => {
      throw new Error('boot resolver was not initialized');
    };
    mocks.bootGate = new Promise((resolve: () => void): void => {
      releaseBoot = resolve;
    });
    const dropped: Promise<void> = new Promise((resolve: () => void): void => {
      mocks.dropTabSignal = resolve;
    });
    main();
    if (mocks.removedListener === null) throw new Error('tab removal listener was not registered');

    mocks.removedListener(7);

    expect(mocks.invalidatedTabIds).toEqual([7]);
    expect(mocks.dropTabCalls).toEqual([]);

    releaseBoot();
    await dropped;

    expect(mocks.dropTabCalls).toEqual([7]);
  });

  it('refuses to believe a migration clear the storage layer kept', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    // The storage layer accepts the removal and keeps the value, which is the one failure a clear
    // cannot see without reading the key back.
    mocks.localRemoveDropKeys = [LOCAL_RUNTIME_MIGRATION];

    main();
    const listener: RuntimeListener = runtimeListener();
    const response: unknown = await new Promise<unknown>(
      (resolve: (value: unknown) => void): void => {
        listener({ type: 'getSnapshot' }, {}, resolve);
      },
    );

    // A marker that outlives the checkpoint explaining it is the state this read-back exists to
    // refuse, so the boot fails rather than treating the migration as finished.
    expect(response).toEqual({
      ok: false,
      error: expect.stringContaining('the runtime migration checkpoint survived its removal'),
    });
    // The asker is told and so is the log: a boot failure nobody records is one nobody can read.
    expect(consoleError).toHaveBeenCalledWith(
      'focus-lock background error',
      expect.objectContaining({
        message: 'the runtime migration checkpoint survived its removal',
      }),
    );
    expect(mocks.localState[LOCAL_RUNTIME_MIGRATION]).toBeDefined();
  });

  it('reports each rejected tab-removal branch once', async () => {
    const invalidationError = new Error('tab cleanup unavailable');
    const dropTabError = new Error('runtime storage unavailable');
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    await finishBoot();
    mocks.invalidationError = invalidationError;
    mocks.dropTabError = dropTabError;
    if (mocks.removedListener === null) throw new Error('tab removal listener was not registered');

    mocks.removedListener(7);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith('focus-lock background error', invalidationError);
    expect(consoleError).toHaveBeenCalledWith('focus-lock background error', dropTabError);
  });

  it('reports alarm and tab-removal rejections', async () => {
    const error = new Error('local storage unavailable');
    let reportCount: number = 0;
    let signalReported: () => void = (): void => {};
    const reported: Promise<void> = new Promise((resolve: () => void): void => {
      signalReported = resolve;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => {
      reportCount += 1;
      if (reportCount === 2) signalReported();
    });
    await finishBoot();
    // The tick alarm reaches the controller through the engine's alarm router now.
    mocks.alarmError = error;
    mocks.dropTabError = error;
    if (mocks.alarmListener === null) throw new Error('alarm listener was not registered');
    if (mocks.removedListener === null) throw new Error('tab removal listener was not registered');

    mocks.alarmListener({
      name: 'tick',
      persistAcrossSessions: false,
      scheduledTime: Date.now(),
    });
    mocks.removedListener(7);
    await reported;

    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenNthCalledWith(1, 'focus-lock background error', error);
    expect(consoleError).toHaveBeenNthCalledWith(2, 'focus-lock background error', error);
  });
});

describe('background all-data journal bootstrap', () => {
  const RESET_EPOCH: string = '50000000-0000-4000-8000-000000000001';
  const RESET_OPERATION: string = '50000000-0000-4000-8000-000000000002';
  const EVENT_ID: string = '50000000-0000-4000-8000-00000000000a';

  /** The marker projection a browser-reset journal carries, at the version this worker reports. */
  function cleanMarker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      profile: 'clean',
      latestReason: 'install',
      extensionVersion: 'unknown',
      ...overrides,
    };
  }

  /** A journal that has finished deleting storage and owes only the browser reset. */
  function browserResetJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 2,
      scope: 'all',
      phase: 'browser-reset',
      inventory: [],
      resetEpoch: RESET_EPOCH,
      resetOperationId: RESET_OPERATION,
      runtimeProjection: emptyRuntimeV2(Date.now(), RESET_EPOCH),
      setupProjection: DEFAULT_SETUP,
      installMarkerProjection: cleanMarker(),
      finalInstallMarkerProjection: cleanMarker(),
      pendingInstallLifecycleIntents: [],
      resetProgress: {
        attemptStartedAt: null,
        resolverPassCount: 0,
        targetGeneration: null,
        stablePasses: 0,
        targets: {},
        commands: {},
        acknowledgements: {},
        exclusions: [],
        deferredUnreachable: [],
      },
      retry: { batch: 1, automaticAttempt: 0, nextAttemptAt: Date.now(), lastError: null },
      ...overrides,
    };
  }

  function seedBrowserReset(overrides: Record<string, unknown> = {}): void {
    mocks.localState = {
      [LOCAL_SETUP]: DEFAULT_SETUP,
      [LOCAL_RUNTIME]: emptyRuntimeV2(Date.now(), RESET_EPOCH),
      [LOCAL_INSTALL_MARKER]: cleanMarker(),
      [LOCAL_DATA_CLEAR_JOURNAL]: browserResetJournal(overrides),
    };
  }

  /** Every value written to one local key, in order, whoever wrote it. */
  function localWrites(key: string): unknown[] {
    const calls: unknown[][] = vi.mocked(chrome.storage.local.set).mock.calls as unknown[][];
    return calls
      .map((call: unknown[]): Record<string, unknown> => call[0] as Record<string, unknown>)
      .filter((items: Record<string, unknown>): boolean => Object.hasOwn(items, key))
      .map((items: Record<string, unknown>): unknown => items[key]);
  }

  /** Every install marker this boot wrote, in order, whoever wrote it. */
  function installMarkerWrites(): unknown[] {
    return localWrites(LOCAL_INSTALL_MARKER);
  }

  /** Every write that started a browser-reset attempt, which is one per dispatch that runs one. */
  function attemptStarts(): unknown[] {
    return localWrites(LOCAL_DATA_CLEAR_JOURNAL).filter((value: unknown): boolean => {
      const journal: AllDataClearJournalV2 = value as AllDataClearJournalV2;
      return (
        journal.resetProgress?.attemptStartedAt != null &&
        journal.resetProgress.resolverPassCount === 0
      );
    });
  }

  function storedJournal(): AllDataClearJournalV2 | undefined {
    return mocks.localState[LOCAL_DATA_CLEAR_JOURNAL] as AllDataClearJournalV2 | undefined;
  }

  /** The services Main hands the router, which is where its dispatcher entry points are bound. */
  function routerServices(): {
    retryDataClear(): Promise<'ok' | 'retry-not-available'>;
    continueAllDataClear(): Promise<void>;
  } {
    const services: unknown = vi.mocked(routeMessage).mock.calls.at(-1)?.[4];
    if (services === null || typeof services !== 'object') {
      throw new Error('the router services were not bound');
    }
    return services as {
      retryDataClear(): Promise<'ok' | 'retry-not-available'>;
      continueAllDataClear(): Promise<void>;
    };
  }

  it('runs the clear before it classifies the profile the clear is erasing', async (): Promise<void> => {
    mocks.persistDeviceIdOnGet = true;
    mocks.localState = {
      [LOCAL_SETUP]: {
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        dataClear: { status: 'pending', scope: 'all', phase: 'remote' },
      },
      [LOCAL_RUNTIME]: emptyRuntime(Date.now()),
      // Legacy evidence a classification would have read: the marker it writes says `legacy`, and
      // it would outlive the clear that is deleting exactly these keys.
      [LOCAL_EVENTS]: [],
      [LOCAL_SYNC_JOURNAL]: { sets: {}, removes: [] },
      [LOCAL_DATA_CLEAR_JOURNAL]: { scope: 'all', phase: 'remote', inventory: [SYNC_SETTINGS] },
    };
    mocks.scenario.storedSync = { [SYNC_SETTINGS]: DEFAULT_SETTINGS };

    await finishBoot();

    expect(storedJournal()).toBeUndefined();
    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toMatchObject({ profile: 'clean' });
    expect(mocks.localState[LOCAL_EVENTS]).toBeUndefined();
    // Classification would have read the evidence above and written `legacy`, which is the marker
    // a clean profile must never carry. No write of one is the proof it never ran.
    expect(installMarkerWrites()).not.toContainEqual(
      expect.objectContaining({ profile: 'legacy' }),
    );
  });

  it('leaves the journal and publishes nothing when the clear cannot finish', async (): Promise<void> => {
    // The clean identity never becomes durable here, so finalization has nothing to read back and
    // the clear stays where it is rather than declaring itself done.
    mocks.persistDeviceIdOnGet = false;
    seedBrowserReset();

    await finishBoot();

    expect(storedJournal()).toMatchObject({ phase: 'browser-reset' });
    expect(mocks.tickCalls).toBe(0);
    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toEqual(cleanMarker());
  });

  it('finishes the browser reset and removes the journal', async (): Promise<void> => {
    mocks.persistDeviceIdOnGet = true;
    seedBrowserReset();

    await finishBoot();

    expect(storedJournal()).toBeUndefined();
    expect(mocks.localState[LOCAL_DEVICE_ID]).toBe('device-id');
    expect(mocks.tickCalls).toBe(1);
  });

  it('classifies nothing when the deletion state cannot be read', async (): Promise<void> => {
    mocks.localState = {
      [LOCAL_SETUP]: { ...DEFAULT_SETUP, completed: true, storageMode: 'local' },
      [LOCAL_RUNTIME]: emptyRuntimeV2(Date.now(), RESET_EPOCH),
      [LOCAL_EVENTS]: [],
      [LOCAL_DATA_CLEAR_JOURNAL]: { scope: 'all', phase: 'nonsense' },
    };

    main();

    // Fail closed. A stored value no parser accepts leaves the boot refusing every request, and
    // nothing classifies the profile, imports legacy policy, or ticks over data that may still be
    // being erased.
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('invalid data clear journal'),
    });
    expect(mocks.tickCalls).toBe(0);
    expect(installMarkerWrites()).toEqual([]);
    expect(mocks.localState[LOCAL_DATA_CLEAR_JOURNAL]).toEqual({
      scope: 'all',
      phase: 'nonsense',
    });
  });

  it('appends a lifecycle event to the journal instead of writing a marker', async (): Promise<void> => {
    mocks.persistDeviceIdOnGet = false;
    seedBrowserReset();
    await finishBoot();

    await installedListener()({
      reason: 'update',
      previousVersion: '0.9.0',
    } as chrome.runtime.InstalledDetails);
    await vi.waitFor((): void => {
      expect(storedJournal()?.pendingInstallLifecycleIntents).toHaveLength(1);
    });

    expect(storedJournal()?.pendingInstallLifecycleIntents[0]).toMatchObject({
      reason: 'update',
      previousVersion: '0.9.0',
      currentVersion: 'unknown',
    });
    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toEqual(cleanMarker());
  });

  it('writes nothing in the frame the lifecycle callback runs in', async (): Promise<void> => {
    mocks.persistDeviceIdOnGet = false;
    seedBrowserReset();
    await finishBoot();
    vi.mocked(chrome.storage.local.set).mockClear();

    installedListener()({ reason: 'install' } as chrome.runtime.InstalledDetails);

    // The Chrome boundary: a worker torn down here loses the event, and nothing durable is half
    // written, because the submission's first write happens in a later turn.
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('replays a captured event into the final marker before the clear ends', async (): Promise<void> => {
    mocks.persistDeviceIdOnGet = true;
    seedBrowserReset({
      pendingInstallLifecycleIntents: [
        {
          version: 1,
          eventId: EVENT_ID,
          reason: 'update',
          currentVersion: '1.1.0',
          previousVersion: '1.0.0',
          observedAt: Date.now(),
        },
      ],
    });

    await finishBoot();

    expect(storedJournal()).toBeUndefined();
    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toEqual(
      cleanMarker({ latestReason: 'update', extensionVersion: '1.1.0' }),
    );
  });

  it('applies a lifecycle event immediately once no clear owns the marker', async (): Promise<void> => {
    setCompleteLocalPolicy();
    mocks.localState[LOCAL_RUNTIME] = emptyRuntimeV2(Date.now(), TEST_EPOCH);
    await finishBoot();

    await installedListener()({
      reason: 'update',
      previousVersion: '0.9.0',
    } as chrome.runtime.InstalledDetails);
    await vi.waitFor((): void => {
      expect(mocks.localState[LOCAL_INSTALL_MARKER]).toMatchObject({ latestReason: 'update' });
    });

    expect(storedJournal()).toBeUndefined();
  });

  it('routes the retry alarm to the dispatcher rather than to the engine', async (): Promise<void> => {
    mocks.persistDeviceIdOnGet = false;
    seedBrowserReset();
    await finishBoot();
    expect(storedJournal()).toBeDefined();

    mocks.persistDeviceIdOnGet = true;
    if (mocks.alarmListener === null) throw new Error('alarm listener was not registered');
    mocks.alarmListener({
      name: 'data-clear-retry',
      persistAcrossSessions: false,
      scheduledTime: Date.now(),
    });
    await vi.waitFor((): void => {
      expect(storedJournal()).toBeUndefined();
    });

    expect(mocks.handledAlarms).not.toContain('data-clear-retry');
  });

  it('refuses a manual retry while the clear still has attempts scheduled', async (): Promise<void> => {
    mocks.persistDeviceIdOnGet = false;
    seedBrowserReset();
    await finishBoot();

    await expect(routerServices().retryDataClear()).resolves.toBe('retry-not-available');
  });

  it('begins a new batch for an exhausted clear and runs it', async (): Promise<void> => {
    mocks.persistDeviceIdOnGet = false;
    seedBrowserReset({
      retry: { batch: 1, automaticAttempt: 12, nextAttemptAt: null, lastError: 'reset-deadline' },
    });
    await finishBoot();
    expect(storedJournal()?.retry.nextAttemptAt).toBeNull();

    mocks.persistDeviceIdOnGet = true;
    await expect(routerServices().retryDataClear()).resolves.toBe('ok');

    expect(storedJournal()).toBeUndefined();
  });

  it('never repairs the marker back over one a replay advanced', async (): Promise<void> => {
    // The crash window between the advanced projection and the marker it produces: the projection
    // is durable, the marker is written from it, and the frozen clean projection must not be
    // materialized over the result on the next dispatch.
    const advanced: Record<string, unknown> = cleanMarker({
      latestReason: 'update',
      extensionVersion: '2.0.0',
    });
    mocks.persistDeviceIdOnGet = true;
    seedBrowserReset({ finalInstallMarkerProjection: advanced });
    mocks.localState[LOCAL_INSTALL_MARKER] = advanced;

    await finishBoot();

    expect(storedJournal()).toBeUndefined();
    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toEqual(advanced);
  });

  it('repairs a drifted runtime even after a replay advanced the marker', async (): Promise<void> => {
    // The repair and the marker are two different obligations. Withholding the repair to protect
    // the marker leaves a drifted runtime that finalization can never accept, and nothing records
    // or schedules anything for it, so the clear stops with the barrier shut and no wake coming.
    const advanced: Record<string, unknown> = cleanMarker({
      latestReason: 'update',
      extensionVersion: '2.0.0',
    });
    mocks.persistDeviceIdOnGet = true;
    seedBrowserReset({ finalInstallMarkerProjection: advanced });
    mocks.localState[LOCAL_INSTALL_MARKER] = advanced;
    // A stopped runtime that is not the projected one: the value a repair exists to correct.
    mocks.localState[LOCAL_RUNTIME] = emptyRuntimeV2(Date.now(), TEST_EPOCH);

    await finishBoot();

    expect(storedJournal()).toBeUndefined();
    expect(mocks.localState[LOCAL_INSTALL_MARKER]).toEqual(advanced);
    expect(mocks.localState[LOCAL_RUNTIME]).toMatchObject({ enforcementEpoch: RESET_EPOCH });
  });

  it('repairs a live-looking runtime rather than refusing to continue over it', async (): Promise<void> => {
    // The gate that protects a live session from being erased underneath itself belongs to the
    // clear that is being created. A clear that already exists is the authority, and its runtime is
    // its own projection, so refusing to continue on a drifted one strands the clear: the refusal
    // precedes every recorder, so no attempt is spent, no error is projected, and the alarm refires
    // on a timestamp that has already passed.
    mocks.persistDeviceIdOnGet = true;
    seedBrowserReset();
    mocks.localState[LOCAL_RUNTIME] = liveSessionRuntimeV2(Date.now());

    await finishBoot();

    expect(storedJournal()).toBeUndefined();
    expect(mocks.localState[LOCAL_RUNTIME]).toMatchObject({ session: null });
  });

  it('answers a second arrival while the clear holds the lease', async (): Promise<void> => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    mocks.persistDeviceIdOnGet = true;
    seedBrowserReset();
    await finishBoot();
    expect(storedJournal()).toBeUndefined();
    vi.mocked(chrome.storage.local.set).mockClear();
    mocks.localState[LOCAL_DATA_CLEAR_JOURNAL] = browserResetJournal();

    // Both arrive in the same turn, so the second reaches the dispatcher while the first holds
    // the lease. It must answer rather than queue: a queued run would finish the clear underneath
    // the first one, which then finalizes a journal that is already gone.
    const first: Promise<void> = routerServices().continueAllDataClear();
    const second: Promise<void> = routerServices().continueAllDataClear();
    await Promise.all([first, second]);

    expect(storedJournal()).toBeUndefined();
    expect(attemptStarts()).toHaveLength(1);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('background work target wiring', (): void => {
  it('registers the work tab listeners and binds a fanout port to the extension pages', async (): Promise<void> => {
    await finishBoot();

    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledOnce();
    expect(chrome.tabs.onCreated.addListener).toHaveBeenCalledOnce();
    expect(chrome.tabs.onReplaced.addListener).toHaveBeenCalledOnce();
    // The worker's own tab drop and the work target refresh both listen for removals.
    expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledTimes(2);

    const ports: EnginePorts = enginePorts();
    vi.mocked(chrome.runtime.sendMessage).mockClear();
    ports.workTargetChanged?.();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'workTargetChanged',
    });
  });

  it('keeps a removed tab flowing to the worker beside the work target refresh', async (): Promise<void> => {
    await finishBoot();
    if (mocks.removedListener === null) throw new Error('tab removal listener was not registered');
    vi.mocked(chrome.runtime.sendMessage).mockClear();

    mocks.removedListener(7);
    await vi.waitFor((): void => expect(mocks.dropTabCalls).toEqual([7]));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'workTargetChanged' });
  });
});

describe('background boot failure channel', (): void => {
  /** The worker under a runtime-stage failure: a v1 runtime whose migration clear is refused. */
  function seedRuntimeStageFailure(): {
    aggregateKey: string;
    aggregate: DailyAgg;
    legacyRuntime: LegacyRuntimeStateV1;
  } {
    const now: number = Date.now();
    const legacyRuntime: LegacyRuntimeStateV1 = {
      ...emptyRuntime(now),
      lastPruneDate: '2026-08-20',
    };
    const aggregateKey: string = 'agg:device-id:2026-08-28';
    const aggregate: DailyAgg = { ...emptyDaily('2026-08-28'), focusMs: 60_000 };
    setCompleteLocalPolicy();
    mocks.localState[LOCAL_RUNTIME] = legacyRuntime;
    mocks.localState[LOCAL_EVENTS] = [];
    mocks.localState[aggregateKey] = aggregate;
    // The storage layer accepts the removal and keeps the checkpoint, which the read-back refuses.
    mocks.localRemoveDropKeys = [LOCAL_RUNTIME_MIGRATION];
    return { aggregateKey, aggregate, legacyRuntime };
  }

  it('answers getSetupState with boot-failed when policy storage refuses to initialize', async (): Promise<void> => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    vi.mocked(routeMessage).mockClear();
    const storedSetup: Record<string, unknown> = { ...DEFAULT_SETUP, version: 2 };
    mocks.localState[LOCAL_SETUP] = storedSetup;

    main();
    const setup: unknown = await dispatchRuntime({ type: 'getSetupState' });

    expect(isSetupState(setup)).toBe(true);
    expect(setup).toMatchObject({ storageError: 'boot-failed' });
    await expect(dispatchRuntime({ type: 'getBootFailure' })).resolves.toEqual({
      ok: true,
      failure: {
        stage: 'policy-storage',
        message: expect.stringContaining('invalid local setup state'),
        at: expect.any(Number),
      },
    });
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('did not finish starting'),
    });
    await expect(dispatchRuntime({ type: 'getSettings' })).resolves.toEqual({
      ok: false,
      error: t('notify_boot_not_finished', { REASON: 'invalid local setup state' }),
    });
    expect(routeMessage).not.toHaveBeenCalled();
    // The failure is reported when the boot settles, not once per request that hits it.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      'focus-lock background error',
      expect.objectContaining({ message: 'invalid local setup state' }),
    );
    // The overlay is an answer, never a write: the stored record keeps the fault it was given.
    expect(mocks.localState[LOCAL_SETUP]).toEqual(storedSetup);
    expect(mocks.engineArguments).toBeNull();

    // Browser events keep arriving at a stopped worker. Each one finds the same settled failure,
    // and none of them may report it again.
    if (mocks.alarmListener === null) throw new Error('alarm listener was not registered');
    if (mocks.removedListener === null) throw new Error('tab removal listener was not registered');
    mocks.alarmListener({ name: 'tick', scheduledTime: Date.now() } as chrome.alarms.Alarm);
    mocks.removedListener(7);
    await vi.waitFor((): void => expect(mocks.invalidatedTabIds).toEqual([7]));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.handledAlarms).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(1);

    // The listeners that wait on Policy Storage rather than on the Engine find the same failure:
    // an inbound Chrome Sync change, an extension update, and the data clear retry alarm.
    if (mocks.storageListener === null) throw new Error('storage listener was not registered');
    mocks.storageListener({ [SYNC_SETTINGS]: { newValue: DEFAULT_SETTINGS } }, 'sync');
    installedListener()({ reason: 'update', previousVersion: '0.0.9' });
    mocks.alarmListener({
      name: 'data-clear-retry',
      scheduledTime: Date.now(),
    } as chrome.alarms.Alarm);
    for (let turn: number = 0; turn < 12; turn += 1) await Promise.resolve();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('does not queue a retried boot behind a stale permission reconcile', async (): Promise<void> => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    // The boot's own website reconcile is still running when Policy Storage refuses, a permission
    // removal queues behind it, and the retry queues its reconcile behind that one. The stale
    // reconcile must step aside rather than wait on the boot it is now blocking.
    let releaseBootReconcile: () => void = (): void => {};
    mocks.registrationReconcileGates = [
      new Promise<void>((resolve: () => void): void => {
        releaseBootReconcile = resolve;
      }),
    ];
    mocks.registrationStatuses = ['unavailable', 'unavailable', 'unavailable'];
    mocks.localState[LOCAL_SETUP] = { ...DEFAULT_SETUP, version: 2 };

    main();
    await expect(dispatchRuntime({ type: 'getBootFailure' })).resolves.toEqual({
      ok: true,
      failure: null,
    });
    // The failure settles while the reconcile is gated: the setup request observes it.
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toMatchObject({
      storageError: 'boot-failed',
    });
    if (mocks.permissionRemovedListener === null) {
      throw new Error('permission removal listener was not registered');
    }
    mocks.permissionRemovedListener({ origins: ['<all_urls>'] });
    mocks.localState[LOCAL_SETUP] = { ...DEFAULT_SETUP };
    const retried: Promise<unknown> = dispatchRuntime({ type: 'retryBoot' });
    for (let turn: number = 0; turn < 12; turn += 1) await Promise.resolve();
    releaseBootReconcile();

    await expect(retried).resolves.toEqual({ ok: true });
    expect(mocks.engineArguments).not.toBeNull();
  });

  it('re-runs the boot on retryBoot once the stored fault is repaired', async (): Promise<void> => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    mocks.recoverError = new Error('recovery journal unreadable');

    main();
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({
      ok: false,
      error: t('notify_boot_not_finished', { REASON: 'recovery journal unreadable' }),
    });
    const first: unknown[] | null = mocks.engineArguments;
    expect(first).not.toBeNull();
    await expect(dispatchRuntime({ type: 'getBootFailure' })).resolves.toEqual({
      ok: true,
      failure: { stage: 'engine', message: 'recovery journal unreadable', at: expect.any(Number) },
    });
    // The same fault again: the retry answers the reason rather than a false success.
    await expect(dispatchRuntime({ type: 'retryBoot' })).resolves.toEqual({
      ok: false,
      error: t('notify_boot_not_finished', { REASON: 'recovery journal unreadable' }),
    });
    expect(mocks.recoverCalls).toBe(2);

    mocks.recoverError = null;
    await expect(dispatchRuntime({ type: 'retryBoot' })).resolves.toEqual({ ok: true });

    expect(mocks.recoverCalls).toBe(3);
    expect(mocks.engineArguments).not.toBeNull();
    expect(mocks.engineArguments).not.toBe(first);
    await expect(dispatchRuntime({ type: 'getBootFailure' })).resolves.toEqual({
      ok: true,
      failure: null,
    });
    vi.mocked(routeMessage).mockClear();
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });
    // The listeners registered once read the ready promise lazily, so they reach the engine the
    // retry built, not the one the failed boot left behind.
    const routed: { constructedWith: unknown[] } = vi.mocked(routeMessage).mock
      .calls[0]?.[0] as unknown as { constructedWith: unknown[] };
    expect(routed.constructedWith).toBe(mocks.engineArguments);
    if (mocks.alarmListener === null) throw new Error('alarm listener was not registered');
    mocks.alarmListener({ name: 'tick', scheduledTime: Date.now() } as chrome.alarms.Alarm);
    await vi.waitFor((): void => expect(mocks.handledAlarms).toEqual(['tick']));
  });

  it('marks a runtime-stage failure and offers the local runtime reset', async (): Promise<void> => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const { aggregateKey, aggregate } = seedRuntimeStageFailure();

    main();
    const setup: unknown = await dispatchRuntime({ type: 'getSetupState' });

    expect(isSetupState(setup)).toBe(true);
    expect(setup).toMatchObject({ completed: true, storageError: 'runtime-boot-failed' });
    await expect(dispatchRuntime({ type: 'getBootFailure' })).resolves.toEqual({
      ok: true,
      failure: {
        stage: 'runtime',
        message: expect.stringContaining('survived its removal'),
        at: expect.any(Number),
      },
    });
    expect(mocks.engineArguments).toBeNull();
    const checkpoint: unknown = mocks.localState[LOCAL_RUNTIME_MIGRATION];
    expect(checkpoint).toBeDefined();
    const failedRuntime: unknown = mocks.localState[LOCAL_RUNTIME];
    expect(failedRuntime).toMatchObject({ runtimeSchemaVersion: 2 });
    expect(consoleError).toHaveBeenCalledTimes(1);

    // The storage layer honours removals again, and the person asks for the reset.
    mocks.localRemoveDropKeys = [];
    await expect(dispatchRuntime({ type: 'resetLocalRuntime' })).resolves.toEqual({ ok: true });

    expect(mocks.localState[LOCAL_RUNTIME_REJECTED]).toEqual({
      version: 1,
      reason: 'manual-reset',
      at: expect.any(Number),
      runtime: JSON.stringify(failedRuntime),
      migration: JSON.stringify(checkpoint),
    });
    expect(chrome.storage.local.remove).toHaveBeenCalledWith([
      LOCAL_RUNTIME,
      LOCAL_RUNTIME_MIGRATION,
    ]);
    expect(mocks.localState[LOCAL_RUNTIME_MIGRATION]).toBeUndefined();
    // The boot that follows the reset writes a fresh v2 runtime under the marker it kept.
    expect(mocks.localState[LOCAL_RUNTIME]).toMatchObject({
      runtimeSchemaVersion: 2,
      session: null,
    });
    expect(mocks.localState[LOCAL_RUNTIME]).not.toEqual(failedRuntime);
    expect(mocks.localState[LOCAL_RUNTIME_SCHEMA]).toEqual({ runtimeSchemaVersion: 2 });
    expect(mocks.localState[LOCAL_SETTINGS]).toEqual(DEFAULT_SETTINGS);
    expect(mocks.localState[LOCAL_EVENTS]).toEqual([]);
    expect(mocks.localState[aggregateKey]).toEqual(aggregate);
    expect(mocks.engineArguments).not.toBeNull();
    await expect(dispatchRuntime({ type: 'getBootFailure' })).resolves.toEqual({
      ok: true,
      failure: null,
    });
    await expect(dispatchRuntime({ type: 'getSnapshot' })).resolves.toEqual({ ok: true });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('refuses resetLocalRuntime when the failure is not in the runtime', async (): Promise<void> => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    mocks.localState[LOCAL_SETUP] = { ...DEFAULT_SETUP, version: 2 };

    main();
    await expect(dispatchRuntime({ type: 'resetLocalRuntime' })).resolves.toEqual({
      ok: false,
      error: t('notify_boot_not_finished', { REASON: 'invalid local setup state' }),
    });

    expect(chrome.storage.local.remove).not.toHaveBeenCalledWith(
      expect.arrayContaining([LOCAL_RUNTIME]),
    );
    expect(mocks.localState[LOCAL_RUNTIME_REJECTED]).toBeUndefined();
    expect(mocks.localState[LOCAL_RUNTIME]).toEqual({});
    expect(mocks.engineArguments).toBeNull();
  });

  it('keeps retryDataClear and the all-data clear reachable after a runtime-stage failure', async (): Promise<void> => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    seedRuntimeStageFailure();
    mocks.persistDeviceIdOnGet = true;

    main();
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toMatchObject({
      storageError: 'runtime-boot-failed',
    });
    // Nothing is exhausted, so the dispatcher's own refusal is the answer, in its own shape.
    await expect(dispatchRuntime({ type: 'retryDataClear' })).resolves.toEqual({
      ok: false,
      code: 'retry-not-available',
      error: t('notify_data_clear_retry_unavailable'),
    });

    mocks.localRemoveDropKeys = [];
    await expect(dispatchRuntime({ type: 'clearFocusLockData', scope: 'all' })).resolves.toEqual({
      ok: true,
      scope: 'all',
      status: 'cleared',
    });

    expect(mocks.localState[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
    expect(mocks.localState[LOCAL_RUNTIME_MIGRATION]).toBeUndefined();
    expect(mocks.localState[LOCAL_SETUP]).toMatchObject({ completed: false, storageError: null });
    // The profile is clean, and the worker boots over it on its own, into setup.
    expect(mocks.engineArguments).not.toBeNull();
    await expect(dispatchRuntime({ type: 'getBootFailure' })).resolves.toEqual({
      ok: true,
      failure: null,
    });
    vi.mocked(routeMessage).mockClear();
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toEqual({ ok: true });
    expect(routeMessage).toHaveBeenCalledOnce();
  });
});

describe('legacy upgrade profile', (): void => {
  /** Seeds both storage areas with the profile and grants website access for the boot. */
  function seedProfile(mutate: (profile: LegacyUpgradeProfile) => void = (): void => {}): void {
    const profile: LegacyUpgradeProfile = legacyUpgradeProfile();
    mutate(profile);
    mocks.localState = profile.local;
    mocks.scenario.storedSync = profile.sync;
    mocks.registrationStatuses = ['ready'];
  }

  /** The item records every call of one storage `set` mock received since the last clear. */
  function writtenItems(set: typeof chrome.storage.local.set): Record<string, unknown>[] {
    return vi
      .mocked(set)
      .mock.calls.map(
        (call: unknown[]): Record<string, unknown> => call[0] as Record<string, unknown>,
      );
  }

  /** The local keys every `chrome.storage.local.set` since the last clear touched. */
  function writtenLocalKeys(): string[] {
    return writtenItems(chrome.storage.local.set).flatMap(
      (items: Record<string, unknown>): string[] => Object.keys(items),
    );
  }

  function bootedRuntime(): RuntimeStateV2 {
    return engineRuntime() as unknown as RuntimeStateV2;
  }

  beforeEach((): void => {
    // The morning after the profile's last session, which is the day it was read.
    vi.setSystemTime(new Date(2026, 8, 10, 9, 0));
  });

  it('boots the 7 September profile, migrates settings once, migrates the stale v1 runtime, and serves setup', async (): Promise<void> => {
    const seededRuntime: LegacyUpgradeRuntimeV1 = legacyUpgradeRuntimeV1();
    seedProfile();
    vi.mocked(routeMessage).mockClear();

    await finishBoot();

    // Served: the Engine holds the migrated settings and a v2 runtime that kept the v1 statistics.
    expect(engineSettings()).toEqual(legacyUpgradeSettingsMigrated());
    const runtime: RuntimeStateV2 = bootedRuntime();
    expect(runtime.runtimeSchemaVersion).toBe(2);
    expect(runtime.session).toBeNull();
    expect(runtime.todayAgg).toEqual(seededRuntime.todayAgg);
    expect(runtime.lastPruneDate).toBe(seededRuntime.lastPruneDate);

    // Persisted: the settings were rewritten in the canonical shape, the direct commit revision
    // embeds them, and the runtime under the marker is v2 with nothing parked or checkpointed.
    expect(mocks.localState[LOCAL_SETTINGS]).toEqual(legacyUpgradeSettingsMigrated());
    const commit: { source: string; revision: string } = mocks.localState[LOCAL_POLICY_COMMIT] as {
      source: string;
      revision: string;
    };
    expect(commit.source).toBe('direct');
    expect(commit.revision.startsWith('policy-v1:')).toBe(true);
    expect(JSON.parse(commit.revision.slice('policy-v1:'.length))).toMatchObject({
      settings: legacyUpgradeSettingsMigrated(),
    });
    expect(mocks.localState[LOCAL_RUNTIME]).toMatchObject({
      runtimeSchemaVersion: 2,
      session: null,
      todayAgg: seededRuntime.todayAgg,
      lastPruneDate: seededRuntime.lastPruneDate,
    });
    expect(mocks.localState[LOCAL_RUNTIME_SCHEMA]).toEqual({ runtimeSchemaVersion: 2 });
    expect(mocks.localState[LOCAL_RUNTIME_MIGRATION]).toBeUndefined();
    expect(mocks.localState[LOCAL_RUNTIME_REJECTED]).toBeUndefined();
    expect(mocks.localState[LOCAL_EVENTS]).toEqual(legacyUpgradeEventsV1());
    const setup: SetupState = mocks.localState[LOCAL_SETUP] as SetupState;
    expect(setup).toMatchObject({ completed: true, legacyImported: true, storageMode: 'sync' });
    expect([null, 'sync-publish-failed']).toContain(setup.storageError);

    // Setup is answered by the router over a Policy Storage that reads the record back whole.
    vi.mocked(routeMessage).mockClear();
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toEqual({ ok: true });
    expect(routeMessage).toHaveBeenCalledOnce();
    const storage: PolicyStorage = vi.mocked(routeMessage).mock.calls[0]?.[3] as PolicyStorage;
    const served: SetupState = await storage.loadSetup();
    expect(isSetupState(served)).toBe(true);
    expect(served.completed).toBe(true);

    // The outbox the boot reconstructed carries the canonical record, and so does what the writer
    // publishes from it. The writer flushes on a timer, so the clock is advanced before the
    // publish is read: without that the loop would run over nothing and could not fail.
    const journal: SyncJournal = mocks.localState[LOCAL_SYNC_JOURNAL] as SyncJournal;
    expect(journal.sets[SYNC_SETTINGS]).toEqual(legacyUpgradeSettingsMigrated());
    await vi.advanceTimersByTimeAsync(10_000);
    const publishedSettings: unknown[] = writtenItems(chrome.storage.sync.set)
      .filter((items: Record<string, unknown>): boolean => Object.hasOwn(items, SYNC_SETTINGS))
      .map((items: Record<string, unknown>): unknown => items[SYNC_SETTINGS]);
    expect(publishedSettings.length).toBeGreaterThan(0);
    for (const published of publishedSettings) {
      expect(published).toEqual(legacyUpgradeSettingsMigrated());
    }
  });

  it('boots the profile a second time without writing settings again', async (): Promise<void> => {
    seedProfile();
    mocks.registrationStatuses = ['ready', 'ready'];
    await finishBoot();
    const settingsAfterFirstBoot: unknown = structuredClone(mocks.localState[LOCAL_SETTINGS]);
    const commitAfterFirstBoot: unknown = structuredClone(mocks.localState[LOCAL_POLICY_COMMIT]);
    // The first boot did rewrite the record. A repair that never writes would pass the rest of
    // this test on its own.
    expect(settingsAfterFirstBoot).toEqual(legacyUpgradeSettingsMigrated());
    vi.mocked(chrome.storage.local.set).mockClear();
    mocks.engineArguments = null;

    await finishBoot();

    expect(writtenLocalKeys()).not.toContain(LOCAL_SETTINGS);
    expect(writtenLocalKeys()).not.toContain(LOCAL_POLICY_COMMIT);
    expect(mocks.localState[LOCAL_SETTINGS]).toEqual(settingsAfterFirstBoot);
    expect(mocks.localState[LOCAL_POLICY_COMMIT]).toEqual(commitAfterFirstBoot);
    expect(mocks.localState[LOCAL_RUNTIME_REJECTED]).toBeUndefined();
    expect(mocks.localState[LOCAL_RUNTIME_MIGRATION]).toBeUndefined();
    expect(engineSettings()).toEqual(legacyUpgradeSettingsMigrated());
    expect(bootedRuntime().runtimeSchemaVersion).toBe(2);
  });

  it('carries a v1 until-stopped session over as an active until-stopped v2 session', async (): Promise<void> => {
    const startedAt: number = Date.now() - 5 * 60_000;
    const session: LegacyUpgradeSessionV1 = legacyIndefiniteSessionV1(startedAt);
    seedProfile((profile: LegacyUpgradeProfile): void => {
      const runtime: LegacyUpgradeRuntimeV1 = legacyUpgradeRuntimeV1();
      runtime.session = session;
      runtime.gate = legacyIndefiniteCancelGateV1(startedAt + 60_000);
      profile.local[LOCAL_RUNTIME] = runtime;
      profile.local[LOCAL_EVENTS] = [
        ...legacyUpgradeEventsV1(),
        legacyIndefiniteStartedEventV1(startedAt),
      ];
    });

    await finishBoot();

    const runtime: RuntimeStateV2 = bootedRuntime();
    expect(runtime.session?.sessionId).toBe(session.sessionId);
    expect(runtime.session?.config.duration.kind).toBe('until-stopped');
    expect(runtime.session?.sessionEndsAt).toBeNull();
    expect(runtime.session?.phase).toBe('focus');
    expect(runtime.gate).toEqual(legacyIndefiniteCancelGateV1(startedAt + 60_000));
    expect(runtime.pendingClosure).toBeNull();
    expect(mocks.localState[LOCAL_RUNTIME]).toMatchObject({
      runtimeSchemaVersion: 2,
      session: {
        sessionId: session.sessionId,
        sessionEndsAt: null,
        config: { duration: { kind: 'until-stopped' } },
      },
    });
    expect(mocks.localState[LOCAL_RUNTIME_REJECTED]).toBeUndefined();
    // The v1 start record with its null duration is history the log keeps as written.
    expect(mocks.localState[LOCAL_EVENTS]).toEqual([
      ...legacyUpgradeEventsV1(),
      legacyIndefiniteStartedEventV1(startedAt),
    ]);
    expect(engineSettings().gate.allowForceEnd).toBe(false);
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toEqual({ ok: true });
  });

  it('reports nothing on the healthy upgrade path', async (): Promise<void> => {
    // The e2e diagnostics gate collects every worker console error, so a downgrade-then-upgrade
    // that reported itself would fail the reproduction scenario on a boot that worked.
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    seedProfile();

    await finishBoot();
    await expect(dispatchRuntime({ type: 'getSetupState' })).resolves.toEqual({ ok: true });
    // The Sync writer's flush is a pending timer, and a report from that flush counts too.
    await vi.runOnlyPendingTimersAsync();

    expect(consoleError).not.toHaveBeenCalled();
    expect(mocks.engineArguments).not.toBeNull();
  });
});
