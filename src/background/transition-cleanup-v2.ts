/**
 * Transition cleanup. This file owns the one durable entry write that moves a transition from the
 * stage it failed at into `cleanup`, together with the closure a cause that ends a durable session
 * must capture before any browser effect runs.
 *
 * Task 3 adds attempts, automatic retry, manual retry, and the post-cleanup resolution handoff on
 * top of this entry without rewriting it: everything below produces the durable row those steps
 * then advance.
 *
 * The entry is one write, and it is the last moment the durable session still exists for a closing
 * cause, which is why the closure projection is captured here rather than after the effects.
 *
 * The entry takes `{ cause, failure, endedAt }` and derives the end reason. An earlier brief drafted
 * it as `{ cause, failure, closure: { endedAt, reason } | null }`; that shape is superseded by
 * controller ruling and should not be restored.
 */

import { CoreError } from '../shared/errors';
import { exactDataEqual } from '../shared/exact-data';
import type { RetryCleanupResultCodeV2 } from '../shared/messages';
import { syncAggKey } from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type { DailyAgg, SessionEndReasonV2, SessionStateV2 } from '../shared/types';
import {
  type AlarmNameV2,
  clearAlarmWithReadBackV2,
  ensurePhaseAlarmV2,
  parseAlarmNameV2,
} from './alarms-v2';
import {
  buildCleanupProgressV2,
  buildCleanupSeedV2,
  documentCommandKeyV2,
  mergeCleanupTabClaimV2,
  resolveCleanupTabV2,
} from './cleanup-progress-v2';
import {
  clearDiscoveredDocumentsV2,
  journalProgressV2,
  mergeDiscoveredClaimsV2,
  recordCleanupFailureAndRearmV2,
  replaceCleanupBatchAndCommitV2,
  resetAndClearDocumentV2,
  settledAggregatesV2,
} from './cleanup-shared-v2';
import { buildClosureProjectionV2, manualEndReasonV2 } from './closure-projection-v2';
import type { FrozenDocumentCommand } from './enforcement-persistence-v2';
import { carryCommitCheckpointProjectionV2, projectRuntimeDomainV2 } from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type {
  CleanupEnforcementTarget,
  CleanupProgress,
  CleanupSeed,
  CleanupTabClaim,
  ClosureProjection,
  PendingEnforcementTransition,
  PostCleanupClosure,
  RuntimeStateV2,
  TransitionFailureReason,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';

export type TransitionCleanupCauseV2 = NonNullable<PendingEnforcementTransition['cleanupCause']>;
export type TransitionCleanupSourceV2 = NonNullable<PendingEnforcementTransition['cleanupFrom']>;

/** The logical end a closing cause captures. The reason is what tells the user why it ended. */
export interface PostCleanupClosureCaptureV2 {
  endedAt: number;
  reason: SessionEndReasonV2;
}

/** The browser effects one cleanup attempt performs. Everything else here is pure state. */
export interface CleanupEffectPortsV2 {
  restoreTabClaims(claims: readonly CleanupTabClaim[]): Promise<number[]>;
  reloadStoppedDocuments(claims: readonly CleanupTabClaim[]): Promise<void>;
  requestBlankBadge(): void;
}

export interface TransitionCleanupEntryV2 {
  cause: TransitionCleanupCauseV2;
  failure: TransitionFailureReason | null;
  /** The logical end. Read only for the causes that close a durable session. */
  endedAt: number;
}

/**
 * The entry's own retry batch, and a manual retry begins the next one. Transition cleanup numbers
 * its batches from one per the task brief, while `freshCleanupRetryStateV2` and the migration
 * closure number theirs from zero. Nothing reads the number except the batch-advance guard, which
 * only compares it with the batch before it, so the two conventions coexist safely.
 */
const FIRST_CLEANUP_BATCH: number = 1;
/** Exactly the causes that must close a durable session, so exactly these capture a closure. */
const CLOSING_CAUSES: ReadonlySet<TransitionCleanupCauseV2> = new Set<TransitionCleanupCauseV2>([
  'timer-completed',
  'manual-end',
  'transition-failed',
]);
/** The end reason each closing cause records, which is what tells the user why it ended. */
const CLOSURE_REASONS: Readonly<Record<string, SessionEndReasonV2>> = {
  'timer-completed': 'timer-completed',
  'manual-end': 'manual-completed',
};

/**
 * Moves the durable transition into `cleanup` in one write. The row it produces carries the exact
 * clear batch runtime `documentCommands` must equal, the session the cause implies, and, for a
 * closing cause, the immutable closure captured while the session is still durable.
 */
export async function enterTransitionCleanupV2(
  ports: RuntimePortsV2,
  entry: TransitionCleanupEntryV2,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition === null) {
    throw new CoreError('invalid-rule', 'transition cleanup needs a durable transition');
  }
  if (transition.stage === 'cleanup') {
    throw new CoreError('invalid-rule', 'this transition is already in cleanup');
  }
  const clearRuntimeRevision: number = runtime.runtimeRevision + 1;
  const seed: CleanupSeed = buildCleanupSeedV2(transition.alarmNames, runtime.tabStates);
  const progress: CleanupProgress = buildCleanupProgressV2({
    cleanupOperationId: ports.newId(),
    clearRuntimeRevision,
    targets: clearTargetsOf(transition, entry),
    identity: {
      enforcementEpoch: runtime.enforcementEpoch,
      basePolicyRevision: transition.basePolicyRevision,
      ...clearedIdentity(transition),
    },
    seed,
    at: ports.now(),
    batch: FIRST_CLEANUP_BATCH,
  });
  const closure: PostCleanupClosure | null = await captureClosure(ports, runtime, entry, seed);
  const next: RuntimeStateV2 = cleanupRuntime(runtime, transition, entry, {
    clearRuntimeRevision,
    progress,
    closure,
  });
  await ports.writeRuntime(next);
  return next;
}

interface CleanupRowV2 {
  clearRuntimeRevision: number;
  progress: CleanupProgress;
  closure: PostCleanupClosure | null;
}

/**
 * The runtime the entry persists. Its command map is exactly the clear batch, its revision is the
 * clear revision, its base policy revision is the one the transition reserved and this write now
 * makes durable, and the session is the one the cause leaves behind.
 *
 * Moving the base policy revision here is a producer requirement, not an option, and it binds the
 * abandoning causes too: a pre-commit start is the one stage whose reservation may lead the durable
 * base, and entering cleanup ends that stage. `transitionBaseRevisionAgrees` refuses a cleanup row
 * whose durable base still trails the transition's reserved one, so a producer that skipped this
 * would meet the rule as a parse failure on the runtime it just wrote.
 */
function cleanupRuntime(
  runtime: RuntimeStateV2,
  transition: PendingEnforcementTransition,
  entry: TransitionCleanupEntryV2,
  row: CleanupRowV2,
): RuntimeStateV2 {
  const next: RuntimeStateV2 = {
    ...structuredClone(runtime),
    session: retainedSession(runtime, entry.cause),
    basePolicyRevision: transition.basePolicyRevision,
    runtimeRevision: row.clearRuntimeRevision,
    documentCommands: structuredClone(row.progress.clearCommands),
    enforcementCheckpoint: null,
    pendingEnforcementTransition: {
      ...structuredClone(transition),
      stage: 'cleanup',
      runtimeRevision: row.clearRuntimeRevision,
      preparedTargetReservations: {},
      failure: entry.failure,
      cleanupProgress: structuredClone(row.progress),
      cleanupFrom: transition.stage as TransitionCleanupSourceV2,
      cleanupCause: entry.cause,
      postCleanupClosure: structuredClone(row.closure),
    },
  };
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(
    carryCommitCheckpointProjectionV2(next),
  );
  if (parsed === null) {
    throw new CoreError('invalid-rule', 'transition cleanup entry failed runtime validation');
  }
  return parsed;
}

/**
 * Abandoning a start removes the session it never committed. Every other cause keeps the durable
 * session: a restored resume keeps its saved pause or break, and a closing cause keeps the session
 * frozen at the projected end until the one-checkpoint handoff clears it.
 */
function retainedSession(
  runtime: RuntimeStateV2,
  cause: TransitionCleanupCauseV2,
): SessionStateV2 | null {
  return cause === 'start-abandon' ? null : structuredClone(runtime.session);
}

/** The two audit answers, which fail before registration is audited and so before any send. */
const AUDIT_FAILURES: ReadonlySet<string> = new Set<string>([
  'website-access-lost',
  'content-registration-failed',
]);

/**
 * The clear batch covers exactly the documents the transition's newest frozen view addressed, with
 * one exception: nothing is sent before registration is audited, so a cleanup entered from the one
 * pre-audit stage has nothing to clear (spec 766). That entry releases its reservations with an
 * empty batch instead of clearing targets that never heard from this transition.
 *
 * The stage is the authority, and the two audit failures are read as well because they are the
 * answers that end a transition at that stage. Discovery uses the same rule, so the batch a journal
 * freezes and the documents it later enumerates agree on what this cleanup ever touched.
 */
function clearTargetsOf(
  transition: PendingEnforcementTransition,
  entry: TransitionCleanupEntryV2,
): CleanupEnforcementTarget[] {
  if (transition.stage === 'prepared') return [];
  if (entry.failure !== null && AUDIT_FAILURES.has(entry.failure)) return [];
  return frozenTargetsOf(transition);
}

function frozenTargetsOf(transition: PendingEnforcementTransition): CleanupEnforcementTarget[] {
  const view: Record<string, FrozenDocumentCommand> =
    transition.activeView?.documents ?? transition.startingView.documents;
  return Object.values(view).map(
    (command: FrozenDocumentCommand): CleanupEnforcementTarget => ({
      tabId: command.tabId,
      documentId: command.documentId,
      expectedUrl: command.expectedUrl,
    }),
  );
}

/**
 * A clear command names the session in the form the source stage had. A committed transition and
 * every resume own a durable session ID; a pre-commit start only ever reserved one.
 */
function clearedIdentity(transition: PendingEnforcementTransition): {
  sessionId: string | null;
  reservedSessionId: string | null;
} {
  const durable: boolean = transition.activeView !== null || transition.kind === 'resume';
  return durable
    ? { sessionId: transition.sessionId, reservedSessionId: null }
    : { sessionId: null, reservedSessionId: transition.sessionId };
}

/**
 * Captures the immutable closure a closing cause owes, while the session is still durable. Focus
 * that crosses a local midnight lands on a day the runtime already wrote, and an aggregate set is
 * an absolute value, so every date the settlement touches is read back before it is added to.
 */
async function captureClosure(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  entry: TransitionCleanupEntryV2,
  seed: CleanupSeed,
): Promise<PostCleanupClosure | null> {
  if (!CLOSING_CAUSES.has(entry.cause)) return null;
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) {
    throw new CoreError('invalid-rule', `${entry.cause} cleanup needs the session it closes`);
  }
  const projection: ClosureProjection = buildClosureProjectionV2({
    session,
    endedAt: entry.endedAt,
    reason: closureReason(entry, session),
    bank: ports.bank(),
    pauseEconomy: ports.economy(),
    accruedFocusMs: runtime.accruedFocusMs,
    todayAgg: runtime.todayAgg,
    priorAggregates: await settledAggregatesV2(ports, runtime, session, entry.endedAt),
    runtimeDate: runtime.date,
    deviceId: ports.deviceId(),
    currentHandledOccurrences: runtime.handledScheduleOccurrences,
    openOccurrences: ports.openOccurrencesAt(entry.endedAt),
  }).projection;
  return { projection: structuredClone(projection), cleanupSeed: structuredClone(seed) };
}

/**
 * Moves the runtime onto the day the closure ended on and adopts the aggregate that closure wrote
 * for it. This is `rebaseClosureDay`'s rule on the transition path: the ended day is not part of
 * the projected domain, so a commit cannot carry it, and leaving the stale copy in place means the
 * next start on that day commits it back over the aggregate the closure just stored, losing the
 * completed session and its focus.
 */
async function rebaseHandOffDay(
  ports: RuntimePortsV2,
  projection: ClosureProjection,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const endedDate: string = localDateStr(projection.endedAt);
  const aggregate: DailyAgg | undefined =
    projection.aggregateSets[syncAggKey(ports.deviceId(), endedDate)];
  if (aggregate === undefined) {
    throw new CoreError(
      'invalid-rule',
      'the closure projection carries no aggregate for the day it ended on',
    );
  }
  if (runtime.date === endedDate && exactDataEqual(runtime.todayAgg, aggregate)) {
    return structuredClone(runtime);
  }
  const next: RuntimeStateV2 = validated({
    ...structuredClone(runtime),
    date: endedDate,
    todayAgg: structuredClone(aggregate),
  });
  await ports.writeRuntime(next);
  return next;
}

/**
 * A transition failure ends the session with the enforcement reason that caused it. Timer
 * completion and a manual end carry their own reasons, and a manual end of a timed session is an
 * early cancel rather than a completion.
 */
function closureReason(
  entry: TransitionCleanupEntryV2,
  session: SessionStateV2,
): SessionEndReasonV2 {
  if (entry.cause === 'transition-failed') {
    if (entry.failure === null) {
      throw new CoreError('invalid-rule', 'a transition-failed cleanup names its failure');
    }
    return entry.failure;
  }
  if (entry.cause === 'manual-end') return manualEndReasonV2(session.config.duration);
  const reason: SessionEndReasonV2 | undefined = CLOSURE_REASONS[entry.cause];
  if (reason === undefined) {
    throw new CoreError('invalid-rule', `${entry.cause} does not close a session`);
  }
  return reason;
}

/** Re-exported so the runner and Task 3 agree on the one document key spelling. */
export { documentCommandKeyV2 };

/**
 * One cleanup attempt. It clears the alarms the transition owns, blanks the badge, reissues the
 * exact frozen clear commands, restores the tab claims it captured, and then either resolves the
 * transition or records the failure and schedules the next attempt.
 *
 * Nothing here regenerates a command. Every send is the value the entry froze, which is what makes
 * an automatic retry and a restart indistinguishable to a document.
 */
export async function runTransitionCleanupAttemptV2(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
): Promise<RuntimeStateV2> {
  const transition: PendingEnforcementTransition = cleanupTransitionOf(ports);
  requireProgress(transition);
  let failure: string | null;
  try {
    failure = await runTransitionAttemptEffects(ports, effects, transition);
  } catch (error: unknown) {
    // A cleanup error raised while acting on the browser, a contradictory tab claim included, is
    // this attempt's failure and is recorded as one. It never escapes as an overwrite or a throw.
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure !== null) {
    return recordCleanupFailureAndRearmV2(ports, 'transition', failure, 'cleanup');
  }
  return resolveCleanup(ports);
}

/**
 * The three ordered steps of one attempt. Spec 1148 to 1155 state the discovery rules for a cleanup
 * batch without distinguishing the journal that owns it, so this journal merges newly found claims
 * before acting and clears newly found documents after its frozen batch, exactly as the closure
 * journal does.
 */
async function runTransitionAttemptEffects(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  transition: PendingEnforcementTransition,
): Promise<string | null> {
  const merged: string | null = await mergeDiscoveredClaimsV2(ports, 'transition', 'cleanup');
  if (merged !== null) return merged;
  const failure: string | null = await performCleanupEffects(ports, effects, transition);
  if (failure !== null) return failure;
  return clearDiscoveredDocumentsV2(ports, 'transition', 'cleanup');
}

/**
 * Runs the browser side of one attempt and returns the first fatal detail, or null when the
 * attempt is clean. A closed or changed target is not a failure: it disappears from the next
 * reread, and a missing acknowledgement is never treated as success.
 */
async function performCleanupEffects(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  transition: PendingEnforcementTransition,
): Promise<string | null> {
  for (const name of transition.alarmNames) {
    const alarm: AlarmNameV2 | null = parseAlarmNameV2(name);
    if (alarm === null) return `cleanup cannot clear the unknown alarm ${name}`;
    if (!(await clearAlarmWithReadBackV2(ports.alarms, alarm))) {
      return `cleanup could not clear the ${alarm} alarm`;
    }
  }
  effects.requestBlankBadge();
  // Reread after every await: an epoch acknowledgement write lands between these steps, and a
  // snapshot taken before them would be a stale copy of the row this attempt is acting on.
  const cleared: string | null = await reissueClearCommands(
    ports,
    journalProgressV2(ports.runtime(), 'transition'),
  );
  if (cleared !== null) return cleared;
  const claims: readonly CleanupTabClaim[] = journalProgressV2(
    ports.runtime(),
    'transition',
  ).tabClaims;
  const resolved: number[] = await effects.restoreTabClaims(claims);
  await effects.reloadStoppedDocuments(claims);
  await recordResolvedTabs(ports, resolved);
  return null;
}

/** Resets any target that has not acknowledged this epoch, then sends its frozen clear command. */
async function reissueClearCommands(
  ports: RuntimePortsV2,
  progress: CleanupProgress,
): Promise<string | null> {
  // Every document gets its reset and clear on each attempt. The first failure is reported after
  // the loop, so one page that never answers holds the journal for itself and not for the rest.
  let first: string | null = null;
  for (const [key, command] of Object.entries(progress.clearCommands)) {
    const failure: string | null = await resetAndClearDocumentV2(
      ports,
      progress,
      key,
      command,
      'cleanup',
    );
    if (failure !== null && first === null) first = failure;
  }
  return first;
}

/** Resolves the transition the clean attempt earned, by the cause that entered cleanup. */
async function resolveCleanup(ports: RuntimePortsV2): Promise<RuntimeStateV2> {
  const transition: PendingEnforcementTransition = cleanupTransitionOf(ports);
  const closure: PostCleanupClosure | null = transition.postCleanupClosure;
  if (closure !== null) return handOffClosure(ports, transition, closure);
  if (transition.cleanupCause === 'resume-restore') return restoreResume(ports);
  return clearTransition(ports, `${transition.sessionId}:abandon`);
}

/**
 * Restores the pause or break a pre-commit resume left. The saved phase alarm is recreated and read
 * back before the commit, so the restored session is never durable without the boundary it needs.
 * An arrived fixed end upgrades to timer completion instead of restoring.
 */
async function restoreResume(ports: RuntimePortsV2): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) {
    throw new CoreError('invalid-rule', 'a resume restore lost the session it restores');
  }
  const now: number = ports.now();
  if (session.sessionEndsAt !== null && session.sessionEndsAt <= now) {
    return upgradeToTimerCompletion(ports, session.sessionEndsAt);
  }
  if ((await ensurePhaseAlarmV2(ports.alarms, session)) === 'alarm-failed') {
    return recordCleanupFailureAndRearmV2(
      ports,
      'transition',
      'cleanup could not restore the saved phase alarm',
      'cleanup',
    );
  }
  return clearTransition(ports, `${session.sessionId}:restore`);
}

/**
 * A resume whose fixed end arrived during cleanup has nothing to restore, so it captures timer
 * completion at the exact end and hands that closure off through the same one-checkpoint path.
 *
 * The reread after the closure capture is structural rather than tested. `captureClosure` awaits
 * only `ports.loadAggregates`, and `settledAggregates` skips that read whenever the settlement
 * covers no dates; this function is reached from `restoreResume` alone, where the session is always
 * paused or break, so the settlement window is always empty and no await occurs. The reread costs
 * nothing and keeps the branch correct if a future caller reaches it with a focus session, but
 * there is no interleaving a test can drive through it today.
 */
async function upgradeToTimerCompletion(
  ports: RuntimePortsV2,
  endedAt: number,
): Promise<RuntimeStateV2> {
  const seed: CleanupSeed = buildCleanupSeedV2(
    cleanupTransitionOf(ports).alarmNames,
    ports.runtime().tabStates,
  );
  const closure: PostCleanupClosure | null = await captureClosure(
    ports,
    ports.runtime(),
    { cause: 'timer-completed', failure: null, endedAt },
    seed,
  );
  if (closure === null) {
    throw new CoreError('invalid-rule', 'timer completion did not capture its closure');
  }
  // Capturing the closure reads stored aggregates, so the row this upgrade writes is reread after
  // that await. A navigation handled meanwhile has already advanced the durable batch.
  const current: RuntimeStateV2 = ports.runtime();
  const upgraded: PendingEnforcementTransition = {
    ...structuredClone(cleanupTransitionOf(ports)),
    cleanupCause: 'timer-completed',
    postCleanupClosure: structuredClone(closure),
  };
  await ports.writeRuntime(
    validated({ ...structuredClone(current), pendingEnforcementTransition: upgraded }),
  );
  return handOffClosure(ports, upgraded, closure);
}

/**
 * The one checkpoint that crosses journals. It allocates the closure's own cleanup batch above the
 * transition's clear revision, carries the verified claims and resolved tabs forward, replaces the
 * runtime command map, flushes the projected events, bank, and aggregates, installs the closure at
 * `cleanup`, and clears the transition. The projection itself is copied byte for byte.
 */
async function handOffClosure(
  ports: RuntimePortsV2,
  transition: PendingEnforcementTransition,
  closure: PostCleanupClosure,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const transitionProgress: CleanupProgress = requireProgress(transition);
  const clearRuntimeRevision: number = transitionProgress.clearRuntimeRevision + 1;
  const projection: ClosureProjection = closure.projection;
  let progress: CleanupProgress = buildCleanupProgressV2({
    cleanupOperationId: ports.newId(),
    clearRuntimeRevision,
    targets: Object.values(transitionProgress.targets).map(
      (target: CleanupEnforcementTarget): CleanupEnforcementTarget => structuredClone(target),
    ),
    identity: {
      enforcementEpoch: runtime.enforcementEpoch,
      basePolicyRevision: runtime.basePolicyRevision,
      sessionId: projection.sessionId,
      reservedSessionId: null,
    },
    seed: closure.cleanupSeed,
    at: ports.now(),
    batch: FIRST_CLEANUP_BATCH,
  });
  for (const claim of transitionProgress.tabClaims) {
    progress = mergeCleanupTabClaimV2(progress, claim);
  }
  for (const tabId of transitionProgress.resolvedTabIds) {
    progress = resolveCleanupTabV2(progress, tabId);
  }
  // The day and its aggregate are not part of the projected domain, so a commit cannot carry them.
  // They are written first, exactly as the closure runner writes them, and the checkpoint below
  // then carries the domain over the runtime this left behind.
  const rebased: RuntimeStateV2 = await rebaseHandOffDay(ports, projection);
  const next: RuntimeStateV2 = validated({
    ...structuredClone(rebased),
    session: null,
    gate: null,
    unlocks: [],
    // The watermark the closure builder hands over with its projection, which the closure runner
    // and the migration checkpoint both reset. Without it the watermark keeps the ended session's
    // focus, so the next session earns no bank and records no focus until it out-focuses a session
    // that is already over.
    accruedFocusMs: 0,
    runtimeRevision: clearRuntimeRevision,
    documentCommands: structuredClone(progress.clearCommands),
    enforcementCheckpoint: null,
    handledScheduleOccurrences: structuredClone(projection.handledOccurrences),
    pendingEnforcementTransition: null,
    pendingClosure: {
      version: 1,
      stage: 'cleanup',
      projection: structuredClone(projection),
      cleanupSeed: structuredClone(closure.cleanupSeed),
      cleanupProgress: structuredClone(progress),
    },
  });
  return ports.commit({
    checkpointId: projection.closureId,
    projection: projectRuntimeDomainV2(next),
    bank: structuredClone(projection.bankAfter),
    events: structuredClone(projection.events),
    syncBank: true,
    aggregateSets: structuredClone(projection.aggregateSets),
    aggregateRemoves: [...projection.aggregateRemoves],
  });
}

/**
 * Clears a resolved transition that owes no closure, retaining the durable clear tuple. An
 * abandoned start leaves an idle runtime, and the same write empties the command map: the batch
 * has done its work, and an idle runtime that kept it would keep the address of every page open
 * at the time. A restored resume keeps its batch, because the session is still running its pause
 * or break and the retained clears are what a live refresh refreezes until that phase ends.
 */
async function clearTransition(
  ports: RuntimePortsV2,
  checkpointId: string,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const abandoned: boolean = runtime.pendingEnforcementTransition?.cleanupCause === 'start-abandon';
  const next: RuntimeStateV2 = validated({
    ...structuredClone(runtime),
    pendingEnforcementTransition: null,
    ...(abandoned ? { documentCommands: {} } : {}),
  });
  return ports.commit({
    checkpointId,
    projection: projectRuntimeDomainV2(next),
    bank: ports.bank(),
    events: [],
    syncBank: false,
    aggregateSets: {},
    aggregateRemoves: [],
  });
}

/** Records the tabs whose captured effects were verified clean, so a retry leaves them alone. */
async function recordResolvedTabs(
  ports: RuntimePortsV2,
  resolved: readonly number[],
): Promise<void> {
  if (resolved.length === 0) return;
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition = cleanupTransitionOf(ports);
  let progress: CleanupProgress = requireProgress(transition);
  for (const tabId of resolved) progress = resolveCleanupTabV2(progress, tabId);
  await ports.writeRuntime(
    validated({
      ...structuredClone(runtime),
      pendingEnforcementTransition: {
        ...structuredClone(transition),
        cleanupProgress: structuredClone(progress),
      },
    }),
  );
}

/**
 * The manual retry the popup offers once a batch is exhausted. One durable write allocates a new
 * operation, advances the clear revision, replaces every frozen command and the runtime map, and
 * begins the next batch. Targets, claims, resolved IDs, and the closure projection do not move.
 */
export async function retryTransitionCleanupV2(
  ports: RuntimePortsV2,
): Promise<{ runtime: RuntimeStateV2; code: RetryCleanupResultCodeV2 }> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  const progress: CleanupProgress | null = transition?.cleanupProgress ?? null;
  if (
    transition === null ||
    transition.stage !== 'cleanup' ||
    progress === null ||
    progress.retry.nextAttemptAt !== null
  ) {
    return { runtime, code: 'retry-not-available' };
  }
  const committed: RuntimeStateV2 = await replaceCleanupBatchAndCommitV2(
    ports,
    'transition',
    transition.transitionId,
  );
  return { runtime: committed, code: 'ok' };
}

/**
 * The cleanup navigation entry the controller calls. It lives in the shared cleanup leaf because a
 * navigation belongs to whichever journal owns the durable batch, and it is re-exported here so the
 * call site that has always imported it from this module keeps working.
 */
export { handleCleanupNavigationV2 } from './cleanup-shared-v2';

/** The durable transition this file acts on: one that is already in cleanup with its progress. */
function cleanupTransitionOf(ports: RuntimePortsV2): PendingEnforcementTransition {
  const transition: PendingEnforcementTransition | null =
    ports.runtime().pendingEnforcementTransition;
  if (transition === null || transition.stage !== 'cleanup') {
    throw new CoreError('invalid-rule', 'this step needs a transition already in cleanup');
  }
  return transition;
}

function requireProgress(transition: PendingEnforcementTransition): CleanupProgress {
  const progress: CleanupProgress | null = transition.cleanupProgress;
  if (progress === null) {
    throw new CoreError('invalid-rule', 'a cleanup transition needs its durable progress');
  }
  return progress;
}

function validated(runtime: RuntimeStateV2): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(
    carryCommitCheckpointProjectionV2(runtime),
  );
  if (parsed === null) {
    throw new CoreError('invalid-rule', 'transition cleanup built an invalid runtime');
  }
  return parsed;
}
