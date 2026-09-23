import { describe, expect, it, vi } from 'vitest';
import type { EnforcementCheckpoint } from '../../../src/background/enforcement-persistence-v2';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import type { BlockingSweepLease, EnginePorts } from '../../../src/background/engine';
import { aggregatedFocusEventV2, Engine } from '../../../src/background/engine';
import { appendEventsV2, readEventsV2 } from '../../../src/background/event-log-v2';
import { encodeListsForSync, LIST_SYNC_SHARD_KEYS } from '../../../src/background/list-sync-codec';
import { clockRebaseArchiveKey } from '../../../src/background/rollover';
import { projectRuntimeDomainV2 } from '../../../src/background/runtime-checkpoint-v2';
import type { DeferredBlockClaim } from '../../../src/background/runtime-leaf-types';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { syncItemBytes } from '../../../src/background/sync-quota';
import { type SyncJournal, SyncWriter } from '../../../src/background/sync-writer';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import { buildMatcherCache, compileSessionMatcher, evaluateUrl } from '../../../src/core/matcher';
import { emptyDaily } from '../../../src/core/stats';
import {
  CATEGORY_IDS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  rulesFromLists,
  TOP_SITES_DAILY,
} from '../../../src/shared/constants';
import { t } from '../../../src/shared/i18n';
import type { Ack } from '../../../src/shared/messages';
import {
  LOCAL_EVENTS,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
  syncAggKey,
} from '../../../src/shared/storage-keys';
import { localDateStr, localMidnightAfter } from '../../../src/shared/time';
import type {
  DailyAgg,
  EventRecord,
  ListsConfig,
  ScheduleEntry,
  SessionConfig,
  SessionRuleSnapshot,
  SessionSnapshot,
  SessionStateV2,
  Settings,
  StreakState,
  Verdict,
} from '../../../src/shared/types';
import { type EngineSeamPortsV2, engineSeamPortsV2, uuidMinterV2 } from './engine-ports-fake';

/**
 * The engine ports a test drives through mocks: everything the engine calls as a function, minus
 * the v2 enforcement seams, which the shared fixture supplies whole and no test here asserts on.
 */
type MockableEnginePorts = Omit<EnginePorts, keyof EngineSeamPortsV2>;
type MockedEnginePorts = {
  [K in keyof MockableEnginePorts as MockableEnginePorts[K] extends
    | ((...args: never[]) => unknown)
    | undefined
    ? K
    : never]: ReturnType<typeof vi.fn>;
};

interface Harness {
  engine: Engine;
  seededRuntime: RuntimeStateV2;
  ports: MockedEnginePorts & {
    hasPendingSync: ReturnType<typeof vi.fn>;
    saveMatcherCache: ReturnType<typeof vi.fn>;
  };
  now(): number;
  setNow(ms: number): void;
  loggedEvents(): EventRecord[];
}

const T0: number = new Date(2026, 7, 29, 8, 59).getTime();
const DAY_MS: number = 86_400_000;

function appendUnique(into: EventRecord[], events: EventRecord[]): void {
  const seen: Set<string> = new Set(
    into.map((event: EventRecord): string => JSON.stringify(event)),
  );
  for (const event of events) {
    const key: string = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(event);
  }
}

function oversizedHostRules(prefix: string): ListsConfig['custom'] {
  return Array.from({ length: 600 }, (_value: unknown, index: number) => ({
    kind: 'host' as const,
    pattern: `${prefix}-${index}.example`,
  }));
}

function highCardinalityDaily(date: string, count: number): DailyAgg {
  return {
    date,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: Object.fromEntries(
      Array.from({ length: count }, (_value: unknown, index: number): [string, number] => [
        `site-${String(index).padStart(4, '0')}.example`,
        count - index,
      ]),
    ),
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    pauseMsEarned: 0,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 0,
  };
}

function splittableLists(custom: ListsConfig['custom'] = []): ListsConfig {
  const exclusions: ListsConfig['exclusions'] = {};
  for (const categoryId of CATEGORY_IDS) {
    exclusions[categoryId] = Array.from(
      { length: 60 },
      (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
    );
  }
  return {
    ...DEFAULT_LISTS,
    custom,
    categories: { ...DEFAULT_LISTS.categories, social: true },
    exclusions,
  };
}

function clearMutationPorts(ports: Harness['ports']): void {
  ports.now.mockClear();
  ports.saveRuntime.mockClear();
  ports.queueSync.mockClear();
  ports.removeSync.mockClear();
  ports.appendEvents.mockClear();
  ports.broadcast.mockClear();
  ports.applyBlocking.mockClear();
  ports.updateIcon.mockClear();
  ports.saveMatcherCache.mockClear();
}

/**
 * The day boundaries a wake hands the Engine, walked the way the controller walks them: a runtime
 * date in the future rebases backward at the current instant, and every finished day is credited
 * one midnight at a time. The walk moved to the controller with the cutover, the crediting stayed
 * here, so a test feeds the boundaries and asserts what the Engine does with each one.
 */
async function creditWakeDays(harness: Harness): Promise<void> {
  const now: number = harness.now();
  const today: string = localDateStr(now);
  let date: string = harness.seededRuntime.date;
  if (date > today) {
    await harness.engine.rolloverCheck(now);
    await harness.engine.tick();
    return;
  }
  while (date < today) {
    const boundary: number = localMidnightAfter(date);
    await harness.engine.rolloverCheck(boundary);
    date = localDateStr(boundary);
  }
  // The rollover leaves its write to the caller that runs once the controller queue is released,
  // which in the worker is the tick that walked the boundaries.
  await harness.engine.tick();
}

function lastSavedRuntime(harness: Harness): RuntimeStateV2 {
  const saved: unknown = harness.ports.saveRuntime.mock.calls.at(-1)?.[0];
  if (saved === undefined) throw new Error('expected a saved runtime');
  return saved as RuntimeStateV2;
}

function _hasCommitCheckpoint(runtime: RuntimeStateV2): boolean {
  return (runtime as RuntimeStateV2 & { commitCheckpoint?: unknown }).commitCheckpoint != null;
}

/**
 * The identity the harness last minted. The archive nonce is one of them, and pinning a literal
 * instead would mean minting something the runtime parser refuses everywhere else.
 */
function mintedId(h: Harness): string {
  const results: Array<{ type: string; value: unknown }> = vi.mocked(h.ports.newId).mock.results;
  const last: { type: string; value: unknown } | undefined = results.at(-1);
  if (last === undefined || typeof last.value !== 'string') {
    throw new Error('the harness minted no identity');
  }
  return last.value;
}

function makeEngine(opts?: {
  bankMs?: number;
  settings?: Partial<Settings>;
  runtime?: RuntimeStateV2;
  streak?: StreakState | null;
  queueSync?: EnginePorts['queueSync'];
  supersedeSync?: EnginePorts['supersedeSync'];
  persistSyncJournal?: EnginePorts['persistSyncJournal'];
  saveMatcherCache?: EnginePorts['saveMatcherCache'];
  savePolicy?: EnginePorts['savePolicy'];
  saveAggregate?: EnginePorts['saveAggregate'];
  removeAggregate?: EnginePorts['removeAggregate'];
  applyBlocking?: EnginePorts['applyBlocking'];
  sessionCompiler?: typeof compileSessionMatcher;
  hasPendingSync?: (key: string) => boolean;
  websiteBlockingReady?: () => boolean;
  lists?: ListsConfig;
}): Harness {
  let nowMs: number = T0;
  const ports: Harness['ports'] = {
    now: vi.fn((): number => nowMs),
    newId: vi.fn(uuidMinterV2()),
    rehydrateAfterDataClear: vi.fn().mockResolvedValue('dev-rehydrated'),
    saveRuntime: vi.fn().mockResolvedValue(undefined),
    ...(opts?.savePolicy === undefined ? {} : { savePolicy: vi.fn(opts.savePolicy) }),
    ...(opts?.saveAggregate === undefined ? {} : { saveAggregate: vi.fn(opts.saveAggregate) }),
    ...(opts?.removeAggregate === undefined
      ? {}
      : { removeAggregate: vi.fn(opts.removeAggregate) }),
    queueSync: opts?.queueSync === undefined ? vi.fn() : vi.fn(opts.queueSync),
    supersedeSync: opts?.supersedeSync === undefined ? vi.fn() : vi.fn(opts.supersedeSync),
    removeSync: vi.fn(),
    persistSyncJournal:
      opts?.persistSyncJournal === undefined
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn(opts.persistSyncJournal),
    appendEvents: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
    applyBlocking:
      opts?.applyBlocking === undefined
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn(opts.applyBlocking),
    playSound: vi.fn(),
    notify: vi.fn(),
    updateIcon: vi.fn(),
    prune: vi.fn().mockResolvedValue(undefined),
    reportError: vi.fn(),
    websiteBlockingReady:
      opts?.websiteBlockingReady === undefined
        ? vi.fn((): boolean => true)
        : vi.fn(opts.websiteBlockingReady),
    hasPendingSync:
      opts?.hasPendingSync === undefined ? vi.fn((): boolean => false) : vi.fn(opts.hasPendingSync),
    saveMatcherCache:
      opts?.saveMatcherCache === undefined
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn(opts.saveMatcherCache),
  };
  // The enforcement seams the controller reads through. These tests seed sessions rather than
  // driving enforcement, so the surfaces answer empty and the documents answer nothing.
  const seams: EngineSeamPortsV2 = engineSeamPortsV2({
    now: (): number => nowMs,
    // A session command that moves a boundary creates an alarm and reads it back, so the fake has
    // to remember what it was given or every phase change closes with `alarm-failed`.
    rememberAlarms: true,
  });
  const settings: Settings = { ...DEFAULT_SETTINGS, ...opts?.settings };
  const lists: ListsConfig =
    opts?.lists ??
    ({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    } satisfies ListsConfig);
  const seeded: RuntimeStateV2 = opts?.runtime ?? emptyRuntimeV2Fixture(T0);
  const engine: Engine = new Engine(
    { ...ports, ...seams } as unknown as EnginePorts,
    settings,
    lists,
    { balanceMs: opts?.bankMs ?? 0 },
    opts?.streak ?? null,
    seeded,
    'dev-test',
    opts?.sessionCompiler,
  );
  return {
    engine,
    seededRuntime: seeded,
    ports,
    now: (): number => nowMs,
    setNow: (ms: number): void => {
      nowMs = ms;
    },
    loggedEvents: (): EventRecord[] =>
      ports.appendEvents.mock.calls.flatMap((c: unknown[]): EventRecord[] => c[0] as EventRecord[]),
  };
}

const TEST_EPOCH: string = '40000000-0000-4000-8000-0000000000ee';

/** The v2 runtime the worker now holds, seeded at one instant with one epoch. */
function emptyRuntimeV2Fixture(now: number): RuntimeStateV2 {
  return emptyRuntimeV2(now, TEST_EPOCH);
}

/** The runtime the Engine last persisted, or the one it was constructed with. */
function currentRuntime(h: Harness): RuntimeStateV2 {
  const calls: unknown[][] = h.ports.saveRuntime.mock.calls;
  const last: unknown[] | undefined = calls.at(-1);
  return last === undefined ? h.seededRuntime : (last[0] as RuntimeStateV2);
}

/**
 * The verdict the rules the session captured at its start would give. That snapshot is durable
 * and never rewritten, so this answers what the session was started with. It does not answer what
 * the session blocks now, because the saved lists move underneath it: ask `sessionBlocks` for
 * that, which goes through the engine.
 */
function frozenVerdict(h: Harness, url: string, at: number = T0): ReturnType<typeof evaluateUrl> {
  const runtime: RuntimeStateV2 = currentRuntime(h);
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) throw new Error('expected a live session to evaluate against');
  return evaluateUrl(
    compileSessionMatcher(session.config.rules, ALL_CATEGORIES, session.config.mode),
    url,
    [...runtime.unlocks],
    at,
  );
}

/**
 * What the session blocks now, asked through the engine so the port under test answers it. Each
 * URL gets its own document, because the worker keys a frozen command by document and a second
 * question asked on the first question's document would be answered from that command.
 */
let probeDocuments: number = 0;
async function sessionBlocks(h: Harness, url: string): Promise<boolean> {
  probeDocuments += 1;
  const commands: DocumentContentCommand[] = await h.engine.documentCommandsFor(
    { tabId: 900 + probeDocuments, documentId: `probe-${probeDocuments}`, url },
    null,
    'read',
  );
  return commands.some(
    (command: DocumentContentCommand): boolean =>
      command.command === 'apply-enforcement' && command.verdict.blocked,
  );
}

/** A durable v2 focus session in the runtime, which is how a test now gets an active session. */
function activeSessionV2(overrides: Partial<SessionStateV2> = {}): SessionStateV2 {
  return {
    version: 2,
    sessionId: '10000000-0000-4000-8000-00000000ac01',
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      duration: { kind: 'timed', minutes: 25 },
      cycling: null,
      intention: 'Ship the release',
      source: 'manual',
      scheduleOccurrence: null,
      rules: rulesFromLists(ENGINE_LISTS),
    },
    startedAt: T0,
    sessionEndsAt: T0 + 1_500_000,
    phase: 'focus',
    phaseStartedAt: T0,
    phaseEndsAt: T0 + 1_500_000,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 0,
    ...overrides,
  };
}

/**
 * A deferred block claim the closed data-clear barrier left behind. The worker no longer writes
 * one, so a test reaches the replay the Engine still owns by restarting on a runtime that carries
 * the claim, which is exactly the state an older build persisted.
 */
function deferredClaim(overrides: Partial<DeferredBlockClaim> = {}): DeferredBlockClaim {
  return {
    attemptAt: T0,
    documentId: 'document-one',
    kind: 'navigation',
    sessionId: '10000000-0000-4000-8000-00000000ac01',
    stage: 'attempt',
    tabId: 7,
    url: 'https://facebook.com/feed',
    ...overrides,
  };
}

/** The session config of a Hard session, which the retained policy guards read. */
function hardConfigV2(): SessionStateV2['config'] {
  return { ...activeSessionV2().config, strictness: 'hard' };
}

/**
 * The enforcement checkpoint that publishes a seeded session. A focus session is only reported as
 * active while a checkpoint attests the same session, epoch, and policy revision, so a seeded
 * runtime carries one or the worker reads it as still starting.
 */
function activeCheckpointV2(
  runtime: RuntimeStateV2,
  session: SessionStateV2,
): EnforcementCheckpoint {
  return {
    version: 1,
    operationId: '50000000-0000-4000-8000-00000000ac01',
    enforcementEpoch: runtime.enforcementEpoch,
    sessionId: session.sessionId,
    basePolicyRevision: runtime.basePolicyRevision,
    kind: 'activation',
    registrationAuditedAt: session.startedAt,
    completedAt: session.startedAt,
    targetGeneration: 1,
    documents: [],
    exclusions: [],
  };
}

/** The runtime a worker holds while a session is live, seeded rather than started. */
function activeRuntimeV2(
  session: Partial<SessionStateV2> = {},
  runtime: Partial<RuntimeStateV2> = {},
): RuntimeStateV2 {
  const base: RuntimeStateV2 = emptyRuntimeV2Fixture(T0);
  const live: SessionStateV2 = activeSessionV2(session);
  return {
    ...base,
    session: live,
    enforcementCheckpoint: activeCheckpointV2(base, live),
    ...runtime,
  };
}

const ENGINE_LISTS: ListsConfig = {
  ...DEFAULT_LISTS,
  custom: [{ kind: 'host', pattern: 'facebook.com' }],
};

const manualConfig: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'timed', minutes: 25 },
  cycling: null,
  intention: 'write the report',
  source: 'manual',
  scheduleOccurrence: null,
  rules: rulesFromLists(ENGINE_LISTS),
};

const scheduledEntry: ScheduleEntry = {
  id: 'weekday-focus',
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '09:00',
  end: '10:00',
  duration: { kind: 'window' },
  mode: 'blacklist',
  strictness: 'hard',
  cycling: null,
  intention: 'scheduled work',
  enabled: true,
};

function oversizedSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    schedule: [{ ...scheduledEntry, intention: 'x'.repeat(8_192) }],
  };
}

describe('the aggregate fold rule', (): void => {
  const ended: EventRecord = {
    t: 'sessionEnded',
    eventId: '40000000-0000-4000-8000-0000000000f1',
    at: T0,
    sessionId: '40000000-0000-4000-8000-0000000000f2',
    outcome: 'completed',
    reason: 'reached-end',
    focusedMs: 60_000,
    duration: { kind: 'timed', minutes: 25 },
    source: 'manual',
    scheduleOccurrence: null,
  } as unknown as EventRecord;

  it('never lets a terminal event carry its focus into the day', (): void => {
    // The day already holds this focus: the Engine credits settled focus as it accrues, so an end
    // event folded with its own focus would count the same minutes twice. The v2 end event is the
    // same kind of event as the two v1 ones the rule already named.
    expect(aggregatedFocusEventV2(ended)).toMatchObject({ focusedMs: 0 });
    expect(
      aggregatedFocusEventV2({ ...ended, outcome: 'ended-early' } as unknown as EventRecord),
    ).toMatchObject({ focusedMs: 0 });
  });

  it('leaves every other event exactly as it was', (): void => {
    const attempt: EventRecord = {
      t: 'attempt',
      at: T0,
      url: 'https://facebook.com/feed',
      host: 'facebook.com',
      tabId: 7,
      kind: 'navigation',
    } as unknown as EventRecord;

    expect(aggregatedFocusEventV2(attempt)).toBe(attempt);
  });
});

describe('Engine', () => {
  it('deduplicates an unavailable schedule notice after a worker restart', async (): Promise<void> => {
    const insideWindow: number = new Date(2026, 7, 29, 9, 1).getTime();
    const first: Harness = makeEngine({
      settings: { schedule: [scheduledEntry] },
      websiteBlockingReady: (): boolean => false,
    });
    first.setNow(insideWindow);
    await first.engine.snapshotPersisted();
    const persisted: RuntimeStateV2 = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeStateV2,
    );

    const restarted: Harness = makeEngine({
      runtime: persisted,
      settings: { schedule: [scheduledEntry] },
      websiteBlockingReady: (): boolean => false,
    });
    restarted.setNow(insideWindow);
    expect(restarted.engine.snapshot()).toMatchObject({ phase: 'idle', scheduleActive: false });
    expect(restarted.ports.notify).not.toHaveBeenCalled();
  });

  it('keeps the captured policy immutable while the session follows the saved lists', async (): Promise<void> => {
    const first: Harness = makeEngine({ runtime: activeRuntimeV2() });
    const replacementLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replacement.example' }],
    };

    await expect(first.engine.updateLists(replacementLists)).resolves.toEqual({ ok: true });
    // What the session captured is durable and never rewritten.
    expect(frozenVerdict(first, 'https://facebook.com/feed').blocked).toBe(true);
    expect(frozenVerdict(first, 'https://replacement.example/page').blocked).toBe(false);
    // What it blocks is the saved lists as they stand now.
    await expect(sessionBlocks(first, 'https://facebook.com/feed')).resolves.toBe(false);
    await expect(sessionBlocks(first, 'https://replacement.example/page')).resolves.toBe(true);

    const persisted: RuntimeStateV2 = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeStateV2,
    );
    const restarted: Harness = makeEngine({ runtime: persisted, lists: replacementLists });
    expect(frozenVerdict(restarted, 'https://facebook.com/feed').blocked).toBe(true);
    expect(frozenVerdict(restarted, 'https://replacement.example/page').blocked).toBe(false);
    await expect(sessionBlocks(restarted, 'https://facebook.com/feed')).resolves.toBe(false);
    await expect(sessionBlocks(restarted, 'https://replacement.example/page')).resolves.toBe(true);
  });

  it('keeps the active policy immutable across a settings change', async (): Promise<void> => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2() });

    await expect(
      h.engine.updateSettings({ ...DEFAULT_SETTINGS, defaultMode: 'whitelist' }),
    ).resolves.toEqual({ ok: true });

    expect(frozenVerdict(h, 'https://facebook.com/feed').blocked).toBe(true);
  });

  it('forwards background errors to the configured port', () => {
    const h: Harness = makeEngine();
    const error = new Error('transient tab read failure');

    h.engine.reportError(error);

    expect(h.ports.reportError).toHaveBeenCalledWith(error);
  });

  it('atomically settles mute ownership after a concurrent URL rebind', async () => {
    const h: Harness = makeEngine();
    const engine = h.engine as Engine & {
      settleMuteClaim(tabId: number, finalUrl: string | null): Promise<void>;
    };

    await h.engine.claimMute(7, 'https://blocked.example/source', false);
    await h.engine.markStopped(7, 'https://blocked.example/source', 'replacement-document');
    await h.engine.transferMuteClaim(
      7,
      'https://blocked.example/source',
      'https://blocked.example/intermediate',
    );

    expect(typeof engine.settleMuteClaim).toBe('function');
    await engine.settleMuteClaim(7, 'https://blocked.example/final');
    expect(h.engine.tabFacts(7, 'https://blocked.example/final').wasMutedByUs).toBe(true);
    await engine.settleMuteClaim(7, null);
    expect(h.engine.tabFacts(7, 'https://blocked.example/final').wasMutedByUs).toBe(false);
    expect(
      h.engine.tabFacts(7, 'https://blocked.example/final', 'replacement-document').wasStopped,
    ).toBe(true);
  });

  it('retries runtime persistence after a failed save', async () => {
    const h: Harness = makeEngine();
    h.ports.saveRuntime.mockRejectedValueOnce(new Error('local storage unavailable'));
    const changed: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 30_000 },
    };

    await expect(h.engine.updateSettings(changed)).rejects.toThrow('local storage unavailable');
    await h.engine.snapshotPersisted();
    expect(h.ports.saveRuntime).toHaveBeenCalledTimes(3);
  });

  it('self-heals a stored bank above the loaded cap and persists the clamp', async () => {
    const h: Harness = makeEngine({
      bankMs: 120_000,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 } },
    });

    await expect(h.engine.snapshotPersisted()).resolves.toMatchObject({ bankMs: 60_000 });
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_BANK, { balanceMs: 60_000 });
    expect(h.ports.persistSyncJournal).toHaveBeenCalled();
  });

  it('clamps and journals a lower local cap before acknowledging', async () => {
    let durableBankMs: number = 120_000;
    let durableSettings: Settings = DEFAULT_SETTINGS;
    let pendingBankMs: number = durableBankMs;
    let pendingSettings: Settings = durableSettings;
    let releaseJournal: () => void = (): void => {
      throw new Error('sync journal persistence did not start');
    };
    let signalJournalStarted: () => void = (): void => {
      throw new Error('sync journal persistence did not start');
    };
    const journalStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalJournalStarted = resolve;
    });
    const journalBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseJournal = resolve;
    });
    const h: Harness = makeEngine({
      bankMs: durableBankMs,
      queueSync: (key: string, value: unknown): void => {
        if (key === SYNC_BANK) pendingBankMs = (value as { balanceMs: number }).balanceMs;
        if (key === SYNC_SETTINGS) pendingSettings = value as Settings;
      },
      persistSyncJournal: async (): Promise<void> => {
        signalJournalStarted();
        await journalBlocked;
        durableBankMs = pendingBankMs;
        durableSettings = pendingSettings;
      },
    });
    const lowered: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
    };

    const updating: Promise<Ack> = h.engine.updateSettings(lowered);
    await journalStarted;
    const beforePersistence: 'pending' | 'resolved' = await Promise.race([
      updating.then((): 'resolved' => 'resolved'),
      Promise.resolve('pending' as const),
    ]);

    expect(beforePersistence).toBe('pending');
    expect(pendingBankMs).toBe(120_000);
    expect(durableBankMs).toBe(120_000);
    expect(durableSettings.pause.capMs).toBe(DEFAULT_SETTINGS.pause.capMs);

    releaseJournal();
    await expect(updating).resolves.toEqual({ ok: true });

    expect(h.engine.snapshot().bankMs).toBe(60_000);
    expect(durableBankMs).toBe(60_000);
    expect(durableSettings.pause.capMs).toBe(60_000);
    expect(h.ports.persistSyncJournal).toHaveBeenCalled();

    const restarted: Harness = makeEngine({
      bankMs: durableBankMs,
      settings: durableSettings,
    });
    expect(restarted.engine.snapshot().bankMs).toBe(60_000);
  });

  it('clamps and persists the bank when live-synced settings lower the cap', async () => {
    const h: Harness = makeEngine({ bankMs: 120_000 });
    const lowered: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
    };

    await expect(h.engine.applySyncedSettings(lowered)).resolves.toEqual({ ok: true });

    expect(h.engine.snapshot().bankMs).toBe(60_000);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_BANK, { balanceMs: 60_000 });
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_SETTINGS, expect.anything());
    expect(h.ports.persistSyncJournal).toHaveBeenCalled();
  });

  it('mirrors inbound policy without early mutation and commits it without publication', async () => {
    const savePolicy = vi.fn().mockResolvedValue(undefined);
    const h: Harness = makeEngine({ bankMs: 120_000, savePolicy });
    const incoming: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
    };

    const mirror = vi.fn(async (): Promise<void> => {
      expect(h.engine.getSettings()).toEqual(DEFAULT_SETTINGS);
      expect(h.engine.snapshot().bankMs).toBe(120_000);
    });

    await expect(
      h.engine.transactSyncedPolicy({ settings: incoming }, false, mirror),
    ).resolves.toEqual({ ok: true });

    expect(mirror).toHaveBeenCalledWith({ settings: incoming, bank: { balanceMs: 60_000 } });
    expect(h.engine.getSettings()).toEqual(incoming);
    expect(h.engine.snapshot().bankMs).toBe(60_000);
    expect(savePolicy).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('serializes an inbound mirror and commit behind an admitted local policy write', async () => {
    let releaseLocalSave: () => void = (): void => undefined;
    const localSaveBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseLocalSave = resolve;
    });
    let localSaveStarted: () => void = (): void => undefined;
    const localSaveAdmission: Promise<void> = new Promise((resolve: () => void): void => {
      localSaveStarted = resolve;
    });
    const h: Harness = makeEngine({
      savePolicy: async (): Promise<void> => {
        localSaveStarted();
        await localSaveBlocked;
      },
    });
    const local: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const remote: Settings = { ...DEFAULT_SETTINGS, retentionDays: 14 };
    const trace: string[] = [];

    const localUpdate: Promise<Ack> = h.engine.updateSettings(local);
    await localSaveAdmission;
    const inbound: Promise<Ack> = h.engine.transactSyncedPolicy(
      { settings: remote },
      false,
      async (): Promise<void> => {
        trace.push('mirror');
      },
    );
    await Promise.resolve();
    expect(trace).toEqual([]);

    releaseLocalSave();
    await expect(localUpdate).resolves.toEqual({ ok: true });
    await expect(inbound).resolves.toEqual({ ok: true });

    expect(trace).toEqual(['mirror']);
    expect(h.engine.getSettings()).toEqual(remote);
  });

  it('preserves the latest local schedule intention when an incoming transaction waits behind a local edit', async (): Promise<void> => {
    let releaseSave: () => void = (): void => undefined;
    const saveBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseSave = resolve;
    });
    let signalSave: () => void = (): void => undefined;
    const saveStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSave = resolve;
    });
    const entry: Settings['schedule'][number] = {
      id: 'morning',
      days: [1],
      start: '09:00',
      end: '10:00',
      duration: { kind: 'window' },
      mode: 'blacklist',
      strictness: 'friction',
      cycling: null,
      intention: 'earlier local task',
      enabled: false,
    };
    const h: Harness = makeEngine({
      settings: { ...DEFAULT_SETTINGS, schedule: [entry] },
      savePolicy: async (): Promise<void> => {
        signalSave();
        await saveBlocked;
      },
    });
    const incoming: Settings = { ...h.engine.getSettings(), theme: 'dark' };
    const local: Settings = {
      ...h.engine.getSettings(),
      schedule: [{ ...entry, intention: 'latest local task' }],
    };
    const updating: Promise<Ack> = h.engine.updateSettings(local);
    await saveStarted;
    const mirror = vi.fn().mockResolvedValue(undefined);
    const inbound: Promise<Ack> = h.engine.transactSyncedPolicy(
      { settings: incoming },
      false,
      mirror,
    );
    releaseSave();
    await expect(updating).resolves.toEqual({ ok: true });
    await expect(inbound).resolves.toEqual({ ok: true });
    const expected: Settings = { ...incoming, schedule: local.schedule };
    expect(mirror).toHaveBeenCalledWith({ settings: expected });
    expect(h.engine.getSettings()).toEqual(expected);
  });

  it('does not answer a persisted snapshot while an admitted policy mutation is active', async (): Promise<void> => {
    let releasePolicySave: () => void = (): void => undefined;
    const policySaveBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releasePolicySave = resolve;
    });
    let signalPolicySaveStarted: () => void = (): void => undefined;
    const policySaveStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalPolicySaveStarted = resolve;
    });
    const h: Harness = makeEngine({
      savePolicy: async (): Promise<void> => {
        signalPolicySaveStarted();
        await policySaveBlocked;
      },
    });
    const updating: Promise<Ack> = h.engine.updateSettings({
      ...DEFAULT_SETTINGS,
      retentionDays: 30,
    });
    await policySaveStarted;

    let snapshotResolved: boolean = false;
    const snapshot: Promise<SessionSnapshot> = h.engine
      .snapshotPersisted()
      .then((value: SessionSnapshot): SessionSnapshot => {
        snapshotResolved = true;
        return value;
      });
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });
    expect(snapshotResolved).toBe(false);

    releasePolicySave();
    await expect(updating).resolves.toEqual({ ok: true });
    await expect(snapshot).resolves.toMatchObject({ phase: 'idle' });
  });

  it('drains an admitted persisted snapshot when a data-clear barrier starts synchronously', async (): Promise<void> => {
    const h: Harness = makeEngine();

    const snapshot: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    const clearing: Promise<void> = h.engine.runWithDataClearBarrier(
      (): Promise<void> => Promise.resolve(),
    );

    await expect(snapshot).resolves.toMatchObject({ phase: 'idle' });
    await expect(clearing).resolves.toBeUndefined();
  });

  it('persists the derived list cache before mirroring inbound list authority', async () => {
    const cacheFailure: Error = new Error('matcher cache unavailable');
    const h: Harness = makeEngine({
      saveMatcherCache: vi.fn().mockRejectedValue(cacheFailure),
    });
    const prior: ListsConfig = h.engine.getLists();
    const incoming: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'accepted.example' }],
    };
    const mirror = vi.fn().mockResolvedValue(undefined);

    await expect(h.engine.transactSyncedPolicy({ lists: incoming }, false, mirror)).rejects.toThrow(
      'matcher cache unavailable',
    );

    expect(mirror).not.toHaveBeenCalled();
    expect(h.engine.getLists()).toEqual(prior);
  });

  it('reapplies blocking only when synced settings change the theme', async () => {
    const h: Harness = makeEngine();
    h.ports.applyBlocking.mockClear();

    await expect(
      h.engine.applySyncedSettings({ ...DEFAULT_SETTINGS, theme: 'dark' }),
    ).resolves.toEqual({ ok: true });
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(1);

    h.ports.applyBlocking.mockClear();
    await expect(
      h.engine.applySyncedSettings({
        ...DEFAULT_SETTINGS,
        theme: 'dark',
        retentionDays: 30,
      }),
    ).resolves.toEqual({ ok: true });
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
  });

  it('does not rewrite the bank when a settings update raises the cap', async () => {
    const h: Harness = makeEngine({
      bankMs: 60_000,
      settings: {
        pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
      },
    });
    const raised: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 120_000 },
    };

    await h.engine.updateSettings(raised);

    expect(h.engine.snapshot().bankMs).toBe(60_000);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_BANK, expect.anything());
  });

  it('rejects a lower-cap acknowledgement until the clamped bank journal persists', async () => {
    const h: Harness = makeEngine({ bankMs: 120_000 });
    h.ports.persistSyncJournal.mockRejectedValueOnce(new Error('sync journal unavailable'));
    const lowered: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
    };

    await expect(h.engine.applySyncedSettings(lowered)).rejects.toThrow('sync journal unavailable');

    expect(h.ports.saveRuntime.mock.calls[0]?.[0]).toMatchObject({
      commitCheckpoint: { bank: { balanceMs: 60_000 }, syncBank: true },
    });
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_BANK, { balanceMs: 60_000 });

    await expect(h.engine.snapshotPersisted()).resolves.toMatchObject({ bankMs: 60_000 });
    expect(h.ports.persistSyncJournal).toHaveBeenCalledTimes(3);
  });

  it('leaves settings, bank, and queues unchanged when a hard-session edit is rejected', async () => {
    const h: Harness = makeEngine({
      runtime: activeRuntimeV2({ config: hardConfigV2() }),
      bankMs: 120_000,
    });
    h.ports.queueSync.mockClear();
    h.ports.persistSyncJournal.mockClear();
    const rejected: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
    };

    await expect(h.engine.updateSettings(rejected)).resolves.toMatchObject({ ok: false });

    expect(h.engine.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(h.engine.snapshot().bankMs).toBe(120_000);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_SETTINGS, expect.anything());
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_BANK, expect.anything());
  });

  it('rejects oversized local settings before mutating settings or clamping the bank', async () => {
    const h: Harness = makeEngine({ bankMs: 120_000 });
    const oversized: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
      schedule: [
        {
          ...scheduledEntry,
          intention: 'x'.repeat(8_192),
        },
      ],
    };

    await expect(h.engine.updateSettings(oversized)).resolves.toEqual({
      ok: false,
      error: t('notify_settings_sync_limit'),
    });

    expect(h.engine.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(h.engine.snapshot().bankMs).toBe(120_000);
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('accepts local settings at the exact Chrome Sync item boundary', async () => {
    const h: Harness = makeEngine();
    const base: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...scheduledEntry, intention: '' }],
    };
    const fillerBytes: number = 8_192 - syncItemBytes(SYNC_SETTINGS, base);
    const boundary: Settings = {
      ...base,
      schedule: [{ ...scheduledEntry, intention: 'x'.repeat(fillerBytes) }],
    };

    expect(syncItemBytes(SYNC_SETTINGS, boundary)).toBe(8_192);
    await expect(h.engine.updateSettings(boundary)).resolves.toEqual({ ok: true });
    expect(h.engine.getSettings()).toEqual(boundary);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_SETTINGS, boundary);
  });

  it('rejects oversized local lists without replacing the compiled matcher', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2() });
    const before = frozenVerdict(h, 'https://facebook.com/feed');
    h.ports.queueSync.mockClear();
    const oversized: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('custom'),
    };

    await expect(h.engine.updateLists(oversized)).resolves.toEqual({
      ok: false,
      error: t('notify_lists_sync_limit'),
    });

    expect(h.engine.getLists()).toEqual({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    });
    expect(frozenVerdict(h, 'https://facebook.com/feed')).toEqual(before);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_LISTS, expect.anything());
    expect(h.ports.saveMatcherCache).not.toHaveBeenCalled();
  });

  it('rejects Chromium-escaped list overflow before cache or state mutation', async () => {
    const h: Harness = makeEngine();
    const before: ListsConfig = h.engine.getLists();
    const escapedBase: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'regex', pattern: '<\u2028\u2029'.repeat(500) }],
    };
    clearMutationPorts(h.ports);

    await expect(h.engine.updateLists(escapedBase)).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );

    expect(h.ports.saveMatcherCache).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
    expect(h.ports.removeSync).not.toHaveBeenCalled();
    expect(h.engine.getLists()).toEqual(before);
  });

  it('queues a complete sharded encoding and durably replays it after restart', async () => {
    let durableJournal: SyncJournal = { sets: {}, removes: [] };
    const writer: SyncWriter = new SyncWriter(
      60_000,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
      {
        initial: durableJournal,
        persist: async (journal: SyncJournal): Promise<void> => {
          durableJournal = structuredClone(journal);
        },
      },
    );
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
      persistSyncJournal: (): Promise<void> => writer.whenJournalDurable(),
    });
    const lists: ListsConfig = splittableLists([{ kind: 'host', pattern: 'sharded.example' }]);

    await expect(h.engine.updateLists(lists)).resolves.toEqual({ ok: true });

    const expected = await encodeListsForSync(lists);
    expect(durableJournal).toEqual({ sets: expected.sets, removes: [] });
    const replayWrites: Array<Record<string, unknown>> = [];
    const restarted: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        replayWrites.push(structuredClone(items));
      },
      vi.fn().mockResolvedValue(undefined),
      { initial: durableJournal, persist: vi.fn().mockResolvedValue(undefined) },
    );
    await restarted.flushNow();
    expect(replayWrites).toEqual([expected.sets]);
  });

  it('removes stale category shards when lists return to the unsplit representation', async () => {
    const h: Harness = makeEngine();
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'unsplit.example' }],
    };

    await expect(h.engine.updateLists(lists)).resolves.toEqual({ ok: true });

    for (const key of LIST_SYNC_SHARD_KEYS) {
      expect(h.ports.removeSync).toHaveBeenCalledWith(key);
    }
  });

  it('keeps the hard-session guard authoritative before queuing sharded lists', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2({ config: hardConfigV2() }) });
    clearMutationPorts(h.ports);

    await expect(h.engine.updateLists(splittableLists())).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );

    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_LISTS, expect.anything());
    for (const key of LIST_SYNC_SHARD_KEYS) {
      expect(h.ports.queueSync).not.toHaveBeenCalledWith(key, expect.anything());
    }
    expect(h.ports.removeSync).not.toHaveBeenCalled();
  });

  it('rejects oversized live lists before catch-up or matcher-cache persistence', async () => {
    const h: Harness = makeEngine();
    clearMutationPorts(h.ports);
    const oversized: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('live'),
    };

    await expect(h.engine.applySyncedLists(oversized)).resolves.toEqual({
      ok: false,
      error: t('notify_lists_sync_limit'),
    });

    expect(h.ports.now).not.toHaveBeenCalled();
    expect(h.ports.saveMatcherCache).not.toHaveBeenCalled();
    expect(h.engine.getLists()).toEqual({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    });
  });

  it('persists both matcher modes and applies them to the session already running', async () => {
    const order: string[] = [];
    const h: Harness = makeEngine({
      runtime: activeRuntimeV2(),
      saveMatcherCache: async (): Promise<void> => {
        order.push('cache');
      },
      queueSync: (key: string): void => {
        if (key === SYNC_LISTS) order.push('sync');
      },
    });
    clearMutationPorts(h.ports);
    const updated: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replacement.example' }],
    };

    await expect(h.engine.updateLists(updated)).resolves.toEqual({ ok: true });

    expect(order).toEqual(['cache', 'sync']);
    expect(h.ports.saveMatcherCache).toHaveBeenCalledWith(
      buildMatcherCache(updated, ALL_CATEGORIES).stored,
      updated,
    );
    expect(h.engine.getLists()).toEqual(updated);
    await expect(sessionBlocks(h, 'https://replacement.example/page')).resolves.toBe(true);
    await expect(sessionBlocks(h, 'https://facebook.com/feed')).resolves.toBe(false);
  });

  it('persists accepted live lists without echoing them, and applies them to the session', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2() });
    clearMutationPorts(h.ports);
    const updated: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    await expect(h.engine.applySyncedLists(updated)).resolves.toEqual({ ok: true });

    expect(h.ports.saveMatcherCache).toHaveBeenCalledWith(
      buildMatcherCache(updated, ALL_CATEGORIES).stored,
      updated,
    );
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_LISTS, expect.anything());
    await expect(sessionBlocks(h, 'https://live.example/page')).resolves.toBe(true);
    await expect(sessionBlocks(h, 'https://facebook.com/feed')).resolves.toBe(false);
  });

  it('keeps a session-only category override when the saved categories move', async () => {
    const captured: SessionRuleSnapshot = rulesFromLists(ENGINE_LISTS);
    const h: Harness = makeEngine({
      runtime: activeRuntimeV2({
        config: {
          ...activeSessionV2().config,
          rules: { ...captured, categories: { ...captured.categories, video: true } },
        },
      }),
    });
    clearMutationPorts(h.ports);

    await expect(
      h.engine.updateLists({
        ...DEFAULT_LISTS,
        categories: { ...DEFAULT_LISTS.categories, news: true },
      }),
    ).resolves.toEqual({ ok: true });

    // The popup's session-only video toggle survives the saved categories moving under it.
    await expect(sessionBlocks(h, 'https://youtube.com/watch')).resolves.toBe(true);
    // The category the saved lists just enabled reaches the running session.
    await expect(sessionBlocks(h, 'https://cnn.com/politics')).resolves.toBe(true);
    // The rule the saved lists dropped stops blocking.
    await expect(sessionBlocks(h, 'https://facebook.com/feed')).resolves.toBe(false);
  });

  it('keeps active lists, matchers, and Sync queues when cache persistence fails', async () => {
    const h: Harness = makeEngine({
      runtime: activeRuntimeV2(),
      saveMatcherCache: (): Promise<void> => Promise.reject(new Error('local cache unavailable')),
    });
    const beforeLists: ListsConfig = h.engine.getLists();
    const beforeVerdict: Verdict = frozenVerdict(h, 'https://facebook.com/feed');
    clearMutationPorts(h.ports);
    const updated: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replacement.example' }],
    };

    await expect(h.engine.updateLists(updated)).rejects.toThrow('local cache unavailable');

    expect(h.engine.getLists()).toEqual(beforeLists);
    expect(frozenVerdict(h, 'https://facebook.com/feed')).toEqual(beforeVerdict);
    expect(frozenVerdict(h, 'https://replacement.example/page').blocked).toBe(false);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_LISTS, expect.anything());
  });

  it('quiesces manual and scheduled session starts for the complete all-data clear barrier', async (): Promise<void> => {
    let releaseRemote: () => void = (): void => undefined;
    let signalRemoteStarted: () => void = (): void => undefined;
    const remoteBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseRemote = resolve;
    });
    const remoteStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalRemoteStarted = resolve;
    });
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });

    const clearing: Promise<void> = h.engine.runWithDataClearBarrier(async (): Promise<void> => {
      signalRemoteStarted();
      await remoteBlocked;
    });
    await remoteStarted;
    h.setNow(T0 + 2 * 60_000);

    await expect(h.engine.tick()).rejects.toThrow('data clear');
    await expect(h.engine.startSession(manualConfig)).resolves.toEqual({
      ok: false,
      code: 'data-clear-pending',
      error: 'data-clear-pending',
    });
    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 1, 'navigation'),
    ).rejects.toThrow('data clear');
    await expect(
      h.engine.markStopped(1, 'https://facebook.com/feed', 'document-id'),
    ).rejects.toThrow('data clear');
    await expect(h.engine.updateLists(DEFAULT_LISTS)).rejects.toThrow('data clear');
    expect(h.engine.snapshot().phase).toBe('idle');
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(h.ports.appendEvents).not.toHaveBeenCalled();
    expect(h.ports.saveMatcherCache).not.toHaveBeenCalled();

    releaseRemote();
    await clearing;

    await expect(h.engine.tick()).resolves.toBeUndefined();
    await expect(h.engine.snapshotPersisted()).resolves.toMatchObject({ phase: 'idle' });
    await expect(h.engine.updateLists(DEFAULT_LISTS)).resolves.toEqual({ ok: true });
    expect(h.engine.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(h.engine.getLists()).toEqual(DEFAULT_LISTS);
    expect(h.engine.snapshot()).toMatchObject({ phase: 'idle', bankMs: 0 });
    expect(h.engine.statsOverlay().pendingEvents).toEqual([]);
    expect(h.ports.rehydrateAfterDataClear).toHaveBeenCalledOnce();
  });

  it('replays deferred navigation bookkeeping after worker restart', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    const restarted: Harness = makeEngine({
      runtime: activeRuntimeV2({}, { deferredBlockClaims: { [`7:${url}`]: deferredClaim() } }),
    });
    restarted.setNow(T0 + 31_000);

    await restarted.engine.tick();

    expect(restarted.engine.snapshot().attemptsToday).toBe(1);
    expect(restarted.engine.tabFacts(7, url, 'document-one').wasStopped).toBe(true);
    expect(restarted.loggedEvents()).toContainEqual(
      expect.objectContaining({
        t: 'attempt',
        at: T0,
        sessionId: deferredClaim().sessionId,
      }),
    );
    expect(lastSavedRuntime(restarted).deferredBlockClaims).toEqual({});
  });

  it('replays only the unfinished stopped stage after the debounce window', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    const restarted: Harness = makeEngine({
      runtime: activeRuntimeV2(
        {},
        {
          attemptDebounce: { [`7:${url}`]: T0 },
          deferredBlockClaims: {
            [`7:${url}`]: deferredClaim({ documentId: 'document-two', stage: 'stopped' }),
          },
          todayAgg: { ...emptyDaily(localDateStr(T0)), attempts: { 'facebook.com': 1 } },
        },
      ),
    });
    restarted.setNow(T0 + 31_000);

    await restarted.engine.tick();

    expect(restarted.engine.snapshot().attemptsToday).toBe(1);
    expect(restarted.engine.tabFacts(7, url, 'document-two').wasStopped).toBe(true);
    expect(
      restarted.loggedEvents().filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toEqual([]);
  });

  it('retries a failed deferred attempt replay without double counting it', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    const restarted: Harness = makeEngine({
      runtime: activeRuntimeV2(
        {},
        {
          deferredBlockClaims: { [`7:${url}`]: deferredClaim({ documentId: 'document-three' }) },
        },
      ),
    });
    const replayError: Error = new Error('event storage unavailable');
    restarted.ports.appendEvents.mockRejectedValueOnce(replayError);
    restarted.setNow(T0 + 1_000);

    await restarted.engine.tick();
    await restarted.engine.tick();

    expect(restarted.ports.reportError).toHaveBeenCalledWith(replayError);
    expect(restarted.engine.snapshot().attemptsToday).toBe(1);
    expect(restarted.engine.tabFacts(7, url, 'document-three').wasStopped).toBe(true);
    expect(lastSavedRuntime(restarted).deferredBlockClaims).toEqual({});
  });

  it('keeps an old deferred attempt attributed to its originating session', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    const restarted: Harness = makeEngine({
      runtime: activeRuntimeV2(
        { sessionId: '10000000-0000-4000-8000-00000000ac02' },
        {
          deferredBlockClaims: {
            [`7:${url}`]: deferredClaim({ documentId: 'old-document' }),
          },
        },
      ),
    });
    restarted.setNow(T0 + 1_000);

    await restarted.engine.tick();

    expect(restarted.engine.snapshot().attemptsToday).toBe(1);
    expect(restarted.engine.tabFacts(7, url, 'old-document').wasStopped).toBe(true);
    expect(restarted.loggedEvents()).toContainEqual(
      expect.objectContaining({
        t: 'attempt',
        sessionId: deferredClaim().sessionId,
      }),
    );
    expect(restarted.loggedEvents()).not.toContainEqual(
      expect.objectContaining({ t: 'attempt', sessionId: '10000000-0000-4000-8000-00000000ac02' }),
    );
    expect(lastSavedRuntime(restarted).deferredBlockClaims).toEqual({});
  });

  it('clears local in-memory aggregates after durable local-history deletion', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = {
      ...emptyRuntimeV2Fixture(T0),
      todayAgg: { ...emptyDaily('2026-08-29'), focusMs: 60_000 },
    };
    const h: Harness = makeEngine({ runtime });
    const clearStorage = vi.fn().mockResolvedValue(true);

    await h.engine.runWithLocalHistoryClear(clearStorage, (): Promise<void> => Promise.resolve());

    expect(clearStorage).toHaveBeenCalledOnce();
    expect(h.engine.statsOverlay()).toMatchObject({
      deviceId: 'dev-test',
      todayAgg: { focusMs: 0 },
      pendingEvents: [],
    });
    expect(h.ports.saveRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({ todayAgg: null, commitCheckpoint: null }),
    );
  });

  it('keeps history sanitized and the transaction pending when runtime persistence fails', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = activeRuntimeV2(
      {},
      { todayAgg: { ...emptyDaily('2026-08-29'), focusMs: 60_000 } },
    );
    const streak: StreakState = {
      current: 3,
      freezeTokens: 1,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [27, 28],
      activeMonth: '2026-08',
    };
    const saveAggregate = vi.fn().mockResolvedValue(undefined);
    const h: Harness = makeEngine({ bankMs: 42_000, runtime, saveAggregate, streak });
    const finishStorage = vi.fn().mockResolvedValue(undefined);
    let historyRemoved: boolean = false;
    h.ports.saveRuntime.mockImplementation(async (saved: RuntimeStateV2): Promise<void> => {
      if (historyRemoved && saved.todayAgg === null) {
        throw new Error('sanitized runtime unavailable');
      }
    });

    await expect(
      h.engine.runWithLocalHistoryClear(async (): Promise<boolean> => {
        historyRemoved = true;
        return true;
      }, finishStorage),
    ).rejects.toThrow('sanitized runtime unavailable');

    expect(finishStorage).not.toHaveBeenCalled();
    expect(h.engine.snapshot()).toMatchObject({ phase: 'focus', bankMs: 42_000 });
    expect(h.engine.statsOverlay()).toMatchObject({
      todayAgg: { focusMs: 0 },
      streak,
      pendingEvents: [],
    });

    h.ports.saveRuntime.mockResolvedValue(undefined);
    saveAggregate.mockClear();
    await h.engine.snapshotPersisted();

    expect(lastSavedRuntime(h)).toMatchObject({ todayAgg: null, commitCheckpoint: null });
    expect(saveAggregate).not.toHaveBeenCalled();

    await h.engine.runWithLocalHistoryClear(
      (): Promise<boolean> => Promise.resolve(true),
      finishStorage,
    );
    expect(finishStorage).toHaveBeenCalledOnce();
  });

  it('keeps mute ownership visible until the all-data cleanup sweep restores audio', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    let restoredMutedTab: boolean = false;
    let h: Harness;
    h = makeEngine({
      applyBlocking: async (): Promise<void> => {
        const facts: ReturnType<Engine['tabFacts']> = h.engine.tabFacts(7, url);
        restoredMutedTab = facts.wasMutedByUs && !facts.priorMuted;
      },
    });
    await h.engine.claimMute(7, url, false);

    await h.engine.runWithDataClearBarrier((): Promise<void> => Promise.resolve());

    expect(restoredMutedTab).toBe(true);
    expect(h.engine.tabFacts(7, url).wasMutedByUs).toBe(false);
  });

  it('keeps stopped-document ownership visible until the all-data cleanup sweep reloads it', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    const documentId: string = 'stopped-document';
    let restoredStoppedTab: boolean = false;
    let h: Harness;
    h = makeEngine({
      applyBlocking: async (): Promise<void> => {
        restoredStoppedTab = h.engine.tabFacts(7, url, documentId).wasStopped;
      },
    });
    await h.engine.markStopped(7, url, documentId);

    await h.engine.runWithDataClearBarrier((): Promise<void> => Promise.resolve());

    expect(restoredStoppedTab).toBe(true);
    expect(h.engine.tabFacts(7, url, documentId).wasStopped).toBe(false);
  });

  it('retains quiescence for a boot-restored all-data retry and reopens after success', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    await h.engine.retainDataClearQuiescence();

    await expect(h.engine.startSession(manualConfig)).resolves.toEqual({
      ok: false,
      code: 'data-clear-pending',
      error: 'data-clear-pending',
    });
    await h.engine.runWithDataClearBarrier((): Promise<void> => Promise.resolve());

    expect(h.engine.hasActiveSession()).toBe(false);
    expect(h.ports.rehydrateAfterDataClear).toHaveBeenCalledOnce();
    await expect(h.engine.snapshotPersisted()).resolves.toMatchObject({ phase: 'idle' });
  });

  it('lets an admitted mutation finish its applyBlocking persistence before closing the barrier', async (): Promise<void> => {
    let releaseBlocking: () => void = (): void => undefined;
    let signalBlockingStarted: () => void = (): void => undefined;
    let attemptRecordedDuringDrain: boolean = false;
    let h: Harness;
    const blockingPaused: Promise<void> = new Promise((resolve: () => void): void => {
      releaseBlocking = resolve;
    });
    const blockingStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalBlockingStarted = resolve;
    });
    h = makeEngine({
      applyBlocking: async (lease: BlockingSweepLease): Promise<void> => {
        signalBlockingStarted();
        await blockingPaused;
        await h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing', lease);
        attemptRecordedDuringDrain = h.engine.snapshot().attemptsToday === 1;
      },
    });

    const sweeping: Promise<void> = h.engine.applyBlockingNow();
    await blockingStarted;
    const clearing: Promise<void> = h.engine.runWithDataClearBarrier(
      (): Promise<void> => Promise.resolve(),
    );
    releaseBlocking();

    await expect(sweeping).resolves.toBeUndefined();
    await clearing;
    expect(attemptRecordedDuringDrain).toBe(true);
  });

  it('keeps an admitted blocking sweep mutation leased while the barrier drains', async (): Promise<void> => {
    let releaseSweep: () => void = (): void => undefined;
    let signalSweepStarted: () => void = (): void => undefined;
    const sweepBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseSweep = resolve;
    });
    const sweepStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalSweepStarted = resolve;
    });
    const h: Harness = makeEngine();
    h.ports.applyBlocking.mockImplementation(async (lease: BlockingSweepLease): Promise<void> => {
      signalSweepStarted();
      await sweepBlocked;
      await h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing', lease);
    });

    const sweeping: Promise<void> = h.engine.applyBlockingNow();
    await sweepStarted;
    let barrierEntered: boolean = false;
    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        barrierEntered = true;
      },
    );
    await Promise.resolve();
    expect(barrierEntered).toBe(false);
    releaseSweep();

    await expect(sweeping).resolves.toBeUndefined();
    await transitioning;
    expect(barrierEntered).toBe(true);
    expect(h.engine.snapshot().attemptsToday).toBe(1);
  });

  it('rejects a forged blocking sweep lease after its admitted sweep finishes', async (): Promise<void> => {
    let capturedLease: BlockingSweepLease | null = null;
    const h: Harness = makeEngine({
      applyBlocking: async (lease: BlockingSweepLease): Promise<void> => {
        capturedLease = lease;
      },
    });
    await h.engine.applyBlockingNow();
    if (capturedLease === null) throw new Error('expected an admitted blocking sweep lease');
    await h.engine.retainDataClearQuiescence();

    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing', capturedLease),
    ).rejects.toThrow('storage transition');
  });

  it('releases a tracked runtime mutation lease when its operation rejects', async (): Promise<void> => {
    const h: Harness = makeEngine();
    const error: Error = new Error('tab operation failed');

    await expect(
      h.engine.runWithRuntimeMutationLease(async (): Promise<void> => {
        throw error;
      }),
    ).rejects.toBe(error);

    await expect(
      h.engine.runWithAggregateStorageBarrier((): Promise<void> => Promise.resolve()),
    ).resolves.toBeUndefined();
  });

  it('lets a draining tab removal tombstone win over an admitted stale tab write', async (): Promise<void> => {
    const h: Harness = makeEngine();
    let releaseStaleWrite: () => void = (): void => undefined;
    let signalStaleWrite: () => void = (): void => undefined;
    const staleWriteBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseStaleWrite = resolve;
    });
    const staleWriteStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalStaleWrite = resolve;
    });
    h.ports.saveRuntime.mockImplementationOnce(async (): Promise<void> => {
      signalStaleWrite();
      await staleWriteBlocked;
    });
    const claiming: Promise<boolean> = h.engine.claimMute(7, 'https://facebook.com/feed', false);
    await staleWriteStarted;
    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      (): Promise<void> => Promise.resolve(),
    );

    const dropping: Promise<void> = h.engine.dropTab(7);
    releaseStaleWrite();
    await Promise.all([claiming, dropping, transitioning]);

    expect(h.engine.tabFacts(7, 'https://facebook.com/feed')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
    expect(lastSavedRuntime(h).tabStates).toEqual({});
  });

  it('queues a tab removal while an aggregate barrier is quiesced', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await h.engine.claimMute(7, 'https://facebook.com/feed', false);
    let releaseBarrier: () => void = (): void => undefined;
    let signalBarrierEntered: () => void = (): void => undefined;
    const barrierBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const barrierEntered: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalBarrierEntered = resolve;
    });
    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        signalBarrierEntered();
        await barrierBlocked;
      },
    );
    await barrierEntered;

    await expect(h.engine.dropTab(7)).resolves.toBeUndefined();
    expect(h.engine.tabFacts(7, 'https://facebook.com/feed').wasMutedByUs).toBe(false);
    releaseBarrier();
    await transitioning;

    expect(lastSavedRuntime(h).tabStates).toEqual({});
  });

  it('forgets the epoch acknowledgements of a dropped tab', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = emptyRuntimeV2Fixture(T0);
    for (const [tabId, documentId] of [
      [7, 'document-7'],
      [8, 'document-8'],
    ] as ReadonlyArray<[number, string]>) {
      runtime.epochResetAcks[`${tabId}:${documentId}`] = {
        version: 1,
        operationId: '20000000-0000-4000-8000-000000000001',
        enforcementEpoch: TEST_EPOCH,
        tabId,
        documentId,
        handledAt: T0,
      };
    }
    const h: Harness = makeEngine({ runtime });

    await h.engine.dropTab(7);

    // The record is the controller's, so the drop reaches it through a controller write rather
    // than through the fields the Engine lays over its own snapshot.
    expect(Object.keys(lastSavedRuntime(h).epochResetAcks)).toEqual(['8:document-8']);
    expect(Object.keys(currentRuntime(h).epochResetAcks)).toEqual(['8:document-8']);
  });

  it('applies a durable tab removal tombstone before deferred claims after restart', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = activeRuntimeV2();
    runtime.tabStates[7] = {
      muteUrl: 'https://facebook.com/feed',
      priorMuted: false,
      stoppedDocumentId: null,
    };
    runtime.deferredBlockClaims.claim = deferredClaim({
      documentId: 'stale-document',
      stage: 'stopped',
    });
    Reflect.set(runtime, 'removedTabTombstones', { 7: true });

    const restarted: Harness = makeEngine({ runtime });
    restarted.setNow(T0 + 1_000);
    await restarted.engine.tick();

    expect(restarted.engine.tabFacts(7, 'https://facebook.com/feed', 'stale-document')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
    expect(lastSavedRuntime(restarted).deferredBlockClaims).toEqual({});
    expect(Reflect.get(lastSavedRuntime(restarted), 'removedTabTombstones')).toEqual({});
  });

  it('keeps mutation admission quiesced after a durable all-data clear journal fails', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await expect(
      h.engine.runWithDataClearBarrier(
        (): Promise<void> => Promise.reject(new Error('remote deletion unavailable')),
        (): boolean => true,
      ),
    ).rejects.toThrow('remote deletion unavailable');
    await expect(h.engine.startSession(manualConfig)).resolves.toEqual({
      ok: false,
      code: 'data-clear-pending',
      error: 'data-clear-pending',
    });
    await expect(
      h.engine.runWithDataClearBarrier(
        (): Promise<void> => Promise.resolve(),
        (): boolean => true,
      ),
    ).resolves.toBeUndefined();
  });

  it('settles pending-clear navigation without admitting mutations', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await h.engine.retainDataClearQuiescence();
    const navigation: () => Promise<void> = vi.fn(async (): Promise<void> => undefined);
    await expect(
      h.engine.runWithRuntimeMutationLeaseOrBlockingSweep(navigation),
    ).resolves.toBeUndefined();
    expect(navigation).not.toHaveBeenCalled();
    await expect(h.engine.runWithRuntimeMutationLease(navigation)).rejects.toThrow(
      'runtime mutation rejected',
    );
    expect(navigation).not.toHaveBeenCalled();
  });

  it('settles deferred navigation when an in-flight clear becomes pending', async (): Promise<void> => {
    const h: Harness = makeEngine();
    let release: () => void = (): void => undefined;
    let entered: () => void = (): void => undefined;
    const held: Promise<void> = new Promise((resolve: () => void): void => {
      release = resolve;
    });
    const ready: Promise<void> = new Promise((resolve: () => void): void => {
      entered = resolve;
    });
    const clearing: Promise<void> = h.engine.runWithDataClearBarrier(
      async (): Promise<void> => {
        entered();
        await held;
        throw new Error('remote deletion unavailable');
      },
      (): boolean => true,
    );
    await ready;
    const navigation: () => Promise<void> = vi.fn(async (): Promise<void> => undefined);
    const deferred: Promise<void> = h.engine.runWithRuntimeMutationLeaseOrBlockingSweep(navigation);
    const navigationSettled: Promise<void> = expect(deferred).resolves.toBeUndefined();
    release();
    await expect(clearing).rejects.toThrow('remote deletion unavailable');
    await navigationSettled;
    expect(navigation).not.toHaveBeenCalled();
    await expect(h.engine.runWithRuntimeMutationLease(navigation)).rejects.toThrow(
      'runtime mutation rejected',
    );
  });

  it('serializes local and live list caches and reconciles a pending local Sync value', async () => {
    let releaseFirstCache: () => void = (): void => {};
    let signalFirstCacheStarted: () => void = (): void => {};
    const firstCacheBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirstCache = resolve;
    });
    const firstCacheStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFirstCacheStarted = resolve;
    });
    let cacheWrites: number = 0;
    const h: Harness = makeEngine({
      runtime: activeRuntimeV2(),
      hasPendingSync: (key: string): boolean => key === SYNC_LISTS,
      saveMatcherCache: (): Promise<void> => {
        cacheWrites += 1;
        if (cacheWrites !== 1) return Promise.resolve();
        signalFirstCacheStarted();
        return firstCacheBlocked;
      },
    });
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    const localUpdate: Promise<Ack> = h.engine.updateLists(localLists);
    await firstCacheStarted;
    const liveUpdate: Promise<Ack> = h.engine.applySyncedLists(liveLists);
    await Promise.resolve();

    expect(h.ports.saveMatcherCache).toHaveBeenCalledTimes(1);
    releaseFirstCache();
    await expect(localUpdate).resolves.toEqual({ ok: true });
    await expect(liveUpdate).resolves.toEqual({ ok: true });
    expect(h.ports.saveMatcherCache).toHaveBeenCalledTimes(2);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_LISTS, localLists);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_LISTS, liveLists);
    expect(h.ports.supersedeSync).not.toHaveBeenCalledWith(SYNC_LISTS, liveLists);
    expect(h.engine.getLists()).toEqual(liveLists);
    await expect(sessionBlocks(h, 'https://live.example/page')).resolves.toBe(true);
  });

  it('reconciles local Sync queued after a live event arrives during cache persistence', async () => {
    let releaseFirstCache: () => void = (): void => {};
    let signalFirstCacheStarted: () => void = (): void => {};
    const firstCacheBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirstCache = resolve;
    });
    const firstCacheStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFirstCacheStarted = resolve;
    });
    let cacheWrites: number = 0;
    const syncWrites: Array<Record<string, unknown>> = [];
    const writer: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        syncWrites.push(structuredClone(items));
      },
    );
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
      saveMatcherCache: (): Promise<void> => {
        cacheWrites += 1;
        if (cacheWrites !== 1) return Promise.resolve();
        signalFirstCacheStarted();
        return firstCacheBlocked;
      },
    });
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    const localUpdate: Promise<Ack> = h.engine.updateLists(localLists);
    await firstCacheStarted;
    expect(writer.hasPending(SYNC_LISTS)).toBe(false);
    const liveUpdate: Promise<Ack> = h.engine.applySyncedLists(liveLists, false);

    releaseFirstCache();
    await expect(localUpdate).resolves.toEqual({ ok: true });
    await expect(liveUpdate).resolves.toEqual({ ok: true });
    await writer.flushNow();

    expect(syncWrites).toHaveLength(1);
    expect(syncWrites[0]).toEqual(expect.objectContaining({ [SYNC_LISTS]: liveLists }));
    expect(h.engine.getLists()).toEqual(liveLists);
  });

  it('prevents stale journal replay after failed cleanup and later live lists', async () => {
    let durableJournal: SyncJournal = { sets: {}, removes: [] };
    let rejectCleanup: boolean = true;
    const syncWrites: Array<Record<string, unknown>> = [];
    const writer: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        syncWrites.push(structuredClone(items));
      },
      undefined,
      {
        initial: durableJournal,
        persist: async (journal: SyncJournal): Promise<void> => {
          if (Object.keys(journal.sets).length === 0 && rejectCleanup) {
            rejectCleanup = false;
            throw new Error('cleanup unavailable');
          }
          durableJournal = structuredClone(journal);
        },
      },
    );
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
      persistSyncJournal: (): Promise<void> => writer.whenJournalDurable(),
    });
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    await expect(h.engine.updateLists(localLists)).resolves.toEqual({ ok: true });
    await expect(writer.flushNow()).rejects.toThrow('cleanup unavailable');

    expect(syncWrites).toEqual([expect.objectContaining({ [SYNC_LISTS]: localLists })]);
    expect(writer.hasPending(SYNC_LISTS)).toBe(true);
    expect(durableJournal.sets[SYNC_LISTS]).toEqual(localLists);

    await expect(h.engine.applySyncedLists(liveLists)).resolves.toEqual({ ok: true });

    expect(durableJournal.sets[SYNC_LISTS]).toEqual(liveLists);
    const replayWrites: Array<Record<string, unknown>> = [];
    const restarted: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        replayWrites.push(structuredClone(items));
      },
      undefined,
      {
        initial: durableJournal,
        persist: vi.fn().mockResolvedValue(undefined),
      },
    );
    await restarted.flushNow();
    expect(replayWrites).toEqual([expect.objectContaining({ [SYNC_LISTS]: liveLists })]);

    await writer.flushNow();
    expect(syncWrites).toEqual([
      expect.objectContaining({ [SYNC_LISTS]: localLists }),
      expect.objectContaining({ [SYNC_LISTS]: liveLists }),
    ]);
    expect(durableJournal).toEqual({ sets: {}, removes: [] });
  });

  it('keeps later live lists after a same-value event and pending local flush', async () => {
    const syncWrites: Array<Record<string, unknown>> = [];
    const writer: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        syncWrites.push(structuredClone(items));
      },
    );
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
      runtime: activeRuntimeV2(),
    });
    await writer.flushNow();
    syncWrites.length = 0;
    clearMutationPorts(h.ports);
    let releaseBlocking: () => void = (): void => {};
    let signalBlockingStarted: () => void = (): void => {};
    const blockingBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseBlocking = resolve;
    });
    const blockingStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalBlockingStarted = resolve;
    });
    h.ports.applyBlocking.mockImplementationOnce((): Promise<void> => {
      signalBlockingStarted();
      return blockingBlocked;
    });
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    const localUpdate: Promise<Ack> = h.engine.updateLists(localLists);
    await blockingStarted;
    const matchingLiveUpdate: Promise<Ack> = h.engine.applySyncedLists(localLists);
    const liveUpdate: Promise<Ack> = h.engine.applySyncedLists(liveLists);
    await writer.flushNow();
    expect(syncWrites).toHaveLength(1);
    expect(syncWrites[0]).toEqual(expect.objectContaining({ [SYNC_LISTS]: localLists }));
    expect(writer.hasPending(SYNC_LISTS)).toBe(false);

    releaseBlocking();
    await expect(localUpdate).resolves.toEqual({ ok: true });
    await expect(matchingLiveUpdate).resolves.toEqual({ ok: true });
    await expect(liveUpdate).resolves.toEqual({ ok: true });
    await writer.flushNow();

    expect(syncWrites).toHaveLength(2);
    expect(syncWrites[1]).toEqual(expect.objectContaining({ [SYNC_LISTS]: liveLists }));
    expect(h.engine.getLists()).toEqual(liveLists);
  });

  it('serializes list encoding and mutations in invocation order', async () => {
    const syncWrites: Array<Record<string, unknown>> = [];
    const writer: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        syncWrites.push(structuredClone(items));
      },
    );
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
    });
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };
    let releaseFirstDigest: () => void = (): void => {};
    const firstDigestBlocked: Promise<ArrayBuffer> = new Promise(
      (resolve: (value: ArrayBuffer) => void): void => {
        releaseFirstDigest = (): void => resolve(new ArrayBuffer(32));
      },
    );
    let signalFirstDigestStarted: () => void = (): void => {};
    const firstDigestStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFirstDigestStarted = resolve;
    });
    let digestCalls: number = 0;
    const digestSpy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockImplementation((): Promise<ArrayBuffer> => {
        digestCalls += 1;
        if (digestCalls === 1) signalFirstDigestStarted();
        return digestCalls === 1 ? firstDigestBlocked : Promise.resolve(new ArrayBuffer(32));
      });
    const listUpdates: Array<Promise<Ack>> = [];

    try {
      const localUpdate: Promise<Ack> = h.engine.updateLists(localLists);
      const matchingLiveUpdate: Promise<Ack> = h.engine.applySyncedLists(localLists);
      const liveUpdate: Promise<Ack> = h.engine.applySyncedLists(liveLists);
      listUpdates.push(localUpdate, matchingLiveUpdate, liveUpdate);
      await firstDigestStarted;

      expect(digestCalls).toBe(1);
      releaseFirstDigest();

      await expect(Promise.all(listUpdates)).resolves.toEqual([
        { ok: true },
        { ok: true },
        { ok: true },
      ]);
    } finally {
      releaseFirstDigest();
      await Promise.allSettled(listUpdates);
      digestSpy.mockRestore();
    }

    await writer.flushNow();

    expect(
      h.ports.saveMatcherCache.mock.calls.map(
        (call: unknown[]): ListsConfig => call[1] as ListsConfig,
      ),
    ).toEqual([localLists, localLists, liveLists]);
    expect(syncWrites).toEqual([expect.objectContaining({ [SYNC_LISTS]: liveLists })]);
    expect(h.engine.getLists()).toEqual(liveLists);
  });

  it('does not rewrite the matcher cache when hard-session guards reject local or live lists', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2({ config: hardConfigV2() }) });
    clearMutationPorts(h.ports);
    const weaker: ListsConfig = { ...DEFAULT_LISTS, custom: [] };

    await expect(h.engine.updateLists(weaker)).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(h.engine.applySyncedLists(weaker)).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );

    expect(h.ports.saveMatcherCache).not.toHaveBeenCalled();
    expect(h.engine.getLists()).toEqual({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    });
    expect(frozenVerdict(h, 'https://facebook.com/feed').blocked).toBe(true);
  });

  it('rejects oversized settings before time-advanced catch-up mutates state or queues writes', async () => {
    const h: Harness = makeEngine();
    const before: SessionSnapshot = h.engine.snapshot();
    await h.engine.snapshotPersisted();
    clearMutationPorts(h.ports);
    h.setNow(T0 + 60_000);

    await expect(h.engine.updateSettings(oversizedSettings())).resolves.toEqual({
      ok: false,
      error: t('notify_settings_sync_limit'),
    });

    expect(h.ports.now).not.toHaveBeenCalled();
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
    expect(h.ports.appendEvents).not.toHaveBeenCalled();
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
    h.setNow(T0);
    expect(h.engine.snapshot()).toEqual(before);
  });

  it('rejects oversized lists before a schedule boundary starts a session or compiles its matcher', async () => {
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    const before: SessionSnapshot = h.engine.snapshot();
    await h.engine.snapshotPersisted();
    clearMutationPorts(h.ports);
    h.setNow(T0 + 60_000);
    const oversized: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('scheduled'),
    };

    await expect(h.engine.updateLists(oversized)).resolves.toEqual({
      ok: false,
      error: t('notify_lists_sync_limit'),
    });

    expect(h.ports.now).not.toHaveBeenCalled();
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
    expect(h.ports.appendEvents).not.toHaveBeenCalled();
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
    expect(h.engine.getLists()).toEqual({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    });
    h.setNow(T0);
    expect(h.engine.snapshot()).toEqual(before);
  });

  it('reports the quota error before hard-session settings weakening policy', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2({ config: hardConfigV2() }) });
    await h.engine.snapshotPersisted();
    clearMutationPorts(h.ports);
    const oversized: Settings = oversizedSettings({
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    });

    await expect(h.engine.updateSettings(oversized)).resolves.toEqual({
      ok: false,
      error: t('notify_settings_sync_limit'),
    });

    expect(h.engine.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(h.ports.now).not.toHaveBeenCalled();
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('reports the quota error before hard-session list weakening policy', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2({ config: hardConfigV2() }) });
    const before = frozenVerdict(h, 'https://facebook.com/feed');
    await h.engine.snapshotPersisted();
    clearMutationPorts(h.ports);
    const oversized: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('replacement'),
    };

    await expect(h.engine.updateLists(oversized)).resolves.toEqual({
      ok: false,
      error: t('notify_lists_sync_limit'),
    });

    expect(h.engine.getLists()).toEqual({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    });
    expect(h.ports.now).not.toHaveBeenCalled();
    expect(frozenVerdict(h, 'https://facebook.com/feed')).toEqual(before);
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('persists attempts discovered by the blocking sweep without commit deadlock', async () => {
    const h: Harness = makeEngine();
    let attemptWasDurableBeforeSweepContinued = false;
    let signalSweepAttempt: () => void = (): void => {
      throw new Error('blocking sweep attempt signal was not initialized');
    };
    const sweepAttemptStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSweepAttempt = resolve;
    });
    h.ports.applyBlocking.mockImplementation(async (lease: BlockingSweepLease): Promise<void> => {
      signalSweepAttempt();
      await h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing', lease);
      attemptWasDurableBeforeSweepContinued = h
        .loggedEvents()
        .some((event: EventRecord): boolean => event.t === 'attempt');
    });
    const sweeping: Promise<void> = h.engine.applyBlockingNow();
    await sweepAttemptStarted;

    await expect(sweeping).resolves.toBeUndefined();
    expect(h.loggedEvents().some((event: EventRecord): boolean => event.t === 'attempt')).toBe(
      true,
    );
    expect(attemptWasDurableBeforeSweepContinued).toBe(true);
  });

  it('awaits pending event persistence before answering an async snapshot request', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2() });
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockClear();
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    const recording: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalled());
    const reading: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    let resolved = false;
    void reading.then((): void => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseEvents();
    expect((await reading).phase).toBe('focus');
    await recording;
  });

  it('rolls the local day and runs retention pruning at most weekly', async () => {
    const h: Harness = makeEngine();
    h.setNow(T0 + DAY_MS);

    // The controller walks a wake's missed days; the Engine still credits each one.
    await creditWakeDays(h);
    await h.engine.tick();

    expect(h.ports.queueSync).toHaveBeenCalledWith(
      `agg:dev-test:${localDateStr(T0)}`,
      expect.objectContaining({ date: localDateStr(T0) }),
    );
    expect(h.ports.prune).toHaveBeenCalledOnce();
    expect(h.ports.prune).toHaveBeenCalledWith(DEFAULT_SETTINGS.retentionDays, T0 + DAY_MS);

    h.setNow(T0 + 2 * DAY_MS);
    // The controller walks a wake's missed days; the Engine still credits each one.
    await creditWakeDays(h);
    await h.engine.tick();

    expect(h.ports.prune).toHaveBeenCalledOnce();
    const savedRuntime: RuntimeStateV2 = h.ports.saveRuntime.mock.calls.at(
      -1,
    )?.[0] as RuntimeStateV2;
    expect(savedRuntime.date).toBe(localDateStr(T0 + 2 * DAY_MS));
  });

  it('retains a finished aggregate checkpoint until local durability succeeds', async (): Promise<void> => {
    const saveAggregate = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockRejectedValueOnce(new Error('local aggregate unavailable'));
    const first: Harness = makeEngine({ saveAggregate });
    first.setNow(T0 + DAY_MS);

    // The day the wake finished is credited by the Engine, and that credit is what fails here.
    await expect(creditWakeDays(first)).rejects.toThrow('local aggregate unavailable');

    const checkpointRuntime: RuntimeStateV2 = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeStateV2,
    );
    const finishedKey: string = `agg:dev-test:${localDateStr(T0)}`;
    expect(checkpointRuntime.commitCheckpoint?.aggregateSets).toMatchObject({
      [finishedKey]: expect.objectContaining({ date: localDateStr(T0) }),
    });

    const recoveredSave = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockResolvedValue(undefined);
    const restarted: Harness = makeEngine({
      runtime: checkpointRuntime,
      saveAggregate: recoveredSave,
    });
    restarted.setNow(T0 + DAY_MS);
    // The controller walks a wake's missed days; the Engine still credits each one.
    await creditWakeDays(restarted);
    await restarted.engine.tick();

    expect(recoveredSave).toHaveBeenCalledWith(
      finishedKey,
      expect.objectContaining({ date: localDateStr(T0) }),
    );
    const recoveredRuntime: RuntimeStateV2 = restarted.ports.saveRuntime.mock.calls.at(-1)?.[0];
    expect(recoveredRuntime.commitCheckpoint).toBeNull();
  });

  it('caps rollover and recovered checkpoint aggregates before durability', async (): Promise<void> => {
    const date: string = localDateStr(T0);
    const runtime: RuntimeStateV2 = {
      ...emptyRuntimeV2Fixture(T0),
      todayAgg: highCardinalityDaily(date, 30),
    };
    const firstSave = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockResolvedValue(undefined);
    const first: Harness = makeEngine({ runtime, saveAggregate: firstSave });
    first.setNow(T0 + DAY_MS);

    await first.engine.tick();

    const rollover = firstSave.mock.calls.find(
      ([key]: [string, DailyAgg]): boolean => key === syncAggKey('dev-test', date),
    )?.[1];
    expect(Object.keys(rollover?.attempts ?? {})).toHaveLength(TOP_SITES_DAILY);
    expect(rollover?.attemptsOther).toBe(55);

    const recoveredBase: RuntimeStateV2 = emptyRuntimeV2Fixture(T0 + DAY_MS);
    const recoveredRuntime: RuntimeStateV2 = {
      ...recoveredBase,
      commitCheckpoint: {
        version: 2,
        checkpointId: `${recoveredBase.enforcementEpoch}:engine-1`,
        projection: projectRuntimeDomainV2(recoveredBase),
        bank: { balanceMs: 0 },
        events: [],
        syncBank: false,
        aggregateSets: {
          [syncAggKey('dev-test', date)]: highCardinalityDaily(date, 30),
        },
        aggregateRemoves: [],
      },
    };
    const recoveredSave = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockResolvedValue(undefined);
    const restarted: Harness = makeEngine({
      runtime: recoveredRuntime,
      saveAggregate: recoveredSave,
    });
    restarted.setNow(T0 + DAY_MS);

    await restarted.engine.tick();

    const recovered = recoveredSave.mock.calls.find(
      ([key]: [string, DailyAgg]): boolean => key === syncAggKey('dev-test', date),
    )?.[1];
    expect(Object.keys(recovered?.attempts ?? {})).toHaveLength(TOP_SITES_DAILY);
    expect(recovered?.attemptsOther).toBe(55);
  });

  it('drains aggregate commits before entering a storage-mode transition', async (): Promise<void> => {
    let releaseSave: () => void = (): void => {
      throw new Error('aggregate save did not start');
    };
    const saveStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseSave = resolve;
    });
    let unblockSave: () => void = (): void => {
      throw new Error('aggregate save release was not initialized');
    };
    let saveCalls: number = 0;
    const h: Harness = makeEngine({
      saveAggregate: async (): Promise<void> => {
        saveCalls += 1;
        if (saveCalls > 1) return;
        releaseSave();
        await new Promise<void>((resolve: () => void): void => {
          unblockSave = resolve;
        });
      },
    });
    h.setNow(T0 + DAY_MS);
    const ticking: Promise<void> = creditWakeDays(h);
    await saveStarted;
    let entered: boolean = false;

    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        entered = true;
        await expect(h.engine.startSession(manualConfig)).rejects.toThrow('storage transition');
      },
    );
    await Promise.resolve();
    expect(entered).toBe(false);

    unblockSave();
    await Promise.all([ticking, transitioning]);

    expect(entered).toBe(true);
    const savedRuntime: RuntimeStateV2 = h.ports.saveRuntime.mock.calls.at(-1)?.[0];
    expect(savedRuntime.commitCheckpoint).toBeNull();
  });

  it('does not grant a freeze token during off-Monday rollover catch-up', async () => {
    const previousDate: string = localDateStr(T0 - DAY_MS);
    const streak: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: previousDate,
      lastFreezeGrantDate: previousDate,
      activeDays: [],
      activeMonth: previousDate.slice(0, 7),
    };
    const h: Harness = makeEngine({
      settings: { streakFreezeIntervalDays: 1 },
      streak,
    });
    h.setNow(T0 + DAY_MS);

    // The controller walks a wake's missed days; the Engine still credits each one.
    await creditWakeDays(h);
    await h.engine.tick();

    expect(h.engine.getStreak()).toMatchObject({
      current: 0,
      freezeTokens: 0,
      lastFreezeGrantDate: previousDate,
    });
  });

  it('grants and spends Monday exactly once after a Sunday-to-Tuesday wake', async () => {
    const sundayAtNoon: number = new Date(2026, 7, 30, 12, 0).getTime();
    const monday: string = '2026-08-31';
    const runtime: RuntimeStateV2 = emptyRuntimeV2Fixture(sundayAtNoon);
    runtime.todayAgg = {
      date: '2026-08-30',
      focusMs: 30 * 60_000,
      sessionsStarted: 1,
      sessionsCompleted: 1,
      attempts: {},
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      pauseMsEarned: 0,
      unlocksTaken: 0,
      unlockMsSpent: 0,
      resisted: 0,
    };
    const h: Harness = makeEngine({ runtime });
    h.setNow(new Date(2026, 8, 1, 12, 0).getTime());

    // The controller walks a wake's missed days; the Engine still credits each one.
    await creditWakeDays(h);
    await h.engine.tick();

    expect(h.engine.getStreak()).toMatchObject({
      current: 1,
      freezeTokens: 0,
      lastCountedDate: monday,
      lastFreezeGrantDate: monday,
    });
    // The walk opens a day and closes it again, so one key is written twice with the same value.
    // A second, different credit for the same day is what catch-up must never produce.
    const mondayWrites: string[] = h.ports.queueSync.mock.calls
      .filter((call: unknown[]): boolean => call[0] === `agg:dev-test:${monday}`)
      .map((call: unknown[]): string => JSON.stringify(call[1]));
    expect(mondayWrites.length).toBeGreaterThan(0);
    expect(new Set<string>(mondayWrites).size).toBe(1);
  });

  it('applies custom Monday cadence and token cap during multi-week catch-up', async () => {
    const sundayAtNoon: number = new Date(2026, 7, 23, 12, 0).getTime();
    const runtime: RuntimeStateV2 = emptyRuntimeV2Fixture(sundayAtNoon);
    runtime.todayAgg = {
      date: '2026-08-23',
      focusMs: 30 * 60_000,
      sessionsStarted: 1,
      sessionsCompleted: 1,
      attempts: {},
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      pauseMsEarned: 0,
      unlocksTaken: 0,
      unlockMsSpent: 0,
      resisted: 0,
    };
    const streak: StreakState = {
      current: 5,
      freezeTokens: 2,
      lastCountedDate: '2026-08-22',
      lastFreezeGrantDate: '2026-08-10',
      activeDays: [18, 19, 20, 21, 22],
      activeMonth: '2026-08',
    };
    const h: Harness = makeEngine({
      runtime,
      streak,
      settings: { streakFreezeIntervalDays: 14 },
    });
    h.setNow(new Date(2026, 8, 15, 12, 0).getTime());

    // The controller walks a wake's missed days; the Engine still credits each one.
    await creditWakeDays(h);
    await h.engine.tick();

    expect(h.engine.getStreak()).toMatchObject({
      current: 0,
      freezeTokens: 0,
      lastCountedDate: '2026-09-14',
      lastFreezeGrantDate: '2026-09-07',
    });
    expect(h.ports.queueSync).toHaveBeenCalledWith(
      SYNC_STREAK,
      expect.objectContaining({
        current: 0,
        freezeTokens: 0,
        lastFreezeGrantDate: '2026-09-07',
      }),
    );
    // Each walked day is written as it opens and again as it closes, always with the same value.
    // A differing second write would mean the catch-up credited that Monday twice.
    for (const monday of ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14']) {
      const writes: string[] = h.ports.queueSync.mock.calls
        .filter((call: unknown[]): boolean => call[0] === `agg:dev-test:${monday}`)
        .map((call: unknown[]): string => JSON.stringify(call[1]));
      expect(writes.length).toBeGreaterThan(0);
      expect(new Set<string>(writes).size).toBe(1);
    }
  });

  it('marks retention pruning only after storage operations succeed', async () => {
    const h: Harness = makeEngine();
    h.ports.prune.mockRejectedValueOnce(new Error('sync remove failed'));

    await h.engine.tick();
    const failedRuntime: RuntimeStateV2 = h.ports.saveRuntime.mock.calls.at(
      -1,
    )?.[0] as RuntimeStateV2;
    expect(failedRuntime.lastPruneDate).toBeNull();
    expect(h.ports.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'sync remove failed',
      }),
    );
    h.ports.prune.mockResolvedValueOnce(undefined);
    await h.engine.tick();

    const savedRuntime: RuntimeStateV2 = h.ports.saveRuntime.mock.calls.at(
      -1,
    )?.[0] as RuntimeStateV2;
    expect(savedRuntime.lastPruneDate).toBe(localDateStr(T0));
    expect(h.ports.prune).toHaveBeenCalledTimes(2);
  });

  it('does not lose a cross-queue attempt when event-log writes finish out of order', async () => {
    const h: Harness = makeEngine();
    h.ports.appendEvents.mockReset();
    h.ports.appendEvents.mockImplementation(appendEventsV2);
    h.ports.saveRuntime.mockClear();

    const localState: Record<string, unknown> = { [LOCAL_EVENTS]: [] };
    let releaseFirstSet: () => void = (): void => {
      throw new Error('first event-log write did not start');
    };
    let signalFirstSet: () => void = (): void => {
      throw new Error('first event-log signal was not initialized');
    };
    const firstSetStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalFirstSet = resolve;
    });
    let signalSecondSet: () => void = (): void => {
      throw new Error('second event-log signal was not initialized');
    };
    const secondSetCompleted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalSecondSet = resolve;
    });
    const getLocal = vi.fn(
      async (): Promise<Record<string, unknown>> => structuredClone(localState),
    );
    let setCalls: number = 0;
    const setLocal = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      setCalls += 1;
      if (setCalls === 1) {
        signalFirstSet();
        await new Promise<void>((resolve: () => void): void => {
          releaseFirstSet = resolve;
        });
        Object.assign(localState, structuredClone(items));
        return;
      }
      Object.assign(localState, structuredClone(items));
      signalSecondSet();
    });
    vi.stubGlobal('chrome', { storage: { local: { get: getLocal, set: setLocal } } });

    const sweepLease: BlockingSweepLease = {} as BlockingSweepLease;
    const activeLeases: Set<BlockingSweepLease> = Reflect.get(
      h.engine,
      'activeRuntimeMutationLeases',
    ) as Set<BlockingSweepLease>;
    activeLeases.add(sweepLease);
    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/first',
      7,
      'existing',
      sweepLease,
    );
    await firstSetStarted;

    activeLeases.delete(sweepLease);
    const second: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/second',
      8,
      'navigation',
    );
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(2));

    if (getLocal.mock.calls.length === 2) await secondSetCompleted;
    releaseFirstSet();
    await Promise.all([first, second]);

    const attempts: EventRecord[] = (await readEventsV2()).filter(
      (event: EventRecord): boolean => event.t === 'attempt',
    );
    expect(attempts.map((event: EventRecord): string => ('url' in event ? event.url : ''))).toEqual(
      ['https://facebook.com/first', 'https://facebook.com/second'],
    );
    const storedRuntime: RuntimeStateV2 = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeStateV2,
    );
    expect(storedRuntime.commitCheckpoint).toBeNull();
    const restarted: Harness = makeEngine({ runtime: storedRuntime });
    expect(restarted.engine.snapshot().attemptsToday).toBe(2);
  });

  it('keeps cross-queue attempt revisions when the first event append is blocked', async () => {
    const h: Harness = makeEngine();
    h.ports.appendEvents.mockClear();
    const durableEvents: EventRecord[] = [];
    let releaseFirstAppend: () => void = (): void => {
      throw new Error('first append did not start');
    };
    let signalSecondAppend: () => void = (): void => {
      throw new Error('second append signal was not initialized');
    };
    const secondAppendStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalSecondAppend = resolve;
    });
    h.ports.appendEvents.mockImplementationOnce(async (events: EventRecord[]): Promise<void> => {
      await new Promise<void>((resolve: () => void): void => {
        releaseFirstAppend = resolve;
      });
      appendUnique(durableEvents, events);
    });
    h.ports.appendEvents.mockImplementation(async (events: EventRecord[]): Promise<void> => {
      signalSecondAppend();
      appendUnique(durableEvents, events);
    });

    const sweepLease: BlockingSweepLease = {} as BlockingSweepLease;
    const activeLeases: Set<BlockingSweepLease> = Reflect.get(
      h.engine,
      'activeRuntimeMutationLeases',
    ) as Set<BlockingSweepLease>;
    activeLeases.add(sweepLease);
    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/first',
      7,
      'existing',
      sweepLease,
    );
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));

    activeLeases.delete(sweepLease);
    const second: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/second',
      8,
      'navigation',
    );
    const firstQueueResult: 'first-completed' | 'second-started' = await Promise.race([
      first.then((): 'first-completed' => 'first-completed'),
      secondAppendStarted.then((): 'second-started' => 'second-started'),
    ]);
    expect(firstQueueResult).toBe('second-started');
    releaseFirstAppend();
    await Promise.all([first, second]);

    expect(
      durableEvents.filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toHaveLength(2);
    const storedRuntime: RuntimeStateV2 = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeStateV2,
    );
    const restarted: Harness = makeEngine({ runtime: storedRuntime });
    expect(restarted.engine.snapshot().attemptsToday).toBe(2);
  });

  it('does not overwrite a durable tab mutation when checkpoint cleanup finishes', async () => {
    const h: Harness = makeEngine();
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    const recording: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));
    await h.engine.markStopped(7, 'https://facebook.com/feed', 'durable-document');
    releaseEvents();
    await recording;

    const storedRuntime: RuntimeStateV2 = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeStateV2,
    );
    // The write that retires the checkpoint composes the current runtime, so it carries the tab
    // the stop claimed while it was in flight and leaves nothing to replay.
    expect(storedRuntime).toMatchObject({
      tabStates: { 7: { stoppedDocumentId: 'durable-document' } },
      commitCheckpoint: null,
    });
    const restarted: Harness = makeEngine({ runtime: storedRuntime });
    expect(
      restarted.engine.tabFacts(7, 'https://facebook.com/feed', 'durable-document').wasStopped,
    ).toBe(true);
  });

  it('does not restore bank data from a checkpoint that does not own a bank write', async () => {
    const runtime: RuntimeStateV2 = emptyRuntimeV2Fixture(T0);
    runtime.commitCheckpoint = {
      version: 2,
      checkpointId: `${runtime.enforcementEpoch}:engine-1`,
      projection: projectRuntimeDomainV2(runtime),
      bank: { balanceMs: 100 },
      events: [],
      syncBank: false,
      aggregateSets: {},
      aggregateRemoves: [],
    };

    const h: Harness = makeEngine({ bankMs: 900, runtime });
    expect(h.engine.snapshot().bankMs).toBe(900);
    await h.engine.snapshotPersisted();
    expect(h.engine.snapshot().bankMs).toBe(900);
  });

  it('does not regress a newer synced streak while replaying stale runtime dates', async (): Promise<void> => {
    const staleRuntime: RuntimeStateV2 = emptyRuntimeV2Fixture(
      new Date(2026, 7, 20, 12, 0).getTime(),
    );
    const syncedStreak: StreakState = {
      current: 12,
      freezeTokens: 2,
      lastCountedDate: '2026-08-27',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [23, 24, 25, 26, 27],
      activeMonth: '2026-08',
    };
    const h: Harness = makeEngine({ runtime: staleRuntime, streak: syncedStreak });
    h.setNow(new Date(2026, 7, 28, 12, 0).getTime());

    await h.engine.tick();

    expect(h.engine.getStreak()).toEqual(syncedStreak);
  });

  // The backward-date rebase has no caller after the cutover: `planBackwardDateRebase` and
  // `clockRebaseArchiveKey` are unreferenced, and `rolloverCheck` credits a future day instead of
  // quarantining it. The assertions are kept whole for whoever gives that rule an owner again.
  // See task-1-piece-A-report.md.
  it('quarantines a future local aggregate and removes its daily key', async () => {
    const runtime: RuntimeStateV2 = emptyRuntimeV2Fixture(T0);
    const futureDate: string = localDateStr(T0 + 3 * DAY_MS);
    const futureAgg: DailyAgg = {
      date: futureDate,
      focusMs: 60_000,
      sessionsStarted: 1,
      sessionsCompleted: 0,
      attempts: { 'x.com': 2 },
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      pauseMsEarned: 0,
      unlocksTaken: 0,
      unlockMsSpent: 0,
      resisted: 0,
    };
    runtime.date = futureDate;
    runtime.todayAgg = futureAgg;
    const futureStreak: StreakState = {
      current: 2,
      freezeTokens: 1,
      lastCountedDate: futureDate,
      lastFreezeGrantDate: null,
      activeDays: [1, 2],
      activeMonth: futureDate.slice(0, 7),
    };
    const h: Harness = makeEngine({ runtime, streak: futureStreak });

    // The controller walks a wake's missed days; the Engine still credits each one.
    await creditWakeDays(h);
    await h.engine.tick();
    const overlay = h.engine.statsOverlay();

    expect(overlay.todayAgg.date).toBe(localDateStr(T0));
    expect(overlay.todayAgg.focusMs).toBe(0);
    expect(h.ports.removeSync).toHaveBeenCalledWith(`agg:dev-test:${futureDate}`);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(
      `agg:dev-test:${futureDate}`,
      expect.anything(),
    );
    expect(h.ports.queueSync).toHaveBeenCalledWith(
      clockRebaseArchiveKey('dev-test', futureDate, T0, mintedId(h)),
      futureAgg,
    );
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(
      `agg:dev-test:${localDateStr(T0)}`,
      expect.anything(),
    );
    expect(h.ports.queueSync).toHaveBeenCalledWith('streak', {
      ...futureStreak,
      current: 0,
      lastCountedDate: null,
      activeDays: [],
      activeMonth: localDateStr(T0).slice(0, 7),
    });
  });

  // The backward-date rebase has no caller after the cutover: `planBackwardDateRebase` and
  // `clockRebaseArchiveKey` are unreferenced, and `rolloverCheck` credits a future day instead of
  // quarantining it. The assertions are kept whole for whoever gives that rule an owner again.
  // See task-1-piece-A-report.md.
  it('makes a backward-date archive durable before removing the future daily', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = emptyRuntimeV2Fixture(T0);
    const futureDate: string = localDateStr(T0 + 3 * DAY_MS);
    runtime.date = futureDate;
    runtime.todayAgg = {
      date: futureDate,
      focusMs: 60_000,
      sessionsStarted: 1,
      sessionsCompleted: 0,
      attempts: {},
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      pauseMsEarned: 0,
      unlocksTaken: 0,
      unlockMsSpent: 0,
      resisted: 0,
    };
    const trace: string[] = [];
    const h: Harness = makeEngine({
      runtime,
      saveAggregate: async (key: string): Promise<void> => {
        trace.push(`set:${key}`);
      },
      removeAggregate: async (key: string): Promise<void> => {
        trace.push(`remove:${key}`);
      },
    });

    // The controller walks a wake's missed days; the Engine still credits each one.
    await creditWakeDays(h);
    await h.engine.tick();

    expect(trace).toEqual([
      `set:${clockRebaseArchiveKey('dev-test', futureDate, T0, mintedId(h))}`,
      `remove:${syncAggKey('dev-test', futureDate)}`,
    ]);
  });

  // The backward-date rebase has no caller after the cutover: `planBackwardDateRebase` and
  // `clockRebaseArchiveKey` are unreferenced, and `rolloverCheck` credits a future day instead of
  // quarantining it. The assertions are kept whole for whoever gives that rule an owner again.
  // See task-1-piece-A-report.md.
  it('caps a backward-date archive before checkpoint and storage persistence', async (): Promise<void> => {
    const futureDate: string = localDateStr(T0 + 3 * DAY_MS);
    const runtime: RuntimeStateV2 = {
      ...emptyRuntimeV2Fixture(T0),
      date: futureDate,
      todayAgg: highCardinalityDaily(futureDate, 30),
    };
    const saveAggregate = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockRejectedValue(new Error('archive persistence interrupted'));
    const h: Harness = makeEngine({ runtime, saveAggregate });

    // The controller hands a future date one backward call, which is where the archive is written.
    await expect(creditWakeDays(h)).rejects.toThrow('archive persistence interrupted');

    const archive = saveAggregate.mock.calls.find(([key]: [string, DailyAgg]): boolean =>
      key.startsWith('archive:clock-rebase:'),
    )?.[1];
    expect(Object.keys(archive?.attempts ?? {})).toHaveLength(TOP_SITES_DAILY);
    expect(archive?.attemptsOther).toBe(55);
    const checkpointRuntime = h.ports.saveRuntime.mock.calls.find(
      (call: unknown[]): boolean => (call[0] as RuntimeStateV2).commitCheckpoint !== null,
    )?.[0] as RuntimeStateV2;
    const checkpointArchive: DailyAgg | undefined = Object.values(
      checkpointRuntime.commitCheckpoint?.aggregateSets ?? {},
    ).find((candidate: DailyAgg): boolean => candidate.date === futureDate);
    expect(Object.keys(checkpointArchive?.attempts ?? {})).toHaveLength(TOP_SITES_DAILY);
    expect(checkpointArchive?.attemptsOther).toBe(55);
  });

  // The backward-date rebase has no caller after the cutover: `planBackwardDateRebase` and
  // `clockRebaseArchiveKey` are unreferenced, and `rolloverCheck` credits a future day instead of
  // quarantining it. The assertions are kept whole for whoever gives that rule an owner again.
  // See task-1-piece-A-report.md.
  it('clears future streak markers during a same-month clock rebase', async () => {
    const runtime: RuntimeStateV2 = emptyRuntimeV2Fixture(T0);
    const futureDate: string = localDateStr(T0 + DAY_MS);
    runtime.date = futureDate;
    const futureStreak: StreakState = {
      current: 3,
      freezeTokens: 1,
      lastCountedDate: futureDate,
      lastFreezeGrantDate: futureDate,
      activeDays: [28, 30],
      activeMonth: futureDate.slice(0, 7),
    };
    const h: Harness = makeEngine({ runtime, streak: futureStreak });

    // The controller walks a wake's missed days; the Engine still credits each one.
    await creditWakeDays(h);
    await h.engine.tick();

    expect(h.engine.getStreak()).toEqual({
      ...futureStreak,
      current: 0,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [28],
    });
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_STREAK, h.engine.getStreak());
  });

  it('persists a theme update and reapplies blocking to mounted overlays', async () => {
    const h: Harness = makeEngine();
    h.ports.applyBlocking.mockClear();

    await expect(h.engine.updateTheme('dark')).resolves.toEqual({ ok: true });

    expect(h.engine.getSettings().theme).toBe('dark');
    expect(h.engine.snapshot().theme).toBe('dark');
    expect(h.ports.queueSync).toHaveBeenCalledWith(
      SYNC_SETTINGS,
      expect.objectContaining({ theme: 'dark' }),
    );
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(1);

    h.ports.applyBlocking.mockClear();
    await expect(h.engine.updateTheme('dark')).resolves.toEqual({ ok: true });
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
  });

  it('reapplies blocking only when a full settings update changes the theme', async () => {
    const h: Harness = makeEngine();
    h.ports.applyBlocking.mockClear();

    await expect(h.engine.updateSettings({ ...DEFAULT_SETTINGS, theme: 'dark' })).resolves.toEqual({
      ok: true,
    });
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(1);

    h.ports.applyBlocking.mockClear();
    await expect(
      h.engine.updateSettings({ ...DEFAULT_SETTINGS, theme: 'dark', retentionDays: 30 }),
    ).resolves.toEqual({ ok: true });
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
  });

  it('recordAttempt debounces the same tab and url within 30 s', async () => {
    const h: Harness = makeEngine();
    await h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation');
    await h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation');
    const attempts: EventRecord[] = h
      .loggedEvents()
      .filter((e: EventRecord): boolean => e.t === 'attempt');
    expect(attempts).toHaveLength(1);
    expect(h.engine.snapshot().attemptsToday).toBe(1);
  });

  it('keeps a debounced caller behind the matching in-flight attempt persistence', async () => {
    const h: Harness = makeEngine();
    let releasePersistence: () => void = (): void => {
      throw new Error('attempt persistence did not start');
    };
    let signalPersistence: () => void = (): void => {
      throw new Error('attempt persistence signal was not initialized');
    };
    const persistenceStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalPersistence = resolve;
    });
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releasePersistence = resolve;
          signalPersistence();
        }),
    );

    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await persistenceStarted;
    let secondResolved = false;
    const second: Promise<void> = h.engine
      .recordAttempt('https://facebook.com/feed', 7, 'existing')
      .then((): void => {
        secondResolved = true;
      });
    await Promise.resolve();

    expect(secondResolved).toBe(false);
    releasePersistence();
    await Promise.all([first, second]);
  });

  it('does not strand overlapping same-key persistence after the debounce window', async () => {
    const h: Harness = makeEngine();
    let releasePersistence: () => void = (): void => {
      throw new Error('attempt persistence did not start');
    };
    let signalPersistence: () => void = (): void => {
      throw new Error('attempt persistence signal was not initialized');
    };
    const persistenceStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalPersistence = resolve;
    });
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releasePersistence = resolve;
          signalPersistence();
        }),
    );

    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await persistenceStarted;
    h.setNow(T0 + 31_000);
    const second: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'existing',
    );
    releasePersistence();

    await Promise.all([first, second]);
  });

  it('reports a commit rejection once after attempt persistence becomes durable', async () => {
    const h: Harness = makeEngine();
    const applyError = new Error('blocking sweep failed after persistence');
    let rejectApply: (error: unknown) => void = (): void => {
      throw new Error('apply rejection was not initialized');
    };
    let signalApplyStarted: () => void = (): void => {
      throw new Error('apply start signal was not initialized');
    };
    const applyStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalApplyStarted = resolve;
    });
    h.ports.applyBlocking.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((_resolve: () => void, reject: (error: unknown) => void): void => {
          rejectApply = reject;
          signalApplyStarted();
        }),
    );
    Reflect.set(h.engine, 'needsBlocking', true);

    const attempt: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await applyStarted;
    await expect(attempt).resolves.toBeUndefined();

    rejectApply(applyError);
    await vi.waitFor((): void => {
      expect(h.ports.reportError).toHaveBeenCalledWith(applyError);
    });
    expect(h.ports.reportError).toHaveBeenCalledTimes(1);
  });

  it('retries failed same-key attempt persistence inside the debounce window', async () => {
    const h: Harness = makeEngine();
    h.ports.appendEvents.mockClear();
    h.ports.appendEvents.mockRejectedValueOnce(new Error('event storage unavailable'));

    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation'),
    ).rejects.toThrow('event storage unavailable');
    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing'),
    ).resolves.toBeUndefined();

    expect(h.ports.appendEvents).toHaveBeenCalledTimes(2);
    const retriedEvents: EventRecord[] = h.ports.appendEvents.mock.calls[1]?.[0] ?? [];
    expect(
      retriedEvents.filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toHaveLength(1);
    expect(h.engine.snapshot().attemptsToday).toBe(1);
  });

  it('counts a new same-key attempt after failed persistence debounce expires', async () => {
    const h: Harness = makeEngine();
    h.ports.appendEvents.mockClear();
    h.ports.appendEvents.mockRejectedValueOnce(new Error('event storage unavailable'));

    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation'),
    ).rejects.toThrow('event storage unavailable');
    h.setNow(T0 + 31_000);
    await h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing');

    expect(h.ports.appendEvents).toHaveBeenCalledTimes(2);
    const retriedEvents: EventRecord[] = h.ports.appendEvents.mock.calls[1]?.[0] ?? [];
    expect(
      retriedEvents.filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toHaveLength(2);
    expect(h.engine.snapshot().attemptsToday).toBe(2);
  });

  it('prunes absent tab records while preserving live restore state', async () => {
    const h: Harness = makeEngine();
    await h.engine.claimMute(7, 'https://kept.example', true);
    await h.engine.claimMute(8, 'https://missing.example', false);
    await h.engine.markStopped(7, 'https://kept.example', 'kept-document');
    await h.engine.markStopped(9, 'https://missing.example', 'missing-document');

    h.engine.reconcileTabs(
      new Map([
        [
          7,
          {
            url: 'https://kept.example',
            mutedByExtension: true,
            documentId: 'kept-document',
          },
        ],
      ]),
    );

    expect(h.engine.tabFacts(7, 'https://kept.example', 'kept-document')).toEqual({
      wasMutedByUs: true,
      priorMuted: true,
      wasStopped: true,
    });
    expect(h.engine.tabFacts(8, 'https://missing.example')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
    expect(h.engine.tabFacts(9, 'https://missing.example')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('persists mute ownership before resolving the claim and persists release', async () => {
    const h: Harness = makeEngine();
    let releaseSave: () => void = (): void => {};
    let signalSave: () => void = (): void => {};
    const saveBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseSave = resolve;
    });
    const saveStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSave = resolve;
    });
    h.ports.saveRuntime.mockImplementationOnce((runtime: RuntimeStateV2): Promise<void> => {
      expect(runtime.tabStates[7]).toEqual({
        muteUrl: 'https://blocked.example/page',
        priorMuted: false,
        stoppedDocumentId: null,
      });
      signalSave();
      return saveBlocked;
    });
    let claimed: boolean = false;

    const pendingClaim: Promise<void> = h.engine
      .claimMute(7, 'https://blocked.example/page', false)
      .then((result: boolean): void => {
        claimed = result;
      });
    const firstCompletion: 'save' | 'claim' = await Promise.race([
      saveStarted.then((): 'save' => 'save'),
      pendingClaim.then((): 'claim' => 'claim'),
    ]);

    expect(firstCompletion).toBe('save');
    expect(claimed).toBe(false);
    releaseSave();
    await pendingClaim;
    expect(claimed).toBe(true);

    h.ports.saveRuntime.mockClear();
    await h.engine.releaseMuteClaim(7, 'https://blocked.example/page');
    expect(h.ports.saveRuntime).toHaveBeenCalledWith(expect.objectContaining({ tabStates: {} }));
  });

  it('drops persisted tab state when a reused id has a different URL', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old');
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    h.engine.reconcileTabs(
      new Map([[7, { url: 'https://allowed.example/new', mutedByExtension: false }]]),
    );

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('drops same-url tab effects when the live mute is not extension-owned', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';
    await h.engine.markStopped(7, url);
    await h.engine.claimMute(7, url, false);

    h.engine.reconcileTabs(new Map([[7, { url, mutedByExtension: false }]]));

    expect(h.engine.tabFacts(7, url)).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('drops same-url stopped ownership when no extension mute confirms the tab', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';
    await h.engine.markStopped(7, url);

    h.engine.reconcileTabs(new Map([[7, { url, mutedByExtension: false }]]));

    expect(h.engine.tabFacts(7, url)).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('rebinds an extension-owned mute after navigation interrupts the mute update', async () => {
    const h: Harness = makeEngine();
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    h.engine.reconcileTabs(
      new Map([
        [
          7,
          {
            url: 'https://allowed.example/new',
            mutedByExtension: true,
          },
        ],
      ]),
    );

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('does not relabel persisted state through a direct URL mismatch', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old');
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('rebinds a confirmed navigation while preserving its tab state', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old', 'document-one');
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    h.engine.rebindTab(7, 'https://blocked.example/new');

    expect(h.engine.tabFacts(7, 'https://blocked.example/new', 'document-one')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: true,
    });
  });

  it('ignores stale restore and reload completions for another URL', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/new', 'document-current');
    await h.engine.claimMute(7, 'https://blocked.example/new', false);

    h.engine.noteMuteRestored(7, 'https://blocked.example/old');
    h.engine.noteReloaded(7, 'document-stale');

    expect(h.engine.tabFacts(7, 'https://blocked.example/new', 'document-current')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: true,
    });
  });

  it('preserves stopped-document ownership before mute ownership exists', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';

    await h.engine.markStopped(7, url, 'document-one');
    h.engine.reconcileTabs(
      new Map([
        [
          7,
          {
            url,
            mutedByExtension: false,
            documentId: 'document-one',
          },
        ],
      ]),
    );

    expect(h.engine.tabFacts(7, url, 'document-one')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: true,
    });
  });

  it('does not give a reused same-URL tab stopped-document ownership', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';

    await h.engine.markStopped(7, url, 'document-one');

    expect(h.engine.tabFacts(7, url, 'document-two')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('caps the active daily attempt map before queueing sync data', async () => {
    const h: Harness = makeEngine();
    for (let index: number = 0; index < 25; index++) {
      await h.engine.recordAttempt(`https://site-${index}.com/feed`, index, 'existing');
    }

    const dailyWrites: unknown[][] = h.ports.queueSync.mock.calls.filter(
      (call: unknown[]): boolean => call[0] === `agg:dev-test:${localDateStr(T0)}`,
    );
    const latest = dailyWrites.at(-1)?.[1] as {
      attempts: Record<string, number>;
      attemptsOther: number;
    };
    expect(Object.keys(latest.attempts)).toHaveLength(20);
    expect(latest.attemptsOther).toBe(5);
    expect(Object.keys(h.engine.statsOverlay().todayAgg.attempts)).toHaveLength(20);
  });

  it('updateSettings rejects weakening during hard, applies otherwise', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2({ config: hardConfigV2() }) });
    const weaker: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    };
    const rejected = await h.engine.updateSettings(weaker);
    expect(rejected.ok).toBe(false);
    const stronger: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 30_000 },
    };
    const ack = await h.engine.updateSettings(stronger);
    expect(ack).toEqual({ ok: true });
    expect(h.engine.getSettings().gate.delayMs).toBe(30_000);
    expect(h.ports.queueSync).toHaveBeenCalledWith('settings', stronger);
  });

  it('does not acknowledge accepted lists before the sync journal is durable', async () => {
    let releaseJournal: () => void = (): void => {};
    let signalJournalStarted: () => void = (): void => {};
    const journalBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseJournal = resolve;
    });
    const journalStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalJournalStarted = resolve;
    });
    const h: Harness = makeEngine({
      persistSyncJournal: (): Promise<void> => {
        signalJournalStarted();
        return journalBlocked;
      },
    });
    const updatedLists = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host' as const, pattern: 'blocked.example' }],
    };
    let acknowledged: boolean = false;

    const pendingAck: Promise<void> = h.engine.updateLists(updatedLists).then((): void => {
      acknowledged = true;
    });
    const firstCompletion: 'journal' | 'ack' = await Promise.race([
      journalStarted.then((): 'journal' => 'journal'),
      pendingAck.then((): 'ack' => 'ack'),
    ]);

    expect(firstCompletion).toBe('journal');
    expect(acknowledged).toBe(false);
    releaseJournal();
    await pendingAck;
    expect(acknowledged).toBe(true);
  });

  it('journals aggregate writes discovered during the blocking sweep before acknowledgement', async () => {
    let persistCalls: number = 0;
    let releaseSecondJournal: () => void = (): void => {};
    let signalSecondJournal: () => void = (): void => {};
    const secondJournalBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseSecondJournal = resolve;
    });
    const secondJournalStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSecondJournal = resolve;
    });
    const h: Harness = makeEngine({
      persistSyncJournal: (): Promise<void> => {
        persistCalls += 1;
        if (persistCalls !== 2) return Promise.resolve();
        signalSecondJournal();
        return secondJournalBlocked;
      },
      runtime: activeRuntimeV2(),
    });
    h.ports.applyBlocking.mockImplementation(
      (lease: BlockingSweepLease): Promise<void> =>
        h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing', lease),
    );

    const pendingAck: Promise<unknown> = h.engine.updateLists({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'later.example' }],
    });
    const firstCompletion: 'journal' | 'ack' = await Promise.race([
      secondJournalStarted.then((): 'journal' => 'journal'),
      pendingAck.then((): 'ack' => 'ack'),
    ]);

    expect(firstCompletion).toBe('journal');
    releaseSecondJournal();
    await pendingAck;
    // The journal that had to come first is the one carrying the sweep's own discovery.
    expect(h.loggedEvents().some((event: EventRecord): boolean => event.t === 'attempt')).toBe(
      true,
    );
  });

  it('applies live sync changes without echoing and rejects hard-session weakening', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2({ config: hardConfigV2() }) });
    h.ports.queueSync.mockClear();
    const weaker: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    };

    const rejected = await h.engine.applySyncedSettings(weaker);
    const accepted = await h.engine.applySyncedBank({ balanceMs: 42_000 });

    expect(rejected.ok).toBe(false);
    expect(accepted).toEqual({ ok: true });
    expect(h.engine.getSettings().gate.delayMs).toBe(DEFAULT_SETTINGS.gate.delayMs);
    expect(h.engine.snapshot().bankMs).toBe(42_000);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith('settings', expect.anything());
    expect(h.ports.queueSync).not.toHaveBeenCalledWith('bank', expect.anything());
  });

  it('applies newer synced streak progress and supersedes pending state', async () => {
    const local: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-26',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26],
      activeMonth: '2026-08',
    };
    const remote: StreakState = {
      ...local,
      current: 3,
      lastCountedDate: '2026-08-27',
      activeDays: [25, 26, 27],
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    expect(h.engine.getStreak()).toEqual(remote);
    expect(h.ports.supersedeSync).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('does not replace newer local streak progress with stale sync data', async () => {
    const remote: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-26',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26],
      activeMonth: '2026-08',
    };
    const local: StreakState = {
      ...remote,
      current: 3,
      lastCountedDate: '2026-08-27',
      activeDays: [25, 26, 27],
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    expect(h.engine.getStreak()).toEqual(local);
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('merges equal-marker streak counters and active days without regression', async () => {
    const remote: StreakState = {
      current: 3,
      freezeTokens: 2,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 28],
      activeMonth: '2026-08',
    };
    const local: StreakState = {
      ...remote,
      current: 5,
      freezeTokens: 1,
      activeDays: [24, 25, 26, 27],
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    const merged: StreakState = {
      ...remote,
      current: 5,
      freezeTokens: 2,
      activeDays: [24, 25, 26, 27, 28],
    };
    expect(h.engine.getStreak()).toEqual(merged);
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('sanitizes future remote streak markers before arbitration', async () => {
    const local: StreakState = {
      current: 0,
      freezeTokens: 1,
      lastCountedDate: null,
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [28],
      activeMonth: '2026-08',
    };
    const remote: StreakState = {
      current: 5,
      freezeTokens: 2,
      lastCountedDate: '2026-09-01',
      lastFreezeGrantDate: '2026-09-01',
      activeDays: [1],
      activeMonth: '2026-09',
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    const corrected: StreakState = {
      current: 0,
      freezeTokens: 1,
      lastCountedDate: null,
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [28],
      activeMonth: '2026-08',
    };
    expect(h.engine.getStreak()).toEqual(corrected);
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('supersedes an older pending streak write with newer remote progress', async () => {
    const older: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-26',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26],
      activeMonth: '2026-08',
    };
    const newer: StreakState = {
      ...older,
      current: 3,
      lastCountedDate: '2026-08-27',
      activeDays: [25, 26, 27],
    };
    const write = vi.fn().mockResolvedValue(undefined);
    const writer: SyncWriter = new SyncWriter(10_000, write);
    writer.queue(SYNC_STREAK, older);
    const h: Harness = makeEngine({
      streak: older,
      supersedeSync: (key: string, value: unknown): void => writer.supersede(key, value),
    });

    await h.engine.applySyncedStreak(newer);
    await writer.flushNow();

    expect(write).toHaveBeenCalledWith({ [SYNC_STREAK]: older });
  });

  it('does not create a sync write when no local streak is pending', async () => {
    const remote: StreakState = {
      current: 3,
      freezeTokens: 0,
      lastCountedDate: '2026-08-27',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26, 27],
      activeMonth: '2026-08',
    };
    const write = vi.fn().mockResolvedValue(undefined);
    const writer: SyncWriter = new SyncWriter(10_000, write);
    const h: Harness = makeEngine({
      supersedeSync: (key: string, value: unknown): void => writer.supersede(key, value),
    });

    await h.engine.applySyncedStreak(remote);
    await writer.flushNow();

    expect(write).not.toHaveBeenCalled();
  });

  it('drives a pause through the Engine and clears the blocking it owed', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2(), bankMs: 10 * 60_000 });
    expect((await h.engine.openGate('pause', null)).ok).toBe(true);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs + 1_000);

    const confirmed = await h.engine.confirmGate(null);

    // The confirmation answers on its own. The clear it owes runs after the command releases the
    // queue, because the sweep it starts asks the controller for every target and would otherwise
    // wait for the command that asked for it.
    expect(confirmed).toEqual({ ok: true, code: 'ok' });
    expect(h.engine.snapshot().phase).toBe('paused');
    await vi.waitFor((): void => {
      expect(h.ports.applyBlocking).toHaveBeenCalled();
    });
  });

  it('leaves every rollover write to the tick that follows it', async () => {
    const yesterday: string = localDateStr(T0 - DAY_MS);
    const saveAggregate = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockResolvedValue(undefined);
    const h: Harness = makeEngine({
      runtime: {
        ...emptyRuntimeV2Fixture(T0),
        date: yesterday,
        todayAgg: { ...emptyDaily(yesterday), focusMs: 60_000 },
      },
      streak: {
        current: 0,
        freezeTokens: 0,
        lastCountedDate: null,
        lastFreezeGrantDate: null,
        activeDays: [],
        activeMonth: '2026-08',
      },
      saveAggregate,
    });
    h.ports.saveRuntime.mockClear();
    h.ports.queueSync.mockClear();

    await h.engine.rolloverCheck(localMidnightAfter(yesterday));

    // The controller calls this from inside its own queue, so nothing may be written here: a write
    // sweeps when blocking work is pending, and the sweep would ask the controller that is waiting.
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(saveAggregate).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalledWith('streak', expect.anything());

    await h.engine.tick();

    // The tick is the caller that runs once the queue is released, and it owes all three writes.
    expect(h.ports.saveRuntime).toHaveBeenCalled();
    expect(saveAggregate).toHaveBeenCalledWith(`agg:dev-test:${yesterday}`, expect.anything());
    expect(h.ports.queueSync).toHaveBeenCalledWith('streak', expect.anything());
  });

  it('carries the controller checkpoint through the window its replay runs in', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2(), bankMs: 10 * 60_000 });
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    // The controller's commit is durable and its replay is still running. This is the window a
    // crash has to survive: the events, bank, and aggregates it named are already being flushed.
    const opening: Promise<unknown> = h.engine.openGate('pause', null);
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));
    await h.engine.markStopped(7, 'https://facebook.com/feed', 'document-one');

    // What a boot would read now is the committed state with its checkpoint, not the state that
    // preceded the commit: replaying the older one would credit the bank a second time.
    const stored: RuntimeStateV2 = lastSavedRuntime(h);
    expect(stored.commitCheckpoint).not.toBeNull();
    expect(stored.gate).not.toBeNull();
    expect(stored.tabStates[7]?.stoppedDocumentId).toBe('document-one');

    releaseEvents();
    await opening;
  });

  it('mints a fresh enforcement epoch when an all-data clear finishes', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2() });
    const before: string = h.seededRuntime.enforcementEpoch;

    await h.engine.runWithDataClearBarrier(async (): Promise<void> => undefined);
    await h.engine.tick();

    // A document that survived the clear still holds commands stamped with the old epoch. A reused
    // epoch would let it keep applying them, so the erase mints a new one and every stale command
    // is refused until its document is reset onto it.
    const after: string = lastSavedRuntime(h).enforcementEpoch;
    expect(before).not.toBe('');
    expect(after).not.toBe(before);
  });

  it('settles the session before it runs its own minute maintenance', async () => {
    const h: Harness = makeEngine({ runtime: activeRuntimeV2() });
    h.setNow(T0 + 60_000);
    let focusAtPrune: number = -1;
    h.ports.prune.mockImplementation(async (): Promise<void> => {
      focusAtPrune = h.engine.statsOverlay().todayAgg.focusMs;
    });

    await h.engine.handleAlarm('tick');

    // The session is what the minute is for, and the prune is what is left over. By the time the
    // prune runs, the minute of focus is already settled and credited, so the boundary was never
    // held behind storage work that belongs to no session.
    expect(h.ports.prune).toHaveBeenCalledTimes(1);
    expect(focusAtPrune).toBe(60_000);
  });

  it('reports a refused maintenance write and still finishes the minute alarm', async () => {
    const h: Harness = makeEngine({
      runtime: activeRuntimeV2({}, { removedTabTombstones: { 7: true } }),
    });
    h.setNow(T0 + 60_000);
    let refused: boolean = false;
    h.ports.saveRuntime.mockImplementation(async (runtime: RuntimeStateV2): Promise<void> => {
      // The tombstone flush is the write that carries none, and it is the one refused here.
      if (!refused && Object.keys(runtime.removedTabTombstones).length === 0) {
        refused = true;
        throw new Error('storage refused the tombstone flush');
      }
    });

    await expect(h.engine.handleAlarm('tick')).resolves.toBeUndefined();

    expect(refused).toBe(true);
    expect(h.ports.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'storage refused the tombstone flush' }),
    );
    // The session still settled: a retention chore may not cost a boundary.
    expect(h.ports.broadcast).toHaveBeenCalled();
  });

  it('prunes on the alarm that reaches the weekly due date', async () => {
    const h: Harness = makeEngine({
      runtime: { ...emptyRuntimeV2Fixture(T0), lastPruneDate: localDateStr(T0) },
    });

    h.setNow(T0 + 3 * DAY_MS);
    await h.engine.handleAlarm('tick');
    expect(h.ports.prune).not.toHaveBeenCalled();

    h.setNow(T0 + 7 * DAY_MS);
    await h.engine.handleAlarm('tick');
    expect(h.ports.prune).toHaveBeenCalledTimes(1);
  });
});
