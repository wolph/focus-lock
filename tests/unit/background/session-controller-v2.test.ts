import { describe, expect, it, vi } from 'vitest';
import {
  PHASE_ALARM,
  TICK_ALARM,
  TRANSITION_CLEANUP_ALARM,
} from '../../../src/background/alarms-v2';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import type {
  PendingEnforcementTransition,
  RuntimeStateV2,
} from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import { SessionControllerV2 } from '../../../src/background/session-controller-v2';
import { DEFAULT_SETTINGS, GATE_EXPIRY_MS } from '../../../src/shared/constants';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import type {
  CommandResponseV2,
  SessionCommandResultCodeV2,
  StartSessionResponseV2,
} from '../../../src/shared/messages';
import { isSessionSnapshotV2 } from '../../../src/shared/runtime-validation';
import { localDateStr, localMidnightAfter } from '../../../src/shared/time';
import type {
  GateState,
  SessionConfigV2,
  SessionSnapshotV2,
  SessionStateV2,
} from '../../../src/shared/types';
import {
  type ControllerEffectsFakeV2,
  createControllerEffectsFakeV2,
  createRuntimePortsFakeV2,
  createScheduleRunnerPortsFakeV2,
  noReceiverResponder,
  type RuntimePortsFakeV2,
  type ScheduleRunnerPortsFakeV2,
} from './runtime-ports-fake';
import {
  ACTIVATION_AT,
  ACTIVE_OPERATION_ID,
  breakRuntime,
  breakSession,
  CLEANUP_OPERATION_ID,
  cancelGateState,
  cleanupClosureRuntime,
  cleanupTransition,
  commitCheckpointRuntime,
  documentKey,
  emptyRuntimeV2,
  epochResetAck,
  epochResetAckMap,
  OTHER_EPOCH_ID,
  OTHER_OPERATION_ID,
  pausedRuntime,
  pausedSession,
  pendingTransition,
  publishedFocusRuntime,
  SECOND_TARGET_URL,
  SESSION_ID,
  STARTING_OPERATION_ID,
  sessionConfigV2,
  TARGET_URL,
  TRANSITION_ID,
  timedFocusSession,
  transitionPostCleanupClosure,
  transitionRuntime,
  untilStoppedFocusSession,
} from './runtime-v2-fixtures';

const BLOCKED_URL: string = 'https://facebook.com/feed';
const DOC_ONE: string = 'document-1';
/** A document the frozen fixtures do not hold, so a navigation freezes its command from the URL. */
const DOC_BLOCKED: string = 'document-9';
const AT: number = ACTIVATION_AT + 60_000;
/** A focus watermark no settle can beat, so a spend test measures the spend and nothing else. */
const SETTLED_WATERMARK_MS: number = 86_400_000;
/** Enough scripted UUIDs for a start, its cleanup, and several live-view operations. */
const IDS: readonly string[] = [
  SESSION_ID,
  TRANSITION_ID,
  STARTING_OPERATION_ID,
  ACTIVE_OPERATION_ID,
  CLEANUP_OPERATION_ID,
  OTHER_OPERATION_ID,
  '60000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000002',
  '60000000-0000-4000-8000-000000000003',
  '60000000-0000-4000-8000-000000000004',
  '60000000-0000-4000-8000-000000000005',
  '60000000-0000-4000-8000-000000000006',
];

interface HarnessV2 {
  controller: SessionControllerV2;
  ports: RuntimePortsFakeV2;
  schedule: ScheduleRunnerPortsFakeV2;
  effects: ControllerEffectsFakeV2;
}

function harness(
  runtime: RuntimeStateV2 = emptyRuntimeV2({ runtimeRevision: 0 }),
  options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
): HarnessV2 {
  const ports: RuntimePortsFakeV2 = createRuntimePortsFakeV2(runtime, {
    now: AT,
    ids: [...IDS],
    tabs: [{ tabId: 11, url: BLOCKED_URL, documentId: DOC_ONE }],
    ...options,
  });
  const schedule: ScheduleRunnerPortsFakeV2 = createScheduleRunnerPortsFakeV2();
  const effects: ControllerEffectsFakeV2 = createControllerEffectsFakeV2();
  return {
    controller: new SessionControllerV2(ports, schedule, effects),
    ports,
    schedule,
    effects,
  };
}

function flexibleConfig(overrides: Partial<SessionConfigV2> = {}): SessionConfigV2 {
  return sessionConfigV2({ strictness: 'flexible', ...overrides });
}

/** The runtime revision of every enforcement command the transport received, in order. */
function sentRevisions(ports: RuntimePortsFakeV2): number[] {
  return ports.sends.flatMap((sent): number[] =>
    sent.message.command === 'apply-enforcement' ? [sent.message.runtimeRevision] : [],
  );
}

/** The gate an active overlay carries, or null for any other presentation. */
function overlayGate(command: FrozenDocumentCommand | undefined): GateState | null {
  const overlay = command?.overlay ?? null;
  return overlay !== null && overlay.presentation === 'active' ? overlay.gate : null;
}

function capturedGate(ports: RuntimePortsFakeV2): GateState {
  const gate: GateState | null = ports.current().gate;
  if (gate === null) throw new Error('Expected an open gate');
  return structuredClone(gate);
}

describe('bounded live document delivery', (): void => {
  it('merges concurrent reset acknowledgements before sending either replacement view', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime({
      accruedFocusMs: SETTLED_WATERMARK_MS,
      unlocks: [],
      epochResetAcks: {},
    });
    const original: FrozenDocumentCommand = Object.values(
      runtime.documentCommands,
    )[0] as FrozenDocumentCommand;
    runtime.documentCommands[documentKey(12, 'document-2')] = {
      ...original,
      tabId: 12,
      documentId: 'document-2',
    };
    const { controller, ports } = harness(runtime, { bank: { balanceMs: 600_000 } });
    expect((await controller.openGate('unlockSite', 'facebook.com')).ok).toBe(true);
    expect(Object.keys(ports.current().epochResetAcks)).toHaveLength(2);
    expect(ports.sends.map((sent): string => sent.message.command)).toEqual([
      'reset-enforcement-epoch',
      'reset-enforcement-epoch',
      'apply-enforcement',
      'apply-enforcement',
    ]);
    const ackWrites: RuntimeStateV2[] = ports.writes.filter(
      (write): boolean => Object.keys(write.epochResetAcks).length > 0,
    );
    expect(ackWrites).toHaveLength(1);
    expect(Object.keys(ackWrites[0]?.epochResetAcks ?? {})).toHaveLength(2);
  });

  it('does not persist a timed out reset or apply its old gate after cancellation', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const { controller, ports } = harness(
        publishedFocusRuntime({
          accruedFocusMs: SETTLED_WATERMARK_MS,
          unlocks: [],
          epochResetAcks: {},
        }),
        { bank: { balanceMs: 600_000 } },
      );
      let answer: (value: unknown) => void = (): void => {};
      ports.respondForDocument(
        11,
        DOC_ONE,
        (): Promise<unknown> =>
          new Promise((resolve): void => {
            answer = resolve;
          }),
      );
      const opening = controller.openGate('unlockSite', 'facebook.com');
      await vi.advanceTimersByTimeAsync(0);
      const reset: DocumentContentCommand | undefined = ports.sends[0]?.message;
      if (reset?.command !== 'reset-enforcement-epoch') throw new Error('expected reset command');
      const lateAnswer: (value: unknown) => void = answer;
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await opening).ok).toBe(true);
      const cancellation = controller.abandonGate();
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await cancellation).ok).toBe(true);
      const writes: number = ports.writes.length;
      lateAnswer({
        version: 1,
        operationId: reset.operationId,
        enforcementEpoch: reset.enforcementEpoch,
        documentId: reset.documentId,
        disposition: 'epoch-reset',
        observedUrl: reset.expectedUrl,
        handledAt: AT,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(ports.current().gate).toBeNull();
      expect(ports.current().epochResetAcks[documentKey(11, DOC_ONE)]).toBeUndefined();
      expect(ports.writes).toHaveLength(writes);
      expect(
        ports.sends
          .filter((sent): boolean => sent.tabId === 11)
          .every((sent): boolean => sent.message.command === 'reset-enforcement-epoch'),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists a gate before parallel sends and releases its queued cancellation after one deadline', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const runtime: RuntimeStateV2 = publishedFocusRuntime({
        accruedFocusMs: SETTLED_WATERMARK_MS,
        unlocks: [],
      });
      const original: FrozenDocumentCommand = Object.values(
        runtime.documentCommands,
      )[0] as FrozenDocumentCommand;
      runtime.documentCommands[documentKey(12, 'document-2')] = {
        ...original,
        tabId: 12,
        documentId: 'document-2',
      };
      runtime.epochResetAcks[documentKey(12, 'document-2')] = epochResetAck({
        tabId: 12,
        documentId: 'document-2',
      });
      const { controller, ports } = harness(runtime, { bank: { balanceMs: 600_000 } });
      for (const command of Object.values(runtime.documentCommands)) {
        ports.respondForDocument(
          command.tabId,
          command.documentId,
          (): Promise<unknown> => new Promise((): void => {}),
        );
      }
      let opened: boolean = false;
      const opening = controller.openGate('unlockSite', 'facebook.com').then((response): void => {
        opened = response.ok;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(ports.current().gate?.kind).toBe('unlockSite');
      expect(ports.sends).toHaveLength(2);
      const cancellation = controller.abandonGate();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(opened).toBe(true);
      expect(ports.current().gate).toBeNull();
      await vi.advanceTimersByTimeAsync(2_000);
      await opening;
      expect((await cancellation).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Every legacy event of one kind the controller committed, in order. */
function eventsOf(ports: RuntimePortsFakeV2, t: string): Array<Record<string, unknown>> {
  return ports.commits.flatMap(
    (commit): Array<Record<string, unknown>> =>
      commit.events
        .filter((event): boolean => event.t === t)
        .map((event): Record<string, unknown> => event as unknown as Record<string, unknown>),
  );
}

/** Opens a gate, waits past its delay, and confirms it with the phrase it persisted. */
async function confirmOpenGate(
  controller: SessionControllerV2,
  ports: RuntimePortsFakeV2,
): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
  ports.advance(60_000);
  return controller.confirmGate(ports.current().gate?.requiredPhrase ?? null);
}

describe('SessionControllerV2 past the end of a session a journal retains', (): void => {
  /** A cleanup transition that keeps its session, at an instant past that session's fixed end. */
  function retained(): { at: number; runtime: RuntimeStateV2 } {
    const transition: PendingEnforcementTransition = cleanupTransition(
      'start',
      'alarm-ready',
      'manual-end',
      { postCleanupClosure: transitionPostCleanupClosure() },
    );
    const runtime: RuntimeStateV2 = transitionRuntime(transition);
    const session: SessionStateV2 | null = runtime.session;
    if (session === null) throw new Error('the cleanup transition kept no session');
    const endsAt: number | null = session.sessionEndsAt;
    if (endsAt === null) throw new Error('the retained session carries no fixed end');
    return { runtime, at: endsAt + 60_000 };
  }

  it('does not try to close a session the journal is already closing', async (): Promise<void> => {
    // The closure builder refuses a session a transition owns, so an unguarded settle threw here
    // and took the whole minute of Engine maintenance behind the tick with it, every tick, for as
    // long as the journal lived.
    const { controller, ports } = retainedHarness();

    await expect(controller.tick()).resolves.toBeUndefined();

    // The journal's own closure is the only end this session gets. A settle that closed it too
    // would either throw, which is what it did, or record a second end for one session.
    const ends: unknown[] = ports.commits.flatMap((commit): unknown[] =>
      commit.events.filter(
        (event): boolean =>
          (event as { reason?: unknown }).reason === 'timer-completed' &&
          (event as { t?: unknown }).t === 'sessionEnded',
      ),
    );
    expect(ends).toEqual([]);
  });

  it('reports the cleanup the journal is running rather than a closure', async (): Promise<void> => {
    const { controller } = retainedHarness();

    const snapshot: SessionSnapshotV2 = controller.snapshot(retained().at);

    // The projection already describes this state exactly. Naming a closure instead hides the
    // transition error and the retry the person could act on behind a cleanup no row backs.
    expect(snapshot.lifecycle.kind).toBe('cleanup');
    if (snapshot.lifecycle.kind !== 'cleanup') throw new Error('expected a cleanup lifecycle');
    expect(snapshot.lifecycle.journal).toBe('transition');
  });

  function retainedHarness(): HarnessV2 {
    const seeded: { at: number; runtime: RuntimeStateV2 } = retained();
    return harness(seeded.runtime, { now: seeded.at });
  }
});

describe('SessionControllerV2 live views under a cleanup journal', (): void => {
  it('refreshes nothing while a closure cleanup owns the command map', async (): Promise<void> => {
    // The refresh is the first thing the phase-change sweep calls, and the sweep's blocking work
    // runs after it. While a cleanup batch is durable the commit is refused by the validator, so a
    // refresh that tried it threw on every alarm and every sweeping command, and the browser-effect
    // sweep behind it was skipped for the whole life of the journal.
    const { controller, ports } = harness(cleanupClosureRuntime());
    const before: RuntimeStateV2 = ports.current();

    await expect(controller.refreshLiveViews()).resolves.toBeUndefined();

    expect(ports.current()).toEqual(before);
  });

  it('refreshes nothing while a transition cleanup owns the command map', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(cleanupTransition('start', 'starting-verified', 'start-abandon')),
    );
    const before: RuntimeStateV2 = ports.current();

    await expect(controller.refreshLiveViews()).resolves.toBeUndefined();

    expect(ports.current()).toEqual(before);
  });
});

describe('SessionControllerV2 writes around an outstanding commit checkpoint', (): void => {
  /** The checkpoint an in-flight commit leaves in the runtime, projecting the runtime it saw. */
  it('hands a pulling document its epoch reset while a commit is in flight', async (): Promise<void> => {
    // The acknowledgement is part of the projected domain, so writing one on top of a runtime that
    // still carries an in-flight commit's checkpoint broke the checkpoint's own equality and the
    // write was refused. The document then got its reset again on every later pull, forever, while
    // the overlay it rendered looked perfectly correct.
    const { controller, ports } = harness(commitCheckpointRuntime(publishedFocusRuntime()), {
      tabs: [{ tabId: 12, url: BLOCKED_URL, documentId: DOC_BLOCKED }],
    });

    const commands: DocumentContentCommand[] = await controller.documentCommandsFor(
      { tabId: 12, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      'navigation',
      'deliver',
    );

    expect(commands.map((command: DocumentContentCommand): string => command.command)).toEqual([
      'reset-enforcement-epoch',
      'apply-enforcement',
    ]);
    // The acknowledgement is durable, so the next pull owes this document no second reset.
    expect(ports.current().epochResetAcks[documentKey(12, DOC_BLOCKED)]).toBeDefined();
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('refreezes a document that navigated within itself while a commit is in flight', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = commitCheckpointRuntime(publishedFocusRuntime());
    const { controller, ports } = harness(runtime, {
      tabs: [{ tabId: 11, url: SECOND_TARGET_URL, documentId: DOC_ONE }],
    });

    const commands: DocumentContentCommand[] = await controller.documentCommandsFor(
      { tabId: 11, documentId: DOC_ONE, url: SECOND_TARGET_URL },
      'navigation',
      'deliver',
    );

    // The refreeze lands under the outstanding checkpoint. The page it is for applied the clear it
    // was sent, and the drop that follows lands in the same window, so the map keeps no address for
    // a page the session no longer blocks.
    const applied: DocumentContentCommand | undefined = commands.find(
      (command: DocumentContentCommand): boolean => command.command === 'apply-enforcement',
    );
    expect(applied?.command === 'apply-enforcement' ? applied.expectedUrl : null).toBe(
      SECOND_TARGET_URL,
    );
    expect(applied?.command === 'apply-enforcement' ? applied.presentation : null).toBe('clear');
    expect(applied?.command === 'apply-enforcement' ? applied.runtimeRevision : null).toBe(
      ports.current().runtimeRevision,
    );
    expect(ports.current().documentCommands[documentKey(11, DOC_ONE)]).toBeUndefined();
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });
});

describe('SessionControllerV2 document pull under a journal', (): void => {
  it('adds a document the durable clear batch does not name and hands it the clear', async (): Promise<void> => {
    // The map is the frozen clear batch while a journal is durable, and the validators require the
    // runtime to keep it exactly, so freezing an ordinary command for a new document wrote a
    // runtime they refused and the pull threw. It now joins the batch instead, through the same
    // durable add the navigation push makes: a document whose only contact with the worker is a
    // pull no longer waits for the journal's runner to enumerate it.
    const { controller, ports } = harness(cleanupClosureRuntime(), {
      tabs: [{ tabId: 77, url: BLOCKED_URL, documentId: 'document-77' }],
    });
    const key: string = documentKey(77, 'document-77');

    const commands: DocumentContentCommand[] = await controller.documentCommandsFor(
      { tabId: 77, documentId: 'document-77', url: BLOCKED_URL },
      'navigation',
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      command: 'apply-enforcement',
      presentation: 'clear',
      expectedUrl: BLOCKED_URL,
    });
    const added: FrozenDocumentCommand | undefined =
      ports.current().pendingClosure?.cleanupProgress?.clearCommands[key];
    expect(added).toBeDefined();
    expect(ports.current().documentCommands[key]).toEqual(added);
  });

  it('records no stopped page for a navigation pull a retained-session cleanup answers', async (): Promise<void> => {
    // The answer is a clear, so the page is not stopped. A claim taken here differs from the
    // journal's saved claim and every later cleanup attempt failed on the contradiction.
    const runtime: RuntimeStateV2 = transitionRuntime(
      cleanupTransition('start', 'alarm-ready', 'manual-end', {
        postCleanupClosure: transitionPostCleanupClosure(),
      }),
      { session: timedFocusSession() },
    );
    expect(runtime.session?.phase).toBe('focus');
    const { controller, effects } = harness(runtime, {
      tabs: [{ tabId: 77, url: BLOCKED_URL, documentId: 'document-77' }],
    });

    const commands: DocumentContentCommand[] = await controller.documentCommandsFor(
      { tabId: 77, documentId: 'document-77', url: BLOCKED_URL },
      'navigation',
      'deliver',
    );

    expect(
      commands.some(
        (c: DocumentContentCommand): boolean => 'presentation' in c && c.presentation === 'clear',
      ),
    ).toBe(true);
    expect(effects.stopped).toHaveLength(0);
  });

  it('leaves a sweep read out of the frozen batch', async (): Promise<void> => {
    // A sweep reports what a target already holds and its URL came from a tab query that may be
    // behind the navigation it is racing, so it does not get to write a durable clear command for a
    // page it may be wrong about. It still answers rather than throwing.
    const { controller, ports } = harness(cleanupClosureRuntime(), {
      tabs: [{ tabId: 77, url: BLOCKED_URL, documentId: 'document-77' }],
    });

    const commands: DocumentContentCommand[] = await controller.documentCommandsFor(
      { tabId: 77, documentId: 'document-77', url: BLOCKED_URL },
      null,
    );

    expect(commands).toEqual([]);
    expect(
      ports.current().pendingClosure?.cleanupProgress?.clearCommands[
        documentKey(77, 'document-77')
      ],
    ).toBeUndefined();
    expect(ports.writes).toHaveLength(0);
  });

  it('hands a document the clear command the batch already holds for it', async (): Promise<void> => {
    const closing: RuntimeStateV2 = cleanupClosureRuntime();
    const key: string = documentKey(11, 'document-1');
    const { controller } = harness(closing);

    const commands: DocumentContentCommand[] = await controller.documentCommandsFor(
      { tabId: 11, documentId: 'document-1', url: TARGET_URL },
      'navigation',
    );

    const expected = closing.pendingClosure?.cleanupProgress?.clearCommands[key];
    expect(expected).toBeDefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      command: 'apply-enforcement',
      presentation: 'clear',
      operationId: expected?.operationId,
      runtimeRevision: expected?.runtimeRevision,
    });
  });
});

describe('SessionControllerV2 commands during a closure journal', (): void => {
  it('answers no-active-session for both spellings of End and cleanup-pending for the rest', async (): Promise<void> => {
    // Spec 1170: a session already closing is no active session. The Friction End opens the cancel
    // gate, so it is an End and answers the same code requestSessionEnd does. A pause or unlock
    // gate is not an End, and reports the journal that is actually blocking it.
    const closing: RuntimeStateV2 = cleanupClosureRuntime();

    const flexibleEnd = await harness(closing).controller.requestSessionEnd();
    const frictionEnd = await harness(closing).controller.openEndGate();
    const pause = await harness(closing).controller.openGate('pause', null);
    const unlock = await harness(closing).controller.openGate('unlockSite', 'facebook.com');

    expect(flexibleEnd.code).toBe('no-active-session');
    expect(frictionEnd.code).toBe('no-active-session');
    expect(pause.code).toBe('closure-cleanup-pending');
    expect(unlock.code).toBe('closure-cleanup-pending');
  });
});

describe('SessionControllerV2 local-date walk', (): void => {
  it('settles each finished local day before it asks the Engine to close it', async (): Promise<void> => {
    // The ordering is the point: a closure delta must never land on a day already closed. The fake
    // records the write count at each rollover, so "settled first" is an assertion rather than a
    // claim in the test name.
    const threeDaysAgo: string = localDateStr(AT - 3 * 86_400_000);
    // A live session, because a settle only writes when there is focus to credit. `todayAgg` is
    // the aggregate for the day the runtime is on, so it goes with the date the walk starts from.
    const { controller, ports } = harness({
      ...publishedFocusRuntime(),
      date: threeDaysAgo,
      todayAgg: null,
    });
    // The retained Engine owns `date`, so the fake has to stand in for it or the walk stops after
    // one boundary with nothing advanced.
    ports.onRolloverAdvanceDate = true;

    await controller.tick();

    expect(ports.rollovers.length).toBeGreaterThanOrEqual(3);
    expect(ports.rollovers).toEqual(
      [...ports.rollovers].sort((a: number, b: number): number => a - b),
    );
    expect(ports.rolloverCallWrites).toHaveLength(ports.rollovers.length);
    // Every close is preceded by at least one write, and each one by strictly more than the last,
    // which is the settle that ran between them.
    expect(ports.rolloverCallWrites[0]).toBeGreaterThan(0);
    for (let index: number = 1; index < ports.rolloverCallWrites.length; index++) {
      expect(ports.rolloverCallWrites[index]).toBeGreaterThan(
        ports.rolloverCallWrites[index - 1] ?? 0,
      );
    }
    expect(ports.current().date).toBe(localDateStr(AT));
  });
});

describe('SessionControllerV2 startSession', (): void => {
  it('converts the config to a manual candidate and publishes', async (): Promise<void> => {
    const { controller, ports } = harness();
    const response: StartSessionResponseV2 = await controller.startSession(flexibleConfig());
    const prepared = ports.writes[0]?.pendingEnforcementTransition;

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(prepared?.kind).toBe('start');
    expect(prepared?.trigger).toBe('manual');
    expect(prepared?.candidate?.source).toBe('manual');
    expect(prepared?.candidate?.scheduleOccurrence).toBeNull();
    expect(prepared?.candidate?.scheduleWindow).toBeNull();
    expect(prepared?.candidate?.duration).toEqual({ kind: 'manual-timed', minutes: 25 });
    expect(prepared?.candidate?.mode).toBe(flexibleConfig().mode);
    expect(ports.current().pendingEnforcementTransition).toBeNull();
    expect(ports.current().session?.sessionId).toBe(SESSION_ID);
  });

  it('converts an indefinite config to an until-stopped plan', async (): Promise<void> => {
    const { controller, ports } = harness();
    await controller.startSession(
      flexibleConfig({ duration: { kind: 'until-stopped' }, cycling: null }),
    );

    expect(ports.writes[0]?.pendingEnforcementTransition?.candidate?.duration).toEqual({
      kind: 'until-stopped',
    });
    expect(ports.current().session?.sessionEndsAt).toBeNull();
  });

  it('rejects a config the boundary refuses without writing', async (): Promise<void> => {
    const { controller, ports } = harness();
    const hostile: SessionConfigV2 = {
      ...flexibleConfig(),
      rules: new Proxy(flexibleConfig().rules, {}),
    };
    const response: StartSessionResponseV2 = await controller.startSession(hostile);

    expect(response.ok).toBe(false);
    expect(response.code).toBe('invalid-request');
    expect(ports.writes).toHaveLength(0);
    expect(ports.sends).toHaveLength(0);
  });

  it('answers the failure code with no cleanupPending when nothing was sent', async (): Promise<void> => {
    const { controller, ports, effects } = harness(emptyRuntimeV2({ runtimeRevision: 0 }), {
      audit: 'website-access-lost',
    });
    await controller.recover();
    const response: StartSessionResponseV2 = await controller.startSession(flexibleConfig());

    expect(response.ok).toBe(false);
    expect(response.code).toBe('website-access-lost');
    expect('cleanupPending' in response ? response.cleanupPending : undefined).toBeUndefined();
    // No enforcement was ever sent, so nothing under a starting or active presentation went out.
    // The clear batch the entry freezes is a separate concern, recorded in the task report.
    for (const send of ports.sends) {
      const message = send.message;
      if (message.command !== 'apply-enforcement') continue;
      expect(message.presentation).toBe('clear');
    }
    // The reservation-release cleanup ran to its resolution inside the command, so the lifecycle
    // the popup reads next is idle rather than a cleanup the user cannot act on.
    expect(ports.current().pendingEnforcementTransition).toBeNull();
    expect(controller.snapshot(ports.now()).lifecycle.kind).toBe('idle');
    expect(effects.broadcasts.length).toBeGreaterThan(0);
  });

  it('refuses a start while either journal exists', async (): Promise<void> => {
    const transition = harness(
      transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon')),
    );
    expect((await transition.controller.startSession(flexibleConfig())).code).toBe(
      'transition-cleanup-pending',
    );

    const closure = harness(cleanupClosureRuntime());
    expect((await closure.controller.startSession(flexibleConfig())).code).toBe(
      'closure-cleanup-pending',
    );
  });
});

describe('SessionControllerV2 end and gate commands', (): void => {
  it('closes a published Flexible session at the request time', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: flexibleConfig() }),
      }),
    );
    const response: CommandResponseV2<SessionCommandResultCodeV2> =
      await controller.requestSessionEnd();

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(ports.current().session).toBeNull();
  });

  it('uses manual-completed for an indefinite session and plays no completion sound', async (): Promise<void> => {
    const { controller, ports, effects } = harness(
      publishedFocusRuntime({
        session: untilStoppedFocusSession({
          config: flexibleConfig({ duration: { kind: 'until-stopped' } }),
        }),
      }),
    );
    await controller.requestSessionEnd();
    const reasons: string[] = ports.commits.flatMap((commit): string[] =>
      commit.events
        .filter((event): boolean => event.t === 'sessionEnded')
        .map((event): string => ('reason' in event ? String(event.reason) : '')),
    );

    expect(reasons).toContain('manual-completed');
    expect(effects.sounds).not.toContain('sessionComplete');
    expect(effects.notices).toHaveLength(0);
  });

  it('refuses End for Hard and Friction and answers no-active-session when idle', async (): Promise<void> => {
    for (const strictness of ['hard', 'friction'] as const) {
      const { controller } = harness(
        publishedFocusRuntime({
          session: timedFocusSession({ config: sessionConfigV2({ strictness }) }),
        }),
      );
      expect((await controller.requestSessionEnd()).code).toBe('end-not-allowed');
    }
    expect((await harness().controller.requestSessionEnd()).code).toBe('no-active-session');
    expect((await harness(cleanupClosureRuntime()).controller.requestSessionEnd()).code).toBe(
      'no-active-session',
    );
  });

  it('reports transition cleanup while that journal exists', async (): Promise<void> => {
    const { controller } = harness(
      transitionRuntime(
        cleanupTransition('start', 'alarm-ready', 'manual-end', {
          postCleanupClosure: transitionPostCleanupClosure(),
        }),
        { session: timedFocusSession() },
      ),
    );
    expect((await controller.requestSessionEnd()).code).toBe('transition-cleanup-pending');
  });

  it('opens the Friction cancel gate under a fresh operation and a higher revision', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    const before: number = ports.current().runtimeRevision;
    const response: CommandResponseV2<SessionCommandResultCodeV2> = await controller.openEndGate();
    const after: RuntimeStateV2 = ports.current();

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(after.gate?.kind).toBe('cancel');
    expect(after.runtimeRevision).toBeGreaterThan(before);
    for (const command of Object.values(after.documentCommands)) {
      expect(command.runtimeRevision).toBe(after.runtimeRevision);
      expect(command.operationId).not.toBe(ACTIVE_OPERATION_ID);
    }
    // A live update never rewrites the base-policy checkpoint.
    expect(after.enforcementCheckpoint?.operationId).toBe(ACTIVE_OPERATION_ID);
    expect((await controller.openEndGate()).code).toBe('ok');
  });

  it('mints the force end flag on the cancel gate only while the setting is on', async (): Promise<void> => {
    const friction: RuntimeStateV2 = publishedFocusRuntime({
      session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
    });
    const off: HarnessV2 = harness(friction);
    const on: HarnessV2 = harness(friction, {
      gateSettings: { ...DEFAULT_SETTINGS.gate, allowForceEnd: true },
    });

    expect((await off.controller.openEndGate()).code).toBe('ok');
    expect((await on.controller.openEndGate()).code).toBe('ok');

    expect(off.ports.current().gate?.forceEndAvailable).toBe(false);
    expect(on.ports.current().gate?.forceEndAvailable).toBe(true);
  });

  it('never mints the force end flag on a pause or unlock gate', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({ accruedFocusMs: SETTLED_WATERMARK_MS }),
      {
        bank: { balanceMs: 600_000 },
        gateSettings: { ...DEFAULT_SETTINGS.gate, allowForceEnd: true },
      },
    );

    expect((await controller.openGate('pause', null)).code).toBe('ok');
    expect(ports.current().gate?.forceEndAvailable).toBe(false);
    await controller.abandonGate();
    expect((await controller.openGate('unlockSite', 'facebook.com')).code).toBe('ok');
    expect(ports.current().gate?.forceEndAvailable).toBe(false);
  });

  it('refuses the End gate for other strictness', async (): Promise<void> => {
    for (const strictness of ['flexible', 'hard'] as const) {
      const { controller } = harness(
        publishedFocusRuntime({
          session: timedFocusSession({ config: sessionConfigV2({ strictness }) }),
        }),
      );
      expect((await controller.openEndGate()).code).toBe('end-not-allowed');
    }
  });

  it('abandons a gate with no change to the verification budget', async (): Promise<void> => {
    expect((await harness(publishedFocusRuntime()).controller.abandonGate()).code).toBe(
      'no-active-gate',
    );

    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    await controller.openEndGate();
    const response: CommandResponseV2<SessionCommandResultCodeV2> = await controller.abandonGate();

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(ports.current().gate).toBeNull();
    // Spec 1021: a committed Friction transition persists its gate and refreezes the active view,
    // and neither the attempt count nor the ten-second budget moves.
    const committed = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    const before = committed.ports.current().pendingEnforcementTransition;
    expect((await committed.controller.openEndGate()).code).toBe('ok');
    const opened: RuntimeStateV2 = committed.ports.current();
    const afterOpen = opened.pendingEnforcementTransition;

    expect(parseRuntimeStateV2(opened)).not.toBeNull();
    expect(opened.gate?.kind).toBe('cancel');
    expect(afterOpen?.activeView?.runtimeRevision).toBe(
      (before?.activeView?.runtimeRevision ?? 0) + 1,
    );
    expect(opened.runtimeRevision).toBe(afterOpen?.activeView?.runtimeRevision);
    expect(opened.documentCommands).toEqual(afterOpen?.activeView?.documents);
    expect(afterOpen?.freshnessAttempts).toBe(before?.freshnessAttempts);
    expect(afterOpen?.verificationStartedAt).toBe(before?.verificationStartedAt);

    expect((await committed.controller.abandonGate()).code).toBe('ok');
    const abandoned: RuntimeStateV2 = committed.ports.current();
    expect(abandoned.gate).toBeNull();
    expect(parseRuntimeStateV2(abandoned)).not.toBeNull();
    expect(abandoned.pendingEnforcementTransition?.stage).toBe('alarm-ready');
    expect(abandoned.pendingEnforcementTransition?.freshnessAttempts).toBe(
      before?.freshnessAttempts,
    );
    expect(abandoned.pendingEnforcementTransition?.verificationStartedAt).toBe(
      before?.verificationStartedAt,
    );

    // Hard is the one strictness that refuses End outright.
    const hard = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'hard' }) }),
      }),
    );
    expect((await hard.controller.openEndGate()).code).toBe('end-not-allowed');
  });

  /** A committed transition whose frozen view matches the live tabs, inside its ten-second budget. */
  function restartHarness(
    options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
    transition: Partial<PendingEnforcementTransition> = {},
  ): HarnessV2 {
    return harness(
      transitionRuntime(pendingTransition('start', 'active-verified', transition), {
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
        // The documents that applied the starting view are on this epoch, so a replacement view
        // goes to them without a reset in front of it.
        epochResetAcks: {
          ...epochResetAckMap(),
          [documentKey(12, 'document-2')]: epochResetAck({ tabId: 12, documentId: 'document-2' }),
        },
      }),
      {
        now: ACTIVATION_AT + 5_000,
        tabs: [
          { tabId: 11, url: TARGET_URL, documentId: DOC_ONE },
          { tabId: 12, url: SECOND_TARGET_URL, documentId: 'document-2' },
        ],
        ...options,
      },
    );
  }

  /** Every freshness attempt count a write recorded, so the restart can be pinned to one attempt. */
  function attemptCounts(ports: RuntimePortsFakeV2): number[] {
    return ports.writes.flatMap((write): number[] =>
      write.pendingEnforcementTransition === null
        ? []
        : [write.pendingEnforcementTransition.freshnessAttempts],
    );
  }

  it('restarts the verification pass when a gate lands at active-verified', async (): Promise<void> => {
    for (const command of ['open', 'abandon'] as const) {
      const { controller, ports } = restartHarness();
      const before = ports.current().pendingEnforcementTransition;
      const attempts: number = before?.freshnessAttempts ?? 0;
      const sentAtCommand: number = ports.sends.length;
      expect(before?.checkpoint).not.toBeNull();
      expect((await controller.openEndGate()).code).toBe('ok');
      if (command === 'abandon') expect((await controller.abandonGate()).code).toBe('ok');

      const restarted = ports.current().pendingEnforcementTransition;
      // The refreeze replaced the operation the candidate checkpoint attested, so the checkpoint is
      // discarded and the pass restarts from the stage that does not require it.
      expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
      expect(restarted?.stage).toBe('alarm-ready');
      expect(restarted?.checkpoint).toBeNull();
      // The count gives back the attempt the restart re-spends, so the runner's increment lands on
      // the number the transition already had rather than a new one.
      expect(restarted?.freshnessAttempts).toBe(attempts - 1);
      expect(restarted?.verificationStartedAt).toBe(before?.verificationStartedAt);
      const operationId: string | undefined = restarted?.activeView?.operationId;
      expect(operationId).not.toBe(before?.activeOperationId);
      expect(ports.current().documentCommands).toEqual(restarted?.activeView?.documents);
      // The documents holding the old view get the replacement at once, not at the next pass.
      expect(
        ports.sends
          .slice(sentAtCommand)
          .some((sent): boolean => sent.message.operationId === operationId),
      ).toBe(true);
      expect(eventsOf(ports, command === 'abandon' ? 'gateResisted' : 'gateOpened')).toHaveLength(
        1,
      );

      // The next drive is recovery's. It runs the pass against the replacement view, on the same
      // attempt number and the same deadline the gate found.
      const sentBefore: number = ports.sends.length;
      await controller.recover();
      const reissued = ports.sends.slice(sentBefore);
      expect(reissued.length).toBeGreaterThan(0);
      expect(reissued.every((sent): boolean => sent.message.operationId === operationId)).toBe(
        true,
      );
      expect(
        ports.writes.some(
          (write): boolean =>
            write.pendingEnforcementTransition?.stage === 'active-verified' &&
            write.pendingEnforcementTransition.freshnessAttempts === attempts,
        ),
      ).toBe(true);
      expect(Math.max(...attemptCounts(ports))).toBe(attempts);
      expect(
        ports.writes.every(
          (write): boolean =>
            write.pendingEnforcementTransition === null ||
            write.pendingEnforcementTransition.verificationStartedAt ===
              before?.verificationStartedAt,
        ),
      ).toBe(true);
      // A finished pass publishes, and the gate the user is deliberating over survives it.
      expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
      expect(ports.current().pendingEnforcementTransition).toBeNull();
      if (command === 'abandon') expect(ports.current().gate).toBeNull();
      else expect(ports.current().gate?.kind).toBe('cancel');
    }
  });

  it('never revives a transition whose freshness budget is already spent', async (): Promise<void> => {
    // Spec 775 spends the budget two ways, and a gate action must not revive either: the deadline
    // arrives, or the count is already three inside the ten seconds.
    const spent: ReadonlyArray<[string, HarnessV2]> = [
      ['deadline', restartHarness({ now: ACTIVATION_AT + 60_000 })],
      ['attempts', restartHarness({}, { freshnessAttempts: 3 })],
    ];
    for (const [label, { controller, ports }] of spent) {
      const before = ports.current().pendingEnforcementTransition;
      expect((await controller.openEndGate()).code, label).toBe('ok');

      const stepped = ports.current().pendingEnforcementTransition;
      // The row still has to be valid, so the invalidated checkpoint goes. The attempt count does
      // not come back, because no pass is coming to spend it.
      expect(parseRuntimeStateV2(ports.current()), label).not.toBeNull();
      expect(stepped?.stage, label).toBe('alarm-ready');
      expect(stepped?.checkpoint, label).toBeNull();
      expect(stepped?.freshnessAttempts, label).toBe(before?.freshnessAttempts);

      await controller.recover();

      // The drive begins no attempt, so it fails the transition instead of reviving it.
      expect(Math.max(...attemptCounts(ports)), label).toBe(before?.freshnessAttempts);
      expect(ports.current().pendingEnforcementTransition?.stage ?? 'resolved', label).not.toBe(
        'alarm-ready',
      );
      expect(
        ports.writes.some(
          (write): boolean =>
            write.pendingEnforcementTransition?.stage === 'cleanup' &&
            write.pendingEnforcementTransition.failure === 'tab-enforcement-failed',
        ),
        label,
      ).toBe(true);
    }
  });

  it('restarts a pre-commit pass when a live refresh lands at starting-verified', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(pendingTransition('start', 'starting-verified')),
    );
    const before = ports.current().pendingEnforcementTransition;
    await controller.refreshLiveViews();

    const after: RuntimeStateV2 = ports.current();
    const restarted = after.pendingEnforcementTransition;
    expect(parseRuntimeStateV2(after)).not.toBeNull();
    expect(restarted?.stage).toBe('registration-audited');
    expect(restarted?.startingCheckpoint).toBeNull();
    expect(restarted?.freshnessAttempts).toBe(before?.freshnessAttempts);
    expect(restarted?.startingView?.runtimeRevision).toBe(after.runtimeRevision);
  });

  it('records gate events raised during a committed transition', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    expect((await controller.openEndGate()).code).toBe('ok');
    expect((await controller.abandonGate()).code).toBe('ok');

    expect(eventsOf(ports, 'gateOpened')).toHaveLength(1);
    expect(eventsOf(ports, 'gateResisted')).toHaveLength(1);
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('ends a committed transition through its cleanup journal, not as no-active-session', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    expect((await controller.openEndGate()).code).toBe('ok');
    const response: CommandResponseV2<SessionCommandResultCodeV2> = await confirmOpenGate(
      controller,
      ports,
    );

    expect(response.code).not.toBe('no-active-session');
    expect(response).toEqual({ ok: true, code: 'ok' });
    // The End is the transition's, so it leaves through the transition journal rather than the
    // bare closure a published session would take.
    const after: RuntimeStateV2 = ports.current();
    expect(parseRuntimeStateV2(after)).not.toBeNull();
    expect(after.gate).toBeNull();
    const cleanupAt: number = ports.writes.findIndex(
      (write): boolean => write.pendingEnforcementTransition?.stage === 'cleanup',
    );
    const closureAt: number = ports.writes.findIndex(
      (write): boolean => write.pendingClosure !== null,
    );
    // A published session prepares its closure directly. This one reverses the transition first,
    // so the cleanup journal exists before any closure does.
    expect(cleanupAt).toBeGreaterThanOrEqual(0);
    expect(closureAt).toBeGreaterThan(cleanupAt);
  });

  it('gates confirmation on readiness and the typed phrase', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
      // The phrase is a settings choice, so this profile asks for one.
      { gateSettings: { ...DEFAULT_SETTINGS.gate, requireTypedPhrase: true } },
    );
    await controller.openEndGate();
    expect((await controller.confirmGate(null)).code).toBe('gate-not-ready');
    ports.advance(60_000);
    expect((await controller.confirmGate('the wrong phrase')).code).toBe('confirmation-mismatch');
    expect((await controller.confirmGate(ports.current().gate?.requiredPhrase ?? null)).code).toBe(
      'ok',
    );
    expect(ports.current().session).toBeNull();
  });

  it('force ends a Friction session before the gate is ready and without the phrase', async (): Promise<void> => {
    const { controller, ports, effects } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
      { gateSettings: { ...DEFAULT_SETTINGS.gate, requireTypedPhrase: true, allowForceEnd: true } },
    );
    await controller.openEndGate();
    const gate: GateState = capturedGate(ports);
    expect(gate.forceEndAvailable).toBe(true);
    expect(ports.now()).toBeLessThan(gate.readyAt);

    const response: CommandResponseV2<SessionCommandResultCodeV2> = await controller.forceEndGate();

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(ports.current().session).toBeNull();
    expect(ports.current().gate).toBeNull();
    // A timed session ended by hand is canceled, the same reason the confirmed gate records.
    const reasons: string[] = ports.commits.flatMap((commit): string[] =>
      commit.events
        .filter((event): boolean => event.t === 'sessionEnded')
        .map((event): string => ('reason' in event ? String(event.reason) : '')),
    );
    expect(reasons).toContain('manual-canceled');
    expect(effects.sounds).not.toContain('sessionComplete');
  });

  it('refuses the force end without a gate, on an economy gate, and for the wrong type', async (): Promise<void> => {
    const on: Parameters<typeof harness>[1] = {
      bank: { balanceMs: 600_000 },
      gateSettings: { ...DEFAULT_SETTINGS.gate, allowForceEnd: true },
    };
    const friction: RuntimeStateV2 = publishedFocusRuntime({
      session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      accruedFocusMs: SETTLED_WATERMARK_MS,
    });

    // No gate is open: nothing to bypass.
    const idle: HarnessV2 = harness(friction, on);
    expect((await idle.controller.forceEndGate()).code).toBe('no-active-gate');
    expect(idle.ports.current().session).not.toBeNull();

    // A pause gate, then an unlock gate: the bypass only ends a session.
    const economy: HarnessV2 = harness(friction, on);
    expect((await economy.controller.openGate('pause', null)).code).toBe('ok');
    expect((await economy.controller.forceEndGate()).code).toBe('end-not-allowed');
    await economy.controller.abandonGate();
    expect((await economy.controller.openGate('unlockSite', 'facebook.com')).code).toBe('ok');
    expect((await economy.controller.forceEndGate()).code).toBe('end-not-allowed');
    expect(economy.ports.current().session).not.toBeNull();

    // A cancel gate persisted against a Hard or Flexible session is no bypass either.
    for (const strictness of ['hard', 'flexible'] as const) {
      const wrongType: HarnessV2 = harness(
        publishedFocusRuntime({
          session: timedFocusSession({ config: sessionConfigV2({ strictness }) }),
          gate: cancelGateState({ forceEndAvailable: true }),
        }),
        on,
      );
      expect((await wrongType.controller.forceEndGate()).code).toBe('end-not-allowed');
      expect(wrongType.ports.current().session).not.toBeNull();
    }
  });

  it('refuses the force end when either the live setting or the minted flag is off', async (): Promise<void> => {
    const frictionWith: (gate: GateState) => RuntimeStateV2 = (gate: GateState): RuntimeStateV2 =>
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
        gate,
      });

    // The gate was minted with the bypass, but the setting has since been turned off.
    const settingOff: HarnessV2 = harness(
      frictionWith(cancelGateState({ forceEndAvailable: true })),
      { gateSettings: { ...DEFAULT_SETTINGS.gate, allowForceEnd: false } },
    );
    expect((await settingOff.controller.forceEndGate()).code).toBe('end-not-allowed');
    expect(settingOff.ports.current().session).not.toBeNull();
    expect(settingOff.ports.current().gate?.kind).toBe('cancel');

    // The setting is on now, but this gate opened while it was off.
    const flagOff: HarnessV2 = harness(
      frictionWith(cancelGateState({ forceEndAvailable: false })),
      { gateSettings: { ...DEFAULT_SETTINGS.gate, allowForceEnd: true } },
    );
    expect((await flagOff.controller.forceEndGate()).code).toBe('end-not-allowed');
    expect(flagOff.ports.current().session).not.toBeNull();
    expect(flagOff.ports.current().gate?.kind).toBe('cancel');
  });

  it('spends the bank and begins a pause with a read-back alarm before the commit', async (): Promise<void> => {
    const { controller, ports, effects } = harness(
      publishedFocusRuntime({ accruedFocusMs: SETTLED_WATERMARK_MS }),
      {
        bank: { balanceMs: 600_000 },
      },
    );
    expect((await controller.openGate('pause', null)).code).toBe('ok');
    const response: CommandResponseV2<SessionCommandResultCodeV2> = await confirmOpenGate(
      controller,
      ports,
    );

    expect(response).toEqual({ ok: true, code: 'ok' });
    expect(ports.current().session?.phase).toBe('paused');
    expect(ports.current().enforcementCheckpoint).toBeNull();
    expect(effects.clears).toBeGreaterThan(0);
    expect(ports.bank().balanceMs).toBe(600_000 - DEFAULT_SETTINGS.pause.pauseMs);
    // The replacement alarm is read back before the paused runtime lands, so a refused alarm cannot
    // leave a paused session with nothing to wake it. `writes` is the write count at the call.
    const pausedWrite: number = ports.writes.findIndex(
      (write): boolean => write.session?.phase === 'paused',
    );
    const created: number = ports.alarmCalls.findIndex(
      (call): boolean => call.kind === 'create' && call.name === PHASE_ALARM,
    );
    expect(pausedWrite).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThanOrEqual(0);
    expect(ports.alarmCallWrites[created]).toBe(pausedWrite);
  });

  it('charges the bank and records exactly one event per gate command', async (): Promise<void> => {
    const economy = { ...DEFAULT_SETTINGS.pause };
    const { controller, ports } = harness(
      publishedFocusRuntime({ accruedFocusMs: SETTLED_WATERMARK_MS }),
      {
        bank: { balanceMs: economy.pauseMs * 2 },
        economy,
      },
    );
    expect((await controller.openGate('pause', null)).code).toBe('ok');
    expect(eventsOf(ports, 'gateOpened')).toHaveLength(1);
    const before: number = ports.bank().balanceMs;
    expect((await confirmOpenGate(controller, ports)).code).toBe('ok');

    expect(ports.bank().balanceMs).toBe(before - economy.pauseMs);
    expect(eventsOf(ports, 'pauseTaken')).toHaveLength(1);
    expect(eventsOf(ports, 'pauseTaken')[0]).toMatchObject({ ms: economy.pauseMs });
    expect(ports.current().session?.phase).toBe('paused');
    expect(ports.current().gate).toBeNull();
  });

  it('replaces a different domain gate with fresh bounds and rejects captured stale actions', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({ accruedFocusMs: SETTLED_WATERMARK_MS }),
      { bank: { balanceMs: DEFAULT_SETTINGS.pause.unlockMs } },
    );
    expect((await controller.openGate('unlockSite', 'www.reddit.com')).code).toBe('ok');
    const reddit: GateState = capturedGate(ports);
    const balance: number = ports.bank().balanceMs;
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      'navigation',
    );
    expect(overlayGate(ports.current().documentCommands[documentKey(11, DOC_BLOCKED)])).toBeNull();
    expect((await controller.openGate('unlockSite', 'reddit.com')).code).toBe('ok');
    expect(ports.current().gate).toEqual(reddit);
    expect((await controller.openGate('unlockSite', 'facebook.com')).code).toBe('ok');
    const facebook: GateState = capturedGate(ports);
    expect(facebook.host).toBe('facebook.com');
    expect(facebook.openedAt).toBeGreaterThan(reddit.openedAt);
    expect(facebook.readyAt - facebook.openedAt).toBe(reddit.readyAt - reddit.openedAt);
    expect((await controller.confirmGate(reddit.requiredPhrase, reddit)).code).toBe(
      'no-active-gate',
    );
    expect((await controller.abandonGate(reddit)).code).toBe('no-active-gate');
    expect(ports.current().gate).toEqual(facebook);
    expect(ports.bank().balanceMs).toBe(balance);
    expect((await controller.openGate('unlockSite', 'reddit.com')).code).toBe('ok');
    expect(ports.current().gate?.openedAt).toBeGreaterThan(facebook.openedAt);
    expect((await controller.abandonGate(reddit)).code).toBe('no-active-gate');
    expect((await controller.openGate('pause', null)).code).toBe('end-not-allowed');
    expect(eventsOf(ports, 'gateOpened')).toHaveLength(3);
    expect(eventsOf(ports, 'gateResisted')).toHaveLength(2);
  });

  it('accepts a captured current gate after an unrelated attempt and spends exactly once', async (): Promise<void> => {
    const cost: number = DEFAULT_SETTINGS.pause.unlockMs;
    const { controller, ports } = harness(
      publishedFocusRuntime({ accruedFocusMs: SETTLED_WATERMARK_MS }),
      { bank: { balanceMs: cost } },
    );
    await controller.openGate('unlockSite', 'facebook.com');
    const expectedGate: GateState = capturedGate(ports);
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      'navigation',
    );
    expect(ports.current().gate).toEqual(expectedGate);
    ports.advance(60_000);
    expect((await controller.confirmGate(expectedGate.requiredPhrase, expectedGate)).code).toBe(
      'ok',
    );
    expect((await controller.confirmGate(expectedGate.requiredPhrase, expectedGate)).code).toBe(
      'no-active-gate',
    );
    expect(ports.bank().balanceMs).toBe(0);
    expect(eventsOf(ports, 'unlockTaken')).toHaveLength(1);
  });

  it.each(['kind', 'host', 'openedAt', 'readyAt', 'requiredPhrase'] as const)(
    'compares captured gate field %s before spending or clearing',
    async (field: keyof GateState): Promise<void> => {
      const { controller, ports } = harness(
        publishedFocusRuntime({ accruedFocusMs: SETTLED_WATERMARK_MS }),
        { bank: { balanceMs: DEFAULT_SETTINGS.pause.unlockMs } },
      );
      await controller.openGate('unlockSite', 'facebook.com');
      const current: GateState = capturedGate(ports);
      const changed: GateState = { ...current };
      Object.assign(changed, {
        [field]: {
          kind: 'pause',
          host: 'reddit.com',
          openedAt: current.openedAt + 1,
          readyAt: current.readyAt + 1,
          requiredPhrase: 'another phrase',
          forceEndAvailable: false,
        }[field],
      });
      expect((await controller.confirmGate(current.requiredPhrase, changed)).code).toBe(
        'no-active-gate',
      );
      expect((await controller.abandonGate(changed)).code).toBe('no-active-gate');
      expect(ports.current().gate).toEqual(current);
    },
  );

  it('charges the bank and records one event for an unlock', async (): Promise<void> => {
    const economy = { ...DEFAULT_SETTINGS.pause };
    const { controller, ports } = harness(
      publishedFocusRuntime({ accruedFocusMs: SETTLED_WATERMARK_MS }),
      {
        bank: { balanceMs: economy.unlockMs },
        economy,
      },
    );
    await controller.openGate('unlockSite', 'facebook.com');
    const before: number = ports.bank().balanceMs;
    expect((await confirmOpenGate(controller, ports)).code).toBe('ok');

    expect(ports.bank().balanceMs).toBe(before - economy.unlockMs);
    expect(eventsOf(ports, 'unlockTaken')).toHaveLength(1);
    expect(eventsOf(ports, 'unlockTaken')[0]).toMatchObject({
      host: 'facebook.com',
      ms: economy.unlockMs,
    });
    // One balance buys one unlock, and the gate the balance cannot cover never opens.
    expect((await controller.openGate('unlockSite', 'twitter.com')).code).toBe('end-not-allowed');
    expect(ports.current().gate).toBeNull();
    expect(eventsOf(ports, 'unlockTaken')).toHaveLength(1);
    expect(ports.bank().balanceMs).toBe(before - economy.unlockMs);
  });

  it('records a resisted event when a gate is abandoned', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    await controller.openEndGate();
    expect((await controller.abandonGate()).code).toBe('ok');

    expect(eventsOf(ports, 'gateOpened')).toHaveLength(1);
    expect(eventsOf(ports, 'gateResisted')).toHaveLength(1);
    expect(eventsOf(ports, 'gateResisted')[0]).toMatchObject({ gate: 'cancel' });
  });

  it('keeps the session and throws when the closure write will not land', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({ session: timedFocusSession({ config: flexibleConfig() }) }),
      { failWrites: true },
    );
    let thrown: unknown = null;
    try {
      await controller.requestSessionEnd();
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).not.toBeNull();
    expect(ports.current().session).not.toBeNull();
    expect(ports.current().pendingClosure).toBeNull();
  });

  it('refuses an economy gate while a transition is durable', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession(),
      }),
      { bank: { balanceMs: 600_000 } },
    );
    expect((await controller.openGate('pause', null)).code).toBe('end-not-allowed');
    expect((await controller.openGate('unlockSite', 'facebook.com')).code).toBe('end-not-allowed');
    expect(ports.current().gate).toBeNull();
  });

  it('leaves focus durable when the pause alarm cannot be read back', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime(), {
      bank: { balanceMs: 600_000 },
      alarmReadBack: 'missing',
    });
    await controller.openGate('pause', null);
    const before: number = ports.bank().balanceMs;
    await confirmOpenGate(controller, ports);

    expect(ports.current().session?.phase).not.toBe('paused');
    // A refused alarm costs nothing, because the spend and the alarm share one checkpoint.
    expect(eventsOf(ports, 'pauseTaken')).toHaveLength(0);
    expect(ports.commits.every((commit): boolean => commit.bank.balanceMs >= before)).toBe(true);
  });

  it('clears the page an unlock paid for and re-blocks it when the unlock lapses', async (): Promise<void> => {
    const economy = { ...DEFAULT_SETTINGS.pause };
    const { controller, ports } = harness(publishedFocusRuntime(), {
      bank: { balanceMs: economy.unlockMs },
      economy,
    });
    const key: string = documentKey(11, DOC_BLOCKED);
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      null,
    );
    expect(ports.current().documentCommands[key]?.verdict.blocked).toBe(true);

    await controller.openGate('unlockSite', 'facebook.com');
    expect((await confirmOpenGate(controller, ports)).code).toBe('ok');

    // The live update the purchase commits re-evaluates the verdict, so the page they paid for is
    // clear before they navigate anywhere.
    const bought = ports.current().documentCommands[key];
    expect(bought?.verdict.blocked).toBe(false);
    expect(bought?.presentation).toBe('clear');
    expect(bought?.overlay).toBeNull();

    // And the expiry is the same live update in reverse.
    ports.advance(economy.unlockMs + 1_000);
    await controller.tick();
    const lapsed = ports.current().documentCommands[key];
    expect(ports.current().unlocks).toEqual([]);
    expect(lapsed?.verdict.blocked).toBe(true);
    expect(lapsed?.presentation).toBe('active');
    expect(lapsed?.runtimeRevision).toBeGreaterThan(bought?.runtimeRevision ?? 0);
    expect(sentRevisions(ports)).toContain(lapsed?.runtimeRevision);
  });

  it('takes an expired gate off the overlay and records the resistance', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({ config: sessionConfigV2({ strictness: 'friction' }) }),
      }),
    );
    const key: string = documentKey(11, DOC_BLOCKED);
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      null,
    );
    expect((await controller.openEndGate()).code).toBe('ok');
    expect(overlayGate(ports.current().documentCommands[key])).not.toBeNull();

    // A gate the user walked away from lapses on the shared window, not a private one.
    ports.advance(GATE_EXPIRY_MS + ports.gateSettings().delayMs + 1_000);
    await controller.tick();

    expect(ports.current().gate).toBeNull();
    expect(eventsOf(ports, 'gateResisted')).toHaveLength(1);
    expect(eventsOf(ports, 'gateResisted')[0]).toMatchObject({ gate: 'cancel' });
    // The overlay the page is still showing loses the controls the gate gave it.
    const cleared = ports.current().documentCommands[key];
    expect(overlayGate(cleared)).toBeNull();
    expect(sentRevisions(ports)).toContain(cleared?.runtimeRevision);
  });

  it('adds a site unlock for an unlock gate', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({ accruedFocusMs: SETTLED_WATERMARK_MS }),
      {
        bank: { balanceMs: 600_000 },
      },
    );
    expect((await controller.openGate('unlockSite', 'facebook.com')).code).toBe('ok');
    expect((await confirmOpenGate(controller, ports)).code).toBe('ok');

    expect(ports.current().unlocks).toContainEqual({
      host: 'facebook.com',
      until: ports.now() + DEFAULT_SETTINGS.pause.unlockMs,
    });
    expect(ports.current().gate).toBeNull();
    expect(ports.bank().balanceMs).toBe(600_000 - DEFAULT_SETTINGS.pause.unlockMs);
  });

  it('resumes from a pause and starts the next focus early from a break', async (): Promise<void> => {
    const paused = harness(pausedRuntime());
    expect((await paused.controller.resumeFromPause()).code).toBe('ok');
    expect(paused.ports.current().session?.phase).toBe('focus');

    // The core requires two minutes of break before an early focus and the boundary must still be
    // ahead, so the fixture's break runs long enough for both.
    const longBreak: SessionStateV2 = breakSession({
      phaseEndsAt: breakSession().phaseStartedAt + 600_000,
    });
    const onBreak = harness(breakRuntime({ session: longBreak }), {
      now: longBreak.phaseStartedAt + 150_000,
    });
    expect((await onBreak.controller.startNextFocusEarly()).code).toBe('ok');
    expect(onBreak.ports.current().session?.phase).toBe('focus');
  });

  it('commits an expiry with no live update while a cleanup journal owns the map', async (): Promise<void> => {
    const gate = cancelGateState();
    const unlocks = [{ host: 'facebook.com', until: ACTIVATION_AT + 10_000 }];
    const journals: ReadonlyArray<[string, RuntimeStateV2]> = [
      [
        'transition',
        transitionRuntime(cleanupTransition('start', 'alarm-ready', 'manual-end'), {
          gate,
          unlocks,
          pendingEnforcementTransition: cleanupTransition('start', 'alarm-ready', 'manual-end', {
            postCleanupClosure: transitionPostCleanupClosure(),
          }),
        }),
      ],
      ['closure', cleanupClosureRuntime({ gate, unlocks })],
    ];
    for (const [label, runtime] of journals) {
      const { controller, ports } = harness(runtime, { now: ACTIVATION_AT + 120_000 });
      await controller.tick();

      // The drop and its event are durable, and the map every document holds is the clear batch the
      // journal is still retrying, so nothing was refrozen and nothing was sent.
      const after: RuntimeStateV2 = ports.current();
      expect(parseRuntimeStateV2(after), label).not.toBeNull();
      expect(after.gate, label).toBeNull();
      expect(after.unlocks, label).toEqual([]);
      expect(eventsOf(ports, 'gateResisted'), label).toHaveLength(1);
      expect(
        Object.values(after.documentCommands).every(
          (command): boolean => command.presentation === 'clear',
        ),
        label,
      ).toBe(true);
      expect(
        ports.sends.every(
          (sent): boolean =>
            sent.message.command !== 'apply-enforcement' || sent.message.presentation === 'clear',
        ),
        label,
      ).toBe(true);
      // And the tick ran past the expiry into its cleanup step, which reissues the clear batch the
      // journal owns. Before this fix the settle threw and the tick never got here.
      expect(ports.sends.length, label).toBeGreaterThan(0);
    }
  });

  it('answers retry codes for the wrong journal and a live batch', async (): Promise<void> => {
    const idle = harness();
    expect((await idle.controller.retryTransitionCleanup()).code).toBe('retry-not-available');
    expect((await idle.controller.retryClosureCleanup()).code).toBe('retry-not-available');

    const live = harness(
      transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon')),
    );
    expect((await live.controller.retryClosureCleanup()).code).toBe('retry-not-available');
    expect((await live.controller.retryTransitionCleanup()).code).toBe('retry-not-available');
  });
});

describe('SessionControllerV2 alarms and ticks', (): void => {
  it('ignores an unknown or hostile alarm name', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    await controller.handleAlarm('not-an-alarm');
    await controller.handleAlarm(`${TICK_ALARM} `);
    expect(ports.writes).toHaveLength(0);
  });

  it('runs a tick that publishes the current projection', async (): Promise<void> => {
    const { controller, effects } = harness();
    await controller.recover();
    await controller.handleAlarm(TICK_ALARM);
    expect(effects.broadcasts.length).toBeGreaterThan(0);
    expect(effects.badges.length).toBeGreaterThan(0);
  });

  it('walks each finished local day, settling before it asks the Engine to close it', async (): Promise<void> => {
    const session: SessionStateV2 = timedFocusSession();
    const today: string = localDateStr(session.phaseStartedAt);
    const twoDaysBack: string = localDateStr(session.phaseStartedAt - 2 * 86_400_000);
    const oneDayBack: string = localDateStr(session.phaseStartedAt - 86_400_000);
    const single = harness(publishedFocusRuntime({ session, date: oneDayBack, todayAgg: null }), {
      now: session.phaseStartedAt + 60_000,
    });
    single.ports.onRolloverAdvanceDate = true;
    await single.controller.tick();
    expect(single.ports.rollovers).toEqual([localMidnightAfter(oneDayBack)]);
    expect(single.ports.current().date).toBe(today);

    const double = harness(publishedFocusRuntime({ session, date: twoDaysBack, todayAgg: null }), {
      now: session.phaseStartedAt + 60_000,
    });
    double.ports.onRolloverAdvanceDate = true;
    await double.controller.tick();
    expect(double.ports.rollovers).toEqual([
      localMidnightAfter(twoDaysBack),
      localMidnightAfter(oneDayBack),
    ]);
    expect(double.ports.current().date).toBe(today);
  });

  it('hands a future date backward to the Engine in one call', async (): Promise<void> => {
    const session: SessionStateV2 = timedFocusSession();
    const ahead: string = localDateStr(session.phaseStartedAt + 3 * 86_400_000);
    const { controller, ports } = harness(
      publishedFocusRuntime({ session, date: ahead, todayAgg: null }),
      { now: session.phaseStartedAt + 60_000 },
    );
    await controller.tick();

    expect(ports.rollovers).toEqual([session.phaseStartedAt + 60_000]);
  });

  it('settles the durable session and expires what the instant expires', async (): Promise<void> => {
    // The local date rollover is not the controller's: `runtime.date` and `todayAgg` belong to the
    // retained Engine and `RuntimePortsV2` exposes no port for them. See the task report.
    const session: SessionStateV2 = timedFocusSession();
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session,
        unlocks: [{ host: 'expired.example', until: session.phaseStartedAt + 1_000 }],
      }),
      { now: session.phaseStartedAt + 120_000 },
    );
    await controller.recover();
    await controller.tick();
    const after: RuntimeStateV2 = ports.current();

    expect(after.unlocks).toEqual([]);
    expect(after.session?.phaseStartedAt).toBe(session.phaseStartedAt);
    expect(controller.snapshot(ports.now()).sessionFocusedMs).toBeGreaterThan(0);
  });

  it('dispatches a cleanup alarm only to its own journal', async (): Promise<void> => {
    const transition = harness(
      transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon')),
    );
    await transition.controller.handleAlarm(TRANSITION_CLEANUP_ALARM);
    expect(transition.ports.writes.length).toBeGreaterThan(0);

    const closure = harness(cleanupClosureRuntime());
    const before: number = closure.ports.writes.length;
    await closure.controller.handleAlarm(TRANSITION_CLEANUP_ALARM);
    expect(closure.ports.writes).toHaveLength(before);
  });

  it('retries a due cleanup from a tick, because tick reads the durable journal', async (): Promise<void> => {
    const { controller, ports } = harness(
      transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon')),
    );
    await controller.tick();
    expect(ports.sends.length).toBeGreaterThan(0);
  });

  it('leaves a cleanup batch whose retry time has not arrived to its own alarm', async (): Promise<void> => {
    const transition: PendingEnforcementTransition = cleanupTransition(
      'start',
      'prepared',
      'start-abandon',
    );
    const progress = transition.cleanupProgress;
    if (progress === null || progress === undefined)
      throw new Error('cleanup transition fixture has no progress');
    const { controller, ports } = harness(
      transitionRuntime({
        ...transition,
        cleanupProgress: {
          ...progress,
          retry: { ...progress.retry, nextAttemptAt: Number.MAX_SAFE_INTEGER },
        },
      }),
    );
    const before: RuntimeStateV2 = ports.current();
    await controller.tick();
    expect(ports.sends).toHaveLength(0);
    expect(ports.current().pendingEnforcementTransition).toEqual(
      before.pendingEnforcementTransition,
    );
  });

  it('never runs or throws on a tick for a spent cleanup batch', async (): Promise<void> => {
    const transition: PendingEnforcementTransition = cleanupTransition(
      'start',
      'prepared',
      'start-abandon',
    );
    const progress = transition.cleanupProgress;
    if (progress === null || progress === undefined)
      throw new Error('cleanup transition fixture has no progress');
    const { controller, ports } = harness(
      transitionRuntime({
        ...transition,
        cleanupProgress: {
          ...progress,
          retry: {
            ...progress.retry,
            automaticAttempt: 12,
            nextAttemptAt: null,
            lastError: 'spent',
          },
        },
      }),
    );
    await expect(controller.tick()).resolves.toBeUndefined();
    expect(ports.sends).toHaveLength(0);
  });
});

describe('SessionControllerV2 navigation and documents', (): void => {
  const target: { tabId: number; documentId: string; url: string } = {
    tabId: 11,
    documentId: DOC_ONE,
    url: BLOCKED_URL,
  };

  it('records an attempt only for a blocked verdict with a non-null kind', async (): Promise<void> => {
    const { controller, effects } = harness(publishedFocusRuntime());
    await controller.handleNavigation(target, 'navigation');
    expect(effects.attempts).toEqual([{ url: BLOCKED_URL, tabId: 11, kind: 'navigation' }]);

    const sweeping = harness(publishedFocusRuntime());
    await sweeping.controller.handleNavigation(target, null);
    expect(sweeping.effects.attempts).toHaveLength(0);
  });

  it('freezes a late document into the tuple the frozen ones already hold', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const before: RuntimeStateV2 = ports.current();
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      null,
    );

    // While the command map is the current authority every command repeats the runtime revision,
    // so a late arrival joins that revision instead of raising it out from under the others.
    const after: RuntimeStateV2 = ports.current();
    expect(parseRuntimeStateV2(after)).not.toBeNull();
    expect(after.runtimeRevision).toBe(before.runtimeRevision);
    expect(after.documentCommands[documentKey(11, DOC_BLOCKED)]?.runtimeRevision).toBe(
      before.runtimeRevision,
    );
    expect(after.documentCommands[documentKey(11, DOC_ONE)]).toEqual(
      before.documentCommands[documentKey(11, DOC_ONE)],
    );
  });

  it('does not persist a command for a document that is not blocked', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const allowed: { tabId: number; documentId: string; url: string } = {
      tabId: 11,
      documentId: DOC_BLOCKED,
      url: 'https://example.org/reading',
    };
    const before: RuntimeStateV2 = ports.current();

    const commands: DocumentContentCommand[] = await controller.documentCommandsFor(
      allowed,
      'navigation',
    );
    await controller.handleNavigation(allowed, null);

    // An allowed page is answered with a clear command computed from the current tuple. A clear
    // presentation carries the canonical clear verdict, which is the only pair the frozen command
    // contract accepts on it. Nothing is stored: a stored entry keeps the page address in the
    // runtime for the rest of the session, and the map is bounded to the documents the session
    // is blocking.
    const applied: DocumentContentCommand | undefined = commands.find(
      (command: DocumentContentCommand): boolean => command.command === 'apply-enforcement',
    );
    expect(applied?.command === 'apply-enforcement' ? applied.presentation : null).toBe('clear');
    expect(applied?.command === 'apply-enforcement' ? applied.verdict : null).toEqual({
      blocked: false,
      reason: 'no-session',
      categoryId: null,
      matchedPattern: null,
    });
    expect(applied?.command === 'apply-enforcement' ? applied.runtimeRevision : null).toBe(
      before.runtimeRevision,
    );
    expect(ports.current().documentCommands).toEqual(before.documentCommands);
    // The push still reaches the page. A clear the map does not hold is delivered from the tuple
    // it was computed from, reset first, because the page has not acknowledged this epoch.
    expect(
      ports.sends
        .filter((sent): boolean => sent.documentId === DOC_BLOCKED)
        .map((sent): string => sent.message.command),
    ).toEqual(['reset-enforcement-epoch', 'apply-enforcement']);
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('pushes the clear an idle runtime owes a page without storing it', async (): Promise<void> => {
    const { controller, ports } = harness();
    const stranded: { tabId: number; documentId: string; url: string } = {
      tabId: 11,
      documentId: DOC_ONE,
      url: BLOCKED_URL,
    };

    await controller.handleNavigation(stranded, null);

    // The boot sweep after a rejected runtime is the case that matters: a page still holding an
    // overlay from a runtime this one replaced is released by the clear, and the idle runtime
    // keeps no address for it afterwards.
    expect(ports.sends.map((sent): string => sent.message.command)).toEqual([
      'reset-enforcement-epoch',
      'apply-enforcement',
    ]);
    expect(ports.current().documentCommands).toEqual({});
    expect(Object.keys(ports.current().epochResetAcks)).toEqual([documentKey(11, DOC_ONE)]);
  });

  it('publishes only the blocked page and lets the allowed page pull a clear it accepts', async (): Promise<void> => {
    const reading: { tabId: number; documentId: string; url: string } = {
      tabId: 12,
      documentId: 'document-2',
      url: 'https://example.org/reading',
    };
    const { controller, ports } = harness(emptyRuntimeV2({ runtimeRevision: 0 }), {
      tabs: [
        { tabId: 11, url: BLOCKED_URL, documentId: DOC_ONE },
        { tabId: reading.tabId, url: reading.url, documentId: reading.documentId },
      ],
    });

    expect((await controller.startSession(flexibleConfig())).code).toBe('ok');
    expect(ports.current().pendingEnforcementTransition).toBeNull();

    // The start sweeps both pages, and the session keeps the blocked one alone. The rule is about
    // the runtime, so the whole persisted value is read rather than the map on its own.
    expect(Object.keys(ports.current().documentCommands)).toEqual([documentKey(11, DOC_ONE)]);
    expect(JSON.stringify(ports.current())).not.toContain(reading.url);
    expect(ports.documentState(11, DOC_ONE)?.presentation).toBe('active');
    expect(ports.documentState(12, 'document-2')?.presentation).toBe('clear');

    // The allowed page pulls again at the tuple the sweep left it on, then moves within the
    // document to another allowed URL. Both answers are the clear it already holds or a higher
    // one, so the page refuses neither and the map stays bounded to the blocked page.
    ports.applyPulled(
      12,
      'document-2',
      await controller.documentCommandsFor(reading, 'existing', 'deliver'),
    );
    await controller.handleNavigation(reading, null);
    const moved: { tabId: number; documentId: string; url: string } = {
      ...reading,
      url: 'https://example.org/other',
    };
    ports.applyPulled(
      12,
      'document-2',
      await controller.documentCommandsFor(moved, 'existing', 'deliver'),
    );
    await controller.handleNavigation(moved, null);

    expect(ports.rejectedAnswers(12, 'document-2')).toBe(0);
    expect(ports.rejectedAnswers(11, DOC_ONE)).toBe(0);
    expect(ports.documentState(12, 'document-2')?.presentation).toBe('clear');
    expect(ports.documentState(11, DOC_ONE)?.presentation).toBe('active');
    expect(Object.keys(ports.current().documentCommands)).toEqual([documentKey(11, DOC_ONE)]);
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('records an acknowledgement without the page address', async (): Promise<void> => {
    const { controller, ports } = harness();
    const pushed: { tabId: number; documentId: string; url: string } = {
      tabId: 11,
      documentId: DOC_ONE,
      url: BLOCKED_URL,
    };
    const pulled: { tabId: number; documentId: string; url: string } = {
      tabId: 12,
      documentId: 'document-2',
      url: 'https://example.org/reading',
    };

    await controller.handleNavigation(pushed, null);
    ports.applyPulled(
      12,
      'document-2',
      await controller.documentCommandsFor(pulled, 'navigation', 'deliver'),
    );

    // Every reader of the record asks whether this document acknowledged this epoch. The push
    // path records the transport's answer and the pull path mints the record itself, and neither
    // keeps the address the reset named.
    for (const target of [pushed, pulled]) {
      const record = ports.current().epochResetAcks[documentKey(target.tabId, target.documentId)];
      expect(record).toEqual({
        version: 1,
        operationId: expect.any(String),
        enforcementEpoch: ports.current().enforcementEpoch,
        tabId: target.tabId,
        documentId: target.documentId,
        handledAt: expect.any(Number),
      });
      expect(record).not.toHaveProperty('url');
    }
    expect(ports.rejectedAnswers(11, DOC_ONE)).toBe(0);
    expect(ports.rejectedAnswers(12, 'document-2')).toBe(0);
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('forgets the acknowledgements of a closed tab', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({
        epochResetAcks: {
          ...epochResetAckMap(),
          [documentKey(12, 'document-2')]: epochResetAck({ tabId: 12, documentId: 'document-2' }),
          [documentKey(12, 'document-3')]: epochResetAck({ tabId: 12, documentId: 'document-3' }),
        },
      }),
    );
    const writes: number = ports.writes.length;

    await controller.forgetTab(12);

    // A closed tab's documents are gone, the back-forward cache included, so nothing will ever
    // ask whether they acknowledged an epoch again. Every other record stays.
    expect(Object.keys(ports.current().epochResetAcks)).toEqual([documentKey(11, DOC_ONE)]);
    expect(ports.writes).toHaveLength(writes + 1);
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();

    // A tab with no record writes nothing.
    await controller.forgetTab(99);
    expect(ports.writes).toHaveLength(writes + 1);
  });

  it('keeps a restored document acknowledged after cleanup pruned the closed tabs', async (): Promise<void> => {
    const reading: { tabId: number; documentId: string; url: string } = {
      tabId: 13,
      documentId: 'document-13',
      url: 'https://example.org/reading',
    };
    const { controller, ports } = harness(
      publishedFocusRuntime({ session: timedFocusSession({ config: flexibleConfig() }) }),
      {
        tabs: [
          { tabId: 11, url: BLOCKED_URL, documentId: DOC_BLOCKED },
          { tabId: reading.tabId, url: reading.url, documentId: reading.documentId },
        ],
      },
    );
    const blocked: { tabId: number; documentId: string; url: string } = {
      tabId: 11,
      documentId: DOC_BLOCKED,
      url: BLOCKED_URL,
    };
    ports.applyPulled(
      11,
      DOC_BLOCKED,
      await controller.documentCommandsFor(blocked, 'navigation', 'deliver'),
    );
    await controller.handleNavigation(blocked, null);
    await controller.handleNavigation(reading, 'navigation');
    // The published fixture already records tab 11's first document, which stays open too.
    expect(Object.keys(ports.current().epochResetAcks).sort()).toEqual([
      documentKey(11, DOC_ONE),
      documentKey(11, DOC_BLOCKED),
      documentKey(reading.tabId, reading.documentId),
    ]);
    // Tab 13 closes while the worker is asleep, so no removal event reaches the controller.
    ports.setTabs([{ tabId: 11, url: BLOCKED_URL, documentId: DOC_BLOCKED }]);

    expect((await controller.requestSessionEnd()).code).toBe('ok');
    expect(ports.current().pendingClosure).toBeNull();
    expect(ports.current().documentCommands).toEqual({});

    // The completed cleanup keeps every record of the open tab and drops the closed tab's.
    expect(Object.keys(ports.current().epochResetAcks).sort()).toEqual([
      documentKey(11, DOC_ONE),
      documentKey(11, DOC_BLOCKED),
    ]);
    // A document in the open tab that comes back from the back-forward cache still holds the
    // batch clear, so the idle runtime answers it nothing rather than a clear it would refuse.
    const sends: number = ports.sends.length;
    const pulled: DocumentContentCommand[] = await controller.documentCommandsFor(
      blocked,
      'existing',
      'deliver',
    );
    ports.applyPulled(11, DOC_BLOCKED, pulled);
    await controller.handleNavigation(blocked, null);
    expect(pulled).toEqual([]);
    expect(ports.sends).toHaveLength(sends);
    expect(ports.rejectedAnswers(11, DOC_BLOCKED)).toBe(0);
    expect(ports.documentState(11, DOC_BLOCKED)?.presentation).toBe('clear');
    // A fresh document in that tab has no record, so it is reset and cleared, and accepts both.
    const fresh: { tabId: number; documentId: string; url: string } = {
      tabId: 11,
      documentId: 'document-fresh',
      url: BLOCKED_URL,
    };
    ports.applyPulled(
      11,
      'document-fresh',
      await controller.documentCommandsFor(fresh, 'navigation', 'deliver'),
    );
    expect(ports.rejectedAnswers(11, 'document-fresh')).toBe(0);
    expect(ports.documentState(11, 'document-fresh')?.presentation).toBe('clear');
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('drops the stored command when a blocked document moves to an allowed URL after its clear is acknowledged', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const key: string = documentKey(11, DOC_BLOCKED);
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      'navigation',
    );
    const blocked: FrozenDocumentCommand | undefined = ports.current().documentCommands[key];
    expect(blocked?.verdict.blocked).toBe(true);

    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: 'https://example.org/reading' },
      'navigation',
    );

    // The same-document navigation refreezes the whole map at the next revision with this page's
    // new URL, and the page applies the clear it is sent. Once it has, the entry has nothing left
    // to say, and keeping it would keep the address of a page the session no longer blocks.
    const cleared: DocumentContentCommand | undefined = ports.sends
      .filter(
        (sent): boolean =>
          sent.documentId === DOC_BLOCKED && sent.message.command === 'apply-enforcement',
      )
      .map((sent): DocumentContentCommand => sent.message)
      .at(-1);
    expect(cleared?.command === 'apply-enforcement' ? cleared.presentation : null).toBe('clear');
    expect(cleared?.command === 'apply-enforcement' ? cleared.expectedUrl : null).toBe(
      'https://example.org/reading',
    );
    expect(cleared?.command === 'apply-enforcement' ? cleared.runtimeRevision : null).toBe(
      ports.current().runtimeRevision,
    );
    expect(ports.current().runtimeRevision).toBeGreaterThan(blocked?.runtimeRevision ?? 0);
    expect(ports.current().documentCommands[key]).toBeUndefined();
    // The other live views moved with it, so the map is still one tuple.
    for (const command of Object.values(ports.current().documentCommands)) {
      expect(command.runtimeRevision).toBe(ports.current().runtimeRevision);
    }
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('keeps the moved document as a clear entry until it acknowledges the clear', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const key: string = documentKey(11, DOC_BLOCKED);
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      'navigation',
    );
    ports.respondForDocument(11, DOC_BLOCKED, noReceiverResponder());

    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: 'https://example.org/reading' },
      'navigation',
    );

    // A clear nobody applied is still owed, and the retained entry is what the next live refresh
    // resends. Dropping it here would leave the page behind whatever overlay it last rendered.
    // This passes on the code before the drop existed by construction. It is a guard because a
    // `dropAcknowledgedClear` that also drops on a `no-receiver` outcome turns it red
    // (`expected undefined to be 'clear'`), which was run when the drop was written.
    const kept: FrozenDocumentCommand | undefined = ports.current().documentCommands[key];
    expect(kept?.presentation).toBe('clear');
    expect(kept?.expectedUrl).toBe('https://example.org/reading');
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  // The three below drive the page through the real content state machine (the ports fake runs
  // `handleContentCommandV2` for every send and `applyPulled` models the router's pull), so the
  // guard is what the page shows, not what the worker believes. Each path is what
  // `onHistoryStateUpdated` produces for a single-page app: `blockedForTarget` reads with the
  // `existing` kind, then the sweep pushes with a null kind.
  it('re-blocks a page that moves in-document from an allowed URL to a blocked one', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const key: string = documentKey(11, DOC_BLOCKED);
    const reading: { tabId: number; documentId: string; url: string } = {
      tabId: 11,
      documentId: DOC_BLOCKED,
      url: 'https://example.org/reading',
    };
    // The page loads allowed and pulls: it holds a clear at the current tuple, unstored.
    ports.applyPulled(
      11,
      DOC_BLOCKED,
      await controller.documentCommandsFor(reading, 'navigation', 'deliver'),
    );
    await controller.handleNavigation(reading, null);
    expect(ports.documentState(11, DOC_BLOCKED)?.presentation).toBe('clear');
    const clearRevision: number | undefined = ports.documentState(11, DOC_BLOCKED)?.tuple
      ?.runtimeRevision;

    const blocked: { tabId: number; documentId: string; url: string } = {
      ...reading,
      url: BLOCKED_URL,
    };
    await controller.documentCommandsFor(blocked, 'existing');
    await controller.handleNavigation(blocked, null);

    // The page accepts only a tuple strictly above the clear it applied, so the blocked command
    // has to land at a higher revision than that clear, which means the map advanced for it.
    const stored: FrozenDocumentCommand | undefined = ports.current().documentCommands[key];
    expect(stored?.verdict.blocked).toBe(true);
    expect(stored?.runtimeRevision).toBeGreaterThan(clearRevision ?? Number.NaN);
    expect(ports.documentState(11, DOC_BLOCKED)?.presentation).toBe('active');
    expect(ports.documentState(11, DOC_BLOCKED)?.tuple?.runtimeRevision).toBe(
      stored?.runtimeRevision,
    );
    expect(ports.rejectedAnswers(11, DOC_BLOCKED)).toBe(0);
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('re-blocks a page that moves in-document to an allowed URL and back', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const key: string = documentKey(11, DOC_BLOCKED);
    const blocked: { tabId: number; documentId: string; url: string } = {
      tabId: 11,
      documentId: DOC_BLOCKED,
      url: BLOCKED_URL,
    };
    ports.applyPulled(
      11,
      DOC_BLOCKED,
      await controller.documentCommandsFor(blocked, 'navigation', 'deliver'),
    );
    await controller.handleNavigation(blocked, null);
    expect(ports.documentState(11, DOC_BLOCKED)?.presentation).toBe('active');

    const reading: { tabId: number; documentId: string; url: string } = {
      ...blocked,
      url: 'https://example.org/reading',
    };
    await controller.documentCommandsFor(reading, 'existing');
    await controller.handleNavigation(reading, null);
    expect(ports.documentState(11, DOC_BLOCKED)?.presentation).toBe('clear');
    expect(ports.current().documentCommands[key]).toBeUndefined();

    await controller.documentCommandsFor(blocked, 'existing');
    await controller.handleNavigation(blocked, null);

    // The drop lost the record of the clear the page applied, so the next blocked command cannot
    // reuse the revision the page already holds.
    const stored: FrozenDocumentCommand | undefined = ports.current().documentCommands[key];
    expect(stored?.verdict.blocked).toBe(true);
    expect(ports.documentState(11, DOC_BLOCKED)?.presentation).toBe('active');
    expect(ports.documentState(11, DOC_BLOCKED)?.tuple?.runtimeRevision).toBe(
      stored?.runtimeRevision,
    );
    expect(ports.rejectedAnswers(11, DOC_BLOCKED)).toBe(0);
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('owes nothing to a page the cleanup cleared once the runtime is idle', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({ session: timedFocusSession({ config: flexibleConfig() }) }),
      { tabs: [{ tabId: 11, url: BLOCKED_URL, documentId: DOC_BLOCKED }] },
    );
    const blocked: { tabId: number; documentId: string; url: string } = {
      tabId: 11,
      documentId: DOC_BLOCKED,
      url: BLOCKED_URL,
    };
    ports.applyPulled(
      11,
      DOC_BLOCKED,
      await controller.documentCommandsFor(blocked, 'navigation', 'deliver'),
    );
    await controller.handleNavigation(blocked, null);
    expect((await controller.requestSessionEnd()).code).toBe('ok');
    expect(ports.current().pendingClosure).toBeNull();
    expect(ports.documentState(11, DOC_BLOCKED)?.presentation).toBe('clear');
    const sends: number = ports.sends.length;

    // The idle sweep and the boot push both arrive here for a still-open page.
    await controller.handleNavigation(blocked, null);
    const pulled: DocumentContentCommand[] = await controller.documentCommandsFor(
      blocked,
      'existing',
      'deliver',
    );
    ports.applyPulled(11, DOC_BLOCKED, pulled);

    // The batch clear the page holds names the closed session, and an idle clear names the epoch
    // as its reservation, so at the same base revision the page refuses the idle one. The page
    // already shows clear, so an idle runtime owes an acknowledged page nothing at all rather
    // than a command it will refuse.
    expect(ports.sends).toHaveLength(sends);
    expect(pulled).toEqual([]);
    expect(ports.rejectedAnswers(11, DOC_BLOCKED)).toBe(0);
    expect(ports.documentState(11, DOC_BLOCKED)?.presentation).toBe('clear');
  });

  it('keeps enumerating live targets in the cleanup batch', async (): Promise<void> => {
    const reading: { tabId: number; documentId: string; url: string } = {
      tabId: 14,
      documentId: 'document-14',
      url: 'https://example.org/reading',
    };
    const { controller, ports } = harness(
      publishedFocusRuntime({ session: timedFocusSession({ config: flexibleConfig() }) }),
      {
        tabs: [
          { tabId: 11, url: BLOCKED_URL, documentId: DOC_ONE },
          { tabId: reading.tabId, url: reading.url, documentId: reading.documentId },
        ],
      },
    );
    const key: string = documentKey(reading.tabId, reading.documentId);
    await controller.handleNavigation(reading, 'navigation');
    expect(ports.current().documentCommands[key]).toBeUndefined();

    expect((await controller.requestSessionEnd()).code).toBe('ok');

    // The batch is built from the tabs the browser reports, not from the map, so a page the map
    // never held is still named by the closure and cleared at the end. The commit is the evidence:
    // it installs the batch the map has to equal for as long as the journal lasts.
    const closure = ports.commits.at(-1)?.projection.pendingClosure;
    const batch =
      closure?.stage === 'cleanup' ? closure.cleanupProgress.clearCommands[key] : undefined;
    expect(batch?.expectedUrl).toBe(reading.url);
    expect(batch?.presentation).toBe('clear');
    expect(
      ports.sends
        .filter(
          (sent): boolean =>
            sent.documentId === reading.documentId && sent.message.command === 'apply-enforcement',
        )
        .map((sent): string =>
          sent.message.command === 'apply-enforcement' ? sent.message.presentation : 'reset',
        )
        .at(-1),
    ).toBe('clear');
    // And once the cleanup completes, the batch goes with the journal.
    expect(ports.current().pendingClosure).toBeNull();
    expect(ports.current().documentCommands).toEqual({});
  });

  it('routes a navigation to the journal that owns the target', async (): Promise<void> => {
    // A closure cleanup owns its clear batch, and a navigation joins it.
    const closing = harness(cleanupClosureRuntime());
    const target = { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL };
    expect(
      Object.keys(closing.ports.current().pendingClosure?.cleanupProgress?.clearCommands ?? {}),
    ).not.toContain(documentKey(11, DOC_BLOCKED));
    await closing.controller.handleNavigation(target, 'navigation');
    const closure = closing.ports.current().pendingClosure;

    expect(parseRuntimeStateV2(closing.ports.current())).not.toBeNull();
    expect(Object.keys(closure?.cleanupProgress?.clearCommands ?? {})).toContain(
      documentKey(11, DOC_BLOCKED),
    );
    expect(closing.ports.sends.some((sent): boolean => sent.documentId === DOC_BLOCKED)).toBe(true);
    // A cleanup page is not a blocked page, so nothing is recorded as an attempt.
    expect(closing.effects.attempts).toHaveLength(0);

    // A committed transition owns its frozen view, and a navigation joins that instead.
    const starting = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession(),
      }),
    );
    await starting.controller.handleNavigation(target, 'navigation');
    const view = starting.ports.current().pendingEnforcementTransition?.activeView;

    expect(parseRuntimeStateV2(starting.ports.current())).not.toBeNull();
    expect(Object.keys(view?.documents ?? {})).toContain(documentKey(11, DOC_BLOCKED));
    expect(starting.ports.sends.some((sent): boolean => sent.documentId === DOC_BLOCKED)).toBe(
      true,
    );
  });

  it('returns the reset command before the newest persisted command', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime({ epochResetAcks: {} }));
    const commands = await controller.documentCommandsFor(target, null, 'deliver');

    expect(commands[0]?.command).toBe('reset-enforcement-epoch');
    expect(commands[1]?.command).toBe('apply-enforcement');
    expect(ports.current().documentCommands[documentKey(11, DOC_ONE)]).toBeDefined();
  });

  it('hands the reset only to a caller that delivers it', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime({ epochResetAcks: {} }));

    const read = await controller.documentCommandsFor(target, null);

    // A reader gets the command and no reset, and records no acknowledgement, so the reset this
    // document is owed is still there for the push that follows.
    expect(read.map((command): string => command.command)).toEqual(['apply-enforcement']);
    expect(ports.current().epochResetAcks).toEqual({});
    const delivered = await controller.documentCommandsFor(target, null, 'deliver');
    expect(delivered.map((command): string => command.command)).toEqual([
      'reset-enforcement-epoch',
      'apply-enforcement',
    ]);
    expect(Object.keys(ports.current().epochResetAcks)).toEqual([documentKey(11, DOC_ONE)]);
  });

  it('applies the attempt rule to documentCommandsFor as well', async (): Promise<void> => {
    const { controller, effects } = harness(publishedFocusRuntime());
    await controller.documentCommandsFor(target, 'existing');
    expect(effects.attempts).toEqual([{ url: BLOCKED_URL, tabId: 11, kind: 'existing' }]);
  });

  it('sources stoppedPage from the durable tab claim', async (): Promise<void> => {
    const { controller } = harness(
      publishedFocusRuntime({
        documentCommands: {},
        tabStates: { 11: { muteUrl: null, priorMuted: null, stoppedDocumentId: DOC_ONE } },
      }),
    );
    const commands = await controller.documentCommandsFor(target, null);
    const applied = commands.find((command): boolean => command.command === 'apply-enforcement');

    expect(applied?.command === 'apply-enforcement' ? applied.overlay?.stoppedPage : null).toBe(
      true,
    );
  });

  it('refreshes a checkpoint record only for a target the checkpoint already named', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const command = ports.current().documentCommands[documentKey(11, DOC_ONE)];
    const named = ports.current().enforcementCheckpoint?.documents[0];
    if (command === undefined || named === undefined) throw new Error('expected a verified target');
    const refreshed = {
      ...structuredClone(named),
      tabId: command.tabId,
      documentId: command.documentId,
      url: command.expectedUrl,
      operationId: command.operationId,
      enforcementEpoch: command.enforcementEpoch,
      basePolicyRevision: command.basePolicyRevision,
      runtimeRevision: command.runtimeRevision,
      verdict: structuredClone(command.verdict),
      handledAt: ports.now(),
    };
    await controller.recordDocumentAck(refreshed);
    // The checkpoint keeps the record of the answer, which is the answer without its address.
    const { url: _url, ...refreshedRecord } = refreshed;
    expect(ports.current().enforcementCheckpoint?.documents).toContainEqual(refreshedRecord);
    expect(JSON.stringify(ports.current().enforcementCheckpoint)).not.toContain(refreshed.url);

    // An ack for a document the checkpoint never verified adds nothing.
    const before: RuntimeStateV2 = ports.current();
    await controller.recordDocumentAck({ ...refreshed, tabId: 99, documentId: 'document-99' });
    expect(ports.current().enforcementCheckpoint).toEqual(before.enforcementCheckpoint);
    // Nor does one for another epoch.
    await controller.recordDocumentAck({ ...refreshed, enforcementEpoch: OTHER_EPOCH_ID });
    expect(ports.current().enforcementCheckpoint).toEqual(before.enforcementCheckpoint);
    // Nor one for a live operation the checkpoint itself never ran: a live refresh re-freezes the
    // commands under a new operation while the checkpoint keeps the one it verified.
    await controller.refreshLiveViews();
    const live = ports.current().documentCommands[documentKey(11, DOC_ONE)];
    if (live === undefined) throw new Error('expected a refrozen command');
    expect(live.operationId).not.toBe(ports.current().enforcementCheckpoint?.operationId);
    const stale: RuntimeStateV2 = ports.current();
    await controller.recordDocumentAck({
      ...refreshed,
      operationId: live.operationId,
      runtimeRevision: live.runtimeRevision,
    });
    expect(ports.current().enforcementCheckpoint).toEqual(stale.enforcementCheckpoint);
  });

  it('refreshes every live view under a new operation and a higher revision', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const before: RuntimeStateV2 = ports.current();
    await controller.refreshLiveViews();
    const after: RuntimeStateV2 = ports.current();

    expect(after.runtimeRevision).toBeGreaterThan(before.runtimeRevision);
    expect(after.enforcementCheckpoint).toEqual(before.enforcementCheckpoint);
    for (const command of Object.values(after.documentCommands)) {
      expect(command.runtimeRevision).toBe(after.runtimeRevision);
    }
  });
});

describe('SessionControllerV2 publication and serialization', (): void => {
  it('settles the read through its own instant past a finite phase end', async (): Promise<void> => {
    // A cycling session, so the boundary one second back is a phase end rather than the session end.
    const cycling = { focusMin: 10, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };
    const focusEndsAt: number = ACTIVATION_AT + 600_000;
    const sessionEndsAt: number = timedFocusSession().sessionEndsAt ?? 0;
    const { controller } = harness(
      publishedFocusRuntime({
        session: timedFocusSession({
          config: sessionConfigV2({ cycling }),
          phaseEndsAt: focusEndsAt,
          sessionEndsAt,
        }),
      }),
    );
    const at: number = focusEndsAt + 1_000;
    const snapshot: SessionSnapshotV2 = controller.snapshot(at);

    // Spec 358: the read settles first, so it is the break the user is in, with focus capped at the
    // boundary rather than still running past it.
    expect(isSessionSnapshotV2(snapshot)).toBe(true);
    expect(snapshot.phase).toBe('break');
    expect(snapshot.sessionFocusedMs).toBe(focusEndsAt - ACTIVATION_AT);
    expect(snapshot.phaseEndsAt).toBeGreaterThan(at);
  });

  it('sends no blocking update for a session that just ran out', async (): Promise<void> => {
    const session = timedFocusSession();
    const { controller, ports } = harness(
      publishedFocusRuntime({
        session,
        unlocks: [{ host: 'facebook.com', until: ACTIVATION_AT + 700_000 }],
      }),
    );
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      null,
    );
    const sentBefore: number = ports.sends.length;

    // The unlock lapses in the same instant the timer completes.
    ports.advance((session.sessionEndsAt ?? 0) + 1_000 - ports.now());
    await controller.tick();

    // The closure one await later replaces the whole map, so the expiry sends nothing blocking to a
    // session that is already over.
    expect(
      ports.sends
        .slice(sentBefore)
        .every(
          (sent): boolean =>
            sent.message.command !== 'apply-enforcement' || sent.message.presentation === 'clear',
        ),
    ).toBe(true);
    expect(ports.current().session).toBeNull();
    expect(parseRuntimeStateV2(ports.current())).not.toBeNull();
  });

  it('rolls focus into its break as a live update the pages can see', async (): Promise<void> => {
    const cycling = { focusMin: 10, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };
    const focusEndsAt: number = ACTIVATION_AT + 600_000;
    const { controller, ports, effects } = harness(
      publishedFocusRuntime({
        unlocks: [],
        session: timedFocusSession({
          config: sessionConfigV2({ cycling }),
          phaseEndsAt: focusEndsAt,
          sessionEndsAt: timedFocusSession().sessionEndsAt ?? 0,
        }),
      }),
    );
    const key: string = documentKey(11, DOC_BLOCKED);
    await controller.handleNavigation(
      { tabId: 11, documentId: DOC_BLOCKED, url: BLOCKED_URL },
      null,
    );
    expect(ports.current().documentCommands[key]?.verdict.blocked).toBe(true);

    ports.advance(focusEndsAt + 1_000 - ports.now());
    await controller.tick();

    // The break is durable, publishable, and visible: no focus checkpoint attests a phase that
    // ended, and every open document gets the clear the new phase means.
    const after: RuntimeStateV2 = ports.current();
    expect(parseRuntimeStateV2(after)).not.toBeNull();
    expect(after.session?.phase).toBe('break');
    expect(after.enforcementCheckpoint).toBeNull();
    expect(after.documentCommands[key]?.presentation).toBe('clear');
    expect(sentRevisions(ports)).toContain(after.documentCommands[key]?.runtimeRevision);
    expect(effects.clears).toBeGreaterThan(0);
    expect(controller.snapshot(ports.now()).lifecycle.kind).toBe('active');
  });

  it('reports the session a resume is owed to, never idle', async (): Promise<void> => {
    const cycling = { focusMin: 10, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };
    const sessionEndsAt: number = timedFocusSession().sessionEndsAt ?? 0;
    // Ten minutes of focus, then the phase that ran out while the worker slept.
    const phaseStartedAt: number = ACTIVATION_AT + 600_000;
    const phaseEndsAt: number = phaseStartedAt + 300_000;
    const phases: ReadonlyArray<[string, SessionStateV2]> = [
      [
        'break',
        timedFocusSession({
          config: sessionConfigV2({ cycling }),
          phase: 'break',
          phaseStartedAt,
          phaseEndsAt,
          cycleIndex: 1,
          focusedMs: 600_000,
          sessionEndsAt,
        }),
      ],
      [
        'pause',
        timedFocusSession({
          phase: 'paused',
          phaseStartedAt,
          phaseEndsAt,
          pausedFrom: { phase: 'focus', phaseEndsAt: sessionEndsAt },
          focusedMs: 600_000,
          sessionEndsAt,
        }),
      ],
      // Asleep through a whole focus and the break behind it, so the read walks both boundaries.
      [
        'focus-through-break',
        timedFocusSession({
          config: sessionConfigV2({ cycling }),
          phaseEndsAt: phaseStartedAt,
          sessionEndsAt,
        }),
      ],
    ];
    for (const [label, session] of phases) {
      const { controller, ports } = harness(
        label === 'focus-through-break'
          ? publishedFocusRuntime({ session })
          : publishedFocusRuntime({ session, enforcementCheckpoint: null }),
        { now: phaseEndsAt + 1_000 },
      );
      const read: SessionSnapshotV2 = controller.snapshot(ports.now());

      // The boundary the tick has not written yet is one the read can walk: the resume is what the
      // tick commits, so the read reports the session that is coming back rather than no session.
      // It is not enforced yet, so it reports as starting, which hides End and offers no start.
      expect(isSessionSnapshotV2(read), label).toBe(true);
      expect(read.lifecycle.kind, label).toBe('starting');
      expect(read.lifecycle.kind, label).not.toBe('idle');

      // And the tick agrees with what the read said: the resume it drives is a focus session. The
      // slept-through case stops at the read, because recovery cannot drive a break it has not
      // written yet (reported, not fixed here: `recovery-v2.ts` is not this wave's file).
      if (label === 'focus-through-break') continue;
      await controller.recover();
      const committed: SessionSnapshotV2 = controller.snapshot(ports.now());
      expect(ports.current().session?.phase, label).toBe('focus');
      expect(committed.phase, label).toBe('focus');
      expect(committed.lifecycle.kind, label).toBe('active');
      expect(isSessionSnapshotV2(committed), label).toBe(true);
    }
  });

  it('invents no phase for a session asleep past its break', async (): Promise<void> => {
    // Two hours with 25 and 5 minute cycles, durable in the break that runs S+25 to S+30, read at
    // S+58. The tick's resume will activate at S+58, so nothing between the two is the worker's.
    const cycling = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };
    const startedAt: number = ACTIVATION_AT;
    const focusMs: number = 1_500_000;
    const breakEndsAt: number = startedAt + focusMs + 300_000;
    const session = timedFocusSession({
      config: sessionConfigV2({ cycling, duration: { kind: 'timed', minutes: 120 } }),
      startedAt,
      sessionEndsAt: startedAt + 7_200_000,
      phase: 'break',
      phaseStartedAt: startedAt + focusMs,
      phaseEndsAt: breakEndsAt,
      cycleIndex: 1,
      focusedMs: focusMs,
    });
    const wake: number = startedAt + 3_480_000;
    const { controller, ports } = harness(
      publishedFocusRuntime({ session, enforcementCheckpoint: null, unlocks: [] }),
      {
        now: wake,
        tabs: [
          { tabId: 11, url: TARGET_URL, documentId: DOC_ONE },
          { tabId: 12, url: SECOND_TARGET_URL, documentId: 'document-2' },
        ],
      },
    );
    const read: SessionSnapshotV2 = controller.snapshot(wake);

    // No invented break, no invented clock, and no focus the user never did.
    expect(isSessionSnapshotV2(read)).toBe(true);
    expect(read.lifecycle.kind).toBe('starting');
    expect(read.phase).toBe('idle');
    expect(read.phaseEndsAt).toBeNull();
    expect(read.sessionFocusedMs).toBe(0);

    // The tick resumes at the instant it woke, and the read then agrees with what it wrote.
    await controller.recover();
    const durable = ports.current().session;
    const after: SessionSnapshotV2 = controller.snapshot(wake);

    expect(durable?.phase).toBe('focus');
    expect(durable?.phaseStartedAt).toBe(wake);
    expect(after.lifecycle.kind).toBe('active');
    expect(after.phase).toBe('focus');
    expect(after.phaseEndsAt).toBe(wake + focusMs);
    expect(after.sessionFocusedMs).toBe(focusMs);
    expect(isSessionSnapshotV2(after)).toBe(true);
  });

  it('reports a live break as the break it is', async (): Promise<void> => {
    const cycling = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };
    const startedAt: number = ACTIVATION_AT;
    const focusMs: number = 1_500_000;
    const breakEndsAt: number = startedAt + focusMs + 300_000;
    const { controller } = harness(
      publishedFocusRuntime({
        enforcementCheckpoint: null,
        session: timedFocusSession({
          config: sessionConfigV2({ cycling, duration: { kind: 'timed', minutes: 120 } }),
          startedAt,
          sessionEndsAt: startedAt + 7_200_000,
          phase: 'break',
          phaseStartedAt: startedAt + focusMs,
          phaseEndsAt: breakEndsAt,
          cycleIndex: 1,
          focusedMs: focusMs,
        }),
      }),
    );
    const inside: number = breakEndsAt - 60_000;
    const read: SessionSnapshotV2 = controller.snapshot(inside);

    // A boundary still ahead of the read is the phase the user is actually in.
    expect(isSessionSnapshotV2(read)).toBe(true);
    expect(read.lifecycle.kind).toBe('active');
    expect(read.phase).toBe('break');
    expect(read.phaseEndsAt).toBe(breakEndsAt);
    expect(read.sessionFocusedMs).toBe(focusMs);
  });

  it('reports the closure a completed timer owes rather than the idle shape', async (): Promise<void> => {
    const { controller, ports } = harness(publishedFocusRuntime());
    const session = ports.current().session;
    const past: number = (session?.sessionEndsAt ?? 0) + 1_000;
    const snapshot: SessionSnapshotV2 = controller.snapshot(past);

    // The session ran out its own clock, which needs a closure no read can write. The read reports
    // that closure, so the popup does not offer a start for a session that is still durable.
    expect(isSessionSnapshotV2(snapshot)).toBe(true);
    expect(snapshot.lifecycle).toMatchObject({
      kind: 'cleanup',
      journal: 'closure',
      id: `${session?.sessionId}:close`,
    });
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.config).toBeNull();
  });

  it('builds a valid snapshot and never broadcasts before recover', async (): Promise<void> => {
    const { controller, ports, effects } = harness(publishedFocusRuntime());
    const snapshot: SessionSnapshotV2 = controller.snapshot(ports.now());

    expect(isSessionSnapshotV2(snapshot)).toBe(true);
    expect(effects.broadcasts).toHaveLength(0);
    await controller.recover();
    expect(effects.broadcasts.length).toBeGreaterThan(0);
    expect(controller.hasActiveSession()).toBe(true);
  });

  it('projects starting for a committed transition', (): void => {
    const { controller, ports } = harness(
      transitionRuntime(pendingTransition('start', 'alarm-ready'), {
        session: timedFocusSession(),
      }),
    );
    const snapshot: SessionSnapshotV2 = controller.snapshot(ports.now());

    expect(snapshot.lifecycle.kind).toBe('starting');
    expect(snapshot.phase).toBe('idle');
    expect(isSessionSnapshotV2(snapshot)).toBe(true);
  });

  it('serializes two concurrent end requests into one closure', async (): Promise<void> => {
    const { controller, ports } = harness(
      publishedFocusRuntime({ session: timedFocusSession({ config: flexibleConfig() }) }),
    );
    const [first, second] = await Promise.all([
      controller.requestSessionEnd(),
      controller.requestSessionEnd(),
    ]);
    const codes: string[] = [first.code, second.code].sort();

    expect(codes).toEqual(['no-active-session', 'ok']);
    expect(ports.current().session).toBeNull();
  });
});

describe('SessionControllerV2 recovery', (): void => {
  it('recovers each journal stage and publishes the recovered lifecycle', async (): Promise<void> => {
    const runtimes: readonly RuntimeStateV2[] = [
      emptyRuntimeV2({ runtimeRevision: 0 }),
      publishedFocusRuntime(),
      transitionRuntime(pendingTransition('start', 'prepared')),
      cleanupClosureRuntime(),
    ];

    for (const runtime of runtimes) {
      const { controller, ports, effects } = harness(runtime);
      await controller.recover();
      const last: SessionSnapshotV2 | undefined = effects.broadcasts[effects.broadcasts.length - 1];

      expect(effects.broadcasts.length).toBeGreaterThan(0);
      expect(last?.lifecycle.kind).toBe(controller.snapshot(ports.now()).lifecycle.kind);
      expect(isSessionSnapshotV2(last as SessionSnapshotV2)).toBe(true);
    }
  });

  it('answers every command with a code rather than throwing across the boundary', async (): Promise<void> => {
    const { controller } = harness(
      transitionRuntime(cleanupTransition('resume', 'prepared', 'resume-restore'), {
        session: pausedSession(),
      }),
    );
    const responses: ReadonlyArray<CommandResponseV2<SessionCommandResultCodeV2>> =
      await Promise.all([
        controller.requestSessionEnd(),
        controller.openEndGate(),
        controller.abandonGate(),
        controller.confirmGate(null),
        controller.openGate('pause', null),
        controller.resumeFromPause(),
        controller.startNextFocusEarly(),
      ]);

    for (const response of responses) {
      expect(response).toEqual({
        ok: false,
        code: 'transition-cleanup-pending',
        error: 'transition-cleanup-pending',
      });
    }
  });

  it('settles the attempt write after it releases the command queue', async (): Promise<void> => {
    const { controller, effects }: HarnessV2 = harness(publishedFocusRuntime());
    let swept: boolean = false;
    // A real attempt write commits, and a commit with blocking work pending sweeps every target
    // it can see straight back through this controller.
    effects.onRecordAttempt = async (): Promise<void> => {
      await controller.documentCommandsFor(
        { tabId: 12, documentId: 'document-2', url: SECOND_TARGET_URL },
        null,
      );
      swept = true;
    };

    const settled: string = await Promise.race([
      controller
        .documentCommandsFor({ tabId: 11, documentId: DOC_ONE, url: TARGET_URL }, 'navigation')
        .then((): string => 'answered'),
      new Promise<string>((resolve: (value: string) => void): void => {
        setTimeout((): void => resolve('deadlocked'), 100);
      }),
    ]);

    expect(settled).toBe('answered');
    expect(swept).toBe(true);
    expect(effects.attempts).toHaveLength(1);
  });
});
