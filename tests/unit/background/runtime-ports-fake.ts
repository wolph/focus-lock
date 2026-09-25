/**
 * The shared in-memory `RuntimePortsV2` every runtime engine test drives. It is a test fixture and
 * never a production builder: nothing here constructs a domain value a runner should build.
 *
 * Two properties make it useful as an oracle rather than a stub. Every `writeRuntime` and `commit`
 * value is validated with `parseRuntimeStateV2` and throws on rejection, so a runner that would
 * persist an invalid runtime fails the test that drove it rather than the one that reads it back.
 * And the transport answers by echoing the command it received, so the real transport classifier
 * decides the outcome and a test only scripts the deviations it cares about.
 */

import { expect } from 'vitest';
import type {
  AlarmNameV2,
  AlarmPortsV2,
  ScheduledAlarmV2,
} from '../../../src/background/alarms-v2';
import type { ContentTransportPortsV2 } from '../../../src/background/content-transport-v2';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import type { EnforcementTargetPortsV2 } from '../../../src/background/enforcement-targets-v2';
import {
  assertCommitPreconditionsV2,
  type RuntimeCommitInputV2,
} from '../../../src/background/runtime-checkpoint-v2';
import type { RuntimePortsV2 } from '../../../src/background/runtime-ports-v2';
import type { CleanupTabClaim, RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import type { ScheduleRunnerPortsV2 } from '../../../src/background/schedule-runner-v2';
import {
  type ContentCommandResultV2,
  createContentEnforcementState,
  handleContentCommandV2,
} from '../../../src/content/enforcement-state';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import type { CompiledMatcher } from '../../../src/core/matcher';
import { compileSessionMatcher, evaluateUrl } from '../../../src/core/matcher';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type {
  ContentEnforcementState,
  DocumentContentCommand,
} from '../../../src/shared/enforcement-v2';
import { CoreError } from '../../../src/shared/errors';
import type { SoundId } from '../../../src/shared/messages';
import { localDateStr } from '../../../src/shared/time';
import type {
  BankState,
  DailyAgg,
  GateSettings,
  ListsConfig,
  PauseEconomy,
  ScheduleOccurrenceRef,
  SessionMode,
  SessionRuleSnapshot,
  SessionSnapshotV2,
  SettingsV2,
  SiteUnlock,
  ThemeMode,
  Verdict,
} from '../../../src/shared/types';

/** One scripted tab row. `documentId` null means the resolver finds no top-frame document. */
export interface FakeTabRowV2 {
  tabId: number;
  url: string | null;
  documentId?: string | null;
}

/** Answers one send. Return the raw content response, or throw to model a transport failure. */
export type FakeResponderV2 = (message: DocumentContentCommand) => unknown;

export interface FakeSendV2 {
  tabId: number;
  documentId: string;
  message: DocumentContentCommand;
}

export interface RuntimePortsFakeOptionsV2 {
  now?: number;
  /** Consumed in order by `newId`. Exhausting it is a test error, not a silent fallback. */
  ids?: readonly string[];
  tabs?: readonly FakeTabRowV2[];
  /** One tab set per `queryTopFrameTabs` call, then `tabs` for every later call. */
  tabSets?: ReadonlyArray<readonly FakeTabRowV2[]>;
  audit?: 'ready' | 'website-access-lost' | 'content-registration-failed';
  generation?: number;
  theme?: ThemeMode;
  economy?: PauseEconomy;
  gateSettings?: GateSettings;
  bank?: BankState;
  deviceId?: string;
  attemptsToday?: number;
  openOccurrences?: readonly ScheduleOccurrenceRef[];
  aggregates?: Record<string, DailyAgg>;
  /** How a created alarm reads back. `exact` is the browser behaving. */
  alarmReadBack?: 'exact' | 'missing' | 'other-time';
  /** Refuses exactly this many read-backs first, then behaves per `alarmReadBack`. */
  alarmReadBackFailures?: number;
  /** Runs when an alarm is created, so a test can move the clock during the alarm stage. */
  onAlarmCreate?: () => void;
  /** Runs while `auditEnforcement` is in flight, for interleaving a write during that await. */
  onAudit?: () => Promise<void> | void;
  /** Runs while `queryTopFrameTabs` is in flight, for interleaving a write during that await. */
  onQueryTabs?: () => Promise<void> | void;
  /** Runs while `loadAggregates` is in flight, for interleaving a write during that await. */
  onLoadAggregates?: () => Promise<void> | void;
  /**
   * Rejects every `writeRuntime` with the `CoreError` the runners' own `requireValid` raises, which
   * is what a durable write that will not land looks like from inside a command.
   */
  failWrites?: boolean;
  /**
   * Documents that already hold an epoch, keyed `${tabId}:${documentId}`, for a scenario that
   * starts mid-session rather than driving the reset handshake itself. Without an entry a document
   * answers `reset-required` until it is sent a reset, which is what a real one does.
   */
  documentEpochs?: Record<string, string>;
}

export interface RuntimePortsFakeV2 extends RuntimePortsV2 {
  /** Every persisted runtime, in write order, including the ones a commit produced. */
  writes: RuntimeStateV2[];
  commits: RuntimeCommitInputV2[];
  sends: FakeSendV2[];
  errors: unknown[];
  /** Every boundary the controller asked the Engine to roll over, in order. */
  rollovers: number[];
  /**
   * How many runtimes had landed at each rollover call, aligned with `rollovers` by index. It is
   * what pins a settle against the close it must precede, the same way `alarmCallWrites` pins an
   * alarm against its write.
   */
  rolloverCallWrites: number[];
  /** When true, `rolloverCheck` rebases `date` the way the retained Engine would. */
  onRolloverAdvanceDate?: boolean;
  auditCalls: number;
  alarmCalls: Array<{ kind: 'create' | 'createPeriodic' | 'clear'; name: AlarmNameV2 }>;
  /**
   * How many runtimes had landed at each alarm call, aligned with `alarmCalls` by index. It is what
   * pins an alarm against the write it must precede, and it stays out of `alarmCalls` so the
   * recorded call shape keeps comparing equal to a plain `{ kind, name }`.
   */
  alarmCallWrites: number[];
  setNow(at: number): void;
  advance(ms: number): void;
  setTabs(tabs: readonly FakeTabRowV2[]): void;
  scriptTabSets(sets: ReadonlyArray<readonly FakeTabRowV2[]>): void;
  setGeneration(generation: number): void;
  bumpGeneration(): void;
  setAudit(result: 'ready' | 'website-access-lost' | 'content-registration-failed'): void;
  setAlarmReadBack(mode: 'exact' | 'missing' | 'other-time'): void;
  /**
   * Holds every later commit at its checkpoint write, which is where production sits while it
   * replays. It is the only way to produce the state a domain write has to survive: a durable
   * runtime carrying a commit checkpoint whose projection describes the value before that write.
   */
  holdCommitReplay(): void;
  /** Finishes the held commit the way the replay does, by clearing the checkpoint it wrote. */
  completeCommitReplay(): void;
  /** Answers every send for one `${tabId}:${documentId}` target. */
  respondForDocument(tabId: number, documentId: string, responder: FakeResponderV2): void;
  /** Puts a document in the epoch it would hold after answering that epoch's reset. */
  setDocumentEpoch(tabId: number, documentId: string, epoch: string): void;
  /** What the document holds, as `src/content/enforcement-state.ts` holds it. Null before any send. */
  documentState(tabId: number, documentId: string): ContentEnforcementState | null;
  /** How many commands the document refused, which the page answers with nothing at all. */
  rejectedAnswers(tabId: number, documentId: string): number;
  /**
   * Applies an array the router handed the page from `getBlockState`, in order. A pull never goes
   * through the transport, so a scenario that pulls has to apply the answer itself, exactly as the
   * content script does before it renders.
   */
  applyPulled(tabId: number, documentId: string, commands: readonly DocumentContentCommand[]): void;
  /** Answers every send that carries one operation ID. Checked before the document responder. */
  respondForOperation(operationId: string, responder: FakeResponderV2): void;
  /** The last runtime this fake persisted, which is what `runtime()` returns. */
  current(): RuntimeStateV2;
  /** The stage of the durable transition at each write, for asserting the write sequence. */
  stages(): Array<string | null>;
}

const DEFAULT_DEVICE_ID: string = 'device-1';

/**
 * The clock is the fake's most load-bearing input: it decides whether a budget is spent, whether an
 * alarm is due, and which local day a settle credits. There is no default worth guessing, and the
 * one this had was accidental, so a caller that forgets it is told rather than run at ten
 * milliseconds past the epoch.
 */
function requiredNow(now: number | undefined): number {
  if (now === undefined) {
    throw new Error('the ports fake needs an explicit `now`: every scenario has a clock');
  }
  return now;
}

export function createRuntimePortsFakeV2(
  initial: RuntimeStateV2,
  options: RuntimePortsFakeOptionsV2 = {},
): RuntimePortsFakeV2 {
  const state: FakeStateV2 = {
    runtime: requireValidRuntime(initial, 'the fake was seeded with an invalid runtime'),
    now: requiredNow(options.now),
    ids: [...(options.ids ?? [])],
    tabs: [...(options.tabs ?? [])],
    tabSets: (options.tabSets ?? []).map((set: readonly FakeTabRowV2[]): FakeTabRowV2[] => [
      ...set,
    ]),
    audit: options.audit ?? 'ready',
    generation: options.generation ?? 0,
    aggregates: structuredClone(options.aggregates ?? {}),
    alarmReadBack: options.alarmReadBack ?? 'exact',
    alarmReadBackFailures: options.alarmReadBackFailures ?? 0,
    bank: structuredClone(options.bank ?? { balanceMs: 0 }),
    alarms: new Map<AlarmNameV2, ScheduledAlarmV2>(),
    byDocument: new Map<string, FakeResponderV2>(),
    byOperation: new Map<string, FakeResponderV2>(),
    documents: seededDocumentStates(initial, options.documentEpochs),
    rejections: new Map<string, number>(),
    holdCommitReplay: false,
  };
  const writes: RuntimeStateV2[] = [];
  const commits: RuntimeCommitInputV2[] = [];
  const sends: FakeSendV2[] = [];
  const errors: unknown[] = [];
  const rollovers: number[] = [];
  const rolloverCallWrites: number[] = [];
  const alarmCalls: Array<{ kind: 'create' | 'createPeriodic' | 'clear'; name: AlarmNameV2 }> = [];
  const alarmCallWrites: number[] = [];

  const fake: RuntimePortsFakeV2 = {
    writes,
    commits,
    sends,
    errors,
    rollovers,
    rolloverCallWrites,
    auditCalls: 0,
    alarmCalls,
    alarmCallWrites,

    now: (): number => state.now,
    newId: (): string => {
      const id: string | undefined = state.ids.shift();
      if (id === undefined) throw new Error('the ports fake ran out of scripted IDs');
      return id;
    },
    runtime: (): RuntimeStateV2 => structuredClone(state.runtime),
    writeRuntime: async (next: RuntimeStateV2): Promise<void> => {
      if (options.failWrites === true) {
        throw new CoreError('invalid-rule', 'the storage boundary refused the runtime write');
      }
      state.runtime = requireValidRuntime(next, 'writeRuntime received an invalid runtime');
      writes.push(structuredClone(state.runtime));
    },
    commit: async (input: RuntimeCommitInputV2): Promise<RuntimeStateV2> => {
      // The same three preconditions production applies before any write, so a caller that
      // committed a stale projection fails here rather than at the storage boundary in production.
      assertCommitPreconditionsV2(state.runtime, input);
      commits.push(structuredClone(input));
      // Production writes the bank the checkpoint carries whatever `syncBank` says, so the fake
      // does too: `syncBank` selects the sync mirror, not whether the local bank lands.
      state.bank = structuredClone(input.bank);
      // Production commits in two phases: it writes the runtime with the checkpoint attached, then
      // replays that checkpoint and clears it. Both are composed here, so the intermediate state is
      // a real value the fake can hold rather than a step it skips. A caller that holds the replay
      // keeps the checkpointed runtime durable, which is the window every domain write has to
      // survive and which no suite could produce while this collapsed into one step.
      const checkpointed: RuntimeStateV2 = requireValidRuntime(
        structuredClone({
          ...state.runtime,
          ...input.projection,
          commitCheckpoint: {
            version: 2,
            checkpointId: input.checkpointId,
            projection: structuredClone(input.projection),
            bank: structuredClone(input.bank),
            events: structuredClone(input.events),
            syncBank: input.syncBank,
            aggregateSets: structuredClone(input.aggregateSets),
            aggregateRemoves: [...input.aggregateRemoves],
          },
        }),
        'commit produced an invalid checkpointed runtime',
      );
      if (state.holdCommitReplay) {
        state.runtime = checkpointed;
        writes.push(structuredClone(state.runtime));
        return structuredClone(state.runtime);
      }
      state.runtime = requireValidRuntime(
        structuredClone({ ...checkpointed, commitCheckpoint: null }),
        'commit produced an invalid runtime',
      );
      writes.push(structuredClone(state.runtime));
      return structuredClone(state.runtime);
    },
    auditEnforcement: async (): Promise<
      'ready' | 'website-access-lost' | 'content-registration-failed'
    > => {
      fake.auditCalls += 1;
      await options.onAudit?.();
      return state.audit;
    },
    compileMatcher: (rules: SessionRuleSnapshot, mode: SessionMode): CompiledMatcher =>
      compileSessionMatcher(rules, ALL_CATEGORIES, mode),
    verdictFor: (matcher: CompiledMatcher, url: string, unlocks: readonly SiteUnlock[]): Verdict =>
      evaluateUrl(matcher, url, [...unlocks], state.now),
    targets: targetPorts(state, options.onQueryTabs),
    transport: transportPorts(state, sends),
    alarms: alarmPorts(state, alarmCalls, options.onAlarmCreate, (): void => {
      alarmCallWrites.push(writes.length);
    }),
    theme: (): ThemeMode => options.theme ?? 'dark',
    economy: (): PauseEconomy => structuredClone(options.economy ?? DEFAULT_SETTINGS.pause),
    gateSettings: (): GateSettings =>
      structuredClone(options.gateSettings ?? DEFAULT_SETTINGS.gate),
    bank: (): BankState => structuredClone(state.bank),
    deviceId: (): string => options.deviceId ?? DEFAULT_DEVICE_ID,
    attemptsToday: (): number => options.attemptsToday ?? 0,
    openOccurrencesAt: (): ScheduleOccurrenceRef[] =>
      structuredClone([...(options.openOccurrences ?? [])]),
    loadAggregates: async (keys: readonly string[]): Promise<Record<string, DailyAgg>> => {
      await options.onLoadAggregates?.();
      const found: Record<string, DailyAgg> = {};
      for (const key of keys) {
        const stored: DailyAgg | undefined = state.aggregates[key];
        if (stored !== undefined) found[key] = structuredClone(stored);
      }
      return found;
    },
    rolloverCheck: async (boundary: number): Promise<void> => {
      rollovers.push(boundary);
      rolloverCallWrites.push(writes.length);
      // The retained Engine owns `date` and `todayAgg`. A test that wants the loop to make
      // progress asks the fake to stand in for that bookkeeping.
      if (!fake.onRolloverAdvanceDate) return;
      state.runtime = requireValidRuntime(
        { ...structuredClone(state.runtime), date: localDateStr(boundary) },
        'rolloverCheck produced an invalid runtime',
      );
      writes.push(structuredClone(state.runtime));
    },
    reportError: (error: unknown): void => {
      errors.push(error);
    },

    setNow: (at: number): void => {
      state.now = at;
    },
    advance: (ms: number): void => {
      state.now += ms;
    },
    setTabs: (tabs: readonly FakeTabRowV2[]): void => {
      state.tabs = [...tabs];
    },
    scriptTabSets: (sets: ReadonlyArray<readonly FakeTabRowV2[]>): void => {
      state.tabSets = sets.map((set: readonly FakeTabRowV2[]): FakeTabRowV2[] => [...set]);
    },
    setGeneration: (generation: number): void => {
      state.generation = generation;
    },
    bumpGeneration: (): void => {
      state.generation += 1;
    },
    setAudit: (result: 'ready' | 'website-access-lost' | 'content-registration-failed'): void => {
      state.audit = result;
    },
    holdCommitReplay: (): void => {
      state.holdCommitReplay = true;
    },
    completeCommitReplay: (): void => {
      state.holdCommitReplay = false;
      if (state.runtime.commitCheckpoint === null) return;
      state.runtime = requireValidRuntime(
        structuredClone({ ...state.runtime, commitCheckpoint: null }),
        'the replayed commit produced an invalid runtime',
      );
      writes.push(structuredClone(state.runtime));
    },
    setAlarmReadBack: (mode: 'exact' | 'missing' | 'other-time'): void => {
      state.alarmReadBack = mode;
    },
    respondForDocument: (tabId: number, documentId: string, responder: FakeResponderV2): void => {
      state.byDocument.set(`${tabId}:${documentId}`, responder);
    },
    setDocumentEpoch: (tabId: number, documentId: string, epoch: string): void => {
      state.documents.set(`${tabId}:${documentId}`, {
        ...createContentEnforcementState(),
        enforcementEpoch: epoch,
      });
    },
    documentState: (tabId: number, documentId: string): ContentEnforcementState | null => {
      const held: ContentEnforcementState | undefined = state.documents.get(
        `${tabId}:${documentId}`,
      );
      return held === undefined ? null : structuredClone(held);
    },
    rejectedAnswers: (tabId: number, documentId: string): number =>
      state.rejections.get(`${tabId}:${documentId}`) ?? 0,
    applyPulled: (
      tabId: number,
      documentId: string,
      commands: readonly DocumentContentCommand[],
    ): void => {
      for (const command of commands) answerAsDocument(state, tabId, documentId, command);
    },
    respondForOperation: (operationId: string, responder: FakeResponderV2): void => {
      state.byOperation.set(operationId, responder);
    },
    current: (): RuntimeStateV2 => structuredClone(state.runtime),
    stages: (): Array<string | null> =>
      writes.map(
        (runtime: RuntimeStateV2): string | null =>
          runtime.pendingEnforcementTransition?.stage ?? null,
      ),
  };
  return fake;
}

/** The exact `applied` answer a well-behaved document returns for one enforcement command. */
export function appliedResponseFor(message: DocumentContentCommand, handledAt: number): unknown {
  if (message.command !== 'apply-enforcement') {
    throw new Error('appliedResponseFor needs an apply-enforcement command');
  }
  return {
    version: 1,
    disposition: 'applied',
    operationId: message.operationId,
    enforcementEpoch: message.enforcementEpoch,
    sessionId: message.sessionId,
    reservedSessionId: message.reservedSessionId,
    basePolicyRevision: message.basePolicyRevision,
    runtimeRevision: message.runtimeRevision,
    documentId: message.documentId,
    observedUrl: message.expectedUrl,
    presentation: message.presentation,
    verdict: structuredClone(message.verdict),
    overlay: structuredClone(message.overlay),
    handledAt,
  };
}

/** The exact `epoch-reset` answer a well-behaved document returns for one reset command. */
export function epochResetResponseFor(message: DocumentContentCommand, handledAt: number): unknown {
  if (message.command !== 'reset-enforcement-epoch') {
    throw new Error('epochResetResponseFor needs a reset-enforcement-epoch command');
  }
  return {
    version: 1,
    disposition: 'epoch-reset',
    operationId: message.operationId,
    enforcementEpoch: message.enforcementEpoch,
    documentId: message.documentId,
    observedUrl: message.expectedUrl,
    handledAt,
  };
}

/** The exact `reset-required` answer a document returns for an epoch it does not hold. */
export function resetRequiredResponseFor(
  message: DocumentContentCommand,
  currentEpoch: string | null,
  handledAt: number,
): unknown {
  if (message.command !== 'apply-enforcement') {
    throw new Error('resetRequiredResponseFor needs an apply-enforcement command');
  }
  return {
    version: 1,
    disposition: 'reset-required',
    operationId: message.operationId,
    enforcementEpoch: message.enforcementEpoch,
    documentId: message.documentId,
    observedUrl: message.expectedUrl,
    requestedEpoch: message.enforcementEpoch,
    currentEpoch,
    handledAt,
  };
}

/** A responder that models a document with no listener at all. */
export function noReceiverResponder(): FakeResponderV2 {
  return (): never => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
}

/** A responder that answers nothing, which the transport reports as a mismatch. */
export function silentResponder(): FakeResponderV2 {
  return (): unknown => undefined;
}

interface FakeStateV2 {
  runtime: RuntimeStateV2;
  now: number;
  /** While true, a commit stops after its checkpoint write, as production does before its replay. */
  holdCommitReplay: boolean;
  /** What each `${tabId}:${documentId}` holds, kept by the real content state machine. */
  documents: Map<string, ContentEnforcementState>;
  /** How many commands each document refused, which the page answers with nothing. */
  rejections: Map<string, number>;
  ids: string[];
  tabs: FakeTabRowV2[];
  tabSets: FakeTabRowV2[][];
  audit: 'ready' | 'website-access-lost' | 'content-registration-failed';
  generation: number;
  aggregates: Record<string, DailyAgg>;
  alarmReadBack: 'exact' | 'missing' | 'other-time';
  alarmReadBackFailures: number;
  bank: BankState;
  alarms: Map<AlarmNameV2, ScheduledAlarmV2>;
  byDocument: Map<string, FakeResponderV2>;
  byOperation: Map<string, FakeResponderV2>;
}

function targetPorts(
  state: FakeStateV2,
  onQueryTabs?: () => Promise<void> | void,
): EnforcementTargetPortsV2 {
  return {
    queryTopFrameTabs: async (): Promise<Array<{ tabId: number; url: string | null }>> => {
      await onQueryTabs?.();
      const set: FakeTabRowV2[] = state.tabSets.shift() ?? state.tabs;
      return set.map((row: FakeTabRowV2): { tabId: number; url: string | null } => ({
        tabId: row.tabId,
        url: row.url,
      }));
    },
    topFrameDocumentId: async (tabId: number): Promise<string | null> => {
      const row: FakeTabRowV2 | undefined = state.tabs.find(
        (candidate: FakeTabRowV2): boolean => candidate.tabId === tabId,
      );
      if (row === undefined) return null;
      return row.documentId === undefined ? `document-${tabId}` : row.documentId;
    },
    readTargetGeneration: (): number => state.generation,
    now: (): number => state.now,
    ensureDocumentScript: (): Promise<'ready' | 'unscriptable'> => Promise.resolve('ready'),
  };
}

function transportPorts(state: FakeStateV2, sends: FakeSendV2[]): ContentTransportPortsV2 {
  return {
    sendToDocument: async (
      tabId: number,
      documentId: string,
      message: DocumentContentCommand,
    ): Promise<unknown> => {
      sends.push({ tabId, documentId, message: structuredClone(message) });
      const byOperation: FakeResponderV2 | undefined = state.byOperation.get(message.operationId);
      if (byOperation !== undefined) return byOperation(message);
      const byDocument: FakeResponderV2 | undefined = state.byDocument.get(
        `${tabId}:${documentId}`,
      );
      if (byDocument !== undefined) return byDocument(message);
      return defaultDocumentAnswer(state, tabId, documentId, message);
    },
  };
}

/**
 * What each document holds at seeding. A recorded `epochResetAcks` entry is the runtime's own
 * evidence that the document answered that epoch's reset, so the fake starts it in that epoch and
 * production's `hasEpochAck` skip stays consistent with what the document then answers. A stored
 * command for that document at that epoch is the evidence of what it applied, so the document
 * starts on that view and tuple, which is what makes it refuse a different view at the same tuple
 * the way the page it stands in for would. An explicit `documentEpochs` option wins, for a scenario
 * that wants a document out of step with the record.
 *
 * A document with a record and no stored command is seeded on no tuple, which accepts any command.
 * That is more permissive than the page: after a start the allowed pages of a published runtime
 * have exactly that record and no entry, and the real page holds its clear at the published tuple
 * and refuses a different view there (docs/testing-rules.md, rule 3). A scenario about that page
 * has to put it on its view first, through `applyPulled` or a scripted responder, rather than take
 * this seed's acceptance for the page's.
 */
function seededDocumentStates(
  initial: RuntimeStateV2,
  overrides: Record<string, string> | undefined,
): Map<string, ContentEnforcementState> {
  const documents: Map<string, ContentEnforcementState> = new Map<
    string,
    ContentEnforcementState
  >();
  for (const [key, ack] of Object.entries(initial.epochResetAcks)) {
    const held: FrozenDocumentCommand | undefined = initial.documentCommands[key];
    const applied: boolean = held !== undefined && held.enforcementEpoch === ack.enforcementEpoch;
    documents.set(key, {
      enforcementEpoch: ack.enforcementEpoch,
      retiredEnforcementEpochs: [],
      tuple:
        held !== undefined && applied
          ? {
              enforcementEpoch: held.enforcementEpoch,
              sessionId: held.sessionId,
              reservedSessionId: held.reservedSessionId,
              basePolicyRevision: held.basePolicyRevision,
              runtimeRevision: held.runtimeRevision,
            }
          : null,
      presentation: held !== undefined && applied ? held.presentation : null,
      verdict: held !== undefined && applied ? structuredClone(held.verdict) : null,
      overlay: held !== undefined && applied ? structuredClone(held.overlay) : null,
    });
  }
  for (const [key, epoch] of Object.entries(overrides ?? {})) {
    documents.set(key, { ...createContentEnforcementState(), enforcementEpoch: epoch });
  }
  return documents;
}

/**
 * What a well-behaved document answers when no responder is scripted for it: whatever the real
 * content state machine answers. A document accepts an enforcement command only for the epoch it
 * holds, only at a tuple above the one it holds or at the same tuple with the same view, and it
 * answers nothing at all to a command it refuses, exactly as `src/content/enforcement-state.ts`
 * does. The fake used to answer `applied` to every command at the epoch it held, which is how a
 * command the page refuses passed every runner suite (docs/testing-rules.md, rule 3).
 */
function defaultDocumentAnswer(
  state: FakeStateV2,
  tabId: number,
  documentId: string,
  message: DocumentContentCommand,
): unknown {
  return answerAsDocument(state, tabId, documentId, message);
}

/** Runs one command through the document's own state and records what it answered. */
function answerAsDocument(
  state: FakeStateV2,
  tabId: number,
  documentId: string,
  message: DocumentContentCommand,
): unknown {
  const key: string = `${tabId}:${documentId}`;
  const held: ContentEnforcementState = state.documents.get(key) ?? createContentEnforcementState();
  // The page reports the URL it is on. The fake has no page, so it reports the URL the command
  // names: a document whose URL drifted is a scripted deviation through `respondForDocument`.
  const result: ContentCommandResultV2 = handleContentCommandV2(
    held,
    message,
    message.expectedUrl,
    state.now,
  );
  state.documents.set(key, result.state);
  if (result.response === null) {
    state.rejections.set(key, (state.rejections.get(key) ?? 0) + 1);
    return undefined;
  }
  return result.response;
}

function alarmPorts(
  state: FakeStateV2,
  alarmCalls: Array<{ kind: 'create' | 'createPeriodic' | 'clear'; name: AlarmNameV2 }>,
  onCreate: (() => void) | undefined,
  recordWrites: () => void,
): AlarmPortsV2 {
  return {
    create: async (name: AlarmNameV2, when: number): Promise<void> => {
      alarmCalls.push({ kind: 'create', name });
      recordWrites();
      state.alarms.set(name, { scheduledTime: when, periodInMinutes: null });
      onCreate?.();
    },
    createPeriodic: async (name: AlarmNameV2, periodInMinutes: number): Promise<void> => {
      alarmCalls.push({ kind: 'createPeriodic', name });
      recordWrites();
      state.alarms.set(name, { scheduledTime: state.now, periodInMinutes });
    },
    get: async (name: AlarmNameV2): Promise<ScheduledAlarmV2 | null> => {
      const stored: ScheduledAlarmV2 | undefined = state.alarms.get(name);
      // An absent alarm reads back as absent, which is how a clear confirms itself. The scripted
      // failures apply only to reading back an alarm that was just created.
      if (stored === undefined) return null;
      if (state.alarmReadBackFailures > 0) {
        state.alarmReadBackFailures -= 1;
        return null;
      }
      if (state.alarmReadBack === 'missing') return null;
      if (state.alarmReadBack === 'other-time') {
        return { ...stored, scheduledTime: stored.scheduledTime + 1 };
      }
      return { ...stored };
    },
    clear: async (name: AlarmNameV2): Promise<void> => {
      alarmCalls.push({ kind: 'clear', name });
      recordWrites();
      state.alarms.delete(name);
    },
  };
}

/** Every persisted value passes the storage boundary, so an invalid write fails its own test. */
function requireValidRuntime(runtime: RuntimeStateV2, detail: string): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(runtime);
  expect(parsed, detail).not.toBeNull();
  if (parsed === null) throw new Error(detail);
  return parsed;
}

/** The schedule ports the controller hands to the schedule runner. */
export interface ScheduleRunnerPortsFakeV2 extends ScheduleRunnerPortsV2 {
  notices: Array<{ title: string; body: string }>;
  sounds: string[];
  setSettings(settings: SettingsV2): void;
  setReady(ready: boolean): void;
}

export function createScheduleRunnerPortsFakeV2(
  settings: SettingsV2 = { ...DEFAULT_SETTINGS, schedule: [] },
  ready: boolean = true,
): ScheduleRunnerPortsFakeV2 {
  let current: SettingsV2 = structuredClone(settings);
  let blockingReady: boolean = ready;
  const notices: Array<{ title: string; body: string }> = [];
  const sounds: string[] = [];
  return {
    notices,
    sounds,
    settings: (): SettingsV2 => structuredClone(current),
    lists: (): ListsConfig => structuredClone(DEFAULT_LISTS),
    websiteBlockingReady: (): boolean => blockingReady,
    notify: (title: string, body: string): void => {
      notices.push({ title, body });
    },
    playSound: (sound: 'scheduleStart'): void => {
      sounds.push(sound);
    },
    setSettings: (next: SettingsV2): void => {
      current = structuredClone(next);
    },
    setReady: (next: boolean): void => {
      blockingReady = next;
    },
  };
}

/** Everything the controller does to the browser, recorded in order. */
export interface ControllerEffectsFakeV2 {
  broadcasts: SessionSnapshotV2[];
  badges: SessionSnapshotV2[];
  sounds: SoundId[];
  notices: Array<{ title: string; body: string }>;
  clears: number;
  attempts: Array<{ url: string; tabId: number; kind: 'navigation' | 'existing' }>;
  /** Every stopped claim the controller took, in order, before the view that explains it. */
  stopped: Array<{ tabId: number; url: string; documentId: string }>;
  restored: number[][];
  reloads: number;
  blankBadges: number;
  /** Runs inside `restoreTabClaims`, for interleaving a write during a cleanup attempt. */
  onRestore?: () => Promise<void> | void;
  /** Runs inside `recordAttempt`, for the sweep a real attempt write starts. */
  onRecordAttempt?: () => Promise<void> | void;
  restoreTabClaims(claims: readonly CleanupTabClaim[]): Promise<number[]>;
  reloadStoppedDocuments(claims: readonly CleanupTabClaim[]): Promise<void>;
  requestBlankBadge(): void;
  broadcast(snapshot: SessionSnapshotV2): void;
  updateBadge(snapshot: SessionSnapshotV2): void;
  playSound(sound: SoundId): void;
  notify(title: string, body: string): void;
  clearBlockingForNonBlockingPhase(): Promise<void>;
  recordAttempt(url: string, tabId: number, kind: 'navigation' | 'existing'): Promise<void>;
  markStoppedPage(tabId: number, url: string, documentId: string): Promise<void>;
}

export function createControllerEffectsFakeV2(): ControllerEffectsFakeV2 {
  const fake: ControllerEffectsFakeV2 = {
    broadcasts: [],
    badges: [],
    sounds: [],
    notices: [],
    clears: 0,
    attempts: [],
    stopped: [],
    restored: [],
    reloads: 0,
    blankBadges: 0,
    restoreTabClaims: async (claims: readonly CleanupTabClaim[]): Promise<number[]> => {
      await fake.onRestore?.();
      const resolved: number[] = claims.map((claim: CleanupTabClaim): number => claim.tabId);
      fake.restored.push(resolved);
      return resolved;
    },
    reloadStoppedDocuments: async (): Promise<void> => {
      fake.reloads += 1;
    },
    requestBlankBadge: (): void => {
      fake.blankBadges += 1;
    },
    broadcast: (snapshot: SessionSnapshotV2): void => {
      fake.broadcasts.push(structuredClone(snapshot));
    },
    updateBadge: (snapshot: SessionSnapshotV2): void => {
      fake.badges.push(structuredClone(snapshot));
    },
    playSound: (sound: SoundId): void => {
      fake.sounds.push(sound);
    },
    notify: (title: string, body: string): void => {
      fake.notices.push({ title, body });
    },
    clearBlockingForNonBlockingPhase: async (): Promise<void> => {
      fake.clears += 1;
    },
    recordAttempt: async (
      url: string,
      tabId: number,
      kind: 'navigation' | 'existing',
    ): Promise<void> => {
      fake.attempts.push({ url, tabId, kind });
      await fake.onRecordAttempt?.();
    },
    markStoppedPage: async (tabId: number, url: string, documentId: string): Promise<void> => {
      fake.stopped.push({ tabId, url, documentId });
    },
  };
  return fake;
}
