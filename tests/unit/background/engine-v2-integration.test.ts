import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import { main } from '../../../src/background/main';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import { emptyRuntime } from '../../../src/background/stores';
import {
  type ContentCommandResultV2,
  createContentEnforcementState,
  handleContentCommandV2,
} from '../../../src/content/enforcement-state';
import { startSession as startLegacySession } from '../../../src/core/session';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  rulesFromLists,
} from '../../../src/shared/constants';
import type {
  ContentEnforcementState,
  DocumentContentCommand,
} from '../../../src/shared/enforcement-v2';
import type { Request } from '../../../src/shared/messages';
import { isEventRecord, isSessionSnapshotV2 } from '../../../src/shared/runtime-validation';
import {
  LOCAL_BANK,
  LOCAL_EVENTS,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS,
  LOCAL_RUNTIME,
  LOCAL_RUNTIME_MIGRATION,
  LOCAL_RUNTIME_REJECTED,
  LOCAL_RUNTIME_SCHEMA,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
  LOCAL_SYNC_JOURNAL,
} from '../../../src/shared/storage-keys';
import { localDateStr, localMidnightAfter } from '../../../src/shared/time';
import type {
  DailyAgg,
  GateState,
  NormalizedSessionConfigV1,
  ScheduleEntryV2,
  SessionConfigV2,
  SessionSnapshotV2,
} from '../../../src/shared/types';
import {
  PREVIOUS_V2_ALLOWED_DOCUMENT_ID,
  PREVIOUS_V2_ALLOWED_TAB_ID,
  PREVIOUS_V2_ALLOWED_URL,
  PREVIOUS_V2_BLOCKED_DOCUMENT_ID,
  PREVIOUS_V2_BLOCKED_TAB_ID,
  PREVIOUS_V2_BLOCKED_URL,
  previousActiveRuntimeProfileV2,
  previousIdleRuntimeProfileV2,
  previousV2ClearCommand,
  previousV2DocumentId,
  previousV2TabId,
  previousV2TabUrl,
} from '../../fixtures/previous-v2-runtime-profile';
import { pendingTransition, timedFocusSession, transitionRuntime } from './runtime-v2-fixtures';

// The worker imports the content script as a built asset. Under vitest that module would evaluate
// against a document that does not exist here, so the asset is stubbed with its built path.
vi.mock('../../../src/content/index.iife.ts?script&iife', () => ({
  default: 'assets/index.iife-test.js',
}));

/** One document the fake browser is showing, which answers enforcement commands like the real one. */
interface FakeDocument {
  tabId: number;
  documentId: string;
  url: string;
  /** Every command the worker sent to this document, in order. */
  received: DocumentContentCommand[];
}

interface AlarmRow {
  name: string;
  when: number | null;
  periodInMinutes: number | null;
}

interface BootOptions {
  /** False makes the icon draw fail, which is what a worker without a canvas looks like. */
  canvas?: boolean;
  /** Documents the browser already holds when the worker boots. */
  documents?: FakeDocument[];
  /** What some of those documents already hold, from a command a previous worker sent them. */
  heldViews?: Array<[FakeDocument, FrozenDocumentCommand]>;
  /** Arms the registration-audit gate before `main()` runs. */
  holdRegistrationAudit?: boolean;
}

interface WorkerHarness {
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
  syncWrites: Array<Record<string, unknown>>;
  documents: FakeDocument[];
  alarms: Map<string, AlarmRow>;
  broadcasts: SessionSnapshotV2[];
  badges: string[];
  sounds: string[];
  /** Holds every sync write until the returned release runs, for interleaving a mode switch. */
  holdSyncWrites(): () => void;
  /** Holds the next sync-journal write, which parks an Engine commit before its runtime write. */
  holdJournalWrite(): () => void;
  /** Holds the content-registration audit, which parks a transition on its `prepared` stage. */
  holdRegistrationAudit(): void;
  releaseRegistrationAudit(): void;
  /** Every tab a cleanup reloaded, in order. */
  reloads: number[];
  notices: Array<{ title: string; body: string }>;
  send(request: Request, sender?: chrome.runtime.MessageSender): Promise<unknown>;
  fireAlarm(name: string): Promise<void>;
  navigate(document: FakeDocument, kind: 'committed' | 'history'): Promise<void>;
  runtime(): RuntimeStateV2;
  /** Every transition stage that became durable, in write order. */
  stages(): string[];
  /** The stored event log, newest last. */
  events(): Array<Record<string, unknown>>;
  /** Takes website access away, the way a revoked permission does. */
  revokeWebsiteAccess(): void;
  /** How many times the worker has written local storage, which is how a no-op wake is read. */
  writes(): number;
  /** Every mute the worker set, which is the sweep's own effect. */
  mutes(): Array<{ tabId: number; muted: boolean }>;
  /**
   * Puts a document on the view and tuple of a command it applied before this worker booted, the
   * way the real page still holds what the previous build sent it.
   */
  holdDocumentView(document: FakeDocument, command: FrozenDocumentCommand): void;
  /** How many commands the document refused, which the page answers with nothing at all. */
  rejectedAnswers(document: FakeDocument): number;
  settle(): Promise<void>;
}

const NOW: number = new Date(2026, 8, 3, 9, 0, 0, 0).getTime();
const CONTENT_SENDER: string = 'https://facebook.com/feed';
const SESSION_UUID: string = '10000000-0000-4000-8000-000000000001';
const DEFAULT_LISTS_BASELINE: string = rulesFromLists(DEFAULT_LISTS).baselineRevision;

let clock: number = NOW;

function tabSender(document: FakeDocument): chrome.runtime.MessageSender {
  return {
    tab: { id: document.tabId } as chrome.tabs.Tab,
    documentId: document.documentId,
    url: document.url,
  } as chrome.runtime.MessageSender;
}

/** Boots one worker over an in-memory browser and returns the handles a scenario drives it with. */
async function bootWorker(
  seed: Record<string, unknown> = {},
  options: BootOptions = {},
): Promise<WorkerHarness> {
  clock = NOW;
  const stages: string[] = [];
  let websiteAccess: boolean = true;
  let localWrites: number = 0;
  const muteCalls: Array<{ tabId: number; muted: boolean }> = [];
  /** What the browser would report for a tab this worker muted, which is what an unmute reads. */
  const mutedTabs: Map<number, boolean> = new Map<number, boolean>();
  const fakeTab = (row: FakeDocument): chrome.tabs.Tab =>
    ({
      id: row.tabId,
      url: row.url,
      mutedInfo: { muted: mutedTabs.get(row.tabId) ?? false, extensionId: 'test-extension' },
    }) as chrome.tabs.Tab;
  const local: Record<string, unknown> = structuredClone(seed);
  const sync: Record<string, unknown> = {};
  const syncWrites: Array<Record<string, unknown>> = [];
  const documents: FakeDocument[] = [...(options.documents ?? [])];
  /** What each `${tabId}:${documentId}` holds, kept by the real content state machine. */
  const documentStates: Map<string, ContentEnforcementState> = new Map<
    string,
    ContentEnforcementState
  >();
  /** How many commands each document refused. */
  const rejections: Map<string, number> = new Map<string, number>();
  const holdView = (document: FakeDocument, command: FrozenDocumentCommand): void => {
    documentStates.set(`${document.tabId}:${document.documentId}`, {
      enforcementEpoch: command.enforcementEpoch,
      retiredEnforcementEpochs: [],
      tuple: {
        enforcementEpoch: command.enforcementEpoch,
        sessionId: command.sessionId,
        reservedSessionId: command.reservedSessionId,
        basePolicyRevision: command.basePolicyRevision,
        runtimeRevision: command.runtimeRevision,
      },
      presentation: command.presentation,
      verdict: structuredClone(command.verdict),
      overlay: structuredClone(command.overlay),
    });
  };
  for (const [document, command] of options.heldViews ?? []) holdView(document, command);
  const alarms: Map<string, AlarmRow> = new Map<string, AlarmRow>();
  const broadcasts: SessionSnapshotV2[] = [];
  const badges: string[] = [];
  const sounds: string[] = [];
  const notices: Array<{ title: string; body: string }> = [];
  let syncWriteGate: Promise<void> | null = null;
  let journalWriteGate: Promise<void> | null = null;
  let auditGate: Promise<void> | null = null;
  let releaseAuditGate: () => void = (): void => undefined;
  const armAuditGate = (): void => {
    auditGate = new Promise<void>((resolve: () => void): void => {
      releaseAuditGate = resolve;
    });
  };
  if (options.holdRegistrationAudit === true) armAuditGate();
  const reloads: number[] = [];
  let messageListener:
    | ((
        request: unknown,
        sender: chrome.runtime.MessageSender,
        respond: (response: unknown) => void,
      ) => boolean)
    | null = null;
  let alarmListener: ((alarm: chrome.alarms.Alarm) => void) | null = null;
  let committedListener: ((details: unknown) => void) | null = null;
  let historyListener: ((details: unknown) => void) | null = null;

  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor() {
        if (options.canvas === false) throw new Error('no canvas in this worker');
      }

      getContext(): Record<string, unknown> {
        const noop = (): void => undefined;
        return new Proxy(
          { canvas: {} },
          {
            get: (target: Record<string, unknown>, key: string): unknown =>
              key === 'getImageData'
                ? (): { data: Uint8ClampedArray } => ({ data: new Uint8ClampedArray(4) })
                : (target[key] ?? noop),
            set: (): boolean => true,
          },
        );
      }
    },
  );
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: vi.fn(async (details: { text: string }): Promise<void> => {
        badges.push(details.text);
      }),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setIcon: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
    },
    alarms: {
      create: vi.fn(
        async (name: string, info: { when?: number; periodInMinutes?: number }): Promise<void> => {
          alarms.set(name, {
            name,
            when: info.when ?? null,
            periodInMinutes: info.periodInMinutes ?? null,
          });
        },
      ),
      get: vi.fn(async (name: string): Promise<chrome.alarms.Alarm | undefined> => {
        const row: AlarmRow | undefined = alarms.get(name);
        return row === undefined
          ? undefined
          : ({
              name: row.name,
              scheduledTime: row.when ?? clock,
              periodInMinutes: row.periodInMinutes ?? undefined,
            } as chrome.alarms.Alarm);
      }),
      clear: vi.fn(async (name: string): Promise<boolean> => alarms.delete(name)),
      onAlarm: {
        addListener: vi.fn((listener: (alarm: chrome.alarms.Alarm) => void): void => {
          alarmListener = listener;
        }),
      },
    },
    notifications: {
      // The API takes an optional id before the options, and the worker passes options alone.
      create: vi.fn(
        async (
          first: string | { title: string; message: string },
          second?: { title: string; message: string },
        ): Promise<void> => {
          const options = typeof first === 'string' ? second : first;
          if (options === undefined) throw new Error('a notification needs its options');
          notices.push({ title: options.title, body: options.message });
        },
      ),
    },
    offscreen: {
      hasDocument: vi.fn().mockResolvedValue(false),
      createDocument: vi.fn().mockResolvedValue(undefined),
      Reason: { AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' },
    },
    permissions: {
      contains: vi.fn(async (): Promise<boolean> => websiteAccess),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    runtime: {
      id: 'test-extension',
      getURL: vi.fn((path: string): string => `chrome-extension://test/${path}`),
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn(
          (
            listener: (
              request: unknown,
              sender: chrome.runtime.MessageSender,
              respond: (response: unknown) => void,
            ) => boolean,
          ): void => {
            messageListener = listener;
          },
        ),
      },
      sendMessage: vi.fn(async (message: unknown): Promise<void> => {
        const broadcast = message as {
          type?: string;
          snapshot?: SessionSnapshotV2;
          sound?: string;
        };
        if (broadcast.type === 'stateChanged' && broadcast.snapshot !== undefined) {
          broadcasts.push(structuredClone(broadcast.snapshot));
        }
        // The offscreen page is the audience for a sound, and this stub is standing in for it.
        if (broadcast.type === 'playSound' && broadcast.sound !== undefined) {
          sounds.push(broadcast.sound);
        }
      }),
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
      getRegisteredContentScripts: vi.fn(
        async (): Promise<chrome.scripting.RegisteredContentScript[]> => {
          if (auditGate !== null) await auditGate;
          return websiteAccess
            ? [{ id: 'focus-lock-content' } as chrome.scripting.RegisteredContentScript]
            : [];
        },
      ),
      registerContentScripts: vi.fn().mockResolvedValue(undefined),
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      // The work target lives here for the browser's lifetime. No scenario here chooses one.
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn() },
      local: {
        get: vi.fn(async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
          if (keys === null) return structuredClone(local);
          const requested: string[] = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key: string): boolean => Object.hasOwn(local, key))
              .map((key: string): [string, unknown] => [key, structuredClone(local[key])]),
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          if (journalWriteGate !== null && Object.hasOwn(items, LOCAL_SYNC_JOURNAL)) {
            // One-shot: the write this gate parks is the one in flight, and everything behind it
            // runs, which is what makes the two authorities overlap.
            const parked: Promise<void> = journalWriteGate;
            journalWriteGate = null;
            await parked;
          }
          localWrites += 1;
          Object.assign(local, structuredClone(items));
          const runtime: RuntimeStateV2 | null = parseRuntimeStateV2(local[LOCAL_RUNTIME]);
          const stage: string | undefined = runtime?.pendingEnforcementTransition?.stage;
          if (stage !== undefined && stages.at(-1) !== stage) stages.push(stage);
        }),
        remove: vi.fn(async (keys: string | string[]): Promise<void> => {
          for (const key of typeof keys === 'string' ? [keys] : keys) delete local[key];
        }),
      },
      sync: {
        get: vi.fn(async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
          if (keys === null) return structuredClone(sync);
          const requested: string[] = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key: string): boolean => Object.hasOwn(sync, key))
              .map((key: string): [string, unknown] => [key, structuredClone(sync[key])]),
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          if (syncWriteGate !== null) await syncWriteGate;
          syncWrites.push(structuredClone(items));
          Object.assign(sync, structuredClone(items));
        }),
        remove: vi.fn(async (keys: string | string[]): Promise<void> => {
          for (const key of typeof keys === 'string' ? [keys] : keys) delete sync[key];
        }),
        getBytesInUse: vi.fn().mockResolvedValue(0),
      },
    },
    tabs: {
      create: vi.fn().mockResolvedValue({}),
      get: vi.fn(async (tabId: number): Promise<chrome.tabs.Tab> => {
        const row: FakeDocument | undefined = documents.find(
          (candidate: FakeDocument): boolean => candidate.tabId === tabId,
        );
        if (row === undefined) throw new Error(`no tab ${tabId}`);
        return fakeTab(row);
      }),
      query: vi.fn(async (): Promise<chrome.tabs.Tab[]> => documents.map(fakeTab)),
      reload: vi.fn(async (tabId: number): Promise<void> => {
        reloads.push(tabId);
      }),
      sendMessage: vi.fn(
        async (
          tabId: number,
          message: DocumentContentCommand,
          options?: { documentId?: string },
        ): Promise<unknown> => {
          const row: FakeDocument | undefined = documents.find(
            (candidate: FakeDocument): boolean =>
              candidate.tabId === tabId && candidate.documentId === options?.documentId,
          );
          if (row === undefined) throw new Error('Could not establish connection.');
          row.received.push(structuredClone(message));
          // The document answers through the real content state machine, on the URL it is on, so
          // a command the page refuses is refused here too rather than answered `applied`.
          const key: string = `${tabId}:${row.documentId}`;
          const result: ContentCommandResultV2 = handleContentCommandV2(
            documentStates.get(key) ?? createContentEnforcementState(),
            message,
            row.url,
            clock,
          );
          documentStates.set(key, result.state);
          if (result.response === null) rejections.set(key, (rejections.get(key) ?? 0) + 1);
          return result.response ?? undefined;
        },
      ),
      update: vi.fn(async (tabId: number, props: { muted?: boolean }): Promise<unknown> => {
        if (props.muted !== undefined) {
          muteCalls.push({ tabId, muted: props.muted });
          mutedTabs.set(tabId, props.muted);
        }
        return {};
      }),
      onCreated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onReplaced: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    webNavigation: {
      getFrame: vi.fn(
        async (details: { tabId: number }): Promise<{ documentId: string } | null> => {
          const row: FakeDocument | undefined = documents.find(
            (candidate: FakeDocument): boolean => candidate.tabId === details.tabId,
          );
          return row === undefined ? null : { documentId: row.documentId };
        },
      ),
      onCommitted: {
        addListener: vi.fn((listener: (details: unknown) => void): void => {
          committedListener = listener;
        }),
      },
      onHistoryStateUpdated: {
        addListener: vi.fn((listener: (details: unknown) => void): void => {
          historyListener = listener;
        }),
      },
    },
    windows: {
      get: vi.fn().mockResolvedValue({ id: 1, incognito: false }),
      getCurrent: vi.fn().mockResolvedValue({ id: 1, incognito: false }),
      update: vi.fn().mockResolvedValue({}),
    },
  });

  main();
  const settle = async (): Promise<void> => {
    for (let turn: number = 0; turn < 400; turn += 1) await Promise.resolve();
  };
  await settle();

  return {
    local,
    sync,
    syncWrites,
    documents,
    alarms,
    broadcasts,
    badges,
    sounds,
    notices,
    reloads,
    holdRegistrationAudit: armAuditGate,
    releaseRegistrationAudit: (): void => {
      auditGate = null;
      releaseAuditGate();
    },
    holdJournalWrite: (): (() => void) => {
      let release: () => void = (): void => undefined;
      journalWriteGate = new Promise<void>((resolve: () => void): void => {
        release = resolve;
      });
      return release;
    },
    holdSyncWrites: (): (() => void) => {
      let release: () => void = (): void => undefined;
      syncWriteGate = new Promise<void>((resolve: () => void): void => {
        release = resolve;
      });
      return (): void => {
        syncWriteGate = null;
        release();
      };
    },
    settle,
    stages: (): string[] => [...stages],
    revokeWebsiteAccess: (): void => {
      websiteAccess = false;
    },
    writes: (): number => localWrites,
    mutes: (): Array<{ tabId: number; muted: boolean }> => [...muteCalls],
    holdDocumentView: holdView,
    rejectedAnswers: (document: FakeDocument): number =>
      rejections.get(`${document.tabId}:${document.documentId}`) ?? 0,
    events: (): Array<Record<string, unknown>> =>
      (local[LOCAL_EVENTS] as Array<Record<string, unknown>> | undefined) ?? [],
    runtime: (): RuntimeStateV2 => {
      const stored: RuntimeStateV2 | null = parseRuntimeStateV2(local[LOCAL_RUNTIME]);
      if (stored === null) throw new Error('the worker persisted no valid v2 runtime');
      return stored;
    },
    send: async (request: Request, sender?: chrome.runtime.MessageSender): Promise<unknown> => {
      if (messageListener === null) throw new Error('the worker registered no message listener');
      return await new Promise<unknown>((resolve: (value: unknown) => void): void => {
        const handled: boolean = (messageListener as NonNullable<typeof messageListener>)(
          request,
          sender ?? ({} as chrome.runtime.MessageSender),
          resolve,
        );
        if (!handled) resolve(undefined);
      });
    },
    fireAlarm: async (name: string): Promise<void> => {
      if (alarmListener === null) throw new Error('the worker registered no alarm listener');
      alarmListener({ name, scheduledTime: clock } as chrome.alarms.Alarm);
      await settle();
    },
    navigate: async (document: FakeDocument, kind: 'committed' | 'history'): Promise<void> => {
      const listener = kind === 'committed' ? committedListener : historyListener;
      if (listener === null) throw new Error('the worker registered no navigation listener');
      listener({
        tabId: document.tabId,
        frameId: 0,
        url: document.url,
        documentId: document.documentId,
      });
      await settle();
    },
  };
}

/** One schedule entry whose window is open at `at`, in the local day that instant belongs to. */
function openWindowEntry(at: number): ScheduleEntryV2 {
  const local: Date = new Date(at);
  const clock = (offsetMinutes: number): string => {
    const moment: Date = new Date(at + offsetMinutes * 60_000);
    return `${String(moment.getHours()).padStart(2, '0')}:${String(moment.getMinutes()).padStart(2, '0')}`;
  };
  return {
    id: 'open-window',
    days: [local.getDay()],
    start: clock(-30),
    end: clock(30),
    duration: { kind: 'window' },
    mode: 'blacklist',
    strictness: 'friction',
    cycling: null,
    intention: 'scheduled focus',
    enabled: true,
  };
}

/** The stored daily aggregate for one local date, whichever device wrote it. */
function aggregateFor(worker: WorkerHarness, date: string): DailyAgg | undefined {
  const entry: [string, unknown] | undefined = Object.entries(worker.local).find(
    ([key]: [string, unknown]): boolean => key.startsWith('agg:') && key.endsWith(`:${date}`),
  );
  return entry === undefined ? undefined : (entry[1] as DailyAgg);
}

/** The attempts the stored day has counted, which is what the popup and the overlay report. */
function attemptsOf(worker: WorkerHarness): number {
  const agg = worker.runtime().todayAgg;
  if (agg === null) return 0;
  return Object.values(agg.attempts).reduce(
    (total: number, count: number): number => total + count,
    0,
  );
}

/** The command map key one document owns. */
function documentKeyOf(document: FakeDocument): string {
  return `${document.tabId}:${document.documentId}`;
}

function indefiniteConfig(): SessionConfigV2 {
  return {
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    cycling: null,
    intention: 'Ship the cutover',
    source: 'manual',
    scheduleOccurrence: null,
    rules: {
      baselineRevision: 'baseline-1',
      baselineCategories: DEFAULT_LISTS.categories,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: {},
      permanentBlacklist: [],
      permanentAllowlist: [],
      sessionBlacklist: [],
      sessionAllowlist: [],
    },
  };
}

/**
 * The storage a profile on the previous build carries: everything a booted worker leaves behind,
 * the committed policy pointer included, with the runtime key holding the previous v2 shape under
 * the v2 schema marker. A seed with no pointer would take the legacy import at boot, which reads
 * the runtime through the v1 reader and is not the path a running profile takes.
 */
async function previousShapeStorage(runtime: unknown): Promise<Record<string, unknown>> {
  const booted: WorkerHarness = await bootWorker(installedSeed());
  return {
    ...structuredClone(booted.local),
    // The profile's session blocks the social category, and a session only blocks a category the
    // saved lists block, so the stored lists carry it too. A session is judged by the lists as
    // they stand, and a seed that disagreed with its own session would describe no real profile.
    [LOCAL_LISTS]: { ...DEFAULT_LISTS, categories: { ...DEFAULT_LISTS.categories, social: true } },
    [LOCAL_RUNTIME]: structuredClone(runtime),
    [LOCAL_RUNTIME_SCHEMA]: { runtimeSchemaVersion: 2 },
  };
}

/** A profile that finished setup with website blocking live, which is what a session needs. */
function installedSeed(): Record<string, unknown> {
  return {
    [LOCAL_INSTALL_MARKER]: { installedAt: NOW - 86_400_000, version: '1.0.0' },
    [LOCAL_SETTINGS]: DEFAULT_SETTINGS,
    [LOCAL_LISTS]: DEFAULT_LISTS,
    [LOCAL_SETUP]: {
      ...DEFAULT_SETUP,
      completed: true,
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
      storageMode: 'local',
    },
  };
}

describe('worker cutover to v2 session authority', (): void => {
  beforeEach((): void => {
    vi.unstubAllGlobals();
  });

  it('boots an empty v2 runtime with the schema marker and the tick alarm', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());

    expect(worker.runtime().session).toBeNull();
    expect(worker.runtime().runtimeSchemaVersion).toBe(2);
    expect(worker.local[LOCAL_RUNTIME_SCHEMA]).toEqual({ runtimeSchemaVersion: 2 });
    expect(worker.alarms.get('tick')?.periodInMinutes).toBe(1);

    const snapshot = (await worker.send({ type: 'getSnapshot' } as Request)) as SessionSnapshotV2;
    expect(snapshot.lifecycle.kind).toBe('idle');
  });

  it('refuses a v1 duration config with invalid-request', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const response = await worker.send({
      type: 'startSession',
      config: { ...indefiniteConfig(), durationMin: 25 },
    } as unknown as Request);

    expect(response).toEqual({ ok: false, code: 'invalid-request' });
  });

  it('walks the start transition, sends both views, and publishes an indefinite session', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });

    const response = await worker.send({
      type: 'startSession',
      config: indefiniteConfig(),
    } as Request);
    await worker.settle();

    expect(response).toEqual({ ok: true, code: 'ok' });
    const runtime: RuntimeStateV2 = worker.runtime();
    expect(runtime.session?.config.duration).toEqual({ kind: 'until-stopped' });
    expect(runtime.pendingEnforcementTransition).toBeNull();
    // An indefinite session has no phase boundary, so it owns no phase alarm.
    expect(worker.alarms.has('phase')).toBe(false);
    const presentations: string[] =
      worker.documents[0]?.received
        .filter((command): boolean => command.command === 'apply-enforcement')
        .map((command): string =>
          command.command === 'apply-enforcement' ? command.presentation : 'reset',
        ) ?? [];
    expect(presentations).toContain('starting');
    expect(presentations).toContain('active');
    const published: SessionSnapshotV2 | undefined = worker.broadcasts.at(-1);
    expect(published?.lifecycle.kind).toBe('active');
    // An indefinite session has no countdown, so the badge says it is on and nothing more.
    expect(worker.badges).toContain('ON');
  });

  it('keeps only the blocked document in the command map after a start', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const blocked: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    const allowed: FakeDocument = {
      tabId: 12,
      documentId: 'document-2',
      url: 'https://example.org/reading',
      received: [],
    };
    worker.documents.push(blocked, allowed);

    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // The sweep reached both pages, and the runtime keeps the address of the blocked one alone.
    // The rule is about the runtime, so the whole stored value is read, not two of its fields.
    expect(worker.runtime().session?.sessionId).not.toBeUndefined();
    expect(Object.keys(worker.runtime().documentCommands)).toEqual([documentKeyOf(blocked)]);
    expect(JSON.stringify(worker.runtime())).not.toContain(allowed.url);
    expect(allowed.received[0]?.command).toBe('reset-enforcement-epoch');
    // Every pass of both sweeps sent the allowed page the canonical clear and nothing else.
    const presentations: string[] = allowed.received
      .filter((command): boolean => command.command === 'apply-enforcement')
      .map((command): string =>
        command.command === 'apply-enforcement' ? command.presentation : 'reset',
      );
    expect(presentations.length).toBeGreaterThan(0);
    expect(presentations.every((presentation: string): boolean => presentation === 'clear')).toBe(
      true,
    );
    expect(Object.keys(worker.runtime().epochResetAcks).sort()).toEqual([
      documentKeyOf(blocked),
      documentKeyOf(allowed),
    ]);
  });

  it('boots the previous v2 runtime shape as its own runtime with no address left', async (): Promise<void> => {
    // The owner's storage the evening this landed: idle, 105 acknowledgements with an address,
    // 105 clear commands from the last cleanup. One of those tabs is still open, holding the
    // batch clear that build sent it.
    const profile = previousIdleRuntimeProfileV2({ date: localDateStr(NOW) });
    const open: FakeDocument = {
      tabId: previousV2TabId(0),
      documentId: previousV2DocumentId(0),
      url: previousV2TabUrl(0),
      received: [],
    };
    const worker: WorkerHarness = await bootWorker(await previousShapeStorage(profile), {
      documents: [open],
      heldViews: [[open, previousV2ClearCommand(0)]],
    });

    // Read as this worker's own runtime: nothing parked, nothing replaced, the day kept.
    expect(worker.local[LOCAL_RUNTIME_REJECTED]).toBeUndefined();
    const runtime: RuntimeStateV2 = worker.runtime();
    expect(runtime.session).toBeNull();
    expect(runtime.enforcementEpoch).toBe(profile.enforcementEpoch);
    expect(runtime.todayAgg).toEqual(profile.todayAgg);
    expect(runtime.documentCommands).toEqual({});
    expect(Object.keys(runtime.epochResetAcks)).toHaveLength(105);
    for (const record of Object.values(runtime.epochResetAcks)) {
      expect(record).not.toHaveProperty('url');
    }
    expect(worker.broadcasts.at(-1)?.lifecycle.kind).toBe('idle');

    // The open page acknowledged this epoch and holds a clear, so the idle runtime owes it nothing
    // and hands it nothing it would refuse.
    const pulled = (await worker.send(
      { type: 'getBlockState', url: open.url, docState: 'loaded' } as Request,
      tabSender(open),
    )) as { commands: DocumentContentCommand[] };
    await worker.settle();
    expect(pulled.commands).toEqual([]);
    expect(worker.rejectedAnswers(open)).toBe(0);
    expect(
      open.received.filter((command): boolean => command.command === 'apply-enforcement'),
    ).toEqual([]);
  });

  it('boots the previous v2 runtime shape mid-session and re-freezes without a refusal', async (): Promise<void> => {
    const profile = previousActiveRuntimeProfileV2();
    const blocked: FakeDocument = {
      tabId: PREVIOUS_V2_BLOCKED_TAB_ID,
      documentId: PREVIOUS_V2_BLOCKED_DOCUMENT_ID,
      url: PREVIOUS_V2_BLOCKED_URL,
      received: [],
    };
    const allowed: FakeDocument = {
      tabId: PREVIOUS_V2_ALLOWED_TAB_ID,
      documentId: PREVIOUS_V2_ALLOWED_DOCUMENT_ID,
      url: PREVIOUS_V2_ALLOWED_URL,
      received: [],
    };
    // Both pages hold what the previous build sent them: the blocked page its overlay, the allowed
    // page an active presentation with its own verdict, at the published tuple.
    const worker: WorkerHarness = await bootWorker(await previousShapeStorage(profile), {
      documents: [blocked, allowed],
      heldViews: [
        [blocked, profile.documentCommands[documentKeyOf(blocked)] as FrozenDocumentCommand],
        [allowed, profile.documentCommands[documentKeyOf(allowed)] as FrozenDocumentCommand],
      ],
    });

    expect(worker.local[LOCAL_RUNTIME_REJECTED]).toBeUndefined();
    const runtime: RuntimeStateV2 = worker.runtime();
    expect(runtime.session?.sessionId).toBe(profile.session?.sessionId);
    expect(runtime.session?.phase).toBe('focus');
    expect(worker.broadcasts.at(-1)?.lifecycle.kind).toBe('active');
    // Recovery froze the blocked page alone, at a revision above the one both pages held.
    expect(Object.keys(runtime.documentCommands)).toEqual([documentKeyOf(blocked)]);
    expect(runtime.runtimeRevision).toBeGreaterThan(profile.runtimeRevision);
    for (const record of Object.values(runtime.epochResetAcks)) {
      expect(record).not.toHaveProperty('url');
    }
    expect(worker.rejectedAnswers(blocked)).toBe(0);
    expect(worker.rejectedAnswers(allowed)).toBe(0);
    const allowedPresentations: string[] = allowed.received
      .filter((command): boolean => command.command === 'apply-enforcement')
      .map((command): string =>
        command.command === 'apply-enforcement' ? command.presentation : 'reset',
      );
    expect(allowedPresentations.length).toBeGreaterThan(0);
    expect(allowedPresentations.every((presentation): boolean => presentation === 'clear')).toBe(
      true,
    );
  });

  it('ends an indefinite session as manual-completed with no sound or notice', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    const sessionId: string = worker.runtime().session?.sessionId ?? '';

    const response = await worker.send({ type: 'requestSessionEnd' } as Request);
    await worker.settle();

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(worker.runtime().session).toBeNull();
    const events = worker.local[LOCAL_EVENTS] as Array<Record<string, unknown>>;
    expect(
      events.some(
        (event: Record<string, unknown>): boolean => event.eventId === `${sessionId}:end`,
      ),
    ).toBe(true);
    expect(worker.sounds).toHaveLength(0);
    expect(worker.notices).toHaveLength(0);
    expect(worker.broadcasts.at(-1)?.lifecycle.kind).toBe('idle');
  });

  it('answers getBlockState with the reset before the enforcement command', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(document);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // A document the start never reached has not acknowledged the epoch, so it is reset first.
    const fresh: FakeDocument = {
      tabId: 12,
      documentId: 'document-2',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(fresh);
    const first = (await worker.send(
      { type: 'getBlockState', url: fresh.url, docState: 'fresh' } as Request,
      tabSender(fresh),
    )) as { commands: DocumentContentCommand[] };
    // The pull records the acknowledgement the same way a push does, so no second reset goes out.
    const second = (await worker.send(
      { type: 'getBlockState', url: fresh.url, docState: 'loaded' } as Request,
      tabSender(fresh),
    )) as { commands: DocumentContentCommand[] };
    const stranger = (await worker.send(
      { type: 'getBlockState', url: document.url, docState: 'fresh' } as Request,
      { url: 'https://other.example/' } as chrome.runtime.MessageSender,
    )) as { commands: DocumentContentCommand[] };

    expect(first.commands.map((command): string => command.command)).toEqual([
      'reset-enforcement-epoch',
      'apply-enforcement',
    ]);
    // The page is on a blocked host, so what it is handed blocks it.
    const enforcement = first.commands.find(
      (command): boolean => command.command === 'apply-enforcement',
    );
    expect(enforcement?.command === 'apply-enforcement' ? enforcement.verdict.blocked : null).toBe(
      true,
    );
    expect(enforcement?.command === 'apply-enforcement' ? enforcement.presentation : null).toBe(
      'active',
    );
    expect(second.commands.map((command): string => command.command)).toEqual([
      'apply-enforcement',
    ]);
    expect(stranger.commands).toEqual([]);
  });

  it('records the stage sequence and the events one start and end produce', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });

    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    const sessionId: string = worker.runtime().session?.sessionId ?? '';
    const stages: string[] = worker.stages();

    // Every stage the machine passes through is durable, in order, and publication clears it.
    expect(stages).toEqual([
      'prepared',
      'registration-audited',
      'starting-verified',
      'committed-pending-verification',
      'alarm-ready',
      'active-verified',
    ]);
    expect(worker.runtime().pendingEnforcementTransition).toBeNull();

    await worker.send({ type: 'requestSessionEnd' } as Request);
    await worker.settle();

    // One start event and one end event, each with the id the session owns.
    const started = worker.events().filter((event): boolean => event.t === 'sessionStarted');
    const ended = worker.events().filter((event): boolean => event.t === 'sessionEnded');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ eventId: `${sessionId}:start`, sessionId });
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      eventId: `${sessionId}:end`,
      outcome: 'completed',
      reason: 'manual-completed',
    });
  });

  it('publishes both clocks and the phase alarm for a timed cycling start', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    const config: SessionConfigV2 = {
      ...indefiniteConfig(),
      duration: { kind: 'timed', minutes: 50 },
      cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    };

    await worker.send({ type: 'startSession', config } as Request);
    await worker.settle();

    const published: SessionSnapshotV2 | undefined = worker.broadcasts.at(-1);
    const activatedAt: number = published?.phaseStartedAt ?? 0;
    expect(published?.lifecycle.kind).toBe('active');
    expect(published?.phaseEndsAt).toBe(activatedAt + 1_500_000);
    expect(published?.sessionEndsAt).toBe(activatedAt + 3_000_000);
    // The phase boundary owns an alarm, and it is the boundary the snapshot reports.
    expect(worker.alarms.get('phase')?.when).toBe(activatedAt + 1_500_000);
  });

  it('records one attempt per blocked navigation and honors the debounce', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(document);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    await worker.send(
      { type: 'getBlockState', url: document.url, docState: 'fresh' } as Request,
      tabSender(document),
    );
    await worker.settle();
    const afterFirst: number = attemptsOf(worker);
    // The same document again inside the debounce window records nothing more.
    await worker.send(
      { type: 'getBlockState', url: document.url, docState: 'fresh' } as Request,
      tabSender(document),
    );
    await worker.settle();

    expect(afterFirst).toBe(1);
    expect(attemptsOf(worker)).toBe(1);
    expect(worker.events().filter((event): boolean => event.t === 'attempt')).toHaveLength(1);
  });

  it('keeps the badge when the icon cannot be drawn', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed(), { canvas: false });
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });

    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // Drawing needs a canvas and the badge needs nothing, so one failing must not take the other.
    expect(worker.badges).toContain('ON');
  });

  it('validates a long mixed event log without recursing', async (): Promise<void> => {
    const legacy: unknown = {
      t: 'sessionStarted',
      at: NOW,
      source: 'manual',
      mode: 'blacklist',
      strictness: 'flexible',
      durationMin: 25,
      intention: 'legacy',
    };
    const started: unknown = {
      version: 2,
      t: 'sessionStarted',
      eventId: `${SESSION_UUID}:start`,
      at: NOW,
      sessionId: SESSION_UUID,
      source: 'manual',
      mode: 'blacklist',
      strictness: 'flexible',
      duration: { kind: 'until-stopped' },
      intention: 'v2',
      scheduleOccurrence: null,
    };
    const ended: unknown = {
      version: 2,
      t: 'sessionEnded',
      eventId: `${SESSION_UUID}:end`,
      at: NOW + 1_000,
      sessionId: SESSION_UUID,
      outcome: 'completed',
      reason: 'manual-completed',
      focusedMs: 1_000,
      duration: { kind: 'until-stopped' },
      source: 'manual',
      scheduleOccurrence: null,
    };
    const log: unknown[] = [];
    for (let index: number = 0; index < 10_000; index += 1) {
      log.push([legacy, started, ended][index % 3]);
    }

    expect(log.every(isEventRecord)).toBe(true);
    // A legacy shape wearing the v2 version but no id is still not a v2 record.
    expect(isEventRecord({ ...(legacy as Record<string, unknown>), version: 2 })).toBe(false);
  });

  it('migrates a stored v1 session and publishes it as active', async (): Promise<void> => {
    // The worker reads the real clock, so the stored session is seeded against it: a session that
    // already ran out would migrate straight into its closure instead.
    const startedAt: number = Date.now() - 300_000;
    const legacyConfig: NormalizedSessionConfigV1 = {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 25,
      cycling: null,
      intention: 'migrated session',
      source: 'manual',
      scheduleEntryId: null,
      rules: {
        baselineRevision: DEFAULT_LISTS_BASELINE,
        baselineCategories: DEFAULT_LISTS.categories,
        categories: { ...DEFAULT_LISTS.categories, social: true },
        exclusions: {},
        permanentBlacklist: [],
        permanentAllowlist: [],
        sessionBlacklist: [],
        sessionAllowlist: [],
      },
    };
    const legacyRuntime: Record<string, unknown> = {
      ...emptyRuntime(Date.now()),
      session: startLegacySession(legacyConfig, startedAt, SESSION_UUID),
    };
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_RUNTIME]: legacyRuntime,
    });

    // The stored v1 session is the authority the boot migrates, and recovery publishes it.
    const runtime: RuntimeStateV2 = worker.runtime();
    expect(runtime.runtimeSchemaVersion).toBe(2);
    expect(runtime.session?.config.duration).toEqual({ kind: 'timed', minutes: 25 });
    expect(runtime.session?.config.intention).toBe('migrated session');
    expect(runtime.session?.sessionId).toBe(SESSION_UUID);
    // The migration checkpoint is cleared once the migration it recorded is finished.
    expect(worker.local[LOCAL_RUNTIME_MIGRATION]).toBeUndefined();
    expect(worker.local[LOCAL_RUNTIME_SCHEMA]).toEqual({ runtimeSchemaVersion: 2 });
  });

  it('serves a navigation that races a start in the order the epoch requires', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const open: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    const arriving: FakeDocument = {
      tabId: 12,
      documentId: 'document-2',
      url: 'https://facebook.com/groups',
      received: [],
    };
    worker.documents.push(open);

    // The content-registration audit is the step between `prepared` and `registration-audited`, so
    // holding it parks the start exactly where a page may not be sent anything yet.
    worker.holdRegistrationAudit();
    const starting: Promise<unknown> = worker.send({
      type: 'startSession',
      config: indefiniteConfig(),
    } as Request);
    await worker.settle();
    expect(worker.stages().at(-1)).toBe('prepared');

    worker.documents.push(arriving);
    await worker.navigate(arriving, 'committed');
    expect(arriving.received).toEqual([]);

    worker.releaseRegistrationAudit();
    await starting;
    await worker.settle();

    // Nothing was lost and nothing arrived out of order: the document that navigated mid-start is
    // reset first, because it has acknowledged no epoch, then shown the starting view, and the
    // active view is what it ends on.
    const shown: string[] = arriving.received.map((command): string =>
      command.command === 'apply-enforcement' ? command.presentation : command.command,
    );
    expect(shown[0]).toBe('reset-enforcement-epoch');
    expect(shown[1]).toBe('starting');
    expect(shown.at(-1)).toBe('active');
    // The starting views all precede the active ones: a document never goes back to the view the
    // transition was showing before it published.
    expect(shown.lastIndexOf('starting')).toBeLessThan(shown.indexOf('active'));
  });

  it('claims a stopped page, shows it, and reloads it when the session ends', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(document);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // A fresh blocked navigation is a page that never rendered, so the worker claims it.
    await worker.send(
      { type: 'getBlockState', url: document.url, docState: 'fresh' } as Request,
      tabSender(document),
    );
    await worker.settle();
    expect(worker.runtime().tabStates[11]?.stoppedDocumentId).toBe('document-1');

    // The claim reaches the page through the next frozen view it is sent.
    await worker.send({ type: 'updateTheme', theme: 'dark' } as Request);
    await worker.settle();
    const command = worker.runtime().documentCommands[documentKeyOf(document)];
    const overlay = command?.overlay;
    expect(overlay?.presentation === 'active' ? overlay.copy.stoppedPage : null).toBe(
      'This page did not load. It will load by itself when the session ends.',
    );

    const reloadsBefore: number = worker.reloads.length;
    await worker.send({ type: 'requestSessionEnd' } as Request);
    await worker.settle();

    // The closure carries the claim, reloads the page it stopped, and gives the tab back.
    expect(worker.reloads.slice(reloadsBefore)).toContain(11);
    expect(worker.runtime().tabStates).toEqual({});
    expect(worker.runtime().session).toBeNull();
  });

  it('migrates a scheduled v1 session with a bare marker into its cleanup', async (): Promise<void> => {
    const startedAt: number = Date.now() - 300_000;
    const legacyConfig: NormalizedSessionConfigV1 = {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 25,
      cycling: null,
      intention: 'scheduled run',
      source: 'schedule',
      scheduleEntryId: 'entry-1',
      rules: {
        baselineRevision: DEFAULT_LISTS_BASELINE,
        baselineCategories: DEFAULT_LISTS.categories,
        categories: { ...DEFAULT_LISTS.categories, social: true },
        exclusions: {},
        permanentBlacklist: [],
        permanentAllowlist: [],
        sessionBlacklist: [],
        sessionAllowlist: [],
      },
    };
    // The v1 writer stored a bare entry id, which names no local start date, so the occurrence
    // this session claims cannot be rebuilt and migration is forbidden to invent one.
    const legacyRuntime: Record<string, unknown> = {
      ...emptyRuntime(Date.now()),
      scheduleActiveEntryId: 'entry-1',
      session: startLegacySession(legacyConfig, startedAt, SESSION_UUID),
      tabStates: {
        11: { muteUrl: null, priorMuted: null, stoppedDocumentId: 'document-1' },
        // A tab the browser has not restored yet. Its claim cannot be read, so it keeps the closure.
        99: {
          muteUrl: 'https://facebook.com/restoring',
          priorMuted: false,
          stoppedDocumentId: null,
        },
      },
    };

    const worker: WorkerHarness = await bootWorker(
      { ...installedSeed(), [LOCAL_RUNTIME]: legacyRuntime },
      { documents: [{ tabId: 11, documentId: 'document-1', url: CONTENT_SENDER, received: [] }] },
    );
    await worker.settle();

    // This asserted a two-phase sequence until a probe refuted the premise underneath it: `cleanup`
    // on the first pass because tab 99 was not restored yet, then `idle` once a retry found it and
    // released the mute. The retry can never find it. Mute a tab from the extension, close the
    // browser and reopen it, and the tab returns `muted: false` with no `extensionId`, under a new
    // identifier. So the claim this migration carries names an effect the relaunch already undid,
    // and holding the closure open for it would refuse every session start for the hours its retry
    // budget takes to expire. Finishing in one pass is the requirement, not an optimisation.
    //
    // The cleanup-then-idle sequence itself is not lost with this scenario. It is projected in
    // lifecycle-projection-v2 and transition-runner-v2, and driven end to end by the tab a browser
    // still lists that answers nothing, which is the case where a closure is genuinely still owed.
    const lifecycles: string[] = worker.broadcasts.map(
      (snapshot: SessionSnapshotV2): string => snapshot.lifecycle.kind,
    );
    expect(lifecycles.at(-1)).toBe('idle');
    const runtime: RuntimeStateV2 = worker.runtime();
    expect(runtime.session).toBeNull();
    expect(runtime.pendingClosure).toBeNull();
    const ended = worker.events().find((event): boolean => event.t === 'sessionEnded') as
      | Record<string, unknown>
      | undefined;
    expect(ended).toMatchObject({
      reason: 'invalid-active-state',
      outcome: 'canceled',
      scheduleOccurrence: null,
    });
    // The stopped page the v1 runtime was holding is reloaded and its claim released, which is the
    // cleanup the closure carried in its seed.
    expect(worker.reloads).toContain(11);
    expect(worker.runtime().tabStates).toEqual({});
  });

  it('migrates a scheduled v1 session whose marker names its occurrence', async (): Promise<void> => {
    const startedAt: number = Date.now() - 300_000;
    const entryId: string = 'entry-1';
    const marker: string = `${entryId}@${localDateStr(startedAt)}`;
    const legacyConfig: NormalizedSessionConfigV1 = {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 25,
      cycling: null,
      intention: 'scheduled run',
      source: 'schedule',
      scheduleEntryId: entryId,
      rules: {
        baselineRevision: DEFAULT_LISTS_BASELINE,
        baselineCategories: DEFAULT_LISTS.categories,
        categories: { ...DEFAULT_LISTS.categories, social: true },
        exclusions: {},
        permanentBlacklist: [],
        permanentAllowlist: [],
        sessionBlacklist: [],
        sessionAllowlist: [],
      },
    };
    const legacyRuntime: Record<string, unknown> = {
      ...emptyRuntime(Date.now()),
      scheduleActiveEntryId: marker,
      session: startLegacySession(legacyConfig, startedAt, SESSION_UUID),
    };

    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_RUNTIME]: legacyRuntime,
    });

    // The exact `entryId@YYYY-MM-DD` marker is the one form that names an occurrence, so this
    // session has a v2 config and survives the migration instead of closing.
    const runtime: RuntimeStateV2 = worker.runtime();
    expect(runtime.session?.config.scheduleOccurrence).toEqual({
      version: 1,
      token: marker,
      entryId,
      localStartDate: localDateStr(startedAt),
    });
    expect(worker.broadcasts.at(-1)?.lifecycle.kind).toBe('active');
  });

  it('refreshes every live view when the theme changes', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(document);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    const before: RuntimeStateV2 = worker.runtime();
    const beforeCommand = before.documentCommands[documentKeyOf(document)];
    const sentBefore: number = document.received.length;

    await worker.send({ type: 'updateTheme', theme: 'dark' } as Request);
    await worker.settle();

    // A theme change is a live update: new operation, higher revision, and the documents get it.
    const after: RuntimeStateV2 = worker.runtime();
    const afterCommand = after.documentCommands[documentKeyOf(document)];
    expect(after.runtimeRevision).toBeGreaterThan(before.runtimeRevision);
    expect(afterCommand?.operationId).not.toBe(beforeCommand?.operationId);
    expect(afterCommand?.runtimeRevision).toBe(after.runtimeRevision);
    expect(document.received.length).toBeGreaterThan(sentBefore);
  });

  it('dispatches each alarm to the owner its name names', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    const sessionId: string | undefined = worker.runtime().session?.sessionId;

    // A name no alarm owns is ignored: nothing settles and nothing publishes.
    const beforeUnknown: number = worker.broadcasts.length;
    const writesBefore: number = worker.writes();
    await worker.fireAlarm('not-an-alarm');
    expect(worker.broadcasts.length).toBe(beforeUnknown);
    expect(worker.writes()).toBe(writesBefore);

    // The tick settles and publishes, and the cleanup alarms find no journal of their own.
    await worker.fireAlarm('tick');
    expect(worker.broadcasts.length).toBeGreaterThan(beforeUnknown);
    await worker.fireAlarm('transition-cleanup');
    await worker.fireAlarm('closure-cleanup');

    expect(worker.runtime().session?.sessionId).toBe(sessionId);
    expect(worker.runtime().pendingClosure).toBeNull();
    expect(parseRuntimeStateV2(worker.runtime())).not.toBeNull();
  });

  it('closes the session when website access is revoked', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    worker.revokeWebsiteAccess();
    await worker.send({ type: 'reconcileWebsiteAccess' } as Request);
    await worker.settle();

    expect(worker.runtime().session).toBeNull();
    const ended = worker
      .events()
      .filter((event): boolean => event.t === 'sessionEnded')
      .at(-1);
    expect(ended).toMatchObject({ reason: 'website-access-lost', outcome: 'canceled' });
  });

  it('never broadcasts a config for a lifecycle that is not active', async (): Promise<void> => {
    // A committed transition is the case that matters: the session is durable while the lifecycle
    // is not active, so a projection that read the session would leak its config to every page.
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_RUNTIME]: transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession(),
      }),
    });
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.fireAlarm('tick');

    expect(worker.broadcasts.length).toBeGreaterThan(0);
    for (const snapshot of worker.broadcasts) {
      if (snapshot.lifecycle.kind === 'active') continue;
      expect(snapshot.config).toBeNull();
      expect(snapshot.phase).toBe('idle');
      expect(snapshot.sessionEndsAt).toBeNull();
    }
    expect(
      worker.broadcasts.some((snapshot): boolean => snapshot.lifecycle.kind !== 'active'),
    ).toBe(true);
  });

  it('keeps the v2 start event when a v1 attempt is appended after it', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(document);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    const sessionId: string = worker.runtime().session?.sessionId ?? '';

    // The attempt rides the retained engine's writer, which must be the v2 one.
    await worker.send(
      { type: 'getBlockState', url: document.url, docState: 'fresh' } as Request,
      tabSender(document),
    );
    await worker.settle();

    const events = worker.events();
    expect(events.filter((event): boolean => event.t === 'attempt')).toHaveLength(1);
    expect(
      events.filter(
        (event): boolean => event.t === 'sessionStarted' && event.eventId === `${sessionId}:start`,
      ),
    ).toHaveLength(1);
  });

  it('recovers a restarted worker without repeating the start event', async (): Promise<void> => {
    const first: WorkerHarness = await bootWorker(installedSeed());
    first.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await first.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await first.settle();
    const sessionId: string = first.runtime().session?.sessionId ?? '';
    const storedAfterStart: Record<string, unknown> = structuredClone(first.local);

    // The same storage, a new worker: recovery resumes the session it finds.
    const second: WorkerHarness = await bootWorker(storedAfterStart);

    expect(second.runtime().session?.sessionId).toBe(sessionId);
    expect(second.broadcasts.at(-1)?.lifecycle.kind).toBe('active');
    expect(second.events().filter((event): boolean => event.t === 'sessionStarted')).toHaveLength(
      1,
    );
  });

  it('mutes a blocked tab through the sweep', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });

    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // A blocked page is muted by the sweep, which is the effect the frozen command does not carry.
    expect(worker.mutes()).toContainEqual({ tabId: 11, muted: true });
  });

  it('earns pause budget as focus settles', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // The worker reads the real clock, so the test moves it: a minute of focus, then a tick.
    const startedAt: number = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt + 60_000);
    try {
      await worker.fireAlarm('tick');
    } finally {
      vi.useRealTimers();
    }

    const runtime: RuntimeStateV2 = worker.runtime();
    expect(runtime.accruedFocusMs).toBeGreaterThan(0);
    expect(runtime.todayAgg?.focusMs ?? 0).toBeGreaterThan(0);
    expect(worker.events().some((event): boolean => event.t === 'budgetEarned')).toBe(true);
    expect(
      (worker.local[LOCAL_BANK] as { balanceMs: number } | undefined)?.balanceMs ?? 0,
    ).toBeGreaterThan(0);
  });

  it('reports the bank the read instant has earned', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    const started: number = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(started + 120_000);
    let snapshot: SessionSnapshotV2;
    try {
      snapshot = (await worker.send({ type: 'getSnapshot' } as Request)) as SessionSnapshotV2;
    } finally {
      vi.useRealTimers();
    }

    // The read settles the core state through its instant, and the bank is what that focus earns,
    // so the balance the popup reads is the balance the user has, not the last settled one.
    expect(snapshot.bankMs).toBeGreaterThan(0);
    expect((worker.local[LOCAL_BANK] as { balanceMs: number } | undefined)?.balanceMs ?? 0).toBe(0);
  });

  it('keeps a hard session blocking while storage switches mode', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(document);
    await worker.send({
      type: 'startSession',
      config: {
        ...indefiniteConfig(),
        strictness: 'hard',
        duration: { kind: 'timed', minutes: 25 },
      },
    } as Request);
    await worker.settle();

    const release: () => void = worker.holdSyncWrites();
    const switching: Promise<unknown> = worker.send({
      type: 'setStorageMode',
      storageMode: 'sync',
      deleteRemote: false,
    } as Request);
    await worker.settle();

    // The barrier is closed and holding, and the page asks what it must show. A storage move is
    // not an erase: the session is still running, so the answer is the command it is running on.
    const answer = (await worker.send(
      { type: 'getBlockState', url: document.url, docState: 'loaded' } as Request,
      tabSender(document),
    )) as { commands: DocumentContentCommand[] };
    release();
    await switching;
    await worker.settle();

    const applied: DocumentContentCommand | undefined = answer.commands.at(-1);
    expect(applied?.command).toBe('apply-enforcement');
    expect(applied?.command === 'apply-enforcement' ? applied.presentation : null).toBe('active');
    expect(worker.local[LOCAL_SETUP]).toMatchObject({ storageMode: 'sync' });
  });

  it('starts an already open schedule window at boot', async (): Promise<void> => {
    // Noon, so the window this entry names sits inside one local day.
    const noon: Date = new Date();
    noon.setHours(12, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(noon.getTime());
      const worker: WorkerHarness = await bootWorker({
        ...installedSeed(),
        [LOCAL_SETTINGS]: { ...DEFAULT_SETTINGS, schedule: [openWindowEntry(noon.getTime())] },
      });
      await worker.settle();

      // The boot resolves its journals and then checks the schedule, so a window that is already
      // open is a session now rather than a session a minute from now.
      const runtime: RuntimeStateV2 = worker.runtime();
      expect(runtime.session?.config.source).toBe('schedule');
      expect(runtime.session?.config.scheduleOccurrence?.entryId).toBe('open-window');
      expect(worker.alarms.get('tick')?.periodInMinutes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts an open window as soon as the schedule is saved', async (): Promise<void> => {
    const noon: Date = new Date();
    noon.setHours(12, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(noon.getTime());
      const worker: WorkerHarness = await bootWorker(installedSeed());
      expect(worker.runtime().session).toBeNull();

      await worker.send({
        type: 'updateSettings',
        settings: { ...DEFAULT_SETTINGS, schedule: [openWindowEntry(noon.getTime())] },
      } as Request);
      await worker.settle();

      // The write is durable before the check reads it, and both run in one policy mutation.
      expect(worker.runtime().session?.config.source).toBe('schedule');
      expect(worker.runtime().session?.config.intention).toBe('scheduled focus');
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers a snapshot while a storage transition holds the barrier', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    const release: () => void = worker.holdSyncWrites();
    const switching: Promise<unknown> = worker.send({
      type: 'setStorageMode',
      storageMode: 'sync',
      deleteRemote: false,
    } as Request);
    await worker.settle();

    // The popup reads through the barrier: the snapshot is a settle at an instant, not a write, and
    // this is the window the popup has to show what the transition is doing.
    const snapshot = (await worker.send({ type: 'getSnapshot' } as Request)) as SessionSnapshotV2;
    release();
    await switching;
    await worker.settle();

    expect(isSessionSnapshotV2(snapshot)).toBe(true);
    expect(snapshot.lifecycle.kind).toBe('active');
  });

  it('recovers on a boot that finds a pending all-data clear', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_SETUP]: {
        ...(installedSeed()[LOCAL_SETUP] as object),
        dataClear: { status: 'pending', scope: 'all', phase: 'remote' },
      },
    });
    await worker.settle();

    // Recovery is what lets the controller publish at all. A worker that skipped it would go dark
    // for its whole life: no broadcast and no badge for anything that happened after the clear.
    expect(worker.broadcasts.length).toBeGreaterThan(0);
    expect(worker.broadcasts.at(-1)?.lifecycle.kind).toBe('idle');
  });

  it('retains the browser reset epoch after all-data finalization', async (): Promise<void> => {
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    const worker: WorkerHarness = await bootWorker(installedSeed(), { documents: [document] });
    await worker.settle();
    document.received.length = 0;
    expect(await worker.send({ type: 'clearFocusLockData', scope: 'all' })).toMatchObject({
      ok: true,
      status: 'cleared',
    });
    await worker.settle();
    const reset: DocumentContentCommand | undefined = document.received.find(
      (command: DocumentContentCommand): boolean => command.command === 'reset-enforcement-epoch',
    );
    expect(reset).toBeDefined();
    expect(worker.runtime().enforcementEpoch).toBe(reset?.enforcementEpoch);
  });

  it('leaves the epoch reset for the push that delivers it', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // A tab the session never reached has acknowledged no epoch. The sweep in front of the push
    // reads whether it is blocked, and reading must not take the reset the push still owes it.
    const arriving: FakeDocument = {
      tabId: 12,
      documentId: 'document-2',
      url: 'https://facebook.com/groups',
      received: [],
    };
    worker.documents.push(arriving);
    await worker.navigate(arriving, 'committed');
    await worker.settle();

    // The reset comes first and the command it prepares follows it. Anything after that is the
    // live refresh the attempt count triggers, which this document is already on the epoch for.
    expect(arriving.received.slice(0, 2).map((command): string => command.command)).toEqual([
      'reset-enforcement-epoch',
      'apply-enforcement',
    ]);
  });

  it('clears the tabs a rejected runtime left behind at boot', async (): Promise<void> => {
    const stranded: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    // A stored runtime the reader refuses is replaced by an empty one under a fresh epoch, so no
    // open document has acknowledged anything and the boot sweep owes every one of them a reset.
    const worker: WorkerHarness = await bootWorker(
      {
        ...installedSeed(),
        [LOCAL_RUNTIME_SCHEMA]: { runtimeSchemaVersion: 2 },
        [LOCAL_RUNTIME]: { version: 2, nonsense: true },
      },
      { documents: [stranded] },
    );
    await worker.settle();

    expect(worker.runtime().session).toBeNull();
    // The reset comes first and the clear follows it, so the page the rejected runtime stranded is
    // released rather than left holding whatever overlay it had.
    expect(stranded.received[0]?.command).toBe('reset-enforcement-epoch');
    const applied: DocumentContentCommand | undefined = stranded.received[1];
    expect(applied?.command === 'apply-enforcement' ? applied.presentation : null).toBe('clear');
  });

  it('moves the attempt count every open overlay is showing', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const watching: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(watching);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    const shown = (): number | null => {
      const command = worker.runtime().documentCommands[documentKeyOf(watching)];
      const overlay = command?.overlay;
      return overlay?.presentation === 'active' ? overlay.attemptsToday : null;
    };
    expect(shown()).toBe(0);

    // A second tab hits a blocked page. The count is a live number, so the overlay this tab is
    // already showing has to move with it rather than keep the number it froze.
    const other: FakeDocument = {
      tabId: 12,
      documentId: 'document-2',
      url: 'https://facebook.com/groups',
      received: [],
    };
    worker.documents.push(other);
    await worker.navigate(other, 'committed');
    await worker.settle();

    expect(attemptsOf(worker)).toBe(1);
    expect(shown()).toBe(1);
  });

  it('keeps an ended session ended when an attempt write is still in flight', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(document);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    // The attempt commit is parked in the middle of its writes, which is where the Engine used to
    // be holding a runtime clone it had taken before them.
    const release: () => void = worker.holdJournalWrite();
    const attempting: Promise<void> = worker.navigate(document, 'committed');
    await worker.settle();

    // The user ends the session while that write is in flight, and the controller commits it.
    await worker.send({ type: 'requestSessionEnd' } as Request);
    await worker.settle();
    release();
    await attempting;
    await worker.settle();

    expect(worker.runtime().session).toBeNull();
    expect(worker.runtime().pendingClosure).toBeNull();
    // The attempt the write carried is still counted: neither authority loses the other's work.
    expect(worker.runtime().attemptDebounce).not.toEqual({});
    expect(attemptsOf(worker)).toBe(1);
  });

  it('counts the focus of a session that follows one that ended', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    // The clock is frozen before the session starts, so the two minutes below are exactly two.
    const started: number = Date.now();
    try {
      await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
      await worker.settle();
      vi.setSystemTime(started + 2 * 60_000);
      await worker.fireAlarm('tick');
      await worker.send({ type: 'requestSessionEnd' } as Request);
      await worker.settle();
      const afterFirst: number = worker.runtime().todayAgg?.focusMs ?? 0;

      // The closure resets the accrual to zero, so the second session starts counting from nothing.
      await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
      await worker.settle();
      vi.setSystemTime(started + 5 * 60_000);
      await worker.fireAlarm('tick');
      await worker.settle();

      expect(afterFirst).toBe(2 * 60_000);
      expect(worker.runtime().todayAgg?.focusMs).toBe(5 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('crosses a midnight with a sweep still owed', async (): Promise<void> => {
    const today: string = localDateStr(Date.now());
    const midnight: number = localMidnightAfter(today);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(midnight - 10 * 60_000);
      const worker: WorkerHarness = await bootWorker(installedSeed());
      worker.documents.push({
        tabId: 11,
        documentId: 'document-1',
        url: CONTENT_SENDER,
        received: [],
      });
      await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
      await worker.settle();

      // One refused sweep leaves blocking work pending, which is what makes the next commit sweep.
      const query = chrome.tabs.query as unknown as ReturnType<typeof vi.fn>;
      query.mockRejectedValueOnce(new Error('tab query refused once'));
      await worker.send({
        type: 'updateSettings',
        settings: { ...DEFAULT_SETTINGS, theme: 'dark' },
      } as Request);
      await worker.settle();

      // The tick crosses the boundary with that work still owed, and finishes: the rollover writes
      // nothing from inside the controller queue, so no sweep is started while that queue is held.
      // What the rollover leaves to the tick is pinned in engine.test.ts, where the writes are
      // counted rather than inferred from a clock.
      vi.setSystemTime(midnight + 60_000);
      await worker.fireAlarm('tick');
      await worker.settle();

      expect(worker.runtime().date).toBe(localDateStr(midnight + 60_000));
      expect(worker.runtime().session).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('splits the focus a session carries across a local midnight', async (): Promise<void> => {
    const today: string = localDateStr(Date.now());
    const midnight: number = localMidnightAfter(today);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(midnight - 10 * 60_000);
      const worker: WorkerHarness = await bootWorker(installedSeed());
      const document: FakeDocument = {
        tabId: 11,
        documentId: 'document-1',
        url: CONTENT_SENDER,
        received: [],
      };
      worker.documents.push(document);
      await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
      await worker.settle();
      // One blocked navigation before midnight, so the day that ends has an attempt of its own.
      await worker.navigate(document, 'committed');
      await worker.settle();

      vi.setSystemTime(midnight + 5 * 60_000);
      await worker.fireAlarm('tick');
      await worker.settle();
      await worker.send({ type: 'requestSessionEnd' } as Request);
      await worker.settle();

      const finished: DailyAgg | undefined = aggregateFor(worker, today);
      const next: DailyAgg | undefined = aggregateFor(worker, localDateStr(midnight + 5 * 60_000));
      // The day that ended keeps everything it counted before the boundary, the focus included.
      expect(Object.keys(finished?.attempts ?? {})).toEqual(['facebook.com']);
      expect(finished?.sessionsStarted).toBe(1);
      expect(finished?.pauseMsEarned).toBe(10 * 60_000 * DEFAULT_SETTINGS.pause.earnRatio);
      expect(finished?.focusMs).toBe(10 * 60_000);
      // The new day counts the session that ended on it and the five minutes it ran into it.
      expect(next?.sessionsStarted ?? 0).toBe(0);
      expect(next?.sessionsCompleted).toBe(1);
      expect(next?.focusMs).toBe(5 * 60_000);
      expect(finished?.date).toBe(today);
      expect(next?.date).toBe(localDateStr(midnight + 5 * 60_000));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not sweep or persist when a captured gate confirmation is stale', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_BANK]: { balanceMs: 10 * 60_000 },
    });
    await worker.send({ type: 'startSession', config: indefiniteConfig() });
    await worker.settle();
    await worker.send({ type: 'openGate', gate: 'pause', host: null });
    await worker.settle();
    const gate: GateState | null = worker.runtime().gate;
    if (gate === null) throw new Error('Expected a pause gate');
    const expectedGate: GateState = { ...gate, openedAt: gate.openedAt - 1 };
    const before: RuntimeStateV2 = structuredClone(worker.runtime());
    const writes: number = worker.writes();
    expect(
      await worker.send({ type: 'confirmGate', typedPhrase: null, expectedGate }),
    ).toMatchObject({ ok: false, code: 'no-active-gate' });
    await worker.settle();
    expect(worker.runtime()).toEqual(before);
    expect(worker.writes()).toBe(writes);
  });

  it('clears the pages a pause is taken over', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_BANK]: { balanceMs: 10 * 60_000 },
    });
    const blocked: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(blocked);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    expect(worker.runtime().documentCommands[documentKeyOf(blocked)]?.presentation).toBe('active');

    const started: number = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    let confirmed: unknown;
    try {
      await worker.send({ type: 'openGate', gate: 'pause', host: null } as Request);
      vi.setSystemTime(started + DEFAULT_SETTINGS.gate.delayMs + 1_000);
      const expectedGate: GateState | null = worker.runtime().gate;
      if (expectedGate === null) throw new Error('Expected a pause gate');
      confirmed = await worker.send({ type: 'confirmGate', typedPhrase: null, expectedGate });
      await worker.settle();
    } finally {
      vi.useRealTimers();
    }

    // The confirmation answers on its own, and the clear it owes runs behind it: a paused session
    // blocks nothing, so the page it was holding is released.
    expect(confirmed).toMatchObject({ ok: true });
    expect(worker.runtime().session?.phase).toBe('paused');
    expect(worker.runtime().documentCommands[documentKeyOf(blocked)]?.presentation).toBe('clear');
    expect(worker.mutes()).toContainEqual({ tabId: 11, muted: false });
  });

  it('unlocks the registrable host, not the subdomain the overlay sent', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_BANK]: { balanceMs: 10 * 60_000 },
    });
    const mobile: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: 'https://m.facebook.com/feed',
      received: [],
    };
    const desktop: FakeDocument = {
      tabId: 12,
      documentId: 'document-2',
      url: 'https://www.facebook.com/feed',
      received: [],
    };
    worker.documents.push(mobile, desktop);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();

    const started: number = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // The overlay sends the hostname the page is on, which is the subdomain the user is looking at.
      await worker.send({
        type: 'openGate',
        gate: 'unlockSite',
        host: 'm.facebook.com',
      } as Request);
      vi.setSystemTime(started + DEFAULT_SETTINGS.gate.delayMs + 1_000);
      const expectedGate: GateState | null = worker.runtime().gate;
      if (expectedGate === null) throw new Error('Expected an unlock gate');
      await worker.send({ type: 'confirmGate', typedPhrase: null, expectedGate });
      await worker.settle();
    } finally {
      vi.useRealTimers();
    }

    // The unlock is paid for once and covers the site, so the desktop page the same session blocks
    // is cleared too rather than staying blocked behind a subdomain the user never typed.
    expect(worker.runtime().unlocks.map((unlock): string => unlock.host)).toEqual(['facebook.com']);
    expect(worker.runtime().documentCommands[documentKeyOf(desktop)]?.presentation).toBe('clear');
    expect(worker.runtime().documentCommands[documentKeyOf(mobile)]?.presentation).toBe('clear');
  });

  it('refuses a manual start while website blocking is unavailable', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      // Setup never finished, which is what `websiteBlockingReady` reports on. The browser still
      // grants the permission, so the transition's audit is happy and only this gate can refuse.
      [LOCAL_SETUP]: { ...(installedSeed()[LOCAL_SETUP] as object), completed: false },
    });
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });

    const answer = (await worker.send({
      type: 'startSession',
      config: indefiniteConfig(),
    } as Request)) as { ok: boolean; code?: string };

    // A session that cannot block anything is not a session, so the start is refused before it
    // prepares anything: no stage is written, no journal survives, and nothing is published.
    expect(answer).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(worker.stages()).toEqual([]);
    expect(worker.runtime().session).toBeNull();
    expect(worker.runtime().pendingEnforcementTransition).toBeNull();
    expect(worker.broadcasts.at(-1)?.lifecycle.kind).toBe('idle');
  });

  it('honors the completion sound and notification the user turned off', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_SETTINGS]: {
        ...DEFAULT_SETTINGS,
        sessionCompleteNotification: false,
        sounds: { ...DEFAULT_SETTINGS.sounds, sessionComplete: false },
      },
    });
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({
      type: 'startSession',
      config: { ...indefiniteConfig(), duration: { kind: 'timed', minutes: 25 } },
    } as Request);
    await worker.settle();

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const when: number | null | undefined = worker.alarms.get('phase')?.when;
      vi.setSystemTime((when ?? Date.now()) + 1_000);
      await worker.fireAlarm('phase');
      await worker.settle();
    } finally {
      vi.useRealTimers();
    }

    // The session finished, and the two things the user switched off stayed off.
    expect(worker.runtime().session).toBeNull();
    expect(worker.sounds).not.toContain('sessionComplete');
    expect(worker.notices).toEqual([]);
  });

  it('clears the badge when a timed session completes', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({
      type: 'startSession',
      config: {
        ...indefiniteConfig(),
        duration: { kind: 'timed', minutes: 30 },
        cycling: { focusMin: 10, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
      },
    } as Request);
    await worker.settle();
    expect(worker.badges.at(-1)).not.toBe('');

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Every boundary the session plans, in order, the way the alarm would deliver them.
      for (let boundary: number = 0; boundary < 10; boundary += 1) {
        const when: number | null | undefined = worker.alarms.get('phase')?.when;
        if (when === undefined || when === null) break;
        vi.setSystemTime(when + 1_000);
        await worker.fireAlarm('phase');
        await worker.settle();
        if (worker.runtime().session === null) break;
      }
    } finally {
      vi.useRealTimers();
    }

    // The session is over, so the toolbar says nothing: a stale countdown outlives the session it
    // was counting and tells the user they are still locked.
    expect(worker.runtime().session).toBeNull();
    expect(worker.badges.at(-1)).toBe('');
    // Every boundary it crossed is in the log and was heard.
    expect(
      worker.events().filter((event): boolean => event.t === 'phase').length,
    ).toBeGreaterThanOrEqual(2);
    expect(worker.sounds).toContain('breakStart');
    expect(worker.sounds).toContain('breakEnd');
    expect(worker.sounds).toContain('sessionComplete');
  });

  it('reblocks an expired unlock on the next tick', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_BANK]: { balanceMs: 10 * 60_000 },
    });
    const document: FakeDocument = {
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    };
    worker.documents.push(document);
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    expect(worker.runtime().documentCommands[documentKeyOf(document)]?.presentation).toBe('active');

    const started: number = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await worker.send({
        type: 'openGate',
        gate: 'unlockSite',
        host: 'facebook.com',
      } as Request);
      vi.setSystemTime(started + DEFAULT_SETTINGS.gate.delayMs + 1_000);
      const expectedGate: GateState | null = worker.runtime().gate;
      if (expectedGate === null) throw new Error('Expected an unlock gate');
      expect(
        (await worker.send({ type: 'confirmGate', typedPhrase: null, expectedGate })) as {
          ok: boolean;
        },
      ).toMatchObject({ ok: true });
      await worker.settle();
      expect(worker.runtime().documentCommands[documentKeyOf(document)]?.presentation).toBe(
        'clear',
      );
      // Indefinite focus owns no phase alarm, and an unlock expiry is not a boundary, so a commit
      // taken while the unlock is live leaves the singleton absent instead of filling it with a
      // time no session asked for.
      vi.setSystemTime(started + DEFAULT_SETTINGS.gate.delayMs + 60_000);
      await worker.fireAlarm('tick');
      await worker.settle();
      expect(worker.runtime().unlocks).toHaveLength(1);
      expect(worker.alarms.get('phase')).toBeUndefined();

      // No alarm owns the expiry: `phase` belongs to the session boundary alone, so the unlock ends
      // by instant and the minute tick is what puts the page back behind the overlay.
      vi.setSystemTime(started + DEFAULT_SETTINGS.pause.unlockMs + 120_000);
      await worker.fireAlarm('tick');
      await worker.settle();
    } finally {
      vi.useRealTimers();
    }

    expect(worker.runtime().documentCommands[documentKeyOf(document)]?.presentation).toBe('active');
  });

  it('counts a resisted gate in the day it happened on', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    worker.documents.push({
      tabId: 11,
      documentId: 'document-1',
      url: CONTENT_SENDER,
      received: [],
    });
    await worker.send({
      type: 'startSession',
      config: {
        ...indefiniteConfig(),
        strictness: 'friction',
        duration: { kind: 'timed', minutes: 25 },
      },
    } as Request);
    await worker.settle();

    expect(
      (await worker.send({ type: 'openEndGate' } as Request)) as { ok: boolean },
    ).toMatchObject({
      ok: true,
    });
    const expectedGate: GateState | null = worker.runtime().gate;
    if (expectedGate === null) throw new Error('Expected a cancellation gate');
    await worker.send({ type: 'abandonGate', expectedGate });
    await worker.settle();

    // Stats read the day, not the log, so an event a commit carries is folded into it.
    expect(worker.runtime().todayAgg?.resisted ?? 0).toBe(1);
    expect(worker.runtime().todayAgg?.sessionsStarted ?? 0).toBe(1);
  });

  it('force ends a Friction session through the worker and sweeps blocking away', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker({
      ...installedSeed(),
      [LOCAL_SETTINGS]: {
        ...DEFAULT_SETTINGS,
        gate: { ...DEFAULT_SETTINGS.gate, requireTypedPhrase: true, allowForceEnd: true },
      },
    });
    await worker.send({
      type: 'startSession',
      config: {
        ...indefiniteConfig(),
        strictness: 'friction',
        duration: { kind: 'timed', minutes: 25 },
      },
    } as Request);
    await worker.settle();

    expect(await worker.send({ type: 'openEndGate' } as Request)).toMatchObject({ ok: true });
    const gate: GateState | null = worker.runtime().gate;
    expect(gate?.forceEndAvailable).toBe(true);
    expect(gate?.requiredPhrase).not.toBeNull();

    expect(await worker.send({ type: 'forceEndGate' } as Request)).toEqual({
      ok: true,
      code: 'ok',
    });
    await worker.settle();

    expect(worker.runtime().session).toBeNull();
    expect(worker.runtime().gate).toBeNull();
    expect(worker.runtime().pendingClosure).toBeNull();
  });

  it('never writes runtime or event keys into sync', async (): Promise<void> => {
    const worker: WorkerHarness = await bootWorker(installedSeed());
    await worker.send({ type: 'startSession', config: indefiniteConfig() } as Request);
    await worker.settle();
    await worker.send({ type: 'requestSessionEnd' } as Request);
    await worker.settle();

    const forbidden: string[] = [
      LOCAL_RUNTIME,
      LOCAL_EVENTS,
      LOCAL_RUNTIME_SCHEMA,
      LOCAL_RUNTIME_MIGRATION,
    ];
    for (const write of worker.syncWrites) {
      for (const key of Object.keys(write)) expect(forbidden).not.toContain(key);
      expect(JSON.stringify(write)).not.toContain('pendingEnforcementTransition');
    }
  });
});
