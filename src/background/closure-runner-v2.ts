/**
 * The closure journal. This file owns the two durable writes that end a session and the cleanup
 * attempts that follow them: `prepared` freezes the logical end while the session is still durable,
 * and one checkpoint commits that end and installs the browser cleanup the closure still owes.
 *
 * The split from `transition-cleanup-v2.ts` is by journal, not by behavior. A transition that must
 * close a session captures its closure and hands it off inside its own cleanup; a session that ends
 * with no transition in flight comes through here. Both produce the same `cleanup` closure row, so
 * the attempt, retry, and removal rules below are the only ones the runtime ever applies to it.
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
  PHASE_ALARM,
  parseAlarmNameV2,
  planPhaseAlarmV2,
} from './alarms-v2';
import {
  buildCleanupProgressV2,
  buildCleanupSeedV2,
  nextCleanupAttemptAtV2,
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
import { buildClosureProjectionV2 } from './closure-projection-v2';
import {
  enumerateEnforcementTargetsV2,
  type TargetClassificationV2,
} from './enforcement-targets-v2';
import { epochResetAcksForTabsV2 } from './epoch-reset-acks-v2';
import { carryCommitCheckpointProjectionV2, projectRuntimeDomainV2 } from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type {
  CleanupEnforcementTarget,
  CleanupProgress,
  CleanupSeed,
  CleanupTabClaim,
  ClosureProjection,
  PendingClosure,
  RuntimeStateV2,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';
import type { CleanupEffectPortsV2 } from './transition-cleanup-v2';

/** The closure's own first retry batch. A manual retry begins the next one. */
const FIRST_CLEANUP_BATCH: number = 1;

/** The logical end a caller asks this runner to make durable. */
export interface ClosureRequestV2 {
  endedAt: number;
  reason: SessionEndReasonV2;
}

type CleanupClosureV2 = Extract<PendingClosure, { stage: 'cleanup' }>;

/**
 * Freezes the logical end. The session, its checkpoint, and its commands all stay durable in this
 * write, so a crash here leaves the session running with a closure that the next boot commits.
 *
 * Every local date the settled focus lands on is read back first. An aggregate set is an absolute
 * value and focus that crosses a local midnight lands on a day the runtime already finished, so the
 * frozen projection has to carry those stored counters before it can add this session's focus.
 */
export async function prepareClosureV2(
  ports: RuntimePortsV2,
  input: ClosureRequestV2,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) throw invalidClosure('a closure needs the session it closes');
  if (runtime.pendingClosure !== null) {
    throw invalidClosure('this runtime already carries a closure');
  }
  if (runtime.pendingEnforcementTransition !== null) {
    throw invalidClosure('a transition closes its own session through its cleanup handoff');
  }
  const seed: CleanupSeed = buildCleanupSeedV2(closureAlarmNames(session), runtime.tabStates);
  const priorAggregates: Record<string, DailyAgg> = await settledAggregatesV2(
    ports,
    runtime,
    session,
    input.endedAt,
  );
  const projection: ClosureProjection = buildClosureProjectionV2({
    session,
    endedAt: input.endedAt,
    reason: input.reason,
    bank: ports.bank(),
    pauseEconomy: ports.economy(),
    accruedFocusMs: runtime.accruedFocusMs,
    todayAgg: runtime.todayAgg,
    priorAggregates,
    runtimeDate: runtime.date,
    deviceId: ports.deviceId(),
    currentHandledOccurrences: runtime.handledScheduleOccurrences,
    openOccurrences: ports.openOccurrencesAt(input.endedAt),
  }).projection;
  const next: RuntimeStateV2 = validated({
    ...structuredClone(runtime),
    pendingClosure: {
      version: 1,
      stage: 'prepared',
      projection: structuredClone(projection),
      cleanupSeed: structuredClone(seed),
      cleanupProgress: null,
    },
  });
  await ports.writeRuntime(next);
  return next;
}

/**
 * The logical commit. One checkpoint removes the session, publishes the projected events, bank, and
 * aggregates, and installs the closure at `cleanup` with the clear batch the runtime command map
 * must equal. The projection is copied byte for byte, so a restart commits exactly what the
 * prepared write froze rather than recomputing an end from a clock that has moved.
 */
export async function commitClosureV2(ports: RuntimePortsV2): Promise<RuntimeStateV2> {
  const closure: PendingClosure = preparedClosureOf(ports);
  const projection: ClosureProjection = closure.projection;
  const clearRuntimeRevision: number = ports.runtime().runtimeRevision + 1;
  const progress: CleanupProgress = buildCleanupProgressV2({
    cleanupOperationId: ports.newId(),
    clearRuntimeRevision,
    targets: await currentClearTargets(ports),
    identity: {
      enforcementEpoch: ports.runtime().enforcementEpoch,
      basePolicyRevision: ports.runtime().basePolicyRevision,
      sessionId: projection.sessionId,
      reservedSessionId: null,
    },
    seed: closure.cleanupSeed,
    at: ports.now(),
    batch: FIRST_CLEANUP_BATCH,
  });
  const rebased: RuntimeStateV2 = await rebaseClosureDay(ports, projection);
  const next: RuntimeStateV2 = validated({
    ...structuredClone(rebased),
    session: null,
    gate: null,
    unlocks: [],
    accruedFocusMs: 0,
    handledScheduleOccurrences: structuredClone(projection.handledOccurrences),
    runtimeRevision: clearRuntimeRevision,
    documentCommands: structuredClone(progress.clearCommands),
    enforcementCheckpoint: null,
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
 * One cleanup attempt. It clears the alarms the closure captured, blanks the badge, reissues the
 * exact frozen clear commands, restores the captured claims, and removes the journal only after
 * every claim and reachable target is resolved. Anything else records the failure and schedules the
 * next attempt, which is what lifecycle reads as `closure-cleanup-failed` once the batch is spent.
 */
export async function runClosureCleanupAttemptV2(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
): Promise<RuntimeStateV2> {
  cleanupClosureOf(ports);
  let failure: string | null;
  try {
    failure = await runClosureAttemptEffects(ports, effects);
  } catch (error: unknown) {
    // A cleanup error raised while acting on the browser, a claim or target built from live
    // enumeration data included, is this attempt's failure and is recorded as one. It never
    // escapes as a throw.
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure !== null)
    return recordCleanupFailureAndRearmV2(ports, 'closure', failure, 'closure cleanup');
  return removeClosureJournal(ports);
}

/** The three ordered steps of one attempt: merge what is new, clear, then clear what appeared. */
async function runClosureAttemptEffects(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
): Promise<string | null> {
  const merged: string | null = await mergeDiscoveredClaimsV2(ports, 'closure', 'closure cleanup');
  if (merged !== null) return merged;
  const failure: string | null = await performClosureEffects(
    ports,
    effects,
    cleanupClosureOf(ports),
  );
  if (failure !== null) return failure;
  return clearDiscoveredDocumentsV2(ports, 'closure', 'closure cleanup');
}

/**
 * The manual retry the popup offers once a batch is exhausted. One durable write allocates a new
 * operation, advances the clear revision, and replaces every frozen command and the runtime map.
 * The projection, the seed, the claims, and the resolved tabs do not move.
 */
export async function retryClosureCleanupV2(
  ports: RuntimePortsV2,
): Promise<{ runtime: RuntimeStateV2; code: RetryCleanupResultCodeV2 }> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const closure: PendingClosure | null = runtime.pendingClosure;
  if (
    closure === null ||
    closure.stage !== 'cleanup' ||
    closure.cleanupProgress.retry.nextAttemptAt !== null
  ) {
    return { runtime, code: 'retry-not-available' };
  }
  const committed: RuntimeStateV2 = await replaceCleanupBatchAndCommitV2(
    ports,
    'closure',
    closure.projection.closureId,
  );
  return { runtime: committed, code: 'ok' };
}

/** The whole close: freeze the end, commit it, and run the first cleanup attempt. */
export async function closeSessionV2(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  input: ClosureRequestV2,
): Promise<RuntimeStateV2> {
  await prepareClosureV2(ports, input);
  await commitClosureV2(ports);
  return runClosureCleanupAttemptV2(ports, effects);
}

/** A session with a durable phase boundary owns the one `phase` alarm the closure must clear. */
function closureAlarmNames(session: SessionStateV2): string[] {
  return planPhaseAlarmV2(session) === null ? [] : [PHASE_ALARM];
}

/** The documents the clear batch addresses: every enforceable target the browser has right now. */
async function currentClearTargets(ports: RuntimePortsV2): Promise<CleanupEnforcementTarget[]> {
  const classified: TargetClassificationV2[] = await enumerateEnforcementTargetsV2(ports.targets);
  const targets: CleanupEnforcementTarget[] = [];
  for (const target of classified) {
    if (target.kind !== 'enforceable') continue;
    targets.push({
      tabId: target.tabId,
      documentId: target.documentId,
      expectedUrl: target.url,
    });
  }
  return targets;
}

/**
 * Moves the runtime day to the day the closure ended on and adopts that day's projected aggregate.
 * The checkpoint projection owns thirteen domain fields and `date` and `todayAgg` are not among
 * them, so this is a separate write. It changes no domain field, it is exactly what a local date
 * rollover would have written, and repeating it is a no-op, so a crash between it and the commit
 * leaves a runtime the next boot commits identically.
 */
async function rebaseClosureDay(
  ports: RuntimePortsV2,
  projection: ClosureProjection,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const endedDate: string = localDateStr(projection.endedAt);
  const aggregate: DailyAgg | undefined =
    projection.aggregateSets[syncAggKey(ports.deviceId(), endedDate)];
  if (aggregate === undefined) {
    throw invalidClosure('the closure projection carries no aggregate for the day it ended on');
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
 * Runs the browser side of one attempt and returns the first fatal detail, or null when the attempt
 * is clean. A closed or changed document is not a failure: it disappears from the next reread, and
 * a missing acknowledgement is never treated as success.
 */
async function performClosureEffects(
  ports: RuntimePortsV2,
  effects: CleanupEffectPortsV2,
  closure: CleanupClosureV2,
): Promise<string | null> {
  // The seed is immutable, so its alarm names are safe to read once. Everything below rereads.
  for (const name of closure.cleanupSeed.alarmNames) {
    const alarm: AlarmNameV2 | null = parseAlarmNameV2(name);
    if (alarm === null) return `closure cleanup cannot clear the unknown alarm ${name}`;
    if (!(await clearAlarmWithReadBackV2(ports.alarms, alarm))) {
      return `closure cleanup could not clear the ${alarm} alarm`;
    }
  }
  effects.requestBlankBadge();
  // Reread after every await: an epoch acknowledgement write lands between these steps, and a
  // snapshot taken before them would be a stale copy of the row this attempt is acting on.
  const cleared: string | null = await reissueClearCommands(
    ports,
    journalProgressV2(ports.runtime(), 'closure'),
  );
  if (cleared !== null) return cleared;
  const claims: readonly CleanupTabClaim[] = journalProgressV2(
    ports.runtime(),
    'closure',
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
      'closure',
    );
    if (failure !== null && first === null) first = failure;
  }
  return first;
}

/**
 * Removes the journal, and only after every captured claim is resolved, or after the automatic
 * budget that waits for them is spent. An unresolved claim is a failed attempt rather than a
 * completion, and a removal that does not persist leaves the journal exactly where it was with the
 * next attempt scheduled.
 *
 * The same write empties the command map. The clear batch was the map for as long as the journal
 * lasted, and once the batch has done its work what it would keep is the address of every page
 * open at the end, for as long as the profile sits idle. A page that returns pulls a fresh clear
 * from the idle runtime, so nothing needs the batch after this write.
 *
 * The write also drops the acknowledgement records of tabs the browser no longer lists. A tab
 * closed while the worker was asleep, or renumbered by a browser restart, sends no removal event
 * this runtime hears, so the end of a session is where those records are bounded. A document in a
 * tab that is still open keeps its record: the back-forward cache can hand that document back, and
 * the record is what tells the idle runtime it already holds a clear rather than owing one.
 */
async function removeClosureJournal(ports: RuntimePortsV2): Promise<RuntimeStateV2> {
  const closure: CleanupClosureV2 = cleanupClosureOf(ports);
  const progress: CleanupProgress = closure.cleanupProgress;
  const unresolved: CleanupTabClaim[] = progress.tabClaims.filter(
    (claim: CleanupTabClaim): boolean => !progress.resolvedTabIds.includes(claim.tabId),
  );
  if (unresolved.length > 0) {
    const detail: string = `closure cleanup left ${unresolved.length} claims unresolved`;
    // A tab the browser is still restoring earns another attempt. A tab that is never coming back
    // would earn them forever, and the closure it holds refuses every start behind it while the
    // manual retry the person is offered can never resolve it either. So the budget bounds the
    // wait: the last attempt finishes and reports what it could not restore.
    if (nextCleanupAttemptAtV2(progress.retry.automaticAttempt + 1, ports.now()) !== null) {
      return recordCleanupFailureAndRearmV2(ports, 'closure', detail, 'closure cleanup');
    }
    ports.reportError(new CoreError('invalid-rule', `${detail} after its last automatic attempt`));
  }
  const openTabIds: ReadonlySet<number> = await openTabIdsV2(ports);
  const next: RuntimeStateV2 = validated({
    ...structuredClone(ports.runtime()),
    pendingClosure: null,
    documentCommands: {},
    epochResetAcks: epochResetAcksForTabsV2(ports.runtime().epochResetAcks, openTabIds),
  });
  try {
    await ports.writeRuntime(next);
  } catch (error: unknown) {
    ports.reportError(error);
    return recordCleanupFailureAndRearmV2(
      ports,
      'closure',
      'closure cleanup could not remove its journal',
      'closure cleanup',
    );
  }
  return next;
}

/** The tabs the browser lists right now, whatever each one shows. */
async function openTabIdsV2(ports: RuntimePortsV2): Promise<ReadonlySet<number>> {
  const open: Array<{ tabId: number; url: string | null }> =
    await ports.targets.queryTopFrameTabs();
  return new Set<number>(open.map((tab: { tabId: number }): number => tab.tabId));
}

/** Records the tabs whose captured effects were verified clean, so a retry leaves them alone. */
async function recordResolvedTabs(
  ports: RuntimePortsV2,
  resolved: readonly number[],
): Promise<void> {
  if (resolved.length === 0) return;
  const closure: CleanupClosureV2 = cleanupClosureOf(ports);
  let progress: CleanupProgress = closure.cleanupProgress;
  for (const tabId of resolved) progress = resolveCleanupTabV2(progress, tabId);
  await ports.writeRuntime(
    validated({
      ...structuredClone(ports.runtime()),
      pendingClosure: { ...structuredClone(closure), cleanupProgress: structuredClone(progress) },
    }),
  );
}

function preparedClosureOf(ports: RuntimePortsV2): PendingClosure {
  const closure: PendingClosure | null = ports.runtime().pendingClosure;
  if (closure === null || closure.stage !== 'prepared') {
    throw invalidClosure('this step needs a durable prepared closure');
  }
  return closure;
}

function cleanupClosureOf(ports: RuntimePortsV2): CleanupClosureV2 {
  const closure: PendingClosure | null = ports.runtime().pendingClosure;
  if (closure === null || closure.stage !== 'cleanup') {
    throw invalidClosure('this step needs a closure already in cleanup');
  }
  return closure;
}

function validated(runtime: RuntimeStateV2): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(
    carryCommitCheckpointProjectionV2(runtime),
  );
  if (parsed === null) throw invalidClosure('the closure runner built an invalid runtime');
  return parsed;
}

function invalidClosure(message: string): never {
  throw new CoreError('invalid-rule', message);
}
