import { describe, expect, it } from 'vitest';
import { PHASE_ALARM } from '../../../src/background/alarms-v2';
import type { FrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2';
import { type RecoveryResultV2, recoverRuntimeV2 } from '../../../src/background/recovery-v2';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import type {
  CleanupProgress,
  CleanupRetryState,
  CleanupTabClaim,
  PendingClosure,
  PendingEnforcementTransition,
  RuntimeStateV2,
} from '../../../src/background/runtime-v2-types';
import type { CleanupEffectPortsV2 } from '../../../src/background/transition-cleanup-v2';
import { focusedMsAtV2 } from '../../../src/core/session-v2';
import { CLEANUP_MAX_AUTOMATIC_ATTEMPTS } from '../../../src/shared/constants';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import { CANONICAL_CLEAR_VERDICT } from '../../../src/shared/enforcement-v2-validation';
import { CoreError } from '../../../src/shared/errors';
import type { SessionStateV2 } from '../../../src/shared/types';
import {
  indefiniteFocusSession,
  indefinitePausedSession,
  startedIndefiniteRuntime,
} from './indefinite-restart-fixtures';
import {
  appliedResponseFor,
  createRuntimePortsFakeV2,
  epochResetResponseFor,
  type FakeSendV2,
  noReceiverResponder,
  type RuntimePortsFakeV2,
} from './runtime-ports-fake';
import {
  ACTIVATION_AT,
  ACTIVE_OPERATION_ID,
  breakRuntime,
  CLEANUP_OPERATION_ID,
  cleanupClosureRuntime,
  cleanupTransition,
  EPOCH_ID,
  migratedActiveFocusRuntime,
  OTHER_OPERATION_ID,
  pausedRuntime,
  pendingTransition,
  preparedClosureRuntime,
  publishedFocusRuntime,
  RESUMED_STARTED_AT,
  SESSION_ID,
  sessionConfigV2,
  timedFocusSession,
  transitionRuntime,
} from './runtime-v2-fixtures';

interface RecoveryHarness {
  ports: RuntimePortsFakeV2;
  effects: CleanupEffectPortsV2;
  restored: number[];
  badges: () => number;
}

type CleanupClosureV2 = Extract<PendingClosure, { stage: 'cleanup' }>;

/** The IDs recovery may allocate: one recovery operation, then any cleanup batch it enters. */
const IDS: readonly string[] = [
  '60000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000002',
  '60000000-0000-4000-8000-000000000003',
  '60000000-0000-4000-8000-000000000004',
];
const MINUTE_MS: number = 60_000;
/** Five minutes into the published focus session, and long after its paused fixture expired. */
const RECOVERY_AT: number = ACTIVATION_AT + 5 * MINUTE_MS;
/** Two seconds after activation, inside the ten second budget a committed transition carries. */
const WITHIN_BUDGET_AT: number = ACTIVATION_AT + 2_000;
const TAB_URL: string = 'https://facebook.com/feed';
const OTHER_URL: string = 'https://news.example.com/story';
const DOC_ONE: string = 'document-11';
const DOC_TWO: string = 'document-12';

/**
 * How the browser answers a request to restore a claimed tab.
 *
 * `all` is what every effects fake outside the closure suite assumed: production returns only the
 * tabs it could actually restore, and a fake that resolves every claim by construction cannot
 * observe a claim that never resolves. That gap is not hypothetical. A claim carrying a tab
 * identifier from before a restart can never resolve, because the browser renumbers restored tabs,
 * and this file is the restart file.
 */
type ClaimResolution = 'all' | 'none';

function harness(
  runtime: RuntimeStateV2,
  options: Parameters<typeof createRuntimePortsFakeV2>[1] = {},
  claims: ClaimResolution = 'all',
): RecoveryHarness {
  const restored: number[] = [];
  let badges: number = 0;
  const ports: RuntimePortsFakeV2 = createRuntimePortsFakeV2(runtime, {
    now: RECOVERY_AT,
    ids: [...IDS],
    tabs: [
      { tabId: 11, url: TAB_URL, documentId: DOC_ONE },
      { tabId: 12, url: OTHER_URL, documentId: DOC_TWO },
    ],
    ...options,
  });
  const effects: CleanupEffectPortsV2 = {
    restoreTabClaims: async (claimed: readonly CleanupTabClaim[]): Promise<number[]> => {
      if (claims === 'none') return [];
      const ids: number[] = claimed.map((claim: CleanupTabClaim): number => claim.tabId);
      restored.push(...ids);
      return ids;
    },
    reloadStoppedDocuments: async (): Promise<void> => {},
    requestBlankBadge: (): void => {
      badges += 1;
    },
  };
  return { ports, effects, restored, badges: (): number => badges };
}

/** Answers every send the way a healthy document answers it. */
function healthyResponders(ports: RuntimePortsFakeV2): void {
  for (const [tabId, documentId] of [
    [11, DOC_ONE],
    [12, DOC_TWO],
  ] as ReadonlyArray<[number, string]>) {
    ports.respondForDocument(tabId, documentId, (message: DocumentContentCommand): unknown =>
      message.command === 'reset-enforcement-epoch'
        ? epochResetResponseFor(message, ports.now())
        : appliedResponseFor(message, ports.now()),
    );
  }
}

function commandsOf(runtime: RuntimeStateV2): FrozenDocumentCommand[] {
  return Object.values(runtime.documentCommands);
}

function sentCommands(ports: RuntimePortsFakeV2): string[] {
  return ports.sends.map((send: FakeSendV2): string => send.message.command);
}

function closureWrite(ports: RuntimePortsFakeV2): RuntimeStateV2 | undefined {
  return ports.writes.find((write: RuntimeStateV2): boolean => write.pendingClosure !== null);
}

/** The runtime this fake would answer with, replaced by a value the parser would refuse. */
function portsReturning(ports: RuntimePortsFakeV2, runtime: RuntimeStateV2): RuntimePortsFakeV2 {
  return { ...ports, runtime: (): RuntimeStateV2 => runtime };
}

/** The same cleanup transition with its next attempt moved past the recovery instant. */
function notDueTransitionRuntime(): RuntimeStateV2 {
  const waiting: PendingEnforcementTransition = cleanupTransition(
    'start',
    'prepared',
    'start-abandon',
  );
  const progress: CleanupProgress = waiting.cleanupProgress as CleanupProgress;
  return transitionRuntime({
    ...waiting,
    cleanupProgress: {
      ...progress,
      retry: { ...progress.retry, nextAttemptAt: RECOVERY_AT + MINUTE_MS },
    },
  });
}

/** The session a recovery result carries, or a test failure if it lost one. */
function session(result: RecoveryResultV2): SessionStateV2 {
  const state: SessionStateV2 | null = result.runtime.session;
  if (state === null) throw new Error('the recovery result carries no session');
  return state;
}

/**
 * What the person is shown. `focusedMsAtV2` is the call the snapshot projector makes for
 * `sessionFocusedMs`, so this is the figure the popup renders rather than a restatement of it.
 * The distinction matters most for an indefinite session: the settled `focusedMs` does not move
 * through an unbroken focus phase, so only the projection reflects the time that passed.
 */
function projectedFocusMs(result: RecoveryResultV2): number {
  return focusedMsAtV2(session(result), RECOVERY_AT);
}

/** The retry state of whichever journal the runtime carries. */
function retryOf(runtime: RuntimeStateV2): CleanupRetryState {
  const progress: CleanupProgress | null =
    (runtime.pendingClosure?.cleanupProgress as CleanupProgress | undefined) ??
    runtime.pendingEnforcementTransition?.cleanupProgress ??
    null;
  if (progress === null) throw new Error('expected a cleanup journal with a retry state');
  return progress.retry;
}

/** The same cleanup closure with its next attempt moved past the recovery instant. */
function notDueClosureRuntime(): RuntimeStateV2 {
  const runtime: RuntimeStateV2 = cleanupClosureRuntime();
  const closure: CleanupClosureV2 = runtime.pendingClosure as CleanupClosureV2;
  return {
    ...runtime,
    pendingClosure: {
      ...closure,
      cleanupProgress: {
        ...closure.cleanupProgress,
        retry: { ...closure.cleanupProgress.retry, nextAttemptAt: RECOVERY_AT + MINUTE_MS },
      },
    },
  };
}

describe('recovery journal order', (): void => {
  it('refuses a runtime that carries both journals', async (): Promise<void> => {
    const test: RecoveryHarness = harness(preparedClosureRuntime());
    const both: RuntimeStateV2 = {
      ...preparedClosureRuntime(),
      pendingEnforcementTransition: pendingTransition('start', 'alarm-ready'),
    };

    await expect(recoverRuntimeV2(portsReturning(test.ports, both), test.effects)).rejects.toThrow(
      CoreError,
    );
    expect(test.ports.writes).toHaveLength(0);
    expect(test.ports.sends).toHaveLength(0);
    expect(test.ports.auditCalls).toBe(0);
  });

  it('commits and cleans a prepared closure before inspecting the session', async (): Promise<void> => {
    const test: RecoveryHarness = harness(preparedClosureRuntime());
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(test.ports.commits).toHaveLength(1);
    expect(test.ports.commits[0]?.projection.session).toBeNull();
    expect(result.runtime.session).toBeNull();
    expect(test.ports.auditCalls).toBe(0);
    expect(test.badges()).toBeGreaterThan(0);
  });

  it('waits for the retry alarm when a cleanup closure is not due', async (): Promise<void> => {
    const test: RecoveryHarness = harness(notDueClosureRuntime());

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.kind).toBe('closure');
    expect(test.ports.sends).toHaveLength(0);
    expect(test.ports.writes).toHaveLength(0);
    expect(test.ports.alarmCalls).toContainEqual({ kind: 'create', name: 'closure-cleanup' });
  });

  it('waits for the retry alarm when a cleanup transition is not due', async (): Promise<void> => {
    const test: RecoveryHarness = harness(notDueTransitionRuntime());

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.kind).toBe('transition');
    expect(test.ports.sends).toHaveLength(0);
    expect(test.ports.writes).toHaveLength(0);
    expect(test.ports.alarmCalls).toContainEqual({ kind: 'create', name: 'transition-cleanup' });
  });

  it('spends an attempt for every retry alarm the browser refuses', async (): Promise<void> => {
    for (const [label, runtime] of [
      ['closure', notDueClosureRuntime()],
      ['transition', notDueTransitionRuntime()],
    ] as ReadonlyArray<[string, RuntimeStateV2]>) {
      const test: RecoveryHarness = harness(runtime, { alarmReadBack: 'missing' });

      const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);
      const retry: CleanupRetryState = retryOf(result.runtime);

      // A refused alarm is a failed attempt, so the batch spends itself down to the exhausted
      // state the manual retry answers rather than waiting on an alarm that does not exist.
      expect(retry.automaticAttempt, label).toBe(CLEANUP_MAX_AUTOMATIC_ATTEMPTS);
      expect(retry.nextAttemptAt, label).toBeNull();
      expect(retry.lastError, label).toContain('could not schedule');
      expect(test.ports.writes.length, label).toBeGreaterThan(0);
      expect(test.ports.sends, label).toHaveLength(0);
    }
  });

  it('reissues the frozen clear commands when the batch is due', async (): Promise<void> => {
    const test: RecoveryHarness = harness(cleanupClosureRuntime());
    healthyResponders(test.ports);

    await recoverRuntimeV2(test.ports, test.effects);

    expect(sentCommands(test.ports)).toContain('apply-enforcement');
    expect(test.badges()).toBeGreaterThan(0);
  });

  it('refuses a cleanup closure whose top revision left its clear batch', async (): Promise<void> => {
    const test: RecoveryHarness = harness(cleanupClosureRuntime());
    const drifted: RuntimeStateV2 = {
      ...cleanupClosureRuntime(),
      runtimeRevision: cleanupClosureRuntime().runtimeRevision + 1,
    };

    await expect(
      recoverRuntimeV2(portsReturning(test.ports, drifted), test.effects),
    ).rejects.toThrow(CoreError);
    expect(test.ports.sends).toHaveLength(0);
  });
});

describe('recovery by transition stage', (): void => {
  it('abandons every pre-commit start stage', async (): Promise<void> => {
    for (const stage of ['prepared', 'registration-audited', 'starting-verified'] as const) {
      const test: RecoveryHarness = harness(transitionRuntime(pendingTransition('start', stage)));
      healthyResponders(test.ports);

      await recoverRuntimeV2(test.ports, test.effects);
      const entered: PendingEnforcementTransition | null =
        test.ports.writes[0]?.pendingEnforcementTransition ?? null;

      expect(entered?.stage, stage).toBe('cleanup');
      expect(entered?.cleanupCause, stage).toBe('start-abandon');
      expect(entered?.cleanupFrom, stage).toBe(stage);
      expect(entered?.failure, stage).toBeNull();
      expect(entered?.postCleanupClosure, stage).toBeNull();
    }
  });

  it('restores a pre-commit resume with a null failure', async (): Promise<void> => {
    const test: RecoveryHarness = harness(
      transitionRuntime(pendingTransition('resume', 'starting-verified')),
    );
    healthyResponders(test.ports);

    await recoverRuntimeV2(test.ports, test.effects);
    const entered: PendingEnforcementTransition | null =
      test.ports.writes[0]?.pendingEnforcementTransition ?? null;

    expect(entered?.cleanupCause).toBe('resume-restore');
    expect(entered?.failure).toBeNull();
    expect(entered?.postCleanupClosure).toBeNull();
  });

  it('continues a committed transition without a recovery checkpoint', async (): Promise<void> => {
    const committed: PendingEnforcementTransition = pendingTransition('start', 'alarm-ready');
    const test: RecoveryHarness = harness(transitionRuntime(committed), { now: WITHIN_BUDGET_AT });
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.kind).toBe('published');
    expect(result.runtime.enforcementCheckpoint?.kind).toBe('activation');
    expect(result.runtime.enforcementCheckpoint?.operationId).toBe(committed.activeOperationId);
    expect(result.runtime.enforcementCheckpoint?.enforcementEpoch).toBe(committed.enforcementEpoch);
    expect(result.runtime.enforcementCheckpoint?.basePolicyRevision).toBe(
      committed.basePolicyRevision,
    );
    expect(
      test.ports.writes.every(
        (write: RuntimeStateV2): boolean => write.enforcementCheckpoint?.kind !== 'recovery',
      ),
    ).toBe(true);
  });

  it('closes the real session when freshness is already exhausted', async (): Promise<void> => {
    const spent: PendingEnforcementTransition = pendingTransition('start', 'alarm-ready', {
      freshnessAttempts: 3,
    });
    const test: RecoveryHarness = harness(transitionRuntime(spent), { now: WITHIN_BUDGET_AT });
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);
    const closing: PendingEnforcementTransition | undefined = test.ports.writes
      .map(
        (write: RuntimeStateV2): PendingEnforcementTransition | null =>
          write.pendingEnforcementTransition,
      )
      .find(
        (transition: PendingEnforcementTransition | null): boolean =>
          transition?.cleanupCause === 'transition-failed',
      ) as PendingEnforcementTransition | undefined;

    expect(closing?.failure).toBe('tab-enforcement-failed');
    expect(closing?.postCleanupClosure).not.toBeNull();
    expect(result.runtime.session).toBeNull();
  });

  it('continues a cleanup transition that is due', async (): Promise<void> => {
    const test: RecoveryHarness = harness(
      transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon')),
    );
    healthyResponders(test.ports);

    await recoverRuntimeV2(test.ports, test.effects);

    expect(sentCommands(test.ports)).toContain('apply-enforcement');
    expect(test.restored.length).toBeGreaterThan(0);
  });
});

describe('recovery of a durable session', (): void => {
  it('closes a timed session whose fixed end already passed', async (): Promise<void> => {
    const ended: RuntimeStateV2 = publishedFocusRuntime();
    const endsAt: number = ended.session?.sessionEndsAt ?? 0;
    const test: RecoveryHarness = harness(ended, { now: endsAt + MINUTE_MS });
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);
    const prepared: RuntimeStateV2 | undefined = closureWrite(test.ports);

    expect(prepared?.session).not.toBeNull();
    expect(prepared?.pendingClosure?.stage).toBe('prepared');
    expect(prepared?.pendingClosure?.projection.endedAt).toBe(endsAt);
    expect(prepared?.pendingClosure?.projection.reason).toBe('timer-completed');
    expect(result.runtime.session).toBeNull();
    expect(test.ports.auditCalls).toBe(0);
  });

  it('closes a cycling session at its fixed end rather than resuming its phase', async (): Promise<void> => {
    const ended: RuntimeStateV2 = breakRuntime();
    const endsAt: number = ended.session?.sessionEndsAt ?? 0;
    const test: RecoveryHarness = harness(ended, { now: endsAt + MINUTE_MS });
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);
    const prepared: RuntimeStateV2 | undefined = closureWrite(test.ports);

    // The break boundary passed too, and settling it first would resume a session that has ended.
    expect(prepared?.pendingClosure?.projection.endedAt).toBe(endsAt);
    expect(prepared?.pendingClosure?.projection.reason).toBe('timer-completed');
    expect(
      test.ports.writes.every(
        (write: RuntimeStateV2): boolean => write.pendingEnforcementTransition === null,
      ),
    ).toBe(true);
    expect(result.runtime.session).toBeNull();
  });

  it('resumes through a focus and the break that followed it', async (): Promise<void> => {
    // Focus ends one minute in, its break one minute after that, and the worker wakes five minutes
    // later. Recovery passes through two boundaries and may only resume from a durable break.
    const asleep: RuntimeStateV2 = publishedFocusRuntime({
      session: timedFocusSession({
        config: sessionConfigV2({
          cycling: { focusMin: 1, shortBreakMin: 1, longBreakMin: 15, longEvery: 4 },
        }),
        phaseEndsAt: ACTIVATION_AT + MINUTE_MS,
      }),
    });
    const test: RecoveryHarness = harness(asleep);
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);
    const breakWrite: RuntimeStateV2 | undefined = test.ports.writes.find(
      (write: RuntimeStateV2): boolean => write.session?.phase === 'break',
    );
    const resumed: PendingEnforcementTransition | undefined = test.ports.writes
      .map(
        (write: RuntimeStateV2): PendingEnforcementTransition | null =>
          write.pendingEnforcementTransition,
      )
      .find((transition: PendingEnforcementTransition | null): boolean => transition !== null) as
      | PendingEnforcementTransition
      | undefined;

    // The break it passed through is durable, and it dropped the checkpoint that attested the focus.
    expect(breakWrite).toBeDefined();
    expect(breakWrite?.session?.focusedMs).toBe(MINUTE_MS);
    expect(breakWrite?.enforcementCheckpoint).toBeNull();
    // Only then can a resume read the phase it restores.
    expect(resumed?.kind).toBe('resume');
    expect(resumed?.trigger).toBe('break-expired');
    expect(resumed?.priorPhase).toBe('break');
    expect(result.kind).toBe('published');
    expect(result.runtime.session?.phase).toBe('focus');
    expect(result.runtime.enforcementCheckpoint?.kind).toBe('resume-strengthening');
  });

  it('settles a phase boundary the worker slept through', async (): Promise<void> => {
    const cycling: RuntimeStateV2 = publishedFocusRuntime({
      session: timedFocusSession({
        config: sessionConfigV2({
          cycling: { focusMin: 1, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
        }),
        phaseEndsAt: ACTIVATION_AT + MINUTE_MS,
      }),
    });
    const test: RecoveryHarness = harness(cycling);
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    // The focus phase ended one minute in, so recovery settles that boundary into its break.
    expect(result.runtime.session?.phase).toBe('break');
    expect(result.runtime.session?.focusedMs).toBe(MINUTE_MS);
    expect(result.runtime.enforcementCheckpoint).toBeNull();
  });

  it('leaves an unfinished phase exactly where it stands', async (): Promise<void> => {
    const test: RecoveryHarness = harness(publishedFocusRuntime());
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.runtime.session).toEqual(publishedFocusRuntime().session);
    // Nothing settled, so the first write is the frozen recovery batch rather than a rewrite of the
    // session that did not move.
    expect(commandsOf(test.ports.writes[0] as RuntimeStateV2)[0]?.operationId).toBe(IDS[0]);
  });

  it('runs standalone recovery for a published focus session', async (): Promise<void> => {
    const published: RuntimeStateV2 = publishedFocusRuntime();
    const test: RecoveryHarness = harness(published);
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);
    const commands: FrozenDocumentCommand[] = commandsOf(result.runtime);

    expect(result.kind).toBe('published');
    expect(result.runtime.enforcementCheckpoint?.kind).toBe('recovery');
    expect(result.runtime.enforcementCheckpoint?.operationId).toBe(IDS[0]);
    expect(result.runtime.enforcementCheckpoint?.operationId).not.toBe(ACTIVE_OPERATION_ID);
    expect(result.runtime.enforcementCheckpoint?.sessionId).toBe(SESSION_ID);
    expect(result.runtime.enforcementCheckpoint?.enforcementEpoch).toBe(published.enforcementEpoch);
    expect(result.runtime.enforcementCheckpoint?.basePolicyRevision).toBe(
      published.basePolicyRevision,
    );
    expect(result.runtime.runtimeRevision).toBeGreaterThan(published.runtimeRevision);
    // Only the blocked page is stored. The allowed page's clear is computed for the sweep and
    // never persisted, so the runtime holds no address for it.
    expect(commands).toHaveLength(1);
    for (const command of commands) {
      expect(command.operationId).toBe(IDS[0]);
      expect(command.presentation).toBe('active');
      expect(command.verdict.blocked).toBe(true);
      expect(command.tabId).toBe(11);
      expect(command.runtimeRevision).toBe(result.runtime.runtimeRevision);
      expect(command.basePolicyRevision).toBe(published.basePolicyRevision);
      expect(command.sessionId).toBe(SESSION_ID);
      expect(command.reservedSessionId).toBeNull();
    }
  });

  it('stores no command for an allowed page and sends it a clear the page accepts', async (): Promise<void> => {
    // No scripted responders: each document answers through the real content state machine.
    const test: RecoveryHarness = harness(publishedFocusRuntime());

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);
    const sent: FakeSendV2[] = test.ports.sends.filter(
      (send: FakeSendV2): boolean => send.documentId === DOC_TWO,
    );
    const clear: DocumentContentCommand | undefined = sent.find(
      (send: FakeSendV2): boolean => send.message.command === 'apply-enforcement',
    )?.message;

    expect(result.kind).toBe('published');
    expect(Object.keys(result.runtime.documentCommands)).toEqual([`11:${DOC_ONE}`]);
    // The clear the allowed page received is the one the controller computes for it later: the
    // canonical clear at the recovery's operation and revision, under the session's identity.
    expect(clear?.command === 'apply-enforcement' ? clear.presentation : null).toBe('clear');
    expect(clear?.command === 'apply-enforcement' ? clear.verdict : null).toEqual(
      CANONICAL_CLEAR_VERDICT,
    );
    expect(clear?.operationId).toBe(IDS[0]);
    expect(clear?.command === 'apply-enforcement' ? clear.runtimeRevision : null).toBe(
      result.runtime.runtimeRevision,
    );
    expect(clear?.command === 'apply-enforcement' ? clear.sessionId : null).toBe(SESSION_ID);
    expect(test.ports.rejectedAnswers(12, DOC_TWO)).toBe(0);
    expect(test.ports.rejectedAnswers(11, DOC_ONE)).toBe(0);
    expect(test.ports.documentState(12, DOC_TWO)?.presentation).toBe('clear');
    expect(test.ports.documentState(11, DOC_ONE)?.presentation).toBe('active');
    // Verification still audited the allowed page: its record is in the checkpoint, and like every
    // record there it names the page and not its address.
    expect(
      result.runtime.enforcementCheckpoint?.documents.map((ack): number => ack.tabId).sort(),
    ).toEqual([11, 12]);
    for (const record of result.runtime.enforcementCheckpoint?.documents ?? []) {
      expect(record).not.toHaveProperty('url');
    }
    expect(JSON.stringify(result.runtime)).not.toContain(OTHER_URL);
  });

  it('persists every recovery command before it sends one', async (): Promise<void> => {
    const test: RecoveryHarness = harness(publishedFocusRuntime());
    const durableAtFirstSend: FrozenDocumentCommand[][] = [];
    for (const [tabId, documentId] of [
      [11, DOC_ONE],
      [12, DOC_TWO],
    ] as ReadonlyArray<[number, string]>) {
      test.ports.respondForDocument(
        tabId,
        documentId,
        (message: DocumentContentCommand): unknown => {
          durableAtFirstSend.push(commandsOf(test.ports.current()));
          return message.command === 'reset-enforcement-epoch'
            ? epochResetResponseFor(message, test.ports.now())
            : appliedResponseFor(message, test.ports.now());
        },
      );
    }

    await recoverRuntimeV2(test.ports, test.effects);

    // Every stored command is already durable when the very first message leaves the worker. The
    // allowed page's clear is never stored: the revision it carries is the one this write made
    // durable, and a page that holds a clear at that tuple is answered the same clear again.
    expect(durableAtFirstSend[0]).toHaveLength(1);
    expect(durableAtFirstSend[0]?.[0]?.verdict.blocked).toBe(true);
    expect(
      durableAtFirstSend[0]?.every(
        (command: FrozenDocumentCommand): boolean => command.operationId === IDS[0],
      ),
    ).toBe(true);
  });

  it('resets a target that has not acknowledged the current epoch', async (): Promise<void> => {
    const test: RecoveryHarness = harness(publishedFocusRuntime());
    healthyResponders(test.ports);

    await recoverRuntimeV2(test.ports, test.effects);

    expect(sentCommands(test.ports)[0]).toBe('reset-enforcement-epoch');
    expect(test.ports.current().epochResetAcks[`11:${DOC_ONE}`]).toBeDefined();
    expect(test.ports.current().epochResetAcks[`12:${DOC_TWO}`]).toBeDefined();
    // The record answers one question, whether the document acknowledged this epoch, so the page
    // address the transport echoes stops at the transport.
    expect(test.ports.current().epochResetAcks[`11:${DOC_ONE}`]).not.toHaveProperty('url');
    expect(test.ports.current().epochResetAcks[`12:${DOC_TWO}`]).not.toHaveProperty('url');
  });

  it('recovers a migrated session that never had a checkpoint', async (): Promise<void> => {
    const test: RecoveryHarness = harness(migratedActiveFocusRuntime());
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.kind).toBe('published');
    expect(result.runtime.enforcementCheckpoint?.kind).toBe('recovery');
    expect(commandsOf(result.runtime)).toHaveLength(1);
  });

  it('keeps a live pause unblocked with no checkpoint', async (): Promise<void> => {
    const test: RecoveryHarness = harness(pausedRuntime(), {
      now: RESUMED_STARTED_AT + 90_000,
    });
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.kind).toBe('published');
    expect(result.runtime.enforcementCheckpoint).toBeNull();
    expect(result.runtime.session?.phase).toBe('paused');
    // A pause blocks nothing, so nothing is stored, and every page is sent a computed clear.
    expect(commandsOf(result.runtime)).toEqual([]);
    expect(
      test.ports.sends
        .filter((send: FakeSendV2): boolean => send.message.command === 'apply-enforcement')
        .map((send: FakeSendV2): string =>
          send.message.command === 'apply-enforcement' ? send.message.presentation : 'reset',
        ),
    ).toEqual(['clear', 'clear']);
  });

  it('keeps a live break unblocked with no checkpoint', async (): Promise<void> => {
    const test: RecoveryHarness = harness(breakRuntime(), { now: RESUMED_STARTED_AT + 90_000 });
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.runtime.enforcementCheckpoint).toBeNull();
    expect(result.runtime.session?.phase).toBe('break');
  });

  it('resumes a session whose pause expired', async (): Promise<void> => {
    const test: RecoveryHarness = harness(pausedRuntime());
    healthyResponders(test.ports);

    await recoverRuntimeV2(test.ports, test.effects);
    const resumed: PendingEnforcementTransition | undefined = test.ports.writes
      .map(
        (write: RuntimeStateV2): PendingEnforcementTransition | null =>
          write.pendingEnforcementTransition,
      )
      .find((transition: PendingEnforcementTransition | null): boolean => transition !== null) as
      | PendingEnforcementTransition
      | undefined;

    expect(resumed?.kind).toBe('resume');
    expect(resumed?.trigger).toBe('pause-expired');
    expect(resumed?.priorPhase).toBe('paused');
  });

  it('resumes a session whose break expired', async (): Promise<void> => {
    const test: RecoveryHarness = harness(breakRuntime());
    healthyResponders(test.ports);

    await recoverRuntimeV2(test.ports, test.effects);
    const resumed: PendingEnforcementTransition | undefined = test.ports.writes
      .map(
        (write: RuntimeStateV2): PendingEnforcementTransition | null =>
          write.pendingEnforcementTransition,
      )
      .find((transition: PendingEnforcementTransition | null): boolean => transition !== null) as
      | PendingEnforcementTransition
      | undefined;

    expect(resumed?.trigger).toBe('break-expired');
    expect(resumed?.priorPhase).toBe('break');
  });
});

describe('recovery failure paths', (): void => {
  it('closes the session when the audit fails', async (): Promise<void> => {
    for (const audit of ['website-access-lost', 'content-registration-failed'] as const) {
      const test: RecoveryHarness = harness(publishedFocusRuntime(), { audit });
      healthyResponders(test.ports);

      const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

      expect(closureWrite(test.ports)?.pendingClosure?.projection.reason, audit).toBe(audit);
      expect(result.runtime.session, audit).toBeNull();
      expect(test.ports.sends.length, audit).toBeGreaterThan(0);
    }
  });

  it('creates and reads back the phase alarm for a timed session', async (): Promise<void> => {
    const test: RecoveryHarness = harness(publishedFocusRuntime());
    healthyResponders(test.ports);

    await recoverRuntimeV2(test.ports, test.effects);

    expect(test.ports.alarmCalls).toContainEqual({ kind: 'create', name: PHASE_ALARM });
  });

  it('closes the session when the phase alarm cannot be read back', async (): Promise<void> => {
    const test: RecoveryHarness = harness(publishedFocusRuntime(), { alarmReadBack: 'missing' });
    healthyResponders(test.ports);

    await recoverRuntimeV2(test.ports, test.effects);

    expect(closureWrite(test.ports)?.pendingClosure?.projection.reason).toBe('alarm-failed');
  });

  it('closes the session when no target can be reached', async (): Promise<void> => {
    const test: RecoveryHarness = harness(publishedFocusRuntime());
    test.ports.respondForDocument(11, DOC_ONE, noReceiverResponder());
    test.ports.respondForDocument(12, DOC_TWO, noReceiverResponder());

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(closureWrite(test.ports)?.pendingClosure?.projection.reason).toBe(
      'tab-enforcement-failed',
    );
    expect(result.runtime.session).toBeNull();
    // The first document's epoch reset, its enforcement command, and the one retry it gets once
    // the script has been put into it. Chrome allowed the script here, so silence the second time
    // is a page this session cannot enforce: the sweep stops there and the session closes rather
    // than running over a document nobody is covering.
    expect(test.ports.sends).toHaveLength(3);
  });

  it('closes a session whose rules cannot compile', async (): Promise<void> => {
    const test: RecoveryHarness = harness(publishedFocusRuntime());
    healthyResponders(test.ports);
    const broken: RuntimePortsFakeV2 = {
      ...test.ports,
      compileMatcher: (): never => {
        throw new CoreError('invalid-rule', 'unusable session rules');
      },
    };

    const result: RecoveryResultV2 = await recoverRuntimeV2(broken, test.effects);

    expect(closureWrite(test.ports)?.pendingClosure?.projection.reason).toBe(
      'invalid-active-state',
    );
    expect(result.runtime.session).toBeNull();
    expect(test.ports.errors).toHaveLength(1);
  });
});

describe('recovery idempotence', (): void => {
  it('publishes the same session twice under a new recovery operation', async (): Promise<void> => {
    const test: RecoveryHarness = harness(publishedFocusRuntime());
    healthyResponders(test.ports);

    const first: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);
    const second: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(first.kind).toBe('published');
    expect(second.kind).toBe('published');
    expect(test.ports.commits).toHaveLength(0);
    expect(second.runtime.session?.sessionId).toBe(SESSION_ID);
    // A second boot is a second recovery operation, exactly as a fresh worker would run it.
    expect(second.runtime.enforcementCheckpoint?.operationId).toBe(IDS[1]);
    expect(second.runtime.runtimeRevision).toBeGreaterThan(first.runtime.runtimeRevision);
  });

  it('keeps one transition identity across two recoveries', async (): Promise<void> => {
    const committed: PendingEnforcementTransition = pendingTransition('start', 'alarm-ready');
    const test: RecoveryHarness = harness(transitionRuntime(committed), { now: WITHIN_BUDGET_AT });
    healthyResponders(test.ports);

    const first: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);
    const second: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(first.runtime.enforcementCheckpoint?.operationId).toBe(committed.activeOperationId);
    expect(second.kind).toBe('published');
    expect(second.runtime.session?.sessionId).toBe(SESSION_ID);
    expect(second.runtime.enforcementCheckpoint?.kind).toBe('recovery');
  });

  it('leaves an idle runtime untouched', async (): Promise<void> => {
    const idle: RuntimeStateV2 = cleanupClosureRuntime({
      pendingClosure: null,
      documentCommands: {},
      runtimeRevision: 0,
      handledScheduleOccurrences: [],
    });
    const test: RecoveryHarness = harness(idle);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result).toEqual({ kind: 'idle', runtime: idle });
    expect(test.ports.writes).toHaveLength(0);
    expect(test.ports.sends).toHaveLength(0);
    expect(test.ports.auditCalls).toBe(0);
  });
});

/** Nothing sends before recovery has decided what this runtime is. */
describe('recovery effect order', (): void => {
  it('audits before it sends and freezes before it audits', async (): Promise<void> => {
    const test: RecoveryHarness = harness(publishedFocusRuntime());
    healthyResponders(test.ports);

    await recoverRuntimeV2(test.ports, test.effects);

    expect(test.ports.auditCalls).toBe(1);
    expect(test.ports.writes.length).toBeGreaterThan(0);
    expect(CLEANUP_OPERATION_ID).not.toBe(OTHER_OPERATION_ID);
  });
});

/**
 * The one session shape that owns no phase alarm while it focuses, and therefore depends entirely
 * on this file's subject to survive an eviction. `planPhaseAlarmV2` answers `null` for indefinite
 * focus, so nothing wakes the worker on its behalf: every other shape has a timer that eventually
 * fires and repairs a bad recovery, and this one does not.
 */
describe('recovering an indefinite session', (): void => {
  it('keeps a focusing session alive with no end and clears the phase alarm', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime({
      session: indefiniteFocusSession(ACTIVATION_AT),
      enforcementCheckpoint: null,
    });
    const test: RecoveryHarness = harness(runtime);
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    // The session survives. A timed session five minutes past its end would have closed here.
    expect(result.kind).toBe('published');
    expect(result.runtime.session?.sessionId).toBe(SESSION_ID);
    expect(result.runtime.session?.phase).toBe('focus');
    expect(result.runtime.session?.sessionEndsAt).toBeNull();
    expect(result.runtime.session?.phaseEndsAt).toBeNull();
    // And it is left with no phase alarm rather than one at an invented time. A created alarm here
    // would fire on a session that has no boundary to fire at.
    expect(test.ports.alarmCalls).toContainEqual({ kind: 'clear', name: PHASE_ALARM });
    expect(test.ports.alarmCalls).not.toContainEqual({ kind: 'create', name: PHASE_ALARM });
  });

  it('counts the focus the worker slept through rather than restarting the clock', async (): Promise<void> => {
    const runtime: RuntimeStateV2 = publishedFocusRuntime({
      session: indefiniteFocusSession(ACTIVATION_AT),
      enforcementCheckpoint: null,
    });
    const test: RecoveryHarness = harness(runtime);
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    // Five minutes passed while the worker was evicted, and the person was focusing for all of
    // it. The settled `focusedMs` deliberately does not move, because an unbroken focus phase has
    // nothing to settle: what the person sees is projected from the phase start, so that is what
    // this asserts.
    expect(result.runtime.session?.phaseStartedAt).toBe(ACTIVATION_AT);
    expect(projectedFocusMs(result)).toBe(RECOVERY_AT - ACTIVATION_AT);
  });

  it('holds a live pause and arms the one alarm this shape does own', async (): Promise<void> => {
    // A pause is the only indefinite phase with a boundary, so it is the only one that arms an
    // alarm. The pause outlasts the recovery instant, so it must survive as a pause.
    const runtime: RuntimeStateV2 = pausedRuntime({
      session: indefinitePausedSession(ACTIVATION_AT, ACTIVATION_AT + MINUTE_MS, 30 * MINUTE_MS),
      enforcementCheckpoint: null,
    });
    const test: RecoveryHarness = harness(runtime);
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.kind).toBe('published');
    expect(result.runtime.session?.phase).toBe('paused');
    expect(result.runtime.session?.sessionEndsAt).toBeNull();
    expect(result.runtime.session?.pausedFrom).toEqual({ phase: 'focus', phaseEndsAt: null });
    expect(test.ports.alarmCalls).toContainEqual({ kind: 'create', name: PHASE_ALARM });
  });

  it('does not credit the pause as focus', async (): Promise<void> => {
    const pausedAt: number = ACTIVATION_AT + MINUTE_MS;
    const runtime: RuntimeStateV2 = pausedRuntime({
      session: indefinitePausedSession(ACTIVATION_AT, pausedAt, 30 * MINUTE_MS),
      enforcementCheckpoint: null,
    });
    const test: RecoveryHarness = harness(runtime);
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    // Four of the five recovered minutes were paused, so only the first one counts, and a paused
    // phase settles its focus rather than projecting more.
    expect(result.runtime.session?.focusedMs).toBe(pausedAt - ACTIVATION_AT);
    expect(projectedFocusMs(result)).toBe(pausedAt - ACTIVATION_AT);
  });

  it('resumes an indefinite session whose pause expired while the worker was gone', async (): Promise<void> => {
    // The exposure this shape has and no other: nothing was going to wake the worker at the pause
    // end, because the pause alarm died with the worker, so recovery is the only thing that can
    // notice the pause is over.
    const runtime: RuntimeStateV2 = pausedRuntime({
      session: indefinitePausedSession(ACTIVATION_AT, ACTIVATION_AT + MINUTE_MS, MINUTE_MS),
      enforcementCheckpoint: null,
    });
    const test: RecoveryHarness = harness(runtime);
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    // Back in focus, with no end, rather than stuck in an expired pause or closed.
    expect(result.runtime.session?.phase).toBe('focus');
    expect(result.runtime.session?.phaseEndsAt).toBeNull();
    expect(result.runtime.session?.sessionEndsAt).toBeNull();
    expect(result.runtime.session?.sessionId).toBe(SESSION_ID);
  });

  it('finishes a durable cleanup journal before it looks at the indefinite session', async (): Promise<void> => {
    // The journal outranks the session whatever the session's shape, and an indefinite session is
    // the one most likely to still be present when a journal is found.
    const runtime: RuntimeStateV2 = preparedClosureRuntime({
      session: indefiniteFocusSession(ACTIVATION_AT),
    });
    const test: RecoveryHarness = harness(runtime);
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(test.ports.commits).toHaveLength(1);
    expect(result.runtime.session).toBeNull();
    // The journal path never asks whether enforcement is healthy, because it is tearing it down.
    expect(test.ports.auditCalls).toBe(0);
    expect(test.badges()).toBeGreaterThan(0);
  });

  it('closes an indefinite session when enforcement can no longer be audited', async (): Promise<void> => {
    // Without a timer, an indefinite session that cannot enforce would otherwise persist forever.
    const runtime: RuntimeStateV2 = publishedFocusRuntime({
      session: indefiniteFocusSession(ACTIVATION_AT),
      enforcementCheckpoint: null,
    });
    const test: RecoveryHarness = harness(runtime, { audit: 'website-access-lost' });
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.runtime.session).toBeNull();
    expect(test.ports.auditCalls).toBe(1);
  });

  it('recovers a runtime a real start wrote rather than one a fixture invented', async (): Promise<void> => {
    // The seam this closes: `runtime-v2-fixtures.ts` never calls a production builder, so nothing
    // else in this file hands recovery a runtime a runner produced. Between the runner and the
    // reader sits only the parser, which does not pin stage semantics.
    // The start runs at activation and the recovery five minutes later, which is the eviction
    // this scenario is about.
    const started: RecoveryHarness = harness(emptyRuntimeV2(ACTIVATION_AT, EPOCH_ID), {
      now: ACTIVATION_AT,
    });
    healthyResponders(started.ports);
    const committed: RuntimeStateV2 = await startedIndefiniteRuntime(started.ports);

    expect(committed.session?.sessionEndsAt).toBeNull();
    expect(committed.pendingEnforcementTransition).toBeNull();

    const test: RecoveryHarness = harness(committed);
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.kind).toBe('published');
    expect(result.runtime.session?.sessionId).toBe(committed.session?.sessionId);
    expect(result.runtime.session?.phase).toBe('focus');
    expect(result.runtime.session?.sessionEndsAt).toBeNull();
    expect(projectedFocusMs(result)).toBe(RECOVERY_AT - ACTIVATION_AT);
  });
});

/**
 * The asymmetry no test could observe, because every effects fake outside the closure suite
 * resolved every claim by construction while production returns only the tabs it could restore.
 *
 * This is the restart file, so it is the right place for it: a claim carrying a tab identifier
 * from before a restart can never resolve, because the browser renumbers restored tabs. The two
 * cleanup paths answer that differently, and the difference is deliberate rather than an
 * oversight, so it is worth pinning in both directions.
 */
describe('recovery cleanup with a claim the browser cannot restore', (): void => {
  it('refuses to finish a closure cleanup while a claim is unresolved', async (): Promise<void> => {
    const test: RecoveryHarness = harness(cleanupClosureRuntime(), {}, 'none');
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    // The journal stays open and records why, so the next attempt has something to retry.
    expect(result.kind).toBe('closure');
    expect(result.runtime.pendingClosure?.stage).toBe('cleanup');
    expect(retryOf(result.runtime).lastError).not.toBeNull();
    expect(test.restored).toEqual([]);
  });

  it('finishes the same closure cleanup once the claims resolve', async (): Promise<void> => {
    // The control. Same runtime, same responders, only the browser's answer differs, which is what
    // makes the previous case a statement about the claim rather than about the fixture.
    const test: RecoveryHarness = harness(cleanupClosureRuntime());
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.runtime.pendingClosure).toBeNull();
    expect(test.restored).not.toEqual([]);
  });

  it('lets a transition cleanup finish with a claim the browser never restored', async (): Promise<void> => {
    // The other half of the asymmetry, and the reason it is worth writing down: the transition
    // path carries no unresolved-claim guard, so an unrestorable claim does not hold it open the
    // way it holds the closure open. Pinned so that a later change to either path has to decide
    // about this difference rather than discover it.
    const test: RecoveryHarness = harness(
      transitionRuntime(cleanupTransition('start', 'prepared', 'start-abandon')),
      {},
      'none',
    );
    healthyResponders(test.ports);

    const result: RecoveryResultV2 = await recoverRuntimeV2(test.ports, test.effects);

    expect(result.runtime.pendingEnforcementTransition).toBeNull();
    expect(test.restored).toEqual([]);
  });
});
