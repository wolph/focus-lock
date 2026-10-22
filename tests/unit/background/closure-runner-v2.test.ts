import { describe, expect, it } from 'vitest';
import { CLOSURE_CLEANUP_ALARM, PHASE_ALARM } from '../../../src/background/alarms-v2';
import {
  closeSessionV2,
  commitClosureV2,
  prepareClosureV2,
  retryClosureCleanupV2,
  runClosureCleanupAttemptV2,
} from '../../../src/background/closure-runner-v2';
import type { RuntimeCommitInputV2 } from '../../../src/background/runtime-checkpoint-v2';
import type { RuntimePortsV2 } from '../../../src/background/runtime-ports-v2';
import type {
  CleanupProgress,
  CleanupTabClaim,
  ClosureProjection,
  PendingClosure,
  RuntimeStateV2,
} from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import {
  type CleanupEffectPortsV2,
  handleCleanupNavigationV2,
} from '../../../src/background/transition-cleanup-v2';
import { emptyDaily } from '../../../src/core/stats';
import { CLEANUP_MAX_AUTOMATIC_ATTEMPTS } from '../../../src/shared/constants';
import { CoreError } from '../../../src/shared/errors';
import { syncAggKey } from '../../../src/shared/storage-keys';
import { localDateStr } from '../../../src/shared/time';
import type { DailyAgg, SessionEndReasonV2, SessionStateV2 } from '../../../src/shared/types';
import {
  createRuntimePortsFakeV2,
  type FakeSendV2,
  noReceiverResponder,
  type RuntimePortsFakeV2,
} from './runtime-ports-fake';
import {
  ACTIVATION_AT,
  CLEANUP_OPERATION_ID,
  commitCheckpointRuntime,
  dailyAgg,
  documentKey,
  epochResetAck,
  epochResetAckMap,
  LOCAL_DATE,
  OTHER_OPERATION_ID,
  publishedFocusRuntime,
  runtimeTabState,
  SESSION_ID,
  timedFocusSession,
  untilStoppedFocusSession,
} from './runtime-v2-fixtures';

const DOC_ONE: string = 'document-1';
const DEVICE_ID: string = 'device-1';
const MINUTE_MS: number = 60_000;
const ENDED_AT: number = ACTIVATION_AT + 10 * MINUTE_MS;
const CLOSURE_OPERATION: string = '90000000-0000-4000-8000-000000000001';
const MIDNIGHT: number = new Date(2026, 8, 3, 0, 0, 0, 0).getTime();
const NEXT_DATE: string = localDateStr(MIDNIGHT);
const CROSSING_ENDED_AT: number = MIDNIGHT + 20 * MINUTE_MS;

/** A timed session that runs into the evening, so its settled focus lands on the earlier day. */
function crossingSession(): SessionStateV2 {
  const base: SessionStateV2 = timedFocusSession();
  const span: number = (base.sessionEndsAt ?? 0) - base.startedAt;
  const startedAt: number = MIDNIGHT - 40 * MINUTE_MS;
  return timedFocusSession({
    startedAt,
    phaseStartedAt: startedAt,
    sessionEndsAt: startedAt + span,
    phaseEndsAt: startedAt + span,
  });
}
const NEXT_OPERATION: string = '90000000-0000-4000-8000-000000000002';

function effectsFake(): CleanupEffectPortsV2 & { badges: number; reloaded: number } {
  const record = {
    badges: 0,
    reloaded: 0,
    restoreTabClaims: async (claims: readonly CleanupTabClaim[]): Promise<number[]> =>
      claims.map((claim: CleanupTabClaim): number => claim.tabId),
    reloadStoppedDocuments: async (): Promise<void> => {
      record.reloaded += 1;
    },
    requestBlankBadge: (): void => {
      record.badges += 1;
    },
  };
  return record;
}

function unresolvedEffects(): CleanupEffectPortsV2 {
  return {
    restoreTabClaims: async (): Promise<number[]> => [],
    reloadStoppedDocuments: async (): Promise<void> => {},
    requestBlankBadge: (): void => {},
  };
}

function closingRuntime(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return publishedFocusRuntime({
    session: timedFocusSession(),
    tabStates: { 11: runtimeTabState() },
    ...overrides,
  });
}

function fakeFor(
  runtime: RuntimeStateV2,
  options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
): RuntimePortsFakeV2 {
  return createRuntimePortsFakeV2(runtime, {
    now: ENDED_AT,
    ids: [CLOSURE_OPERATION, NEXT_OPERATION, OTHER_OPERATION_ID, CLEANUP_OPERATION_ID],
    deviceId: DEVICE_ID,
    tabs: [{ tabId: 11, url: 'https://facebook.com/feed', documentId: DOC_ONE }],
    ...options,
  });
}

function preparedClosureOf(runtime: RuntimeStateV2): PendingClosure {
  const closure: PendingClosure | null = runtime.pendingClosure;
  if (closure === null) throw new Error('the runtime carries no closure');
  return closure;
}

function cleanupProgressOf(runtime: RuntimeStateV2): CleanupProgress {
  const closure: PendingClosure = preparedClosureOf(runtime);
  if (closure.stage !== 'cleanup') throw new Error('the closure is not in cleanup');
  return closure.cleanupProgress;
}

async function prepared(
  fake: RuntimePortsFakeV2,
  reason: SessionEndReasonV2 = 'timer-completed',
  endedAt: number = ENDED_AT,
): Promise<RuntimeStateV2> {
  return prepareClosureV2(fake, { endedAt, reason });
}

async function inCleanup(
  fake: RuntimePortsFakeV2,
  reason: SessionEndReasonV2 = 'timer-completed',
): Promise<RuntimeStateV2> {
  await prepared(fake, reason);
  return commitClosureV2(fake);
}

describe('prepareClosureV2', (): void => {
  it('loads every settled date before it writes the prepared closure', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    const loads: string[][] = [];
    const ports: RuntimePortsV2 = {
      ...fake,
      loadAggregates: async (keys: readonly string[]): Promise<Record<string, DailyAgg>> => {
        loads.push([...keys]);
        expect(fake.writes).toHaveLength(0);
        return fake.loadAggregates(keys);
      },
    };

    const next: RuntimeStateV2 = await prepareClosureV2(ports, {
      endedAt: ENDED_AT,
      reason: 'timer-completed',
    });

    expect(loads).toHaveLength(1);
    expect(loads[0]).toContain(syncAggKey(DEVICE_ID, LOCAL_DATE));
    expect(next.pendingClosure?.stage).toBe('prepared');
    expect(next.session).toEqual(closingRuntime().session);
    expect(parseRuntimeStateV2(next)).not.toBeNull();
  });

  it('prepares the closure while a commit is in flight', async (): Promise<void> => {
    // Preparing is what a session end does first, and it writes the pending closure, a projected
    // field. Refused while a checkpoint was outstanding, the end threw and the session stayed
    // open, which is the shape the user sees as an end button that does nothing.
    const fake: RuntimePortsFakeV2 = fakeFor(commitCheckpointRuntime(closingRuntime()));

    const next: RuntimeStateV2 = await prepared(fake);

    expect(next.pendingClosure?.stage).toBe('prepared');
    expect(fake.current().commitCheckpoint?.projection.pendingClosure).toEqual(next.pendingClosure);
  });

  it('keeps the enforcement checkpoint and captures the phase alarm and claims', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());

    const next: RuntimeStateV2 = await prepared(fake);
    const closure: PendingClosure = preparedClosureOf(next);

    expect(next.enforcementCheckpoint).toEqual(closingRuntime().enforcementCheckpoint);
    expect(closure.cleanupSeed.alarmNames).toEqual([PHASE_ALARM]);
    expect(closure.cleanupSeed.tabClaims).toEqual([{ tabId: 11, state: runtimeTabState() }]);
    expect(closure.cleanupProgress).toBeNull();
  });

  it('captures no phase alarm for an indefinite focus session', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(
      closingRuntime({ session: untilStoppedFocusSession() }),
    );

    const next: RuntimeStateV2 = await prepared(fake, 'manual-completed');

    expect(preparedClosureOf(next).cleanupSeed.alarmNames).toEqual([]);
  });

  it('keeps a finished day the settled focus reaches back into', async (): Promise<void> => {
    const session: SessionStateV2 = crossingSession();
    const settledMs: number = (session.sessionEndsAt ?? 0) - session.phaseStartedAt;
    const stored: DailyAgg = dailyAgg({ attempts: { 'example.com': 4 }, sessionsStarted: 2 });
    const fake: RuntimePortsFakeV2 = fakeFor(
      closingRuntime({
        session,
        accruedFocusMs: 0,
        date: NEXT_DATE,
        todayAgg: emptyDaily(NEXT_DATE),
      }),
      {
        now: CROSSING_ENDED_AT,
        aggregates: { [syncAggKey(DEVICE_ID, LOCAL_DATE)]: stored },
      },
    );

    const next: RuntimeStateV2 = await prepared(fake, 'timer-completed', CROSSING_ENDED_AT);
    const projection: ClosureProjection = preparedClosureOf(next).projection;
    const earlier: DailyAgg | undefined =
      projection.aggregateSets[syncAggKey(DEVICE_ID, LOCAL_DATE)];

    expect(earlier?.attempts).toEqual({ 'example.com': 4 });
    expect(earlier?.sessionsStarted).toBe(2);
    expect(earlier?.pauseMsEarned).toBe(stored.pauseMsEarned);
    expect(earlier?.focusMs).toBe(stored.focusMs + settledMs);
  });

  it.each([
    // An idle runtime holds no commands either, or the parser refuses it before the closure does.
    [
      'no durable session',
      closingRuntime({ session: null, enforcementCheckpoint: null, documentCommands: {} }),
    ],
    ['a closure already prepared', null],
  ])(
    'refuses a closure with %s',
    async (label: string, runtime: RuntimeStateV2 | null): Promise<void> => {
      const fake: RuntimePortsFakeV2 = fakeFor(runtime ?? closingRuntime());
      if (runtime === null) await prepared(fake);

      await expect(prepared(fake)).rejects.toThrow(CoreError);
      expect(label).toBeTruthy();
    },
  );
});

describe('commitClosureV2', (): void => {
  it('commits the frozen projection in one checkpoint', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    const before: RuntimeStateV2 = await prepared(fake);
    const projection: ClosureProjection = preparedClosureOf(before).projection;

    const next: RuntimeStateV2 = await commitClosureV2(fake);
    const commit: RuntimeCommitInputV2 | undefined = fake.commits[0];
    const progress: CleanupProgress = cleanupProgressOf(next);

    expect(fake.commits).toHaveLength(1);
    expect(commit?.checkpointId).toBe(projection.closureId);
    expect(commit?.events).toEqual(projection.events);
    expect(commit?.bank).toEqual(projection.bankAfter);
    expect(commit?.aggregateSets).toEqual(projection.aggregateSets);
    expect(commit?.syncBank).toBe(true);
    expect(next.session).toBeNull();
    expect(next.gate).toBeNull();
    expect(next.unlocks).toEqual([]);
    expect(next.accruedFocusMs).toBe(0);
    expect(next.enforcementCheckpoint).toBeNull();
    expect(next.pendingEnforcementTransition).toBeNull();
    expect(next.handledScheduleOccurrences).toEqual(projection.handledOccurrences);
    expect(next.runtimeRevision).toBe(before.runtimeRevision + 1);
    expect(next.documentCommands).toEqual(progress.clearCommands);
    expect(progress.clearRuntimeRevision).toBe(next.runtimeRevision);
    expect(progress.cleanupOperationId).toBe(CLOSURE_OPERATION);
    expect(progress.tabClaims).toEqual(preparedClosureOf(before).cleanupSeed.tabClaims);
    expect(progress.resolvedTabIds).toEqual([]);
    expect(parseRuntimeStateV2(next)).not.toBeNull();
  });

  it('adopts the ended day aggregate as the runtime aggregate', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    const before: RuntimeStateV2 = await prepared(fake);
    const projection: ClosureProjection = preparedClosureOf(before).projection;

    const next: RuntimeStateV2 = await commitClosureV2(fake);

    expect(next.date).toBe(LOCAL_DATE);
    expect(next.todayAgg).toEqual(projection.aggregateSets[syncAggKey(DEVICE_ID, LOCAL_DATE)]);
  });

  it('rebases the runtime day when the closure ends on a later date', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(
      closingRuntime({ session: crossingSession(), accruedFocusMs: 0 }),
      { now: CROSSING_ENDED_AT },
    );
    const before: RuntimeStateV2 = await prepared(fake, 'timer-completed', CROSSING_ENDED_AT);
    const projection: ClosureProjection = preparedClosureOf(before).projection;

    const next: RuntimeStateV2 = await commitClosureV2(fake);

    expect(before.date).toBe(LOCAL_DATE);
    expect(next.date).toBe(NEXT_DATE);
    expect(next.todayAgg).toEqual(projection.aggregateSets[syncAggKey(DEVICE_ID, NEXT_DATE)]);
    expect(projection.aggregateSets[syncAggKey(DEVICE_ID, LOCAL_DATE)]?.focusMs).toBeGreaterThan(
      dailyAgg().focusMs,
    );
    expect(parseRuntimeStateV2(next)).not.toBeNull();
  });

  it.each<[SessionEndReasonV2, number]>([
    ['manual-completed', 1],
    ['manual-canceled', 0],
  ])(
    'records the completion increment for %s',
    async (reason: SessionEndReasonV2, increment: number): Promise<void> => {
      const session =
        reason === 'manual-completed' ? untilStoppedFocusSession() : timedFocusSession();
      const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime({ session }));
      const before: RuntimeStateV2 = await prepared(fake, reason);

      await commitClosureV2(fake);

      expect(preparedClosureOf(before).projection.completionIncrement).toBe(increment);
      expect(
        fake.commits[0]?.aggregateSets[syncAggKey(DEVICE_ID, LOCAL_DATE)]?.sessionsCompleted,
      ).toBe(dailyAgg().sessionsCompleted + increment);
    },
  );

  it('never rebuilds the frozen projection after a restart', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    const before: RuntimeStateV2 = await prepared(fake);
    const restarted: RuntimePortsV2 = {
      ...fake,
      loadAggregates: async (): Promise<Record<string, DailyAgg>> => {
        throw new Error('the projection was rebuilt');
      },
      openOccurrencesAt: (): never => {
        throw new Error('the projection was rebuilt');
      },
    };

    const next: RuntimeStateV2 = await commitClosureV2(restarted);

    expect(cleanupProgressOf(next).clearRuntimeRevision).toBe(next.runtimeRevision);
    expect(fake.commits[0]?.events).toEqual(preparedClosureOf(before).projection.events);
  });

  it('refuses a closure that is not prepared', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());

    await expect(commitClosureV2(fake)).rejects.toThrow(CoreError);
  });
});

describe('runClosureCleanupAttemptV2', (): void => {
  it('clears the phase alarm, blanks the badge, clears documents, and removes the journal', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    const effects = effectsFake();

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effects);

    expect(fake.alarmCalls).toContainEqual({ kind: 'clear', name: PHASE_ALARM });
    expect(effects.badges).toBe(1);
    expect(effects.reloaded).toBe(1);
    expect(
      fake.sends.some((send: FakeSendV2): boolean => send.message.command === 'apply-enforcement'),
    ).toBe(true);
    expect(next.pendingClosure).toBeNull();
    expect(parseRuntimeStateV2(next)).not.toBeNull();
  });

  it('empties documentCommands when the closure journal is removed', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    const committed: RuntimeStateV2 = await inCleanup(fake);
    expect(Object.keys(committed.documentCommands).length).toBeGreaterThan(0);

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());

    // The clear batch is the command map for as long as the journal lasts. Once every target and
    // claim is resolved the batch has done its work, and keeping it would keep the address of every
    // page that was open at the end for as long as the profile stays idle. A page that returns
    // pulls a fresh clear from the idle runtime instead.
    expect(next.pendingClosure).toBeNull();
    expect(next.documentCommands).toEqual({});
    expect(fake.current().documentCommands).toEqual({});
    expect(parseRuntimeStateV2(next)).not.toBeNull();
  });

  it('drops the acknowledgements of tabs the browser no longer lists when it removes the journal', async (): Promise<void> => {
    // Tab 11 is open and in the batch. Tab 13 answered a reset earlier in the session and was
    // closed while the worker was not listening, so no removal event ever pruned it.
    const fake: RuntimePortsFakeV2 = fakeFor(
      closingRuntime({
        epochResetAcks: {
          ...epochResetAckMap(),
          [documentKey(13, 'document-13')]: epochResetAck({ tabId: 13, documentId: 'document-13' }),
        },
      }),
    );
    await inCleanup(fake);

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());

    // The same write that removes the journal and empties the command map bounds the record to
    // the tabs the browser still has. A document in an open tab keeps its acknowledgement, which
    // is what lets one restored from the back-forward cache pull an empty answer rather than a
    // clear it would refuse.
    expect(next.pendingClosure).toBeNull();
    expect(Object.keys(next.epochResetAcks)).toEqual([documentKey(11, DOC_ONE)]);
    expect(fake.current().epochResetAcks).toEqual(next.epochResetAcks);
    const removal: RuntimeStateV2 | undefined = fake.writes.find(
      (write: RuntimeStateV2): boolean =>
        write.pendingClosure === null && Object.keys(write.documentCommands).length === 0,
    );
    expect(removal?.epochResetAcks).toEqual(next.epochResetAcks);
    expect(parseRuntimeStateV2(next)).not.toBeNull();
  });

  it('resets a document that has not acknowledged the epoch before clearing it', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime({ epochResetAcks: {} }));
    await inCleanup(fake);

    await runClosureCleanupAttemptV2(fake, effectsFake());

    const commands: string[] = fake.sends.map((send: FakeSendV2): string => send.message.command);
    expect(commands[0]).toBe('reset-enforcement-epoch');
    expect(commands).toContain('apply-enforcement');
  });

  it('keeps the journal and schedules a retry when a clear finds no receiver', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());
    const progress: CleanupProgress = cleanupProgressOf(next);

    expect(next.pendingClosure?.stage).toBe('cleanup');
    expect(progress.retry.automaticAttempt).toBe(1);
    expect(progress.retry.lastError).not.toBeNull();
    expect(fake.alarmCalls).toContainEqual({ kind: 'create', name: CLOSURE_CLEANUP_ALARM });
  });

  it('still clears every later document when an earlier one finds no receiver', async (): Promise<void> => {
    // One page that never answers holds the journal for itself and must not strand the documents
    // after it in the batch with their overlays still up.
    const fake: RuntimePortsFakeV2 = fakeFor(
      closingRuntime({ tabStates: { 11: runtimeTabState(), 12: runtimeTabState() } }),
      {
        tabs: [
          { tabId: 11, url: 'https://facebook.com/feed', documentId: DOC_ONE },
          { tabId: 12, url: 'https://facebook.com/other', documentId: 'document-2' },
        ],
      },
    );
    await inCleanup(fake);
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());

    expect(
      fake.sends.some(
        (send: FakeSendV2): boolean =>
          send.documentId === 'document-2' && send.message.command === 'apply-enforcement',
      ),
    ).toBe(true);
    expect(next.pendingClosure?.stage).toBe('cleanup');
    expect(cleanupProgressOf(next).retry.lastError).toContain(DOC_ONE);
  });

  it('finishes when a listed tab with no receiver is one Chrome will not script', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    fake.targets.ensureDocumentScript = async (): Promise<'ready' | 'unscriptable'> =>
      'unscriptable';

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());

    expect(fake.sends.some((send: FakeSendV2): boolean => send.documentId === DOC_ONE)).toBe(true);
    expect(next.pendingClosure).toBeNull();
  });

  it('finishes when the tab behind a no-receiver answer is gone from the browser', async (): Promise<void> => {
    // A tab the person closed answers no-receiver rather than naming itself closed, because the
    // runtime reports a missing listener before it reports a missing tab. Treated as a refusal,
    // that held the journal for the life of its batch over a page that no longer exists, with
    // every start refused behind it and a manual retry the person is only offered at the end.
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    // The tab was there when the batch froze and the person closes it before the attempt sends.
    fake.setTabs([]);
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());

    // The clear really was attempted against that document, so this is the no-receiver path and
    // not a batch that quietly had nothing in it.
    expect(fake.sends.some((send: FakeSendV2): boolean => send.documentId === DOC_ONE)).toBe(true);
    expect(next.pendingClosure).toBeNull();
  });

  it('treats a closed document as resolved without inventing an acknowledgement', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime({ epochResetAcks: {} }), { tabs: [] });
    await inCleanup(fake);

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());

    expect(next.pendingClosure).toBeNull();
    expect(Object.keys(fake.current().epochResetAcks)).toEqual([]);
  });

  it('keeps the journal while a captured claim is unresolved', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, unresolvedEffects());

    expect(next.pendingClosure?.stage).toBe('cleanup');
    expect(cleanupProgressOf(next).retry.lastError).not.toBeNull();
  });

  it('finishes on the last attempt rather than stranding a claim nothing can restore', async (): Promise<void> => {
    // A tab the browser will never bring back leaves a claim that no attempt can resolve. Holding
    // the journal for it strands the person: the closure is owed forever, every start is refused
    // behind it, and the manual retry they are offered can never succeed either. So the automatic
    // budget bounds it. The last attempt finishes the closure and reports the claims it could not
    // restore, which is the one thing about this the user's log should carry.
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);

    let next: RuntimeStateV2 = fake.current();
    for (let attempt: number = 0; attempt < CLEANUP_MAX_AUTOMATIC_ATTEMPTS; attempt++) {
      next = await runClosureCleanupAttemptV2(fake, unresolvedEffects());
    }

    expect(next.pendingClosure).toBeNull();
    expect(fake.errors).toHaveLength(1);
    expect(String(fake.errors[0])).toContain('1');
  });

  it('stops scheduling after the twelfth failed attempt', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());

    let next: RuntimeStateV2 = fake.current();
    for (let attempt: number = 0; attempt < CLEANUP_MAX_AUTOMATIC_ATTEMPTS; attempt++) {
      next = await runClosureCleanupAttemptV2(fake, effectsFake());
    }

    const progress: CleanupProgress = cleanupProgressOf(next);
    expect(progress.retry.automaticAttempt).toBe(CLEANUP_MAX_AUTOMATIC_ATTEMPTS);
    expect(progress.retry.nextAttemptAt).toBeNull();
    expect(
      fake.alarmCalls.filter(
        (call: { kind: string; name: string }): boolean =>
          call.name === CLOSURE_CLEANUP_ALARM && call.kind === 'create',
      ),
    ).toHaveLength(CLEANUP_MAX_AUTOMATIC_ATTEMPTS - 1);
  });

  it('advances the schedule by one attempt when the browser accepts the alarm', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());

    expect(cleanupProgressOf(next).retry.automaticAttempt).toBe(1);
    expect(cleanupProgressOf(next).retry.nextAttemptAt).not.toBeNull();
    expect(
      fake.alarmCalls.filter(
        (call: { kind: string; name: string }): boolean =>
          call.name === CLOSURE_CLEANUP_ALARM && call.kind === 'create',
      ),
    ).toHaveLength(1);
  });

  it('burns the schedule down to the manual retry when the browser refuses the alarm', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    fake.setAlarmReadBack('missing');

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());
    const progress: CleanupProgress = cleanupProgressOf(next);

    // A refused alarm is not a scheduled attempt, so it is recorded as one more failure until the
    // schedule reaches the exhausted state a manual retry answers.
    expect(progress.retry.automaticAttempt).toBe(CLEANUP_MAX_AUTOMATIC_ATTEMPTS);
    expect(progress.retry.nextAttemptAt).toBeNull();
    expect(progress.retry.lastError).toContain('could not schedule its retry alarm');
    expect(next.pendingClosure?.stage).toBe('cleanup');
  });

  it('lets a refused alarm be the failure that exhausts the batch', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    for (let attempt: number = 0; attempt < CLEANUP_MAX_AUTOMATIC_ATTEMPTS - 2; attempt++) {
      await runClosureCleanupAttemptV2(fake, effectsFake());
    }
    expect(cleanupProgressOf(fake.current()).retry.automaticAttempt).toBe(
      CLEANUP_MAX_AUTOMATIC_ATTEMPTS - 2,
    );
    fake.setAlarmReadBack('missing');

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());
    const progress: CleanupProgress = cleanupProgressOf(next);

    expect(progress.retry.automaticAttempt).toBe(CLEANUP_MAX_AUTOMATIC_ATTEMPTS);
    expect(progress.retry.nextAttemptAt).toBeNull();
  });

  it('merges a claim discovered since the closure committed', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    const runtime: RuntimeStateV2 = fake.current();
    await fake.writeRuntime({
      ...runtime,
      tabStates: { ...runtime.tabStates, 12: runtimeTabState({ stoppedDocumentId: 'document-2' }) },
    });

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, unresolvedEffects());
    const claims: CleanupTabClaim[] = cleanupProgressOf(next).tabClaims;

    expect(claims.map((claim: CleanupTabClaim): number => claim.tabId)).toEqual([11, 12]);
    expect(next.pendingClosure?.stage).toBe('cleanup');
  });

  it('fails the attempt when a discovered claim contradicts the captured one', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    const runtime: RuntimeStateV2 = fake.current();
    await fake.writeRuntime({
      ...runtime,
      tabStates: { 11: runtimeTabState({ muteUrl: 'https://example.com/other' }) },
    });

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, effectsFake());
    const progress: CleanupProgress = cleanupProgressOf(next);

    expect(progress.retry.lastError).toContain('contradictory claim');
    expect(progress.tabClaims).toEqual([{ tabId: 11, state: runtimeTabState() }]);
    expect(next.pendingClosure?.stage).toBe('cleanup');
  });

  it('keys and clears a document discovered during the attempt', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    const discoveredKey: string = documentKey(12, 'document-2');
    fake.setTabs([
      { tabId: 11, url: 'https://facebook.com/feed', documentId: DOC_ONE },
      { tabId: 12, url: 'https://news.example.com/story', documentId: 'document-2' },
    ]);

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(fake, unresolvedEffects());
    const progress: CleanupProgress = cleanupProgressOf(next);

    expect(Object.keys(progress.clearCommands)).toContain(discoveredKey);
    expect(progress.targets[discoveredKey]?.expectedUrl).toBe('https://news.example.com/story');
    expect(progress.clearCommands[discoveredKey]?.runtimeRevision).toBe(
      progress.clearRuntimeRevision,
    );
    expect(next.documentCommands[discoveredKey]).toEqual(progress.clearCommands[discoveredKey]);
    expect(fake.sends.some((send: FakeSendV2): boolean => send.documentId === 'document-2')).toBe(
      true,
    );
  });

  it('resets a discovered document before it sends that document its clear', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    fake.setTabs([
      { tabId: 11, url: 'https://facebook.com/feed', documentId: DOC_ONE },
      { tabId: 12, url: 'https://news.example.com/story', documentId: 'document-2' },
    ]);

    await runClosureCleanupAttemptV2(fake, unresolvedEffects());

    // A document discovered during the attempt has no acknowledgement by construction, so it owes
    // the same epoch handshake the frozen batch owes before any clear reaches it.
    const discovered: FakeSendV2[] = fake.sends.filter(
      (send: FakeSendV2): boolean => send.documentId === 'document-2',
    );
    expect(discovered.map((send: FakeSendV2): string => send.message.command)).toEqual([
      'reset-enforcement-epoch',
      'apply-enforcement',
    ]);
    expect(discovered[0]?.message.enforcementEpoch).toBe(fake.current().enforcementEpoch);
    expect(Object.keys(fake.current().epochResetAcks)).toContain(documentKey(12, 'document-2'));
    expect(fake.current().epochResetAcks[documentKey(12, 'document-2')]).not.toHaveProperty('url');
  });

  it("records a write that throws mid-attempt as this attempt's failure", async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    const runtime: RuntimeStateV2 = fake.current();
    await fake.writeRuntime({
      ...runtime,
      tabStates: { ...runtime.tabStates, 12: runtimeTabState({ stoppedDocumentId: 'document-2' }) },
    });
    let refuseNextWrite: boolean = true;
    const ports: RuntimePortsV2 = {
      ...fake,
      writeRuntime: async (next: RuntimeStateV2): Promise<void> => {
        if (refuseNextWrite) {
          refuseNextWrite = false;
          throw new Error('runtime write refused');
        }
        return fake.writeRuntime(next);
      },
    };

    const next: RuntimeStateV2 = await runClosureCleanupAttemptV2(ports, effectsFake());
    const progress: CleanupProgress = cleanupProgressOf(next);

    expect(progress.retry.automaticAttempt).toBe(1);
    expect(progress.retry.lastError).toContain('runtime write refused');
    expect(progress.retry.nextAttemptAt).not.toBeNull();
    expect(fake.alarmCalls).toContainEqual({ kind: 'create', name: CLOSURE_CLEANUP_ALARM });
    expect(next.pendingClosure?.stage).toBe('cleanup');
  });

  it('adds and clears a document that navigates during closure cleanup', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    const before: CleanupProgress = cleanupProgressOf(fake.current());
    const key: string = documentKey(12, 'document-2');

    await handleCleanupNavigationV2(fake, {
      tabId: 12,
      documentId: 'document-2',
      url: 'https://news.example.com/story',
    });

    // The controller routes every cleanup navigation to this entry, so a closure journal has to
    // serve it: the target lands in the closure batch, not in a transition that does not exist.
    const after: CleanupProgress = cleanupProgressOf(fake.current());
    expect(after.targets[key]?.expectedUrl).toBe('https://news.example.com/story');
    expect(after.clearCommands[key]?.operationId).toBe(before.cleanupOperationId);
    expect(after.clearCommands[key]?.runtimeRevision).toBe(before.clearRuntimeRevision);
    expect(fake.current().documentCommands[key]).toEqual(after.clearCommands[key]);
    expect(
      fake.sends
        .filter((send: FakeSendV2): boolean => send.documentId === 'document-2')
        .map((send: FakeSendV2): string => send.message.command),
    ).toEqual(['reset-enforcement-epoch', 'apply-enforcement']);
    expect(parseRuntimeStateV2(fake.current())).not.toBeNull();
  });

  it('ignores a navigation while no cleanup batch is durable', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await prepared(fake);
    const writes: number = fake.writes.length;

    await handleCleanupNavigationV2(fake, {
      tabId: 12,
      documentId: 'document-2',
      url: 'https://news.example.com/story',
    });

    // A prepared closure owns no clear batch, and the controller routes on the journal being
    // present rather than on its stage, so this has to be a no-op instead of a throw.
    expect(fake.writes).toHaveLength(writes);
    expect(fake.sends).toEqual([]);
  });

  it('refuses to run without a cleanup closure', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());

    await expect(runClosureCleanupAttemptV2(fake, effectsFake())).rejects.toThrow(CoreError);
  });
});

describe('retryClosureCleanupV2', (): void => {
  it('replaces the batch of an exhausted closure cleanup', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    await inCleanup(fake);
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());
    for (let attempt: number = 0; attempt < CLEANUP_MAX_AUTOMATIC_ATTEMPTS; attempt++) {
      await runClosureCleanupAttemptV2(fake, effectsFake());
    }
    const exhausted: CleanupProgress = cleanupProgressOf(fake.current());

    const retried: { runtime: RuntimeStateV2; code: string } = await retryClosureCleanupV2(fake);
    const progress: CleanupProgress = cleanupProgressOf(retried.runtime);

    expect(retried.code).toBe('ok');
    // Through the checkpoint, so `assertCleanupBatchAdvance` sees the replacement batch.
    expect(fake.commits).toHaveLength(2);
    expect(fake.commits[1]?.checkpointId).toBe(
      `${SESSION_ID}:close:cleanup-retry-${progress.retry.batch}`,
    );
    expect(fake.commits[1]?.events).toEqual([]);
    expect(fake.commits[1]?.syncBank).toBe(false);
    expect(progress.cleanupOperationId).not.toBe(exhausted.cleanupOperationId);
    expect(progress.clearRuntimeRevision).toBe(exhausted.clearRuntimeRevision + 1);
    expect(progress.retry.batch).toBe(exhausted.retry.batch + 1);
    expect(retried.runtime.runtimeRevision).toBe(progress.clearRuntimeRevision);
    expect(retried.runtime.documentCommands).toEqual(progress.clearCommands);
    expect(parseRuntimeStateV2(retried.runtime)).not.toBeNull();
  });

  it.each([
    ['a live batch', true],
    ['no closure', false],
  ])('refuses a manual retry with %s', async (_label: string, live: boolean): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    if (live) await inCleanup(fake);

    const retried: { runtime: RuntimeStateV2; code: string } = await retryClosureCleanupV2(fake);

    expect(retried.code).toBe('retry-not-available');
  });
});

describe('closeSessionV2', (): void => {
  it('prepares, commits, and runs the first attempt', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());

    const next: RuntimeStateV2 = await closeSessionV2(fake, effectsFake(), {
      endedAt: ENDED_AT,
      reason: 'timer-completed',
    });

    expect(fake.stages()).toContain(null);
    expect(fake.commits).toHaveLength(1);
    expect(next.session).toBeNull();
    expect(next.pendingClosure).toBeNull();
    expect(parseRuntimeStateV2(next)).not.toBeNull();
  });

  it('leaves the closure durable when its first attempt fails', async (): Promise<void> => {
    const fake: RuntimePortsFakeV2 = fakeFor(closingRuntime());
    fake.respondForDocument(11, DOC_ONE, noReceiverResponder());

    const next: RuntimeStateV2 = await closeSessionV2(fake, effectsFake(), {
      endedAt: ENDED_AT,
      reason: 'timer-completed',
    });

    expect(next.session).toBeNull();
    expect(next.pendingClosure?.stage).toBe('cleanup');
  });
});
