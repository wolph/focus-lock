import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmPortsV2, ScheduledAlarmV2 } from '../../../src/background/alarms-v2';
import type { ContentTransportPortsV2 } from '../../../src/background/content-transport-v2';
import {
  type AllDataClearJournalV2,
  type CleanInstallMarkerProjection,
  DATA_CLEAR_RESET_DEADLINE_MS,
  type DataClearResetProgress,
  type FinalInstallMarkerProjection,
  MAX_DATA_CLEAR_RESOLVER_PASSES,
  parseDataClearJournal,
} from '../../../src/background/data-clear-journal';
import {
  type AllDataClearLease,
  createAllDataClearLease,
  type DataClearLeaseToken,
} from '../../../src/background/data-clear-lease';
import {
  type BrowserResetPortsV2,
  finalizeAllDataClearV2,
  retryBrowserResetV2,
  runBrowserResetAttemptV2,
} from '../../../src/background/data-clear-reset-v2';
import type { FrozenEpochResetCommand } from '../../../src/background/enforcement-persistence-v2';
import {
  type EnforcementTargetPortsV2,
  FINAL_FRESHNESS_TIMEOUT_MS,
  MAX_TARGET_RESOLVER_PASSES,
} from '../../../src/background/enforcement-targets-v2';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import { DEFAULT_SETUP } from '../../../src/shared/constants';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import { LOCAL_DATA_CLEAR_JOURNAL } from '../../../src/shared/storage-keys';

const NOW: number = Date.parse('2026-09-04T10:00:00.000Z');
const RESET_EPOCH: string = '20000000-0000-4000-8000-000000000001';
const RESET_OPERATION: string = '20000000-0000-4000-8000-000000000002';
const NEXT_OPERATION: string = '20000000-0000-4000-8000-000000000003';
const OTHER_EPOCH: string = '20000000-0000-4000-8000-000000000004';
const EXTENSION_VERSION: string = '1.0.0';
const TARGET_URL: string = 'https://facebook.com/feed';
const OTHER_URL: string = 'https://news.example.com/story';
const FIRST_KEY: string = '11:document-1';

/** One open document the reset has to reach, and how it answers. */
interface FakeTargetV2 {
  tabId: number;
  documentId: string | null;
  url: string | null;
  answer:
    | 'reset'
    | 'closed'
    | 'no-receiver'
    | 'mismatch'
    | 'rejected'
    | 'stale-operation'
    | 'stale-url';
}

interface MaterializedStateV2 {
  runtime: unknown;
  setup: unknown;
  installMarker: unknown;
}

interface ResetHarnessV2 {
  ports: BrowserResetPortsV2;
  lease: AllDataClearLease;
  storage: Record<string, unknown>;
  alarms: Map<string, ScheduledAlarmV2>;
  tabs: FakeTargetV2[];
  generation: { value: number };
  clock: { now: number };
  ensureDeviceIdCalls: number[];
  replayCalls: number;
  sent: string[];
  /** What Policy Storage and the replay have actually written, which is what the checks read. */
  materialized: MaterializedStateV2;
  /** The commands the journal held at the instant each send went out. */
  frozenAtSend: Array<Record<string, FrozenEpochResetCommand>>;
  journal(): AllDataClearJournalV2;
  progress(): DataClearResetProgress;
  run<T>(operation: (token: DataClearLeaseToken) => Promise<T>): Promise<T>;
}

function cleanMarker(): CleanInstallMarkerProjection {
  return {
    version: 1,
    profile: 'clean',
    latestReason: 'install',
    extensionVersion: EXTENSION_VERSION,
  };
}

function resetProgress(overrides: Partial<DataClearResetProgress> = {}): DataClearResetProgress {
  return {
    attemptStartedAt: null,
    resolverPassCount: 0,
    targetGeneration: null,
    stablePasses: 0,
    targets: {},
    commands: {},
    acknowledgements: {},
    exclusions: [],
    deferredUnreachable: [],
    ...overrides,
  };
}

function browserResetJournal(
  overrides: Partial<AllDataClearJournalV2> = {},
): AllDataClearJournalV2 {
  return {
    version: 2,
    scope: 'all',
    phase: 'browser-reset',
    inventory: [],
    resetEpoch: RESET_EPOCH,
    resetOperationId: RESET_OPERATION,
    runtimeProjection: emptyRuntimeV2(NOW, RESET_EPOCH),
    setupProjection: DEFAULT_SETUP,
    installMarkerProjection: cleanMarker(),
    finalInstallMarkerProjection: cleanMarker(),
    pendingInstallLifecycleIntents: [],
    resetProgress: resetProgress(),
    retry: { batch: 1, automaticAttempt: 0, nextAttemptAt: NOW, lastError: null },
    ...overrides,
  };
}

/** The document's answer to one reset command, in the shape the transport parser accepts. */
function answerFor(target: FakeTargetV2, command: Record<string, unknown>, at: number): unknown {
  if (target.answer === 'closed') throw new Error('The tab was closed.');
  if (target.answer === 'no-receiver') throw new Error('Could not establish connection.');
  if (target.answer === 'mismatch') return { nonsense: true };
  if (target.answer === 'rejected') {
    return {
      version: 1,
      disposition: 'epoch-reset-rejected',
      operationId: command.operationId,
      enforcementEpoch: command.enforcementEpoch,
      documentId: command.documentId,
      observedUrl: command.expectedUrl,
      currentEpoch: OTHER_EPOCH,
      reason: 'retired-epoch',
      handledAt: at,
    };
  }
  return {
    version: 1,
    disposition: 'epoch-reset',
    operationId: target.answer === 'stale-operation' ? 'another-operation' : command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    documentId: command.documentId,
    // A document that answers with the URL it is really on, which is what disputes the address a
    // frozen command carries.
    observedUrl: target.answer === 'stale-url' ? (target.url ?? '') : command.expectedUrl,
    handledAt: at,
  };
}

function harness(journal: AllDataClearJournalV2 | null = browserResetJournal()): ResetHarnessV2 {
  const storage: Record<string, unknown> =
    journal === null ? {} : { [LOCAL_DATA_CLEAR_JOURNAL]: structuredClone(journal) };
  const alarms: Map<string, ScheduledAlarmV2> = new Map<string, ScheduledAlarmV2>();
  const tabs: FakeTargetV2[] = [
    { tabId: 11, documentId: 'document-1', url: TARGET_URL, answer: 'reset' },
  ];
  const generation: { value: number } = { value: 7 };
  const clock: { now: number } = { now: NOW };
  const ensureDeviceIdCalls: number[] = [];
  const sent: string[] = [];
  const frozenAtSend: Array<Record<string, FrozenEpochResetCommand>> = [];
  const materialized: MaterializedStateV2 = {
    runtime: journal?.runtimeProjection ?? null,
    setup: journal?.setupProjection ?? null,
    installMarker: journal?.installMarkerProjection ?? null,
  };
  const state: { replayCalls: number; deviceId: boolean; replay: 'complete' | 'failed' } = {
    replayCalls: 0,
    deviceId: true,
    replay: 'complete',
  };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(
          async (key: string): Promise<Record<string, unknown>> =>
            Object.hasOwn(storage, key) ? { [key]: structuredClone(storage[key]) } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          Object.assign(storage, structuredClone(items));
        }),
        remove: vi.fn(async (key: string): Promise<void> => {
          delete storage[key];
        }),
      },
    },
  });
  const lease: AllDataClearLease = createAllDataClearLease((): boolean => false);
  const targets: EnforcementTargetPortsV2 = {
    queryTopFrameTabs: async (): Promise<Array<{ tabId: number; url: string | null }>> =>
      tabs.map((tab: FakeTargetV2): { tabId: number; url: string | null } => ({
        tabId: tab.tabId,
        url: tab.url,
      })),
    topFrameDocumentId: async (tabId: number): Promise<string | null> =>
      tabs.find((tab: FakeTargetV2): boolean => tab.tabId === tabId)?.documentId ?? null,
    readTargetGeneration: (): number => generation.value,
    now: (): number => clock.now,
    ensureDocumentScript: (): Promise<'ready' | 'unscriptable'> => Promise.resolve('ready'),
  };
  const transport: ContentTransportPortsV2 = {
    sendToDocument: async (
      tabId: number,
      documentId: string,
      message: unknown,
    ): Promise<unknown> => {
      const target: FakeTargetV2 | undefined = tabs.find(
        (tab: FakeTargetV2): boolean => tab.tabId === tabId && tab.documentId === documentId,
      );
      if (target === undefined) throw new Error('The tab was closed.');
      sent.push(`${tabId}:${documentId}`);
      frozenAtSend.push(storedJournal(storage)?.resetProgress?.commands ?? {});
      return answerFor(target, message as Record<string, unknown>, clock.now);
    },
  };
  const alarmPorts: AlarmPortsV2 = {
    create: async (name: string, when: number): Promise<void> => {
      alarms.set(name, { scheduledTime: when, periodInMinutes: null });
    },
    createPeriodic: async (name: string, periodInMinutes: number): Promise<void> => {
      alarms.set(name, { scheduledTime: clock.now, periodInMinutes });
    },
    get: async (name: string): Promise<ScheduledAlarmV2 | null> => alarms.get(name) ?? null,
    clear: async (name: string): Promise<void> => {
      alarms.delete(name);
    },
  };
  const ports: BrowserResetPortsV2 = {
    lease,
    now: (): number => clock.now,
    newId: (): string => NEXT_OPERATION,
    targets,
    transport,
    alarms: alarmPorts,
    readMaterialized: async (): Promise<MaterializedStateV2> => structuredClone(materialized),
    deviceIdExists: async (): Promise<boolean> => state.deviceId,
    ensureDeviceId: async (): Promise<string> => {
      ensureDeviceIdCalls.push(clock.now);
      return 'device-id';
    },
    // Main's replay writes the marker its journal projects. A failed one writes nothing.
    replayLifecycleIntents: async (): Promise<'complete' | 'failed'> => {
      state.replayCalls += 1;
      if (state.replay === 'complete') {
        materialized.installMarker =
          storedJournal(storage)?.finalInstallMarkerProjection ?? materialized.installMarker;
      }
      return state.replay;
    },
    reportError: vi.fn(),
  };
  return {
    ports,
    lease,
    storage,
    alarms,
    tabs,
    generation,
    clock,
    ensureDeviceIdCalls,
    materialized,
    frozenAtSend,
    get replayCalls(): number {
      return state.replayCalls;
    },
    sent,
    journal: (): AllDataClearJournalV2 => {
      const stored: AllDataClearJournalV2 | null = storedJournal(storage);
      if (stored === null) throw new Error('expected a stored all-data journal');
      return stored;
    },
    progress: (): DataClearResetProgress => {
      const stored: AllDataClearJournalV2 | null = storedJournal(storage);
      if (stored?.resetProgress == null) throw new Error('expected reset progress');
      return stored.resetProgress;
    },
    run: <T>(operation: (token: DataClearLeaseToken) => Promise<T>): Promise<T> =>
      lease.run(operation),
  };
}

function storedJournal(storage: Record<string, unknown>): AllDataClearJournalV2 | null {
  const raw: unknown = storage[LOCAL_DATA_CLEAR_JOURNAL];
  if (raw === undefined) return null;
  const parsed = parseDataClearJournal(raw);
  return parsed !== null && 'version' in parsed && parsed.scope === 'all' ? parsed : null;
}

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('browser reset attempt', (): void => {
  beforeEach((): void => {
    vi.restoreAllMocks();
  });

  it('bounds the resolver by the numbers the enforcement sweep is bounded by', (): void => {
    // The journal leaf may not import the enforcement module, so the two definitions are kept in
    // agreement here rather than by construction. A change to one without the other lands as a
    // failure instead of a silently different bound.
    expect(MAX_DATA_CLEAR_RESOLVER_PASSES).toBe(MAX_TARGET_RESOLVER_PASSES);
    expect(DATA_CLEAR_RESET_DEADLINE_MS).toBe(FINAL_FRESHNESS_TIMEOUT_MS);
  });

  it('refuses to start on evidence the journal did not project', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    h.ports.readMaterialized = async (): Promise<{
      runtime: unknown;
      setup: unknown;
      installMarker: unknown;
    }> => ({ runtime: { drifted: true }, setup: DEFAULT_SETUP, installMarker: cleanMarker() });

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // Policy Storage owns repair, so the attempt records what it saw and waits for the next
    // dispatch rather than materializing anything itself.
    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('materialization-mismatch');
    expect(h.ensureDeviceIdCalls).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('regenerates the device identity once before it sends anything', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const order: string[] = [];
    h.ports.ensureDeviceId = async (): Promise<string> => {
      order.push('identity');
      h.ensureDeviceIdCalls.push(h.clock.now);
      return 'device-id';
    };
    const send = h.ports.transport.sendToDocument;
    h.ports.transport.sendToDocument = async (
      tabId: number,
      documentId: string,
      message: DocumentContentCommand,
    ): Promise<unknown> => {
      order.push('send');
      return send(tabId, documentId, message);
    };

    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(h.ensureDeviceIdCalls).toHaveLength(1);
    expect(order[0]).toBe('identity');
  });

  it('freezes every command in the journal before it sends one', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();

    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // Nothing may be issued that a crash could leave unrecorded: the journal already holds this
    // exact command at the instant it goes out.
    expect(h.frozenAtSend).not.toHaveLength(0);
    for (const frozen of h.frozenAtSend) {
      expect(frozen[FIRST_KEY]).toMatchObject({
        tabId: 11,
        documentId: 'document-1',
        expectedUrl: TARGET_URL,
        operationId: RESET_OPERATION,
        enforcementEpoch: RESET_EPOCH,
      });
    }
  });

  it('keeps what a failed pass had already made durable', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    h.tabs.push({ tabId: 12, documentId: 'document-2', url: OTHER_URL, answer: 'mismatch' });

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // The first document was reset under this operation. A journal that forgot the command it was
    // reset with would have no record that the reset was ever issued.
    expect(result).toBe('retry-scheduled');
    expect(Object.keys(h.progress().commands)).toContain(FIRST_KEY);
    expect(h.progress().targets[FIRST_KEY]).toMatchObject({ tabId: 11, expectedUrl: TARGET_URL });
  });

  it('retries the exact frozen command when the document drifts', async (): Promise<void> => {
    const frozen: FrozenEpochResetCommand = {
      version: 1,
      command: 'reset-enforcement-epoch',
      tabId: 11,
      documentId: 'document-1',
      expectedUrl: TARGET_URL,
      operationId: RESET_OPERATION,
      enforcementEpoch: RESET_EPOCH,
    };
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({
          targets: {
            [FIRST_KEY]: { tabId: 11, documentId: 'document-1', expectedUrl: TARGET_URL },
          },
          commands: { [FIRST_KEY]: frozen },
        }),
      }),
    );
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.url = OTHER_URL;

    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(h.progress().commands[FIRST_KEY]).toEqual(frozen);
  });

  it('reaches stable on two generation-stable acknowledged passes', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('stable');
    const progress: DataClearResetProgress = h.progress();
    expect(progress.stablePasses).toBe(2);
    expect(progress.attemptStartedAt).toBe(NOW);
    expect(progress.resolverPassCount).toBe(2);
    expect(progress.targetGeneration).toBe(7);
    // Every command is frozen in the journal, and only the exact acknowledgement is kept.
    expect(progress.commands[FIRST_KEY]).toMatchObject({
      command: 'reset-enforcement-epoch',
      operationId: RESET_OPERATION,
      enforcementEpoch: RESET_EPOCH,
      documentId: 'document-1',
      expectedUrl: TARGET_URL,
      tabId: 11,
    });
    expect(progress.acknowledgements[FIRST_KEY]).toMatchObject({
      operationId: RESET_OPERATION,
      enforcementEpoch: RESET_EPOCH,
      documentId: 'document-1',
    });
  });

  it('keeps the materialized runtime exactly as the journal projected it', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();

    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // The acknowledgements live in the journal alone. A runtime that grew `epochResetAcks` would
    // be a second authority for the same fact, and the next boot would replay it.
    const materialized = await h.ports.readMaterialized();
    expect(materialized.runtime).toEqual(h.journal().runtimeProjection);
    expect((materialized.runtime as { epochResetAcks: unknown }).epochResetAcks).toEqual({});
  });

  it('restarts the stable count when the target generation moves', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    let passes: number = 0;
    const queryTopFrameTabs = h.ports.targets.queryTopFrameTabs;
    h.ports.targets.queryTopFrameTabs = async (): Promise<
      Array<{ tabId: number; url: string | null }>
    > => {
      passes += 1;
      if (passes === 2) h.generation.value += 1;
      return await queryTopFrameTabs();
    };

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // A generation change costs the stable count and nothing else, so the attempt keeps spending
    // its own pass budget until the bound stops it. The three sends are that budget: the change
    // cost stability rather than the attempt.
    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('reset-passes-exhausted');
    expect(h.sent).toHaveLength(3);
    // The attempt that ended leaves nothing for the next wake to inherit.
    expect(h.progress().attemptStartedAt).toBeNull();
    expect(h.progress().resolverPassCount).toBe(0);
  });

  it('fails the attempt on a rejected epoch rather than deferring it', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'rejected';

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toContain('epoch-reset-rejected');
    expect(h.progress().deferredUnreachable).toEqual([]);
    expect(h.progress().exclusions).toEqual([]);
  });

  it('fails the attempt on an answer that is not plain data', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    h.ports.transport.sendToDocument = async (): Promise<unknown> =>
      new Proxy(
        {},
        {
          get: (): never => {
            throw new Error('a hostile answer must not be read field by field');
          },
        },
      );

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toContain('mismatch');
  });

  it('fails the attempt on an acknowledgement for another operation', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'stale-operation';

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toContain('mismatch');
    expect(h.progress().acknowledgements).toEqual({});
  });

  it('excludes a closed tab and defers one with no receiver', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    h.tabs.push({ tabId: 12, documentId: 'document-2', url: OTHER_URL, answer: 'no-receiver' });
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'closed';

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // Neither answer fails the attempt, and neither keeps deleted data alive: a closed tab is
    // gone, and a tab with no receiver is recorded and left for the reset every old-epoch document
    // gets when it next loads.
    expect(result).toBe('stable');
    expect(h.progress().exclusions).toEqual([
      { tabId: 11, documentId: 'document-1', expectedUrl: TARGET_URL, reason: 'closed' },
    ]);
    expect(h.progress().deferredUnreachable).toEqual([
      { tabId: 12, documentId: 'document-2', expectedUrl: OTHER_URL, reason: 'no-receiver' },
    ]);
  });

  it('stabilizes when the only document open has no receiver', async (): Promise<void> => {
    // Every tab that was already open when the extension was installed answers this way. It must
    // not keep the clear from completing, or a user who deletes their data is left with a browser
    // the barrier never reopens.
    const h: ResetHarnessV2 = harness();
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'no-receiver';

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('stable');
    expect(h.progress().deferredUnreachable).toEqual([
      { tabId: 11, documentId: 'document-1', expectedUrl: TARGET_URL, reason: 'no-receiver' },
    ]);
  });

  it('stops sending once its ten seconds are spent', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const answer = h.ports.transport.sendToDocument;
    h.ports.transport.sendToDocument = async (
      tabId: number,
      documentId: string,
      message: never,
    ): Promise<unknown> => {
      // The first pass takes the whole budget, which is what a slow browser looks like.
      h.clock.now = NOW + DEADLINE_MS;
      return await answer(tabId, documentId, message);
    };

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // The pass that had already started finishes, and no second pass is sent: the deadline is
    // checked before a pass rather than in the middle of one.
    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('reset-deadline');
    expect(h.sent).toEqual(['11:document-1']);
  });

  it('schedules the next attempt and leaves the twelfth exhausted', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        retry: { batch: 1, automaticAttempt: 11, nextAttemptAt: NOW, lastError: 'earlier' },
      }),
    );
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'rejected';

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('exhausted');
    expect(h.journal().retry.automaticAttempt).toBe(12);
    expect(h.journal().retry.nextAttemptAt).toBeNull();
    expect(h.alarms.has('data-clear-retry')).toBe(false);
  });

  it('schedules the retry alarm the journal asks for', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'rejected';

    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(h.alarms.get('data-clear-retry')?.scheduledTime).toBe(h.journal().retry.nextAttemptAt);
  });
});

describe('browser reset manual retry', (): void => {
  it('reissues every command under a new operation and a new batch', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );
    const before: AllDataClearJournalV2 = h.journal();

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => retryBrowserResetV2(h.ports, token),
    );

    const after: AllDataClearJournalV2 = h.journal();
    expect(result).toBe('ok');
    expect(after.resetOperationId).toBe(NEXT_OPERATION);
    expect(after.resetProgress?.commands[FIRST_KEY]?.operationId).toBe(NEXT_OPERATION);
    expect(after.resetProgress?.acknowledgements).toEqual({});
    expect(after.resetProgress?.stablePasses).toBe(0);
    expect(after.resetProgress?.resolverPassCount).toBe(0);
    expect(after.retry.batch).toBe(before.retry.batch + 1);
    expect(after.retry.nextAttemptAt).toBe(NOW);
    // The identity of the clear is the epoch and the projections, and a retry keeps all of them.
    expect(after.resetEpoch).toBe(before.resetEpoch);
    expect(after.runtimeProjection).toEqual(before.runtimeProjection);
    expect(after.setupProjection).toEqual(before.setupProjection);
    expect(after.finalInstallMarkerProjection).toEqual(before.finalInstallMarkerProjection);
  });

  it('has nothing to retry without a browser-reset journal', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(null);

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => retryBrowserResetV2(h.ports, token),
    );

    expect(result).toBe('retry-not-available');
  });
});

describe('all-data clear finalization', (): void => {
  async function stableHarness(): Promise<ResetHarnessV2> {
    const h: ResetHarnessV2 = harness();
    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );
    return h;
  }

  it('removes the journal and reads the key again to prove it', async (): Promise<void> => {
    const h: ResetHarnessV2 = await stableHarness();

    const result: string = await finalizeAllDataClearV2(h.ports);

    expect(result).toBe('removed');
    expect(h.storage[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
    expect(h.replayCalls).toBe(1);
  });

  it('replays nothing while the reset is unfinished', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();

    const result: string = await finalizeAllDataClearV2(h.ports);

    expect(result).toBe('not-finalizable');
    expect(h.replayCalls).toBe(0);
    expect(h.storage[LOCAL_DATA_CLEAR_JOURNAL]).toBeDefined();
  });

  it('replays nothing while the profile has no device identity', async (): Promise<void> => {
    const h: ResetHarnessV2 = await stableHarness();
    h.ports.deviceIdExists = async (): Promise<boolean> => false;

    const result: string = await finalizeAllDataClearV2(h.ports);

    expect(result).toBe('not-finalizable');
    expect(h.replayCalls).toBe(0);
  });

  it('schedules a retry when the removal does not stick', async (): Promise<void> => {
    const h: ResetHarnessV2 = await stableHarness();
    const kept: unknown = structuredClone(h.storage[LOCAL_DATA_CLEAR_JOURNAL]);
    const chromeStub = chrome as unknown as {
      storage: { local: { remove: (key: string) => Promise<void> } };
    };
    chromeStub.storage.local.remove = async (): Promise<void> => {
      h.storage[LOCAL_DATA_CLEAR_JOURNAL] = kept;
    };

    const result: string = await finalizeAllDataClearV2(h.ports);

    // The read after the removal is the proof, so a key that survives is a failed attempt with a
    // retry rather than a clear that reports itself finished.
    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('journal-not-removed');
  });

  it('replays the crash window that left the marker behind its projection', async (): Promise<void> => {
    // Spec 1337's window: the advanced projection is durable and the marker is not. Replay is the
    // only thing that closes it, so finalization must reach the replay to recover.
    const advanced: FinalInstallMarkerProjection = {
      version: 1,
      profile: 'clean',
      latestReason: 'update',
      extensionVersion: '2.0.0',
    };
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        finalInstallMarkerProjection: advanced,
        resetProgress: resetProgress({
          attemptStartedAt: NOW,
          stablePasses: 2,
          targetGeneration: 7,
        }),
      }),
    );

    const outcome: string = await finalizeAllDataClearV2(h.ports);

    expect(outcome).toBe('removed');
    expect(h.replayCalls).toBe(1);
    expect(h.materialized.installMarker).toEqual(advanced);
    expect(h.storage[LOCAL_DATA_CLEAR_JOURNAL]).toBeUndefined();
  });

  it('does not call an advanced marker a materialization mismatch', async (): Promise<void> => {
    const advanced: FinalInstallMarkerProjection = {
      version: 1,
      profile: 'clean',
      latestReason: 'update',
      extensionVersion: '2.0.0',
    };
    const h: ResetHarnessV2 = harness(
      browserResetJournal({ finalInstallMarkerProjection: advanced }),
    );
    h.materialized.installMarker = advanced;

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // The clean projection is frozen forever, so it stops being what the live marker must equal
    // the moment a replay advances the journal's own final projection.
    expect(result).toBe('stable');
    expect(h.journal().retry.lastError).toBeNull();
  });

  it('refuses the removal when the target generation moved under it', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({
          attemptStartedAt: NOW,
          stablePasses: 2,
          targetGeneration: 7,
        }),
      }),
    );
    h.generation.value = 8;

    const outcome: string = await finalizeAllDataClearV2(h.ports);

    expect(outcome).toBe('retry-scheduled');
    expect(h.storage[LOCAL_DATA_CLEAR_JOURNAL]).toBeDefined();
    expect(h.journal().retry.lastError).toContain('generation');
  });

  it('answers exhausted rather than scheduled when the batch is spent', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        retry: { batch: 1, automaticAttempt: 11, nextAttemptAt: NOW, lastError: 'reset-deadline' },
        resetProgress: resetProgress({ attemptStartedAt: NOW, stablePasses: 2 }),
      }),
    );
    h.ports.replayLifecycleIntents = async (): Promise<'complete' | 'failed'> => 'failed';

    const outcome: string = await finalizeAllDataClearV2(h.ports);

    // The twelfth failure leaves no alarm, so telling the caller a retry is scheduled would be a
    // lie about state it may act on.
    expect(outcome).toBe('exhausted');
    expect(h.alarms.get('data-clear-retry')).toBeUndefined();
  });

  it('refuses to acquire the lease a caller already holds', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();

    await expect(
      h.run((): Promise<string> => finalizeAllDataClearV2(h.ports)),
    ).rejects.toMatchObject({ code: 'lease-order' });
  });

  it('resets the caller in memory before it releases the lease', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({
          attemptStartedAt: NOW,
          stablePasses: 2,
          targetGeneration: 7,
        }),
      }),
    );
    const held: boolean[] = [];
    const projection: unknown = structuredClone(h.journal().runtimeProjection);
    h.ports.afterRemoval = vi.fn(async (): Promise<void> => {
      held.push(h.lease.held());
    });

    const outcome: string = await finalizeAllDataClearV2(h.ports);

    // A clear that began against a half-reset caller would be reasoning about state nobody owns.
    expect(outcome).toBe('removed');
    expect(held).toEqual([true]);
    expect(h.ports.afterRemoval).toHaveBeenCalledWith(projection);
  });

  it('schedules a retry when the lifecycle replay fails', async (): Promise<void> => {
    const h: ResetHarnessV2 = await stableHarness();
    h.ports.replayLifecycleIntents = async (): Promise<'complete' | 'failed'> => 'failed';

    const result: string = await finalizeAllDataClearV2(h.ports);

    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('lifecycle-replay-failed');
    expect(h.storage[LOCAL_DATA_CLEAR_JOURNAL]).toBeDefined();
  });
});

describe('browser reset across attempts', (): void => {
  beforeEach((): void => {
    vi.restoreAllMocks();
  });

  it('gives the scheduled retry an attempt of its own', async (): Promise<void> => {
    // The seam no single-attempt test reaches: what the next wake finds in the journal the last
    // one left. Every retry delay is longer than the ten second deadline, so a wake that inherits
    // the spent attempt does nothing at all and burns eleven of the twelve automatic attempts.
    const h: ResetHarnessV2 = harness();
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'rejected';

    const first: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );
    expect(first).toBe('retry-scheduled');
    const scheduled: number | null = h.journal().retry.nextAttemptAt;
    expect(scheduled).toBeGreaterThan(NOW);

    target.answer = 'reset';
    h.clock.now = scheduled ?? NOW;
    const sendsBefore: number = h.sent.length;
    const second: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(second).toBe('stable');
    expect(h.sent.length).toBeGreaterThan(sendsBefore);
    expect(h.journal().retry.automaticAttempt).toBe(1);
  });

  it('leaves no spent attempt behind for the next wake to inherit', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'rejected';

    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // An attempt that ended says so. A start left behind is indistinguishable from a crash inside
    // an attempt, which is the state the resume rule is for.
    expect(h.progress().attemptStartedAt).toBeNull();
    expect(h.progress().resolverPassCount).toBe(0);
  });

  it('runs the whole automatic schedule rather than expiring it', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness();
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    target.answer = 'rejected';

    for (let attempt: number = 1; attempt <= 4; attempt += 1) {
      const scheduled: number | null = h.journal().retry.nextAttemptAt;
      h.clock.now = scheduled ?? h.clock.now;
      const sendsBefore: number = h.sent.length;
      await h.run(
        (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
      );
      // Every automatic attempt is a real attempt: it reaches the documents rather than expiring
      // on a deadline the previous attempt spent.
      expect(h.sent.length).toBeGreaterThan(sendsBefore);
      expect(h.journal().retry.automaticAttempt).toBe(attempt);
    }
  });

  it('re-establishes stability after a worker restart moves the generation', async (): Promise<void> => {
    // A restart is the case that cannot be recovered by re-reading: the generation is a per-worker
    // counter that starts again at zero, so the stored one can never match again.
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({
          attemptStartedAt: NOW,
          stablePasses: 2,
          targetGeneration: 7,
        }),
      }),
    );
    h.generation.value = 0;

    const refused: string = await finalizeAllDataClearV2(h.ports);

    expect(refused).toBe('retry-scheduled');
    // The stable evidence belonged to a target set that has moved, so it is spent with the
    // refusal. The next attempt is what re-establishes it against the counter this worker owns.
    expect(h.progress().stablePasses).toBe(0);

    const attempt: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );
    expect(attempt).toBe('stable');
    expect(h.progress().targetGeneration).toBe(0);

    await expect(finalizeAllDataClearV2(h.ports)).resolves.toBe('removed');
  });

  it('re-derives a command for a document that changed its URL under one', async (): Promise<void> => {
    const frozen: FrozenEpochResetCommand = {
      version: 1,
      command: 'reset-enforcement-epoch',
      tabId: 11,
      documentId: 'document-1',
      expectedUrl: TARGET_URL,
      operationId: RESET_OPERATION,
      enforcementEpoch: RESET_EPOCH,
    };
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({
          targets: {
            [FIRST_KEY]: { tabId: 11, documentId: 'document-1', expectedUrl: TARGET_URL },
          },
          commands: { [FIRST_KEY]: frozen },
        }),
      }),
    );
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    // A route change inside one document, which is every single page application: the document ID
    // survives and the URL does not.
    target.url = OTHER_URL;
    target.answer = 'stale-url';

    const failed: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );
    expect(failed).toBe('retry-scheduled');
    // The stale command is dropped, so the next attempt freezes this document again at the URL it
    // is really on. Without that there is no exit: the manual retry reissues the same stale URL.
    expect(h.progress().commands[FIRST_KEY]).toBeUndefined();

    target.answer = 'reset';
    h.clock.now = h.journal().retry.nextAttemptAt ?? NOW;
    const recovered: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(recovered).toBe('stable');
    expect(h.progress().commands[FIRST_KEY]?.expectedUrl).toBe(OTHER_URL);
  });

  it('tells an exhausted batch apart from a scheduled one when evidence is missing', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        retry: { batch: 1, automaticAttempt: 12, nextAttemptAt: null, lastError: 'reset-deadline' },
        resetProgress: resetProgress({
          attemptStartedAt: NOW,
          stablePasses: 2,
          targetGeneration: 7,
        }),
      }),
    );
    h.materialized.runtime = { drifted: true };

    // No alarm is coming, so telling the caller the clear is merely not finalizable yet is the
    // same lie as telling it a retry is scheduled.
    await expect(finalizeAllDataClearV2(h.ports)).resolves.toBe('exhausted');
  });

  it('keeps the frozen command when the answer disputes something other than the URL', async (): Promise<void> => {
    const frozen: FrozenEpochResetCommand = {
      version: 1,
      command: 'reset-enforcement-epoch',
      tabId: 11,
      documentId: 'document-1',
      expectedUrl: TARGET_URL,
      operationId: RESET_OPERATION,
      enforcementEpoch: RESET_EPOCH,
    };
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({
          targets: {
            [FIRST_KEY]: { tabId: 11, documentId: 'document-1', expectedUrl: TARGET_URL },
          },
          commands: { [FIRST_KEY]: frozen },
        }),
      }),
    );
    const target: FakeTargetV2 | undefined = h.tabs[0];
    if (target === undefined) throw new Error('the harness needs its target');
    // An answer no parser accepts: nothing about it says the frozen URL is wrong, so dropping the
    // command would throw away a durable record for a document that never disputed it.
    target.answer = 'mismatch';

    await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(h.progress().commands[FIRST_KEY]).toEqual(frozen);
  });

  it('records the evidence it was missing rather than stopping silently', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({
          attemptStartedAt: NOW,
          stablePasses: 2,
          targetGeneration: 7,
        }),
      }),
    );
    h.materialized.runtime = { drifted: true };

    const outcome: string = await finalizeAllDataClearV2(h.ports);

    // A finalization that answers nothing and schedules nothing is a clear that stops with the
    // barrier shut and no wake coming.
    expect(outcome).toBe('not-finalizable');
    expect(h.journal().retry.lastError).not.toBeNull();
    expect(h.journal().retry.nextAttemptAt).not.toBeNull();
  });
});

describe('browser reset restart recovery', (): void => {
  it('resumes on the pass budget the crashed attempt had written', async (): Promise<void> => {
    // The worker died after its second pass count was durable, so the restart owes one pass, and
    // one pass alone can never reach the two stable passes completion needs.
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({ attemptStartedAt: NOW, resolverPassCount: 2 }),
      }),
    );

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // One pass is all the crashed attempt's budget had left, and one pass can never reach the two
    // stable passes completion needs, so the attempt ends failed with its budget spent.
    expect(result).toBe('retry-scheduled');
    expect(h.sent).toHaveLength(1);
    expect(h.journal().retry.automaticAttempt).toBe(1);
    expect(h.progress().attemptStartedAt).toBeNull();
    expect(h.progress().resolverPassCount).toBe(0);
  });

  it('resumes the remaining time rather than restamping the attempt start', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({ attemptStartedAt: NOW, resolverPassCount: 1 }),
      }),
    );
    h.clock.now = NOW + DEADLINE_MS - 1;
    const answer = h.ports.transport.sendToDocument;
    h.ports.transport.sendToDocument = async (
      tabId: number,
      documentId: string,
      message: DocumentContentCommand,
    ): Promise<unknown> => {
      h.clock.now = NOW + DEADLINE_MS;
      return await answer(tabId, documentId, message);
    };

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // The deadline belongs to the attempt that began, not to the wake that resumed it: one pass
    // fits in what is left and the next is refused rather than measured from the restart.
    expect(result).toBe('retry-scheduled');
    expect(h.journal().retry.lastError).toBe('reset-deadline');
    expect(h.sent).toHaveLength(1);
    expect(h.progress().attemptStartedAt).toBeNull();
  });

  it('advances the schedule before any effect when it restarts past the deadline', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({ resetProgress: resetProgress({ attemptStartedAt: NOW }) }),
    );
    h.clock.now = NOW + DEADLINE_MS;

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    // The budget the crashed attempt owned is spent, so this wake schedules the next attempt and
    // does nothing else: no identity, no send, and no rewritten start.
    expect(result).toBe('retry-scheduled');
    expect(h.sent).toEqual([]);
    expect(h.ensureDeviceIdCalls).toEqual([]);
    expect(h.journal().retry.automaticAttempt).toBe(1);
    expect(h.journal().retry.lastError).toContain('reset-deadline');
    // The spent attempt is cleared with the failure, so the retry this schedules is a real one.
    expect(h.progress().attemptStartedAt).toBeNull();
    expect(h.progress().resolverPassCount).toBe(0);
  });

  it('advances the schedule before any effect when it restarts past its passes', async (): Promise<void> => {
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        resetProgress: resetProgress({ attemptStartedAt: NOW, resolverPassCount: 3 }),
      }),
    );

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('retry-scheduled');
    expect(h.sent).toEqual([]);
    expect(h.ensureDeviceIdCalls).toEqual([]);
    expect(h.journal().retry.automaticAttempt).toBe(1);
  });

  it('answers instead of raising when the batch is already exhausted', async (): Promise<void> => {
    // Spec 1355 has bootstrap resume the reset for any journal it finds, exhausted included, and
    // the result type declares `exhausted`, so a caller is entitled to that answer.
    const h: ResetHarnessV2 = harness(
      browserResetJournal({
        retry: { batch: 1, automaticAttempt: 12, nextAttemptAt: null, lastError: 'reset-deadline' },
        resetProgress: resetProgress({ attemptStartedAt: NOW, resolverPassCount: 3 }),
      }),
    );

    const result: string = await h.run(
      (token: DataClearLeaseToken): Promise<string> => runBrowserResetAttemptV2(h.ports, token),
    );

    expect(result).toBe('exhausted');
    expect(h.journal().retry.automaticAttempt).toBe(12);
  });
});

const DEADLINE_MS: number = 10_000;
