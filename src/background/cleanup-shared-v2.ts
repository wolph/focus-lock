/**
 * What both cleanup journals do the same way. A transition cleanup and a closure cleanup differ in
 * which durable row owns the batch and in what resolving it means, and in nothing else: the epoch
 * handshake before a clear, the acknowledgement write, the aggregate read a closure capture owes,
 * the failure-and-rearm loop, and the navigation entry are one rule each.
 *
 * This is a leaf. It imports neither runner, so both runners and recovery can call it, and the
 * journal is a parameter rather than a module boundary.
 */

import { CoreError } from '../shared/errors';
import { exactDataEqual } from '../shared/exact-data';
import { syncAggKey } from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type { DailyAgg, SessionStateV2 } from '../shared/types';
import {
  type AlarmNameV2,
  CLOSURE_CLEANUP_ALARM,
  createAlarmWithReadBackV2,
  TRANSITION_CLEANUP_ALARM,
} from './alarms-v2';
import {
  addCleanupTargetV2,
  documentCommandKeyV2,
  mergeCleanupTabClaimV2,
  recordCleanupAttemptFailureV2,
  replaceCleanupBatchV2,
} from './cleanup-progress-v2';
import { closureSplitIntervalV2, splitFocusByLocalDateV2 } from './closure-projection-v2';
import {
  type DocumentCommandOutcomeV2,
  type EpochResetOutcomeV2,
  sendDocumentEnforcementCommand,
  sendEpochResetCommand,
} from './content-transport-v2';
import type {
  DocumentEpochResetAck,
  EpochResetAckRecord,
  FrozenDocumentCommand,
} from './enforcement-persistence-v2';
import {
  classifyEnforcementTargetV2,
  enumerateEnforcementTargetsV2,
  type TargetClassificationV2,
} from './enforcement-targets-v2';
import { withEpochResetAckV2 } from './epoch-reset-acks-v2';
import { buildFrozenEpochResetCommandV2 } from './overlay-view-v2';
import { carryCommitCheckpointProjectionV2, projectRuntimeDomainV2 } from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type {
  CleanupProgress,
  CleanupTabClaim,
  PendingClosure,
  PendingEnforcementTransition,
  RuntimeStateV2,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';

/** Which durable row owns the current clear batch. */
export type CleanupJournalV2 = 'closure' | 'transition';

/** The clear commands of one batch name the session in the form its source stage had. */
export interface CleanupClearIdentityV2 {
  sessionId: string | null;
  reservedSessionId: string | null;
}

/** The journal that owns a durable clear batch right now, or null when neither does. */
export function cleanupJournalOfV2(runtime: RuntimeStateV2): CleanupJournalV2 | null {
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition !== null && transition.stage === 'cleanup') return 'transition';
  const closure: PendingClosure | null = runtime.pendingClosure;
  return closure !== null && closure.stage === 'cleanup' ? 'closure' : null;
}

/** The cleanup progress of one journal, which the caller has already proven is the current batch. */
export function journalProgressV2(
  runtime: RuntimeStateV2,
  journal: CleanupJournalV2,
): CleanupProgress {
  const progress: CleanupProgress | null =
    journal === 'closure'
      ? ((runtime.pendingClosure?.cleanupProgress ?? null) as CleanupProgress | null)
      : (runtime.pendingEnforcementTransition?.cleanupProgress ?? null);
  if (progress === null) {
    throw invalidCleanup(`the ${journal} journal lost its cleanup progress`);
  }
  return progress;
}

/** The same runtime with one journal's progress replaced. Every other field is carried. */
function withJournalProgressV2(
  runtime: RuntimeStateV2,
  journal: CleanupJournalV2,
  progress: CleanupProgress,
): RuntimeStateV2 {
  if (journal === 'closure') {
    const closure: PendingClosure | null = runtime.pendingClosure;
    if (closure === null || closure.stage !== 'cleanup') {
      throw invalidCleanup('a closure cleanup write needs its cleanup closure');
    }
    return {
      ...structuredClone(runtime),
      pendingClosure: { ...structuredClone(closure), cleanupProgress: structuredClone(progress) },
    };
  }
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition === null || transition.stage !== 'cleanup') {
    throw invalidCleanup('a transition cleanup write needs its cleanup transition');
  }
  return {
    ...structuredClone(runtime),
    pendingEnforcementTransition: {
      ...structuredClone(transition),
      cleanupProgress: structuredClone(progress),
    },
  };
}

/** The alarm that wakes one journal's waiting batch. */
function cleanupAlarmOfV2(journal: CleanupJournalV2): AlarmNameV2 {
  return journal === 'closure' ? CLOSURE_CLEANUP_ALARM : TRANSITION_CLEANUP_ALARM;
}

/**
 * Records one failed attempt and schedules the next. An alarm the browser refused is not a
 * scheduled attempt: recording it as one more failure is what keeps the schedule moving toward the
 * manual retry instead of stranding a journal with a live `nextAttemptAt` nothing will ever fire.
 * The twelfth failure leaves `nextAttemptAt` null and creates no alarm.
 */
export async function recordCleanupFailureAndRearmV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  detail: string,
  label: string,
): Promise<RuntimeStateV2> {
  await writeCleanupFailureV2(ports, journal, detail);
  return rearmCleanupAlarmV2(ports, journal, label);
}

/**
 * Brings the journal's retry alarm in line with its durable `nextAttemptAt`, which is what a boot
 * owes a batch that is waiting. A refused read-back is recorded as one more failed attempt, so the
 * loop ends either with an alarm the browser confirmed or with an exhausted batch.
 */
export async function rearmCleanupAlarmV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  label: string,
): Promise<RuntimeStateV2> {
  const name: AlarmNameV2 = cleanupAlarmOfV2(journal);
  let runtime: RuntimeStateV2 = ports.runtime();
  for (;;) {
    const scheduled: number | null = journalProgressV2(runtime, journal).retry.nextAttemptAt;
    if (scheduled === null) return runtime;
    if (await createAlarmWithReadBackV2(ports.alarms, name, scheduled)) return runtime;
    runtime = await writeCleanupFailureV2(
      ports,
      journal,
      `${label} could not schedule its retry alarm`,
    );
  }
}

/** One durable failed attempt on the journal that owns the batch. The caller owns the loop. */
async function writeCleanupFailureV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  detail: string,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const progress: CleanupProgress = journalProgressV2(runtime, journal);
  const next: CleanupProgress = {
    ...structuredClone(progress),
    retry: recordCleanupAttemptFailureV2(progress.retry, ports.now(), detail),
  };
  await ports.writeRuntime(
    validatedCleanupRuntimeV2(withJournalProgressV2(runtime, journal, next)),
  );
  return ports.runtime();
}

/**
 * How one send treats a page that answers with no receiver at all.
 *
 * Membership in this batch is the evidence the transport answer does not carry. A document the
 * batch froze, or one on a tab this cleanup holds a claim for, was overlaid by this session (spec
 * 758, spec 1954), so a missing receiver there is a clear that did not land and the journal stays
 * open. A document discovered on a tab with no claim was never sent anything by this journal and
 * has no overlay to clear, so an unreachable one is deferred rather than fatal, which is how spec
 * 1345 treats the same case in browser reset.
 */
export interface CleanupSendPolicyV2 {
  tolerateNoReceiver: boolean;
}

const OVERLAID_SEND_POLICY: CleanupSendPolicyV2 = { tolerateNoReceiver: false };
const UNCLAIMED_SEND_POLICY: CleanupSendPolicyV2 = { tolerateNoReceiver: true };

/**
 * Spec step 6 for one document: reset it when it has not acknowledged the current epoch, and only
 * then send its exact frozen clear. Every reachable document owes that handshake, the ones a batch
 * froze and the ones an attempt or a navigation discovers alike, so every send comes through here.
 */
export async function resetAndClearDocumentV2(
  ports: RuntimePortsV2,
  progress: CleanupProgress,
  key: string,
  command: FrozenDocumentCommand,
  label: string,
  policy: CleanupSendPolicyV2 = OVERLAID_SEND_POLICY,
): Promise<string | null> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const ack: EpochResetAckRecord | undefined = runtime.epochResetAcks[key];
  if (ack === undefined || ack.enforcementEpoch !== runtime.enforcementEpoch) {
    const reset: EpochResetOutcomeV2 = await sendEpochResetCommand(
      ports.transport,
      buildFrozenEpochResetCommandV2({
        tabId: command.tabId,
        documentId: command.documentId,
        expectedUrl: command.expectedUrl,
        operationId: progress.cleanupOperationId,
        enforcementEpoch: command.enforcementEpoch,
      }),
    );
    // A closed document owes nothing further this attempt, and its claim decides its resolution.
    if (reset.kind === 'closed') return null;
    if (reset.kind === 'no-receiver' && (await toleratedNoReceiverV2(ports, command, policy))) {
      return null;
    }
    if (reset.kind !== 'reset' && !movedDocumentResetV2(reset)) {
      return `${label} reset for ${key} answered ${reset.kind}`;
    }
    if (reset.kind === 'reset') await recordEpochAckV2(ports, reset.ack);
  }
  const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
    ports.transport,
    command,
  );
  // `changed` says only that the worker refused to wrap an acknowledgement for a URL it did not
  // name. The content script never reads `expectedUrl`, so the clear was applied and the overlay is
  // gone, and the document disappears from the next reread under its own URL.
  if (outcome.kind === 'applied' || outcome.kind === 'closed' || outcome.kind === 'changed') {
    return null;
  }
  if (outcome.kind === 'no-receiver' && (await toleratedNoReceiverV2(ports, command, policy))) {
    return null;
  }
  // Nothing may outrank the clear revision, so a stale answer during cleanup is fatal too.
  return `${label} clear for ${key} answered ${outcome.kind}`;
}

/**
 * Whether a missing listener ends this target rather than failing the attempt.
 *
 * The policy answers for a document this journal never overlaid. Beyond that, Chrome answers a send
 * to a tab that has gone with the missing-listener message rather than the missing-tab one, so the
 * browser's own tab list is asked: a target whose tab the browser no longer lists has no overlay
 * left to clear, and treating that as a refusal held the journal for the life of its batch over a
 * page the person had closed, with every start refused behind it.
 */
async function toleratedNoReceiverV2(
  ports: RuntimePortsV2,
  command: FrozenDocumentCommand,
  policy: CleanupSendPolicyV2,
): Promise<boolean> {
  if (policy.tolerateNoReceiver) return true;
  const open: Array<{ tabId: number; url: string | null }> =
    await ports.targets.queryTopFrameTabs();
  if (!open.some((tab: { tabId: number }): boolean => tab.tabId === command.tabId)) return true;
  // A listed tab with no listener is either a page the script has not reached or one Chrome
  // refuses to script, and only trying tells them apart, as the start sweep does. A document
  // Chrome will not script was never overlaid, so there is nothing to clear and it is resolved.
  const state: 'ready' | 'unscriptable' = await ports.targets.ensureDocumentScript(command.tabId);
  return state === 'unscriptable';
}

/**
 * A cleanup reset whose only discrepancy is the URL the document reports.
 *
 * URL drift is fatal in the enforcement flow, spec 1343, because a verdict computed for one URL must
 * never be applied to another. A cleanup reset carries no verdict: it exists only to establish epoch
 * agreement so the clear that follows is accepted, and removing an overlay is correct on any URL.
 * The document did reset its epoch, because its handler never reads the expected URL, so only the
 * worker's field comparison refused the answer. The reason does not carry over, so neither does the
 * rule, and every other mismatched field stays fatal here.
 */
function movedDocumentResetV2(reset: EpochResetOutcomeV2): boolean {
  return reset.kind === 'mismatch' && reset.field === 'observedUrl';
}

/** One acknowledgement becomes durable before the clear command it authorizes is sent. */
async function recordEpochAckV2(ports: RuntimePortsV2, ack: DocumentEpochResetAck): Promise<void> {
  const runtime: RuntimeStateV2 = ports.runtime();
  await ports.writeRuntime(
    validatedCleanupRuntimeV2({
      ...structuredClone(runtime),
      epochResetAcks: withEpochResetAckV2(runtime.epochResetAcks, ack),
    }),
  );
}

/**
 * Reads back every stored day a closure capture will settle focus on, plus the day it ends on. The
 * interval is the one `buildClosureProjectionV2` splits: it ends at the last focus instant and is
 * exactly the unsettled focus delta long. An aggregate set is an absolute value, so a day that is
 * already finished has to be read before this closure can add to it.
 */
export async function settledAggregatesV2(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  session: SessionStateV2,
  endedAt: number,
): Promise<Record<string, DailyAgg>> {
  const interval: { from: number; to: number } = closureSplitIntervalV2(
    session,
    endedAt,
    runtime.accruedFocusMs,
  );
  const dates: Set<string> = new Set<string>(
    splitFocusByLocalDateV2(interval.from, interval.to).map(
      (split: { date: string }): string => split.date,
    ),
  );
  dates.add(localDateStr(endedAt));
  return ports.loadAggregates(
    [...dates].map((date: string): string => syncAggKey(ports.deviceId(), date)),
  );
}

/**
 * Spec 1148: before each cleanup write, any newly discovered owned claim is merged idempotently by
 * tab ID into the batch's claims only. Saved ownership wins, a saved null may be filled once, and
 * contradictory ownership is a cleanup error rather than an overwrite, so it fails the attempt
 * instead of rewriting what the journal captured.
 */
export async function mergeDiscoveredClaimsV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  label: string,
): Promise<string | null> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const saved: CleanupProgress = journalProgressV2(runtime, journal);
  let progress: CleanupProgress = saved;
  try {
    for (const [key, state] of Object.entries(runtime.tabStates)) {
      progress = mergeCleanupTabClaimV2(progress, { tabId: Number(key), state });
    }
  } catch (error: unknown) {
    return error instanceof CoreError
      ? `${label} found a contradictory claim: ${error.message}`
      : `${label} could not merge a discovered claim`;
  }
  if (exactDataEqual(progress.tabClaims, saved.tabClaims)) return null;
  await ports.writeRuntime(
    validatedCleanupRuntimeV2(withJournalProgressV2(runtime, journal, progress)),
  );
  return null;
}

/**
 * Spec 1150: a newly discovered cleanup document is persisted under the existing clear revision in
 * the target, progress command, and runtime command maps before its first send, and a document
 * whose identity changed gets a new keyed target. Enumerating after the frozen batch ran is what
 * finds both, because a moved document answers `changed` and then reappears here under its new key.
 */
export async function clearDiscoveredDocumentsV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  label: string,
): Promise<string | null> {
  // Spec 766: a cleanup that entered before its registration audit sent nothing, so discovery must
  // not invent a first send for a document this cleanup never touched. The exemption is that stage,
  // not an empty batch: a post-audit batch that froze no commands still enumerates, and a closure
  // has no pre-audit stage to exempt.
  if (enteredBeforeAuditV2(ports.runtime(), journal)) return null;
  const classified: TargetClassificationV2[] = await enumerateEnforcementTargetsV2(ports.targets);
  for (const target of classified) {
    if (target.kind !== 'enforceable') continue;
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    // Membership is read before the add, because `durableCleanupClearCommandV2` puts a newly
    // discovered document into the batch, and it is membership before that write which says whether
    // this cleanup ever overlaid the page.
    const saved: CleanupProgress = journalProgressV2(ports.runtime(), journal);
    if (Object.hasOwn(saved.clearCommands, key)) continue;
    const overlaid: boolean = wasOverlaidByThisCleanupV2(saved, key, target.tabId);
    const command: FrozenDocumentCommand = await durableCleanupClearCommandV2(ports, journal, {
      tabId: target.tabId,
      documentId: target.documentId,
      expectedUrl: target.url,
    });
    const failure: string | null = await resetAndClearDocumentV2(
      ports,
      journalProgressV2(ports.runtime(), journal),
      key,
      command,
      label,
      overlaid ? OVERLAID_SEND_POLICY : UNCLAIMED_SEND_POLICY,
    );
    if (failure !== null) return failure;
  }
  return null;
}

/**
 * Whether this cleanup ever put an overlay on the page, which is what makes a missing receiver a
 * clear that did not land rather than nothing to clear.
 *
 * The frozen batch is the first half and the stronger one: for a transition it is exactly the
 * documents its starting and active views addressed, so a document in it was sent an overlay by
 * this session. A tab claim is the second half and is weaker on its own, because
 * `Engine.dropEmptyTabState` deletes a tab's state unless it was muted or stopped, so an overlaid
 * tab can legitimately hold no claim by the time cleanup runs. Either one is enough.
 */
function wasOverlaidByThisCleanupV2(
  progress: CleanupProgress,
  key: string,
  tabId: number,
): boolean {
  if (Object.hasOwn(progress.clearCommands, key)) return true;
  return progress.tabClaims.some((claim: CleanupTabClaim): boolean => claim.tabId === tabId);
}

/** The two `auditEnforcement` answers, which are the failures that precede any send. */
const PRE_AUDIT_FAILURES: ReadonlySet<string> = new Set<string>([
  'website-access-lost',
  'content-registration-failed',
]);

/**
 * Whether this cleanup entered before the registration audit, which spec 766 exempts from every
 * clear. The stage the cleanup came from is the authority: `prepared` is the one stage before the
 * audit, and it covers an abandon that carries no failure at all as well as the two audit answers.
 * Those failures are still read, because a journal that reaches cleanup without recording its
 * source stage would otherwise lose the exemption its failure already proves.
 */
function enteredBeforeAuditV2(runtime: RuntimeStateV2, journal: CleanupJournalV2): boolean {
  if (journal === 'closure') return false;
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition === null) return false;
  if (transition.cleanupFrom === 'prepared') return true;
  const failure: string | null = transition.failure;
  return failure !== null && PRE_AUDIT_FAILURES.has(failure);
}

/**
 * The manual retry both journals run, which is one step: a new operation ID and clear revision
 * replace the batch identity, every frozen command is restamped with them, and the row is persisted.
 *
 * It commits rather than writing, because `assertCleanupBatchAdvance` is written for exactly this
 * replacement and only runs inside a commit. Nothing is flushed: no events, no aggregates, and the
 * bank unchanged.
 */
export async function replaceCleanupBatchAndCommitV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  checkpointOwnerId: string,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  const progress: CleanupProgress = journalProgressV2(runtime, journal);
  const replaced: CleanupProgress = replaceCleanupBatchV2(progress, {
    cleanupOperationId: ports.newId(),
    clearRuntimeRevision: progress.clearRuntimeRevision + 1,
    at: ports.now(),
  });
  const next: RuntimeStateV2 = validatedCleanupRuntimeV2(
    restampedCleanupRowV2(withJournalProgressV2(runtime, journal, replaced), journal, replaced),
  );
  return ports.commit({
    checkpointId: `${checkpointOwnerId}:cleanup-retry-${replaced.retry.batch}`,
    projection: projectRuntimeDomainV2(next),
    bank: ports.bank(),
    events: [],
    syncBank: false,
    aggregateSets: {},
    aggregateRemoves: [],
  });
}

/**
 * The runtime a replacement batch persists. The clear revision is the runtime revision, the command
 * map is the restamped batch, and a transition carries that revision on its own row as well.
 */
function restampedCleanupRowV2(
  runtime: RuntimeStateV2,
  journal: CleanupJournalV2,
  replaced: CleanupProgress,
): RuntimeStateV2 {
  const next: RuntimeStateV2 = {
    ...runtime,
    runtimeRevision: replaced.clearRuntimeRevision,
    documentCommands: structuredClone(replaced.clearCommands),
  };
  if (journal === 'closure') return next;
  const transition: PendingEnforcementTransition | null = next.pendingEnforcementTransition;
  if (transition === null) {
    throw invalidCleanup('a transition cleanup retry needs its cleanup transition');
  }
  return {
    ...next,
    pendingEnforcementTransition: {
      ...transition,
      runtimeRevision: replaced.clearRuntimeRevision,
    },
  };
}

/**
 * A document that navigated while a cleanup batch is durable. It belongs to whichever journal owns
 * that batch, so this dispatches on the durable row rather than on the caller: the controller
 * routes every cleanup navigation here and neither journal is a special case.
 *
 * The target and its frozen clear command are durable before the first send, under the batch's
 * existing operation and clear revision, so a newly found document never outranks the commands
 * already in flight.
 */
export async function handleCleanupNavigationV2(
  ports: RuntimePortsV2,
  target: { tabId: number; documentId: string; url: string },
): Promise<void> {
  if (typeof target.documentId !== 'string' || target.documentId.trim() === '') {
    throw invalidCleanup('a cleanup target needs a document ID');
  }
  const classified: TargetClassificationV2 = classifyEnforcementTargetV2(
    target.tabId,
    target.url,
    target.documentId,
  );
  if (classified.kind !== 'enforceable') return;
  // A runtime with no cleanup batch owns no clear command for this document, so there is nothing
  // to add and nothing to send. That includes a prepared closure, whose session is still running.
  const journal: CleanupJournalV2 | null = cleanupJournalOfV2(ports.runtime());
  if (journal === null) return;
  const key: string = documentCommandKeyV2(classified.tabId, classified.documentId);
  const command: FrozenDocumentCommand = await durableCleanupClearCommandV2(ports, journal, {
    tabId: classified.tabId,
    documentId: classified.documentId,
    expectedUrl: classified.url,
  });
  await resetAndClearDocumentV2(
    ports,
    journalProgressV2(ports.runtime(), journal),
    key,
    command,
    journal,
  );
}

/**
 * Returns the batch's command for this document, adding and persisting it when it is new. This is
 * the one place a document joins a frozen batch, and both ways the worker meets a late document
 * reach it: the navigation push, and a pull from a document that named the URL it is on. Without
 * the second, a document whose only contact with the worker is a pull waits for the journal's
 * runner to enumerate it.
 */
export async function durableCleanupClearCommandV2(
  ports: RuntimePortsV2,
  journal: CleanupJournalV2,
  target: { tabId: number; documentId: string; expectedUrl: string },
): Promise<FrozenDocumentCommand> {
  const key: string = documentCommandKeyV2(target.tabId, target.documentId);
  const runtime: RuntimeStateV2 = ports.runtime();
  const progress: CleanupProgress = journalProgressV2(runtime, journal);
  const known: FrozenDocumentCommand | undefined = progress.clearCommands[key];
  if (known !== undefined) return known;
  const added: CleanupProgress = addCleanupTargetV2(progress, target, {
    enforcementEpoch: runtime.enforcementEpoch,
    basePolicyRevision: runtime.basePolicyRevision,
    ...cleanupClearIdentityV2(runtime, journal),
  });
  const next: RuntimeStateV2 = withJournalProgressV2(runtime, journal, added);
  await ports.writeRuntime(
    validatedCleanupRuntimeV2({
      ...next,
      documentCommands: structuredClone(added.clearCommands),
    }),
  );
  const command: FrozenDocumentCommand | undefined = added.clearCommands[key];
  if (command === undefined) throw invalidCleanup('the cleanup batch lost its new clear command');
  return command;
}

/**
 * The session identity a batch's clear commands carry. A closure closed a durable session, and a
 * transition names the durable one it committed or the reserved one a pre-commit start held.
 */
function cleanupClearIdentityV2(
  runtime: RuntimeStateV2,
  journal: CleanupJournalV2,
): CleanupClearIdentityV2 {
  if (journal === 'closure') {
    const closure: PendingClosure | null = runtime.pendingClosure;
    if (closure === null) throw invalidCleanup('a closure clear needs its closure');
    return { sessionId: closure.projection.sessionId, reservedSessionId: null };
  }
  const transition: PendingEnforcementTransition | null = runtime.pendingEnforcementTransition;
  if (transition === null) throw invalidCleanup('a transition clear needs its transition');
  const durable: boolean = transition.activeView !== null || transition.kind === 'resume';
  return durable
    ? { sessionId: transition.sessionId, reservedSessionId: null }
    : { sessionId: null, reservedSessionId: transition.sessionId };
}

function validatedCleanupRuntimeV2(runtime: RuntimeStateV2): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(
    carryCommitCheckpointProjectionV2(runtime),
  );
  if (parsed === null) throw invalidCleanup('a cleanup step built an invalid runtime');
  return parsed;
}

function invalidCleanup(message: string): CoreError {
  return new CoreError('invalid-rule', message);
}
