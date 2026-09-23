import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, type EnginePorts } from '../../../src/background/engine';
import { readEventsV2 } from '../../../src/background/event-log-v2';
import type { PolicyStorage } from '../../../src/background/policy-storage';
import { routeMessage } from '../../../src/background/router';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { type AggregateStorage, fetchStats } from '../../../src/background/stats-service';
import type { WorkTargetService } from '../../../src/background/work-target';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  rulesFromLists,
} from '../../../src/shared/constants';
import type {
  DocumentContentCommand,
  DocumentEnforcementCommand,
} from '../../../src/shared/enforcement-v2';
import { t } from '../../../src/shared/i18n';
import type { StatsBundle } from '../../../src/shared/messages';
import { isWebsiteAccessReconciliation } from '../../../src/shared/runtime-validation';
import type {
  EventRecord,
  ListsConfig,
  OnboardingDraft,
  SessionConfig,
  SetupState,
} from '../../../src/shared/types';
import { engineSeamPortsV2, uuidMinterV2 } from './engine-ports-fake';

vi.mock('../../../src/background/audio', () => ({ playSound: vi.fn() }));
vi.mock('../../../src/background/stats-service', () => ({ fetchStats: vi.fn() }));
vi.mock('../../../src/background/event-log-v2', async () => {
  const actual: typeof import('../../../src/background/event-log-v2') = await vi.importActual(
    '../../../src/background/event-log-v2',
  );
  return { ...actual, readEventsV2: vi.fn() };
});

/** The engine fixture boots on one fixed enforcement epoch so its runtime parses. */
const ENGINE_EPOCH_ID: string = '30000000-0000-4000-8000-0000000000a1';

const overlay: ReturnType<Engine['statsOverlay']> = {
  deviceId: 'devA',
  todayAgg: {
    date: '2026-08-29',
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    unlocksTaken: 0,
    resisted: 0,
  },
  streak: null,
  pendingEvents: [],
};
const engine: Engine = { statsOverlay: vi.fn(() => overlay) } as unknown as Engine;
const sender: chrome.runtime.MessageSender = {};

describe('content unlock domain authority', (): void => {
  it('rejects another domain for opening, confirming and abandoning', async (): Promise<void> => {
    const expectedGate = {
      kind: 'unlockSite' as const,
      host: 'reddit.com',
      openedAt: 1,
      readyAt: 2,
      requiredPhrase: null,
      forceEndAvailable: false,
    };
    const openGate = vi.fn().mockResolvedValue({ ok: true });
    const confirmGate = vi.fn().mockResolvedValue({ ok: true });
    const abandonGate = vi.fn().mockResolvedValue({ ok: true });
    const engine: Engine = { openGate, confirmGate, abandonGate } as unknown as Engine;
    for (const url of ['https://facebook.com', 'invalid', 'http://127.0.0.1']) {
      const content: chrome.runtime.MessageSender = { tab: { id: 1 } as chrome.tabs.Tab, url };
      expect(
        await routeMessage(
          engine,
          { type: 'openGate', gate: 'unlockSite', host: 'reddit.com' },
          content,
        ),
      ).toMatchObject({ ok: false });
      expect(
        await routeMessage(
          engine,
          { type: 'confirmGate', typedPhrase: null, expectedGate },
          content,
        ),
      ).toMatchObject({ ok: false });
      expect(
        await routeMessage(engine, { type: 'abandonGate', expectedGate }, content),
      ).toMatchObject({ ok: false });
    }
    expect(openGate).not.toHaveBeenCalled();
    expect(confirmGate).not.toHaveBeenCalled();
    expect(abandonGate).not.toHaveBeenCalled();
    await routeMessage(
      engine,
      { type: 'confirmGate', typedPhrase: null, expectedGate },
      { url: 'https://www.reddit.com', tab: { id: 1 } as chrome.tabs.Tab },
    );
    expect(confirmGate).toHaveBeenCalledWith(null, expectedGate);
    await routeMessage(
      engine,
      { type: 'abandonGate', expectedGate },
      { url: 'chrome-extension://test/popup.html' },
    );
    expect(abandonGate).toHaveBeenCalledWith(expectedGate);
  });
});
const stats: StatsBundle = {
  days: [],
  months: [],
  streak: {
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: '2026-08',
  },
  recentSessions: [],
  totals: {
    focusMsToday: 0,
    focusMsLast7Days: 0,
    attemptsToday: 0,
    resistedToday: 0,
  },
};

function onboardingStorage(
  overrides: Partial<Record<keyof PolicyStorage, unknown>> = {},
): PolicyStorage {
  return {
    loadSetup: vi.fn().mockResolvedValue(structuredClone(DEFAULT_SETUP)),
    updateSetup: vi.fn().mockResolvedValue(undefined),
    markSetupCompleted: vi.fn().mockResolvedValue(undefined),
    selectLocalMode: vi.fn().mockResolvedValue(undefined),
    enableSync: vi.fn().mockResolvedValue(undefined),
    storageMode: vi.fn().mockResolvedValue('local'),
    deleteRemoteData: vi.fn().mockResolvedValue(undefined),
    clearLocalHistory: vi.fn().mockResolvedValue(undefined),
    finishLocalHistoryClear: vi.fn().mockResolvedValue(undefined),
    allDataClearPublicState: vi
      .fn()
      .mockResolvedValue({ status: 'idle', scope: null, phase: null }),
    ...overrides,
  } as unknown as PolicyStorage;
}

function realBlockingEngine(options?: {
  now?: () => number;
  saveRuntime?: (runtime: RuntimeStateV2) => Promise<void> | void;
  onCommand?: (command: DocumentContentCommand) => void;
}): Engine {
  const now: () => number = options?.now ?? ((): number => new Date(2026, 7, 31, 12, 0).getTime());
  const ports: EnginePorts = {
    now,
    newId: uuidMinterV2(),
    rehydrateAfterDataClear: async (): Promise<string> => 'device-rehydrated',
    saveRuntime: async (runtime: RuntimeStateV2): Promise<void> => options?.saveRuntime?.(runtime),
    saveMatcherCache: async (): Promise<void> => undefined,
    queueSync: (): void => undefined,
    supersedeSync: (): void => undefined,
    removeSync: (): void => undefined,
    persistSyncJournal: async (): Promise<void> => undefined,
    appendEvents: async (): Promise<void> => undefined,
    broadcast: (): void => undefined,
    applyBlocking: async (): Promise<void> => undefined,
    playSound: (): void => undefined,
    notify: (): void => undefined,
    updateIcon: (): void => undefined,
    prune: async (): Promise<void> => undefined,
    reportError: (): void => undefined,
    websiteBlockingReady: (): boolean => true,
    hasPendingSync: (): boolean => false,
    // The controller reads its alarms back, so this fixture remembers what it scheduled.
    ...engineSeamPortsV2({
      now,
      rememberAlarms: true,
      readTargetGeneration: (): number => 0,
      onCommand: options?.onCommand,
    }),
  };
  return new Engine(
    ports,
    DEFAULT_SETTINGS,
    { ...DEFAULT_LISTS, custom: [{ kind: 'host', pattern: 'facebook.com' }] },
    { balanceMs: 0 },
    null,
    emptyRuntimeV2(now(), ENGINE_EPOCH_ID),
    'device-id',
  );
}

/** The one blocked enforcement command the router reads a stopped page out of. */
function blockingCommand(url: string, documentId: string): DocumentEnforcementCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: '40000000-0000-4000-8000-0000000000ff',
    enforcementEpoch: ENGINE_EPOCH_ID,
    sessionId: null,
    reservedSessionId: null,
    basePolicyRevision: 1,
    runtimeRevision: 1,
    documentId,
    expectedUrl: url,
    presentation: 'active',
    verdict: { blocked: true, reason: 'custom', categoryId: null, matchedPattern: url },
    overlay: null,
  };
}

/** The one host every enforcement test in this file blocks, and the page it pulls for. */
const BLOCKED_HOST: string = 'facebook.com';
const BLOCKED_URL: string = 'https://facebook.com/feed';

/** A live timed focus session over the fixture's one custom host. */
function focusSessionConfig(): SessionConfig {
  return {
    mode: 'blacklist',
    strictness: 'friction',
    duration: { kind: 'timed', minutes: 25 },
    cycling: null,
    intention: 'finish the launch',
    source: 'manual',
    scheduleOccurrence: null,
    rules: rulesFromLists({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: BLOCKED_HOST }],
    }),
  };
}

/** The enforcement commands out of one `getBlockState` answer, in the order they were frozen. */
function enforcementIn(commands: DocumentContentCommand[]): DocumentEnforcementCommand[] {
  return commands.filter(
    (command: DocumentContentCommand): command is DocumentEnforcementCommand =>
      command.command === 'apply-enforcement',
  );
}

describe('routeMessage pending changes', (): void => {
  it('answers with the edits the engine is still holding', async (): Promise<void> => {
    const held: Engine = realBlockingEngine();
    const blocked: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    };
    await held.startSession({
      mode: 'blacklist',
      strictness: 'hard',
      duration: { kind: 'timed', minutes: 25 },
      cycling: null,
      intention: 'ship it',
      source: 'manual',
      scheduleOccurrence: null,
      rules: rulesFromLists(blocked),
    });

    await expect(held.updateLists({ ...DEFAULT_LISTS, custom: [] })).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );

    expect(held.pendingChanges()).toHaveLength(1);
    await expect(routeMessage(held, { type: 'getPendingChanges' }, sender)).resolves.toEqual({
      changes: [expect.objectContaining({ path: 'lists' })],
    });
  });

  it('refuses to cancel an edit it is not holding', async (): Promise<void> => {
    await expect(
      routeMessage(
        realBlockingEngine(),
        { type: 'cancelPendingChange', path: 'settings.pause.capMs' },
        sender,
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
  });
});

describe('routeMessage onboarding wiring', (): void => {
  it('returns an exact operational cleanup failure', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      loadSetup: vi.fn().mockResolvedValue({ ...DEFAULT_SETUP, completed: true }),
    });

    await expect(
      routeMessage(engine, { type: 'cleanupOnboardingDraft' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn().mockRejectedValue(new Error('storage remove failed')),
        reportError: vi.fn(),
      }),
    ).resolves.toEqual({ ok: false, error: 'storage remove failed' });
  });

  it('returns an exact operational completion failure', async (): Promise<void> => {
    const authoritative: OnboardingDraft = {
      version: 1,
      revision: 8,
      step: 3,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'deferred',
      syncEnabled: false,
    };
    const storage: PolicyStorage = onboardingStorage({
      selectLocalMode: vi.fn().mockRejectedValue(new Error('policy storage failed')),
    });

    await expect(
      routeMessage(
        engine,
        { type: 'completeOnboarding', revision: 8, storageMode: 'local' },
        sender,
        storage,
        {
          reconcileWebsiteAccess: vi.fn(),
          loadOnboardingDraft: vi
            .fn()
            .mockResolvedValue({ ok: true, draft: authoritative, invalid: false }),
          removeOnboardingDraft: vi.fn(),
          reportError: vi.fn(),
        },
      ),
    ).resolves.toEqual({ ok: false, error: 'policy storage failed' });
  });

  it('rejects stale-tab completion before committing any policy', async (): Promise<void> => {
    const authoritative: OnboardingDraft = {
      version: 1,
      revision: 8,
      step: 3,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'deferred',
      syncEnabled: true,
    };
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Engine;
    const storage: PolicyStorage = onboardingStorage();

    await expect(
      routeMessage(
        setupEngine,
        { type: 'completeOnboarding', revision: 7, storageMode: 'sync' },
        sender,
        storage,
        {
          reconcileWebsiteAccess: vi.fn(),
          loadOnboardingDraft: vi
            .fn()
            .mockResolvedValue({ ok: true, draft: authoritative, invalid: false }),
          removeOnboardingDraft: vi.fn(),
          reportError: vi.fn(),
        },
      ),
    ).resolves.toEqual({
      ok: false,
      error: t('notify_setup_changed_reload_before_finishing'),
      conflict: true,
      completed: false,
      draft: authoritative,
    });
    expect(setupEngine.updateSettings).not.toHaveBeenCalled();
    expect(setupEngine.updateLists).not.toHaveBeenCalled();
    expect(storage.enableSync).not.toHaveBeenCalled();
    expect(storage.markSetupCompleted).not.toHaveBeenCalled();
  });

  it('completes from the revision-checked authoritative draft', async (): Promise<void> => {
    const authoritative: OnboardingDraft = {
      version: 1,
      revision: 8,
      step: 3,
      settings: { ...DEFAULT_SETTINGS, retentionDays: 30 },
      lists: { ...DEFAULT_LISTS, categories: { ...DEFAULT_LISTS.categories, news: true } },
      websiteAccessChoice: 'deferred',
      syncEnabled: false,
    };
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Engine;
    const storage: PolicyStorage = onboardingStorage();

    await expect(
      routeMessage(
        setupEngine,
        { type: 'completeOnboarding', revision: 8, storageMode: 'local' },
        sender,
        storage,
        {
          reconcileWebsiteAccess: vi.fn(),
          loadOnboardingDraft: vi
            .fn()
            .mockResolvedValue({ ok: true, draft: authoritative, invalid: false }),
          removeOnboardingDraft: vi.fn(),
          reportError: vi.fn(),
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(setupEngine.updateSettings).toHaveBeenCalledWith(authoritative.settings);
    expect(setupEngine.updateLists).toHaveBeenCalledWith(authoritative.lists);
    expect(storage.markSetupCompleted).toHaveBeenCalledOnce();
  });

  it('publishes a running all-data clear over an idle materialized Setup', async (): Promise<void> => {
    // Browser reset materializes the clean Setup from its own projection while the clear is still
    // running, so the stored record says idle and the journal says otherwise.
    const setup: SetupState = { ...DEFAULT_SETUP, websiteAccess: 'denied' };
    const storage: PolicyStorage = onboardingStorage({
      loadSetup: vi.fn().mockResolvedValue(setup),
      allDataClearPublicState: vi
        .fn()
        .mockResolvedValue({ status: 'pending', scope: 'all', phase: 'browser-reset' }),
    });

    await expect(routeMessage(engine, { type: 'getSetupState' }, sender, storage)).resolves.toEqual(
      { ...setup, dataClear: { status: 'pending', scope: 'all', phase: 'browser-reset' } },
    );
  });

  it('answers a retry request from the dispatcher', async (): Promise<void> => {
    const retryDataClear = vi.fn().mockResolvedValue('ok');

    await expect(
      routeMessage(engine, { type: 'retryDataClear' }, sender, onboardingStorage(), {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        retryDataClear,
      }),
    ).resolves.toEqual({ ok: true, code: 'ok' });
    expect(retryDataClear).toHaveBeenCalledOnce();
  });

  it('refuses a retry the dispatcher has nothing to begin', async (): Promise<void> => {
    await expect(
      routeMessage(engine, { type: 'retryDataClear' }, sender, onboardingStorage(), {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        retryDataClear: vi.fn().mockResolvedValue('retry-not-available'),
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'retry-not-available',
      error: t('notify_data_clear_retry_unavailable'),
    });
  });

  it('refuses a retry when no dispatcher is bound', async (): Promise<void> => {
    await expect(
      routeMessage(engine, { type: 'retryDataClear' }, sender, onboardingStorage()),
    ).resolves.toEqual({
      ok: false,
      code: 'retry-not-available',
      error: t('notify_data_clear_retry_unavailable'),
    });
  });

  it('answers getBootFailure with no failure once boot succeeded', async (): Promise<void> => {
    // A request that reaches the router did so through a resolved boot, so there is no failure to
    // report. Main answers the failed case itself, before any request can reach here.
    await expect(
      routeMessage(engine, { type: 'getBootFailure' }, sender, onboardingStorage()),
    ).resolves.toEqual({ ok: true, failure: null });
  });

  it('answers retryBoot and refuses resetLocalRuntime when boot is healthy', async (): Promise<void> => {
    await expect(
      routeMessage(engine, { type: 'retryBoot' }, sender, onboardingStorage()),
    ).resolves.toEqual({ ok: true });
    await expect(
      routeMessage(engine, { type: 'resetLocalRuntime' }, sender, onboardingStorage()),
    ).resolves.toEqual({ ok: false, error: t('notify_nothing_to_reset') });
  });

  it('returns setup state without exposing a broad setup writer', async (): Promise<void> => {
    const setup: SetupState = { ...DEFAULT_SETUP, websiteAccess: 'denied' };
    const storage: PolicyStorage = onboardingStorage({
      loadSetup: vi.fn().mockResolvedValue(setup),
    });

    await expect(routeMessage(engine, { type: 'getSetupState' }, sender, storage)).resolves.toEqual(
      setup,
    );
  });

  it.each([
    ['granted', 'ready', { ok: true, granted: true, registration: 'ready' }],
    [
      'granted',
      'unavailable',
      {
        ok: false,
        error: t('notify_website_access_inconsistent'),
      },
    ],
    [
      'granted',
      'error',
      {
        ok: false,
        error: t('notify_website_access_granted_blocking_failed'),
        granted: true,
        registration: 'error',
      },
    ],
    [
      'denied',
      'ready',
      {
        ok: false,
        error: t('notify_website_access_inconsistent'),
      },
    ],
    ['denied', 'unavailable', { ok: true, granted: false, registration: 'unavailable' }],
    [
      'denied',
      'error',
      {
        ok: false,
        error: t('notify_website_access_unavailable_cleanup_failed'),
        granted: false,
        registration: 'error',
      },
    ],
    [
      'unknown',
      'ready',
      {
        ok: false,
        error: t('notify_website_access_check_failed'),
      },
    ],
    [
      'unknown',
      'unavailable',
      {
        ok: false,
        error: t('notify_website_access_check_failed'),
      },
    ],
    [
      'unknown',
      'error',
      {
        ok: false,
        error: t('notify_website_access_check_failed'),
        registration: 'error',
      },
    ],
  ] as const)(
    'maps %s permission with %s registration to an exact reconciliation response',
    async (permission, status, expected): Promise<void> => {
      const reconcileWebsiteAccess = vi.fn().mockResolvedValue({ permission, status });

      const result: unknown = await routeMessage(
        engine,
        { type: 'reconcileWebsiteAccess' },
        sender,
        onboardingStorage(),
        { reconcileWebsiteAccess, removeOnboardingDraft: vi.fn(), reportError: vi.fn() },
      );

      expect(result).toEqual(expected);
      expect(isWebsiteAccessReconciliation(result)).toBe(true);
    },
  );

  it('dismisses only the website-access notice', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage();
    const dismissWebsiteAccessNotice = vi.fn().mockResolvedValue(undefined);

    await expect(
      routeMessage(engine, { type: 'dismissWebsiteAccessNotice' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        dismissWebsiteAccessNotice,
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
      }),
    ).resolves.toEqual({ ok: true });

    expect(dismissWebsiteAccessNotice).toHaveBeenCalledOnce();
    expect(storage.updateSetup).not.toHaveBeenCalled();
  });

  it.each(['local', 'sync'] as const)(
    'commits policy, %s mode, completion, then draft cleanup',
    async (storageMode): Promise<void> => {
      const order: string[] = [];
      const setupEngine: Engine = {
        updateSettings: vi.fn(async (): Promise<{ ok: true }> => {
          order.push('settings');
          return { ok: true };
        }),
        updateLists: vi.fn(async (): Promise<{ ok: true }> => {
          order.push('lists');
          return { ok: true };
        }),
      } as unknown as Engine;
      const storage: PolicyStorage = onboardingStorage({
        selectLocalMode: vi.fn(async (): Promise<void> => {
          order.push('local');
        }),
        enableSync: vi.fn(async (): Promise<void> => {
          order.push('sync');
        }),
        markSetupCompleted: vi.fn(async (): Promise<void> => {
          order.push('completed');
        }),
      });
      const removeOnboardingDraft = vi.fn(async (): Promise<void> => {
        order.push('draft');
      });

      await expect(
        routeMessage(
          setupEngine,
          { type: 'completeSetup', storageMode, settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS },
          sender,
          storage,
          { reconcileWebsiteAccess: vi.fn(), removeOnboardingDraft, reportError: vi.fn() },
        ),
      ).resolves.toEqual({ ok: true });

      expect(order).toEqual(
        storageMode === 'local'
          ? ['local', 'settings', 'lists', 'completed', 'draft']
          : ['settings', 'lists', 'sync', 'completed', 'draft'],
      );
    },
  );

  it('leaves local mode unchanged when a pending deletion rejects a Sync mode request', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      enableSync: vi
        .fn()
        .mockRejectedValue(new Error('finish the pending data deletion before enabling Sync')),
    });

    await expect(
      routeMessage(
        engine,
        { type: 'setStorageMode', storageMode: 'sync', deleteRemote: false },
        sender,
        storage,
      ),
    ).rejects.toThrow('finish the pending data deletion before enabling Sync');

    expect(storage.enableSync).toHaveBeenCalledOnce();
    expect(storage.selectLocalMode).not.toHaveBeenCalled();
  });

  it('retries the authoritative Sync journal and reports durable completion', async (): Promise<void> => {
    const retrySync = vi.fn(async (): Promise<void> => {});
    const storage: PolicyStorage = onboardingStorage({
      retrySync,
      loadSetup: vi.fn().mockResolvedValue({
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'sync',
        syncWriteStatus: 'idle',
      }),
    });

    await expect(
      routeMessage(engine, { type: 'retrySync' } as never, sender, storage),
    ).resolves.toEqual({ ok: true, syncWriteStatus: 'idle' });
    expect(retrySync).toHaveBeenCalledOnce();
    expect(storage.enableSync).not.toHaveBeenCalled();
  });

  it('reports an authoritative Sync retry failure instead of returning success', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      retrySync: vi.fn().mockRejectedValue(new Error('8192-byte limit')),
      loadSetup: vi.fn().mockResolvedValue({
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'sync',
        syncWriteStatus: 'error',
        storageError: 'sync-publish-failed',
      }),
    });

    await expect(routeMessage(engine, { type: 'retrySync' }, sender, storage)).rejects.toThrow(
      '8192-byte limit',
    );
    expect(storage.loadSetup).not.toHaveBeenCalled();
  });

  it('keeps setup incomplete when a pending deletion rejects Sync completion', async (): Promise<void> => {
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Engine;
    const storage: PolicyStorage = onboardingStorage({
      enableSync: vi
        .fn()
        .mockRejectedValue(new Error('finish the pending data deletion before enabling Sync')),
    });

    await expect(
      routeMessage(
        setupEngine,
        {
          type: 'completeSetup',
          storageMode: 'sync',
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
        },
        sender,
        storage,
      ),
    ).rejects.toThrow('finish the pending data deletion before enabling Sync');

    expect(storage.markSetupCompleted).not.toHaveBeenCalled();
  });

  it('quiesces a failed Sync completion before writing a replacement local policy', async (): Promise<void> => {
    let storageMode: 'local' | 'sync' = 'sync';
    let remoteWrites: number = 0;
    const storage: PolicyStorage = onboardingStorage({
      selectLocalMode: vi.fn(async (): Promise<void> => {
        storageMode = 'local';
      }),
    });
    const setupEngine: Engine = {
      updateSettings: vi.fn(async (): Promise<{ ok: true }> => {
        if (storageMode === 'sync') remoteWrites += 1;
        return { ok: true };
      }),
      updateLists: vi.fn(async (): Promise<{ ok: true }> => {
        if (storageMode === 'sync') remoteWrites += 1;
        return { ok: true };
      }),
    } as unknown as Engine;

    await expect(
      routeMessage(
        setupEngine,
        {
          type: 'completeSetup',
          storageMode: 'local',
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
        },
        sender,
        storage,
      ),
    ).resolves.toEqual({ ok: true });

    expect(remoteWrites).toBe(0);
    expect(storage.selectLocalMode).toHaveBeenCalledOnce();
  });

  it('keeps setup incomplete and the draft when policy persistence fails', async (): Promise<void> => {
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: false, error: 'lists rejected' }),
    } as unknown as Engine;
    const storage: PolicyStorage = onboardingStorage();
    const removeOnboardingDraft = vi.fn();

    await expect(
      routeMessage(
        setupEngine,
        {
          type: 'completeSetup',
          storageMode: 'local',
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
        },
        sender,
        storage,
        { reconcileWebsiteAccess: vi.fn(), removeOnboardingDraft, reportError: vi.fn() },
      ),
    ).resolves.toEqual({ ok: false, error: 'lists rejected' });
    expect(storage.selectLocalMode).toHaveBeenCalledOnce();
    expect(storage.markSetupCompleted).not.toHaveBeenCalled();
    expect(removeOnboardingDraft).not.toHaveBeenCalled();
  });

  it('keeps completed setup when stale-draft cleanup fails', async (): Promise<void> => {
    const reportError = vi.fn();
    const storage: PolicyStorage = onboardingStorage();
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Engine;

    await expect(
      routeMessage(
        setupEngine,
        {
          type: 'completeSetup',
          storageMode: 'local',
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
        },
        sender,
        storage,
        {
          reconcileWebsiteAccess: vi.fn(),
          removeOnboardingDraft: vi.fn().mockRejectedValue(new Error('remove failed')),
          reportError,
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(storage.markSetupCompleted).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('keeps the draft when setup completion persistence fails', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      markSetupCompleted: vi.fn().mockRejectedValue(new Error('completion unavailable')),
    });
    const setupEngine: Engine = {
      updateSettings: vi.fn().mockResolvedValue({ ok: true }),
      updateLists: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Engine;
    const removeOnboardingDraft = vi.fn();

    await expect(
      routeMessage(
        setupEngine,
        {
          type: 'completeSetup',
          storageMode: 'local',
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
        },
        sender,
        storage,
        { reconcileWebsiteAccess: vi.fn(), removeOnboardingDraft, reportError: vi.fn() },
      ),
    ).rejects.toThrow('completion unavailable');
    expect(removeOnboardingDraft).not.toHaveBeenCalled();
  });

  it('changes to local mode before optionally deleting remote data', async (): Promise<void> => {
    const order: string[] = [];
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue('sync'),
      selectLocalMode: vi.fn(async (): Promise<void> => {
        order.push('local');
      }),
      deleteRemoteData: vi.fn(async (): Promise<void> => {
        order.push('delete');
      }),
    });

    await expect(
      routeMessage(
        engine,
        { type: 'setStorageMode', storageMode: 'local', deleteRemote: true },
        sender,
        storage,
      ),
    ).resolves.toEqual({ ok: true });
    expect(order).toEqual(['local', 'delete']);
    expect(storage.deleteRemoteData).toHaveBeenCalledWith('synced-policy');
  });

  it('does not report a failed remote deletion as a successful mode change', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      deleteRemoteData: vi.fn().mockRejectedValue(new Error('remote deletion failed')),
    });

    await expect(
      routeMessage(
        engine,
        { type: 'setStorageMode', storageMode: 'local', deleteRemote: true },
        sender,
        storage,
      ),
    ).rejects.toThrow('remote deletion failed');
  });

  /**
   * One blocked navigation delivered while `transition` holds the Engine storage barrier open. The
   * barrier is released and the mode change awaited before anything is read back, so every caller
   * asserts against a settled worker.
   */
  async function blockedNavigationUnderStorageBarrier(
    transition: 'enableSync' | 'selectLocalMode',
  ): Promise<{ engine: Engine; enforcement: DocumentEnforcementCommand[]; url: string }> {
    const blockingEngine: Engine = realBlockingEngine();
    await blockingEngine.startSession(focusSessionConfig());
    let releaseBarrier: () => void = (): void => undefined;
    let signalBarrierHeld: () => void = (): void => undefined;
    const barrierBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const barrierHeld: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalBarrierHeld = resolve;
    });
    const holdBarrier: () => Promise<void> = (): Promise<void> =>
      blockingEngine.runWithAggregateStorageBarrier(async (): Promise<void> => {
        signalBarrierHeld();
        await barrierBlocked;
      });
    const storage: PolicyStorage = onboardingStorage({
      [transition]: vi.fn(holdBarrier),
    });
    const changingMode: Promise<unknown> = routeMessage(
      blockingEngine,
      {
        type: 'setStorageMode',
        storageMode: transition === 'enableSync' ? 'sync' : 'local',
        deleteRemote: false,
      },
      sender,
      storage,
    );
    await barrierHeld;
    const url: string = BLOCKED_URL;

    let answer: unknown;
    try {
      // Switching where policy is stored does not end the session, so the page this pull is for
      // stays blocked for the whole transition. Only a pending all-data clear answers nothing.
      answer = await routeMessage(
        blockingEngine,
        { type: 'getBlockState', url, docState: 'fresh' },
        {
          url,
          tab: { id: 7, url } as chrome.tabs.Tab,
          documentId: 'document-id',
        },
      );
    } finally {
      releaseBarrier();
      await changingMode;
    }
    const commands: DocumentContentCommand[] = (answer as { commands: DocumentContentCommand[] })
      .commands;
    return { engine: blockingEngine, enforcement: enforcementIn(commands), url };
  }

  it.each(['enableSync', 'selectLocalMode'] as const)(
    'keeps a live session blocking while %s holds the Engine storage barrier',
    async (transition: 'enableSync' | 'selectLocalMode'): Promise<void> => {
      const held: {
        engine: Engine;
        enforcement: DocumentEnforcementCommand[];
        url: string;
      } = await blockedNavigationUnderStorageBarrier(transition);

      expect(held.enforcement).toHaveLength(1);
      expect(held.enforcement[0]?.verdict.blocked).toBe(true);
      // The page is stopped, so the claim the closure reloads it from is kept: only the profile
      // erase refuses that write, and a mode switch is not one.
      expect(held.engine.tabFacts(7, held.url, 'document-id').wasStopped).toBe(true);
    },
  );

  // The barrier is storage bookkeeping the user cannot see, and a blocked navigation they made is
  // an attempt the day owes them, so a quiesced barrier holds the write and replays it when the
  // barrier opens. The spec exempts only the sweep from attempt accounting.
  it.each(['enableSync', 'selectLocalMode'] as const)(
    'counts the blocked attempt taken while %s holds the Engine storage barrier',
    async (transition: 'enableSync' | 'selectLocalMode'): Promise<void> => {
      const held: {
        engine: Engine;
        enforcement: DocumentEnforcementCommand[];
        url: string;
      } = await blockedNavigationUnderStorageBarrier(transition);

      expect(held.engine.statsOverlay().todayAgg.attempts['facebook.com']).toBe(1);
    },
  );

  it('clears local history through the serialized storage adapter', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage();
    const historyEngine: Engine = {
      runWithLocalHistoryClear: vi.fn(
        async (
          operation: () => Promise<boolean>,
          finish: () => Promise<void>,
        ): Promise<boolean> => {
          const result: boolean = await operation();
          await finish();
          return result;
        },
      ),
    } as unknown as Engine;

    await expect(
      routeMessage(
        historyEngine,
        { type: 'clearFocusLockData', scope: 'local-history' },
        sender,
        storage,
      ),
    ).resolves.toEqual({ ok: true, scope: 'local-history', status: 'cleared' });
    expect(storage.clearLocalHistory).toHaveBeenCalledOnce();
    expect(storage.finishLocalHistoryClear).toHaveBeenCalledOnce();
  });

  it('keeps the exact local-history scope pending when runtime sanitization fails', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      clearLocalHistory: vi.fn().mockResolvedValue(true),
    });
    const historyEngine: Engine = {
      runWithLocalHistoryClear: vi.fn(
        async (operation: () => Promise<boolean>): Promise<boolean> => {
          await operation();
          throw new Error('sanitized runtime unavailable');
        },
      ),
    } as unknown as Engine;

    await expect(
      routeMessage(
        historyEngine,
        { type: 'clearFocusLockData', scope: 'local-history' },
        sender,
        storage,
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'sanitized runtime unavailable',
      scope: 'local-history',
      status: 'pending',
    });
    expect(storage.finishLocalHistoryClear).not.toHaveBeenCalled();
  });

  it('returns the pending local-history scope when durable removal fails', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      clearLocalHistory: vi.fn().mockRejectedValue(new Error('local history unavailable')),
    });
    const historyEngine: Engine = {
      runWithLocalHistoryClear: vi.fn(
        async (operation: () => Promise<boolean>): Promise<boolean> => operation(),
      ),
    } as unknown as Engine;

    await expect(
      routeMessage(
        historyEngine,
        { type: 'clearFocusLockData', scope: 'local-history' },
        sender,
        storage,
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'local history unavailable',
      scope: 'local-history',
      status: 'pending',
    });
  });

  it('returns the pending scope when synced-policy deletion requires disabled Sync', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue('sync'),
    });

    await expect(
      routeMessage(engine, { type: 'clearFocusLockData', scope: 'synced-policy' }, sender, storage),
    ).resolves.toEqual({
      ok: false,
      error: t('notify_disable_sync_before_delete'),
      scope: 'synced-policy',
      status: 'pending',
    });
    expect(storage.deleteRemoteData).not.toHaveBeenCalled();
  });

  it('returns the pending synced-policy scope when storage-mode loading fails', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockRejectedValue(new Error('mode unavailable')),
    });

    await expect(
      routeMessage(engine, { type: 'clearFocusLockData', scope: 'synced-policy' }, sender, storage),
    ).resolves.toEqual({
      ok: false,
      error: 'mode unavailable',
      scope: 'synced-policy',
      status: 'pending',
    });
    expect(storage.deleteRemoteData).not.toHaveBeenCalled();
  });

  it('quiesces Sync, clears all data through its Engine barrier, then reconciles permission', async (): Promise<void> => {
    const order: string[] = [];
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue('sync'),
      selectLocalMode: vi.fn(async (): Promise<void> => {
        order.push('local');
      }),
      deleteRemoteData: vi.fn(async (): Promise<void> => {
        order.push('delete');
      }),
    });
    const clearingEngine: Engine = {} as Engine;
    const reconcileWebsiteAccess = vi.fn(async () => {
      order.push('reconcile');
      return { permission: 'granted' as const, status: 'ready' as const };
    });

    await expect(
      routeMessage(clearingEngine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess,
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
      }),
    ).resolves.toEqual({ ok: true, scope: 'all', status: 'cleared' });
    expect(order).toEqual(['local', 'delete', 'reconcile']);
    expect(storage.deleteRemoteData).toHaveBeenCalledWith('all');
  });

  it('hands the rest of an all-data clear to the dispatcher before it reconciles', async (): Promise<void> => {
    const order: string[] = [];
    const storage: PolicyStorage = onboardingStorage({
      deleteRemoteData: vi.fn(async (): Promise<void> => {
        order.push('delete');
      }),
    });
    const continueAllDataClear = vi.fn(async (): Promise<void> => {
      order.push('dispatch');
    });

    await expect(
      routeMessage({} as Engine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(async () => {
          order.push('reconcile');
          return { permission: 'granted' as const, status: 'ready' as const };
        }),
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        continueAllDataClear,
      }),
    ).resolves.toEqual({ ok: true, scope: 'all', status: 'cleared' });
    // The creation seam opens the journal and runs the phases it owns. The browser reset and the
    // finalization are the dispatcher's, and they run before the answer leaves the router.
    expect(order).toEqual(['delete', 'dispatch', 'reconcile']);
  });

  it('reports a dispatcher failure as a clear that is still pending', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage();
    const setupCompleted = vi.fn();

    await expect(
      routeMessage({} as Engine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        setupCompleted,
        continueAllDataClear: vi.fn().mockRejectedValue(new Error('browser reset unavailable')),
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'browser reset unavailable',
      scope: 'all',
      status: 'pending',
    });
    expect(setupCompleted).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('preserves data and does not reconcile when all-data remote deletion fails', async (): Promise<void> => {
    const clearingEngine: Engine = {} as Engine;
    const setupCompleted = vi.fn();
    const storage: PolicyStorage = onboardingStorage({
      deleteRemoteData: vi.fn().mockRejectedValue(new Error('remote deletion unavailable')),
      loadSetup: vi.fn().mockResolvedValue({
        ...DEFAULT_SETUP,
        completed: true,
        storageMode: 'local',
        dataClear: { status: 'error', scope: 'all', phase: 'remote' },
      } satisfies SetupState),
    });
    const reconcileWebsiteAccess = vi.fn();

    await expect(
      routeMessage(clearingEngine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess,
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        setupCompleted,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'remote deletion unavailable',
      scope: 'all',
      status: 'pending',
    });
    expect(reconcileWebsiteAccess).not.toHaveBeenCalled();
    expect(setupCompleted).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('keeps live completion aligned when all-data storage-mode loading fails early', async (): Promise<void> => {
    const setupCompleted = vi.fn();
    const completedSetup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'local',
    };
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockRejectedValue(new Error('mode unavailable')),
      loadSetup: vi.fn().mockResolvedValue(completedSetup),
    });

    await expect(
      routeMessage({} as Engine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        setupCompleted,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'mode unavailable',
      scope: 'all',
      status: 'pending',
    });

    expect(completedSetup).toMatchObject({ completed: true, dataClear: { status: 'idle' } });
    expect(storage.loadSetup).toHaveBeenCalledOnce();
    expect(setupCompleted).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('keeps live completion aligned when local-mode selection fails before deletion', async (): Promise<void> => {
    const setupCompleted = vi.fn();
    const completedSetup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
    };
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue('sync'),
      selectLocalMode: vi.fn().mockRejectedValue(new Error('local mode unavailable')),
      loadSetup: vi.fn().mockResolvedValue(completedSetup),
    });

    await expect(
      routeMessage({} as Engine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        setupCompleted,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'local mode unavailable',
      scope: 'all',
      status: 'pending',
    });

    expect(completedSetup).toMatchObject({ completed: true, dataClear: { status: 'idle' } });
    expect(storage.loadSetup).toHaveBeenCalledOnce();
    expect(storage.deleteRemoteData).not.toHaveBeenCalled();
    expect(setupCompleted).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('clears live completion when Engine reset fails after durable all-data deletion', async (): Promise<void> => {
    const setupCompleted = vi.fn();
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue('local'),
      deleteRemoteData: vi.fn().mockRejectedValue(new Error('device rehydration unavailable')),
      loadSetup: vi.fn().mockResolvedValue(structuredClone(DEFAULT_SETUP)),
    });

    await expect(
      routeMessage({} as Engine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage, {
        reconcileWebsiteAccess: vi.fn(),
        removeOnboardingDraft: vi.fn(),
        reportError: vi.fn(),
        setupCompleted,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'device rehydration unavailable',
      scope: 'all',
      status: 'pending',
    });

    expect(storage.loadSetup).toHaveBeenCalledOnce();
    expect(setupCompleted).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('retries a boot-restored null-mode all-data local phase without selecting a mode', async (): Promise<void> => {
    const storage: PolicyStorage = onboardingStorage({
      storageMode: vi.fn().mockResolvedValue(null),
    });

    await expect(
      routeMessage({} as Engine, { type: 'clearFocusLockData', scope: 'all' }, sender, storage),
    ).resolves.toEqual({ ok: true, scope: 'all', status: 'cleared' });
    expect(storage.selectLocalMode).not.toHaveBeenCalled();
    expect(storage.deleteRemoteData).toHaveBeenCalledWith('all');
  });
});

/**
 * `Engine.documentCommandsFor` and `Engine.handleNavigation` both read
 * `Engine.allDataClearPending`, and the distinction they carry is easy to invert. A storage-mode
 * switch or an aggregate drain moves where policy lives while the session keeps enforcing, which
 * the barrier cases in the suite above pin. A pending all-data clear is the opposite: the profile
 * is about to be erased, so the worker answers nothing and writes nothing behind the deletion. The
 * last test here is the control that says the refusal is the gate rather than the fixture.
 */
describe('routeMessage all-data clear enforcement gate', (): void => {
  /** Lets every queued persist settle, so a runtime write started behind the gate is still seen. */
  function settle(): Promise<void> {
    return new Promise((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });
  }

  /** A live blocking session on a real Engine, with its durable writes and its wire recorded. */
  function recordingEngine(): {
    engine: Engine;
    savedRuntimes: RuntimeStateV2[];
    sentCommands: DocumentContentCommand[];
  } {
    const savedRuntimes: RuntimeStateV2[] = [];
    const sentCommands: DocumentContentCommand[] = [];
    const engine: Engine = realBlockingEngine({
      saveRuntime: (runtime: RuntimeStateV2): void => {
        savedRuntimes.push(structuredClone(runtime));
      },
      onCommand: (command: DocumentContentCommand): void => {
        sentCommands.push(command);
      },
    });
    return { engine, savedRuntimes, sentCommands };
  }

  it('answers no commands, and writes nothing, while an all-data clear is pending', async (): Promise<void> => {
    const recorded: {
      engine: Engine;
      savedRuntimes: RuntimeStateV2[];
      sentCommands: DocumentContentCommand[];
    } = recordingEngine();
    await recorded.engine.startSession(focusSessionConfig());
    // The state a boot with an owed all-data clear leaves behind (`src/background/main.ts:885`):
    // the barrier is quiesced, the session is still in the runtime, and the erase has not run.
    await recorded.engine.retainDataClearQuiescence();
    const writesBefore: number = recorded.savedRuntimes.length;
    const commandsBefore: number = recorded.sentCommands.length;
    const url: string = BLOCKED_URL;

    const answer: unknown = await routeMessage(
      recorded.engine,
      { type: 'getBlockState', url, docState: 'fresh' },
      {
        url,
        tab: { id: 7, url } as chrome.tabs.Tab,
        documentId: 'document-id',
      },
    );
    await settle();

    expect(answer).toEqual({ commands: [] });
    // Nothing was frozen into the runtime the deletion is about to remove, no stopped claim was
    // taken over the page, and no attempt reached the aggregate that goes with it.
    expect(recorded.savedRuntimes).toHaveLength(writesBefore);
    expect(recorded.sentCommands).toHaveLength(commandsBefore);
    expect(recorded.engine.tabFacts(7, url, 'document-id').wasStopped).toBe(false);
    expect(recorded.engine.statsOverlay().todayAgg.attempts[BLOCKED_HOST]).toBeUndefined();
  });

  it('refuses a navigation and its commands while the all-data clear runs', async (): Promise<void> => {
    const recorded: {
      engine: Engine;
      savedRuntimes: RuntimeStateV2[];
      sentCommands: DocumentContentCommand[];
    } = recordingEngine();
    await recorded.engine.startSession(focusSessionConfig());
    // The barrier is taken the way a boot with an owed clear takes it, which leaves the session in
    // the runtime. `runWithDataClearBarrier` ends the session before its operation runs, so a gate
    // staged on that one is asked about a profile with nothing left to protect.
    await recorded.engine.retainDataClearQuiescence();
    expect(recorded.engine.hasActiveSession()).toBe(true);
    const writesBefore: number = recorded.savedRuntimes.length;
    const commandsBefore: number = recorded.sentCommands.length;
    const url: string = BLOCKED_URL;
    const target: { tabId: number; documentId: string; url: string } = {
      tabId: 7,
      documentId: 'document-id',
      url,
    };

    try {
      await recorded.engine.handleNavigation(target, 'navigation');
      await expect(recorded.engine.documentCommandsFor(target, 'navigation')).resolves.toEqual([]);
      await settle();

      // The controller is never entered, so no command reaches the document and no write lands in
      // the runtime the erase is about to delete. A clear that reported `cleared` while leaving a
      // frozen command and an attempt behind is the residue this gate exists to prevent.
      expect(recorded.sentCommands).toHaveLength(commandsBefore);
      expect(recorded.savedRuntimes).toHaveLength(writesBefore);
      expect(recorded.engine.tabFacts(7, url, 'document-id').wasStopped).toBe(false);
      expect(recorded.engine.statsOverlay().todayAgg.attempts[BLOCKED_HOST]).toBeUndefined();
      // The session is still live, so this gate refused a navigation it was actually protecting.
      expect(recorded.engine.hasActiveSession()).toBe(true);
    } finally {
      await settle();
    }
  });

  it('explains the stopped page in the first view the page receives', async (): Promise<void> => {
    const recorded: { engine: Engine } = recordingEngine();
    await recorded.engine.startSession(focusSessionConfig());
    const url: string = BLOCKED_URL;

    const answer: unknown = await routeMessage(
      recorded.engine,
      { type: 'getBlockState', url, docState: 'fresh' },
      { url, tab: { id: 7, url } as chrome.tabs.Tab, documentId: 'document-id' },
    );
    await settle();
    const enforcement: DocumentEnforcementCommand[] = enforcementIn(
      (answer as { commands: DocumentContentCommand[] }).commands,
    );

    // The page whose load was stopped is told why in the view that stops it. An explanation that
    // arrives on some later refresh leaves the user looking at a blocked page with no reason on it.
    expect(recorded.engine.tabFacts(7, url, 'document-id').wasStopped).toBe(true);
    expect(enforcement[0]?.overlay?.stoppedPage).toBe(true);
    expect(enforcement[0]?.overlay?.copy.stoppedPage).toBe(
      'This page did not load. It will load by itself when the session ends.',
    );
  });

  it('serves the same navigation, and counts it, with no all-data clear pending', async (): Promise<void> => {
    const recorded: {
      engine: Engine;
      savedRuntimes: RuntimeStateV2[];
      sentCommands: DocumentContentCommand[];
    } = recordingEngine();
    await recorded.engine.startSession(focusSessionConfig());
    const writesBefore: number = recorded.savedRuntimes.length;
    const url: string = BLOCKED_URL;

    const answer: unknown = await routeMessage(
      recorded.engine,
      { type: 'getBlockState', url, docState: 'fresh' },
      {
        url,
        tab: { id: 7, url } as chrome.tabs.Tab,
        documentId: 'document-id',
      },
    );
    await settle();
    const enforcement: DocumentEnforcementCommand[] = enforcementIn(
      (answer as { commands: DocumentContentCommand[] }).commands,
    );

    expect(enforcement).toHaveLength(1);
    expect(enforcement[0]?.verdict.blocked).toBe(true);
    expect(recorded.engine.tabFacts(7, url, 'document-id').wasStopped).toBe(true);
    expect(recorded.engine.statsOverlay().todayAgg.attempts[BLOCKED_HOST]).toBe(1);
    expect(recorded.savedRuntimes.length).toBeGreaterThan(writesBefore);
  });
});

describe('routeMessage stats wiring', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
  });

  afterEach((): void => {
    vi.restoreAllMocks();
  });

  it('delegates getStats with the requested range and current time', async () => {
    const now: number = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(fetchStats).mockResolvedValue(stats);

    const local = {} as chrome.storage.StorageArea;
    const aggregateStorage: AggregateStorage = { local, sync: null };
    const withAggregateStorage = vi.fn(
      async (operation: (storage: AggregateStorage) => Promise<unknown>): Promise<unknown> =>
        operation(aggregateStorage),
    );
    const policyStorage: PolicyStorage = {
      withAggregateStorage:
        withAggregateStorage as unknown as PolicyStorage['withAggregateStorage'],
    } as unknown as PolicyStorage;
    const result: unknown = await routeMessage(
      engine,
      { type: 'getStats', days: 14 },
      sender,
      policyStorage,
    );

    expect(result).toBe(stats);
    expect(withAggregateStorage).toHaveBeenCalledOnce();
    expect(fetchStats).toHaveBeenCalledWith(14, now, overlay, aggregateStorage);
  });

  it('exports the local event log as formatted JSON', async () => {
    const events: EventRecord[] = [
      {
        t: 'sessionCompleted',
        at: 123,
        focusedMs: 60_000,
      },
    ];
    vi.mocked(readEventsV2).mockResolvedValue(events);

    const result: unknown = await routeMessage(engine, { type: 'exportEvents' }, sender);

    expect(result).toEqual({ json: JSON.stringify(events, null, 2) });
  });
});

describe('routeMessage session category override wiring', (): void => {
  it('starts and enforces an edited category without changing persistent lists', async (): Promise<void> => {
    const blockingEngine: Engine = realBlockingEngine();
    const before: ListsConfig = blockingEngine.getLists();
    const config: SessionConfig = {
      mode: 'blacklist',
      strictness: 'friction',
      duration: { kind: 'timed', minutes: 25 },
      cycling: null,
      intention: 'finish the launch',
      source: 'manual',
      scheduleOccurrence: null,
      rules: {
        ...rulesFromLists(before),
        categories: { ...before.categories, social: true },
      },
    };

    await expect(
      routeMessage(blockingEngine, { type: 'startSession', config }, sender),
    ).resolves.toEqual({ ok: true, code: 'ok' });
    const url: string = 'https://instagram.com/explore';
    await expect(
      routeMessage(
        blockingEngine,
        { type: 'getBlockState', url, docState: 'fresh' },
        {
          url,
          tab: { id: 17, url } as chrome.tabs.Tab,
          documentId: 'category-override-document',
        },
      ),
    ).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({
          command: 'apply-enforcement',
          verdict: expect.objectContaining({ blocked: true }),
          overlay: expect.objectContaining({ presentation: 'active', phase: 'focus' }),
        }),
      ]),
    });
    expect(blockingEngine.getLists()).toEqual(before);
  });
});

describe('routeMessage session ending wiring', () => {
  it('delegates the honest session-end request to the engine', async (): Promise<void> => {
    const requestSessionEnd = vi.fn().mockResolvedValue({ ok: true });
    const endingEngine: Engine = { requestSessionEnd } as unknown as Engine;

    expect(await routeMessage(endingEngine, { type: 'requestSessionEnd' }, sender)).toEqual({
      ok: true,
    });
    expect(requestSessionEnd).toHaveBeenCalledTimes(1);
  });

  it('delegates the force end bypass to the engine', async (): Promise<void> => {
    const forceEndGate = vi.fn().mockResolvedValue({ ok: true, code: 'ok' });
    const endingEngine: Engine = { forceEndGate } as unknown as Engine;

    expect(await routeMessage(endingEngine, { type: 'forceEndGate' }, sender)).toEqual({
      ok: true,
      code: 'ok',
    });
    expect(forceEndGate).toHaveBeenCalledTimes(1);
  });
});

describe('routeMessage tab identity wiring', () => {
  it('binds a stopped fresh document to its URL', async () => {
    const url: string = 'https://blocked.example/page';
    const documentId = 'document-one';
    const markStopped = vi.fn().mockResolvedValue(undefined);
    const rebindTab = vi.fn();
    const documentCommandsFor = vi.fn().mockResolvedValue([blockingCommand(url, documentId)]);
    const blockingEngine: Engine = {
      documentCommandsFor,
      rebindTab,
      markStopped,
    } as unknown as Engine;
    const tabSender: chrome.runtime.MessageSender = {
      tab: { id: 7, url } as chrome.tabs.Tab,
      url,
      documentId,
    };

    await routeMessage(
      blockingEngine,
      { type: 'getBlockState', url, docState: 'fresh' },
      tabSender,
    );

    // The router delivers what it answers, so the document may take the epoch reset it is handed.
    // The stopped claim is not the router's to take: it belongs to the call that freezes the view,
    // which is the only place it can be taken before the view that explains it.
    expect(documentCommandsFor).toHaveBeenCalledWith(
      { tabId: 7, documentId, url },
      'navigation',
      'deliver',
    );
    expect(markStopped).not.toHaveBeenCalled();
    expect(rebindTab).not.toHaveBeenCalled();
  });

  it('fails closed when a fresh sender has no document identity', async () => {
    const url: string = 'https://blocked.example/page';
    const markStopped = vi.fn().mockResolvedValue(undefined);
    const documentCommandsFor = vi.fn().mockResolvedValue([blockingCommand(url, 'document-one')]);
    const blockingEngine: Engine = {
      documentCommandsFor,
      rebindTab: vi.fn(),
      markStopped,
    } as unknown as Engine;

    await expect(
      routeMessage(
        blockingEngine,
        { type: 'getBlockState', url, docState: 'fresh' },
        { tab: { id: 7, url } as chrome.tabs.Tab, url },
      ),
    ).resolves.toEqual({ commands: [] });

    expect(documentCommandsFor).not.toHaveBeenCalled();
    expect(markStopped).not.toHaveBeenCalled();
  });

  it('ignores stale block-state mutations after the tab navigates', async () => {
    const oldUrl: string = 'https://blocked.example/old';
    const newUrl: string = 'https://allowed.example/new';
    const rebindTab = vi.fn();
    const markStopped = vi.fn().mockResolvedValue(undefined);
    const documentCommandsFor = vi
      .fn()
      .mockResolvedValue([blockingCommand(oldUrl, 'document-one')]);
    const blockingEngine: Engine = {
      documentCommandsFor,
      rebindTab,
      markStopped,
    } as unknown as Engine;
    const staleSender: chrome.runtime.MessageSender = {
      tab: { id: 7, url: newUrl } as chrome.tabs.Tab,
      url: oldUrl,
    };

    await routeMessage(
      blockingEngine,
      { type: 'getBlockState', url: oldUrl, docState: 'fresh' },
      staleSender,
    );

    expect(rebindTab).not.toHaveBeenCalled();
    expect(documentCommandsFor).not.toHaveBeenCalled();
    expect(markStopped).not.toHaveBeenCalled();
  });
});

describe('work target routing', (): void => {
  const WORK_SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
  const popup: chrome.runtime.MessageSender = {
    id: 'extension',
    url: 'chrome-extension://extension/src/popup/popup.html',
  };
  type ServiceMocks = {
    getWorkTabs: ReturnType<typeof vi.fn>;
    getContentWorkTabs: ReturnType<typeof vi.fn>;
    getWorkTabIcon: ReturnType<typeof vi.fn>;
    getWorkTarget: ReturnType<typeof vi.fn>;
    setWorkTarget: ReturnType<typeof vi.fn>;
    returnToWork: ReturnType<typeof vi.fn>;
    startSession: ReturnType<typeof vi.fn>;
  };
  function fakeService(): { mocks: ServiceMocks; service: WorkTargetService } {
    const mocks: ServiceMocks = {
      getWorkTabs: vi.fn().mockResolvedValue({ ok: true, tabs: [] }),
      getContentWorkTabs: vi.fn().mockResolvedValue({ ok: true, tabs: [] }),
      getWorkTabIcon: vi.fn().mockResolvedValue({ ok: true, icon: null }),
      getWorkTarget: vi
        .fn()
        .mockResolvedValue({ ok: true, sessionId: null, state: 'missing', title: null }),
      setWorkTarget: vi.fn().mockResolvedValue({ ok: true }),
      returnToWork: vi.fn().mockResolvedValue({ ok: true }),
      startSession: vi.fn().mockResolvedValue({ ok: true, code: 'ok' }),
    };
    return { mocks, service: mocks as unknown as WorkTargetService };
  }

  it('dispatches every work target request to the injected service with the sender', async (): Promise<void> => {
    const { mocks, service } = fakeService();
    const engine: Engine = {} as unknown as Engine;
    const rules = rulesFromLists(DEFAULT_LISTS);
    const route = (msg: Parameters<typeof routeMessage>[1]): Promise<unknown> =>
      routeMessage(engine, msg, popup, undefined, undefined, service);

    expect(await route({ type: 'getWorkTabs', mode: 'blacklist', windowId: 3 })).toEqual({
      ok: true,
      tabs: [],
    });
    expect(mocks.getWorkTabs).toHaveBeenLastCalledWith('blacklist', 3, undefined, popup);
    await route({ type: 'getWorkTabs', mode: 'whitelist', windowId: 3, rules });
    expect(mocks.getWorkTabs).toHaveBeenLastCalledWith('whitelist', 3, rules, popup);
    await route({ type: 'getWorkTabs', sessionId: WORK_SESSION_ID });
    expect(mocks.getContentWorkTabs).toHaveBeenCalledExactlyOnceWith(WORK_SESSION_ID, popup);
    await route({ type: 'getWorkTabIcon', sessionId: WORK_SESSION_ID, tabId: 4 });
    expect(mocks.getWorkTabIcon).toHaveBeenCalledExactlyOnceWith(WORK_SESSION_ID, 4, popup);
    await route({ type: 'getWorkTarget' });
    expect(mocks.getWorkTarget).toHaveBeenLastCalledWith(undefined, popup);
    await route({ type: 'getWorkTarget', windowId: 3 });
    expect(mocks.getWorkTarget).toHaveBeenLastCalledWith(3, popup);
    await route({ type: 'setWorkTarget', sessionId: WORK_SESSION_ID, tabId: 4 });
    expect(mocks.setWorkTarget).toHaveBeenLastCalledWith(WORK_SESSION_ID, 4, undefined, popup);
    await route({ type: 'setWorkTarget', sessionId: WORK_SESSION_ID, tabId: 4, windowId: 3 });
    expect(mocks.setWorkTarget).toHaveBeenLastCalledWith(WORK_SESSION_ID, 4, 3, popup);
    await route({ type: 'returnToWork', sessionId: WORK_SESSION_ID });
    expect(mocks.returnToWork).toHaveBeenLastCalledWith(WORK_SESSION_ID, undefined, popup);
    await route({ type: 'returnToWork', sessionId: WORK_SESSION_ID, windowId: 3 });
    expect(mocks.returnToWork).toHaveBeenLastCalledWith(WORK_SESSION_ID, 3, popup);
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('starts through the engine without a work tab and through the service with one', async (): Promise<void> => {
    const { mocks, service } = fakeService();
    const startSession = vi.fn().mockResolvedValue({ ok: true, code: 'ok' });
    const engine: Engine = { startSession } as unknown as Engine;
    const config: SessionConfig = focusSessionConfig();

    expect(
      await routeMessage(
        engine,
        { type: 'startSession', config },
        popup,
        undefined,
        undefined,
        service,
      ),
    ).toEqual({ ok: true, code: 'ok' });
    expect(startSession).toHaveBeenCalledExactlyOnceWith(config);
    expect(mocks.startSession).not.toHaveBeenCalled();

    expect(
      await routeMessage(
        engine,
        { type: 'startSession', config, workTabId: 4, windowId: 3 },
        popup,
        undefined,
        undefined,
        service,
      ),
    ).toEqual({ ok: true, code: 'ok' });
    expect(mocks.startSession).toHaveBeenCalledExactlyOnceWith(config, 4, 3, popup);
    expect(startSession).toHaveBeenCalledTimes(1);
  });
});
