/**
 * Enumerates enforcement targets, drives one bounded stabilization sweep over them, and bounds the
 * final freshness attempt. Every browser fact arrives through injected ports and every command
 * through an injected driver, so this module holds no chrome API, no clock, and no storage. It
 * never writes runtime state: the durable candidate checkpoint and its generation reread belong to
 * the transition runner, and a sweep never touches attempt accounting.
 */

import { MAX_FINAL_FRESHNESS_ATTEMPTS } from '../shared/constants';
import { isKnownUnsupportedUrlV2 } from '../shared/enforcement-v2-validation';
import { isNonBlankString, isNonNegativeInteger, isRecord } from '../shared/v2-domain-intrinsics';
import { documentCommandKeyV2 } from './cleanup-progress-v2';
import {
  type ContentTransportPortsV2,
  type DocumentCommandOutcomeV2,
  type EpochResetOutcomeV2,
  sendDocumentEnforcementCommand,
  sendEpochResetCommand,
} from './content-transport-v2';
import type {
  DocumentEnforcementAck,
  DocumentEpochResetAck,
  EnforcementTargetExclusion,
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from './enforcement-persistence-v2';

/** One sweep reaches a stable enforceable set within this many complete passes, or it is fatal. */
export const MAX_TARGET_RESOLVER_PASSES: number = 3;
export { MAX_FINAL_FRESHNESS_ATTEMPTS };
export const FINAL_FRESHNESS_TIMEOUT_MS: number = 10_000;

const HTTP_PREFIXES: readonly string[] = ['http://', 'https://'];

export interface EnforcementTargetPortsV2 {
  queryTopFrameTabs(): Promise<Array<{ tabId: number; url: string | null }>>;
  topFrameDocumentId(tabId: number): Promise<string | null>;
  readTargetGeneration(): number;
  now(): number;
  /**
   * Puts the enforcement script into one document and answers whether Chrome permits it at all.
   *
   * A document with no listener is one of two things, and only trying tells them apart: an
   * ordinary page whose script has not reached it yet, which is every tab that was already open
   * when the extension was installed or reloaded, or a document Chrome refuses to script, such as
   * a frame showing a network error page. The first is recoverable and the second is not, and
   * treating both as fatal is what made one dead tab refuse every session start.
   */
  ensureDocumentScript(tabId: number): Promise<'ready' | 'unscriptable'>;
}

export type TargetClassificationV2 =
  | { kind: 'enforceable'; tabId: number; documentId: string; url: string }
  | { kind: 'known-unsupported'; tabId: number; documentId: string | null; url: string }
  /** An HTTP(S) document Chrome refuses to script, learned by trying rather than by its URL. */
  | { kind: 'unscriptable'; tabId: number; documentId: string; url: string }
  | { kind: 'changed'; tabId: number; url: string; documentId: null }
  | { kind: 'outside'; tabId: number };

type EnforceableTargetV2 = Extract<TargetClassificationV2, { kind: 'enforceable' }>;

export interface SweepDriverV2 {
  commandFor(target: EnforceableTargetV2): Promise<FrozenDocumentCommand>;
  resetFor(target: EnforceableTargetV2): Promise<FrozenEpochResetCommand>;
  hasEpochAck(tabId: number, documentId: string): boolean;
  recordEpochAck(ack: DocumentEpochResetAck): Promise<void>;
  onStale(target: EnforceableTargetV2): Promise<FrozenDocumentCommand>;
  transport: ContentTransportPortsV2;
}

export type EnforcementPassResultV2 =
  | {
      kind: 'stable';
      documents: DocumentEnforcementAck[];
      exclusions: EnforcementTargetExclusion[];
      generation: number;
    }
  | { kind: 'unreachable'; detail: string };

export interface FreshnessBudgetV2 {
  verificationStartedAt: number;
  freshnessAttempts: number;
}

export type FreshnessAttemptResultV2 =
  | {
      kind: 'verified';
      documents: DocumentEnforcementAck[];
      exclusions: EnforcementTargetExclusion[];
      generation: number;
      completedAt: number;
    }
  | { kind: 'generation-changed' }
  | { kind: 'deadline' }
  | { kind: 'unreachable'; detail: string };

/**
 * One target's answer. `skipped` is the transport's Closed and Changed rows: no acknowledgement,
 * no failure, and the reread at the end of the pass decides whether the target is gone or replaced.
 */
type TargetOutcomeV2 =
  | { kind: 'acknowledged'; ack: DocumentEnforcementAck }
  | { kind: 'skipped' }
  /** Chrome refuses to script this document, so it is recorded as excluded rather than enforced. */
  | { kind: 'unscriptable' }
  | { kind: 'unreachable'; detail: string; missingReceiver: boolean };

/** The command answers that end the sweep. Closed and Changed are handled before this point. */
type FatalCommandOutcomeV2 = Extract<
  DocumentCommandOutcomeV2,
  { kind: 'stale' | 'reset-required' | 'no-receiver' | 'mismatch' }
>;
type FatalResetOutcomeV2 = Extract<
  EpochResetOutcomeV2,
  { kind: 'rejected' | 'no-receiver' | 'mismatch' }
>;

export { isKnownUnsupportedUrlV2 };

/** True for a top-frame HTTP(S) URL the registered content script is allowed to run in. */
export function isEnforceableHttpUrlV2(url: string): boolean {
  return hasAnyPrefix(url, HTTP_PREFIXES) && !isKnownUnsupportedUrlV2(url);
}

/**
 * Classifies one enumerated tab. A URL that is not a string at all is outside, so a hostile URL is
 * never read past its type. An HTTP(S) tab with no top-frame document yet is Changed, which is
 * retryable within the pass budget rather than a failure of its own.
 */
export function classifyEnforcementTargetV2(
  tabId: number,
  url: string | null,
  documentId: string | null,
): TargetClassificationV2 {
  if (typeof url !== 'string' || !hasAnyPrefix(url, HTTP_PREFIXES))
    return { kind: 'outside', tabId };
  if (isKnownUnsupportedUrlV2(url)) {
    return {
      kind: 'known-unsupported',
      tabId,
      documentId: isNonBlankString(documentId) ? documentId : null,
      url,
    };
  }
  if (!isNonBlankString(documentId)) return { kind: 'changed', tabId, url, documentId: null };
  return { kind: 'enforceable', tabId, documentId, url };
}

/**
 * Reads the current top-frame tabs and classifies each one. A row that cannot name a tab is not a
 * target at all and is skipped, and a document-ID read that throws leaves that tab pending for
 * this pass rather than failing the sweep.
 */
export async function enumerateEnforcementTargetsV2(
  ports: EnforcementTargetPortsV2,
): Promise<TargetClassificationV2[]> {
  const rows: unknown = await ports.queryTopFrameTabs();
  if (!Array.isArray(rows)) return [];
  const targets: TargetClassificationV2[] = [];
  for (const row of rows) {
    if (!isRecord(row) || !isNonNegativeInteger(row.tabId)) continue;
    const tabId: number = row.tabId;
    const url: string | null = typeof row.url === 'string' ? row.url : null;
    // The classifier owns what "outside" means. A tab outside the target set is never asked for a
    // document, so a hostile URL is classified on its type and read no further.
    const outside: TargetClassificationV2 = classifyEnforcementTargetV2(tabId, url, null);
    if (outside.kind === 'outside' || url === null) {
      targets.push(outside);
      continue;
    }
    targets.push(classifyEnforcementTargetV2(tabId, url, await documentIdOf(ports, tabId)));
  }
  return targets;
}

/**
 * Runs one bounded stabilization sweep. Each pass applies the driver's frozen command to every
 * enforceable target, then rereads the target set and decides stability from that reread alone. A
 * closed target simply disappears from the reread and is dropped.
 */
export async function runEnforcementPassV2(
  ports: EnforcementTargetPortsV2,
  driver: SweepDriverV2,
): Promise<EnforcementPassResultV2> {
  let pending: TargetClassificationV2[] = [];
  // Tabs this sweep has learned Chrome will not script. They are excluded for the rest of it, so
  // neither the sends nor the stability reread asks them for an acknowledgement they cannot give.
  const unscriptable: Set<number> = new Set<number>();
  for (let pass: number = 0; pass < MAX_TARGET_RESOLVER_PASSES; pass++) {
    const acknowledged: Map<string, DocumentEnforcementAck> = new Map<
      string,
      DocumentEnforcementAck
    >();
    const targets: TargetClassificationV2[] = excludingUnscriptable(
      await enumerateEnforcementTargetsV2(ports),
      unscriptable,
    );
    for (const target of enforceableOf(targets)) {
      const outcome: TargetOutcomeV2 = await applyToTargetWithRecoveryV2(ports, driver, target);
      if (outcome.kind === 'unreachable') return { kind: 'unreachable', detail: outcome.detail };
      if (outcome.kind === 'unscriptable') {
        unscriptable.add(target.tabId);
        continue;
      }
      if (outcome.kind === 'acknowledged') acknowledged.set(targetKey(target), outcome.ack);
    }
    const current: TargetClassificationV2[] = excludingUnscriptable(
      await enumerateEnforcementTargetsV2(ports),
      unscriptable,
    );
    pending = current.filter(
      (target: TargetClassificationV2): boolean => target.kind === 'changed',
    );
    const documents: DocumentEnforcementAck[] | null =
      pending.length === 0 ? settledDocumentsV2(current, acknowledged) : null;
    if (documents !== null) {
      return {
        kind: 'stable',
        documents,
        exclusions: exclusionsOf(current),
        generation: ports.readTargetGeneration(),
      };
    }
  }
  return { kind: 'unreachable', detail: unstableDetail(pending) };
}

/** The budget for one final freshness attempt: at most three attempts inside ten seconds. */
export function freshnessBudgetPermitsV2(budget: FreshnessBudgetV2, now: number): boolean {
  if (budget.freshnessAttempts >= MAX_FINAL_FRESHNESS_ATTEMPTS) return false;
  return now < budget.verificationStartedAt + FINAL_FRESHNESS_TIMEOUT_MS;
}

/**
 * One freshness attempt: two consecutive stable passes under one unchanged target generation. The
 * generation is read before the first pass, and the attempt fails the moment a pass ends on a
 * different generation, the generation moves between the passes, or the budget stops permitting.
 */
export async function runFreshnessAttemptV2(
  ports: EnforcementTargetPortsV2,
  driver: SweepDriverV2,
  budget: FreshnessBudgetV2,
): Promise<FreshnessAttemptResultV2> {
  if (!freshnessBudgetPermitsV2(budget, ports.now())) return { kind: 'deadline' };
  const generation: number = ports.readTargetGeneration();
  const first: EnforcementPassResultV2 = await runEnforcementPassV2(ports, driver);
  if (first.kind === 'unreachable') return first;
  if (first.generation !== generation) return { kind: 'generation-changed' };
  if (!freshnessBudgetPermitsV2(budget, ports.now())) return { kind: 'deadline' };
  if (ports.readTargetGeneration() !== generation) return { kind: 'generation-changed' };
  const second: EnforcementPassResultV2 = await runEnforcementPassV2(ports, driver);
  if (second.kind === 'unreachable') return second;
  if (second.generation !== generation) return { kind: 'generation-changed' };
  const completedAt: number = ports.now();
  if (!freshnessBudgetPermitsV2(budget, completedAt)) return { kind: 'deadline' };
  return {
    kind: 'verified',
    documents: second.documents,
    exclusions: second.exclusions,
    generation,
    completedAt,
  };
}

/** Reclassifies the targets this sweep has already found unscriptable, so nothing asks them again. */
function excludingUnscriptable(
  targets: readonly TargetClassificationV2[],
  unscriptable: ReadonlySet<number>,
): TargetClassificationV2[] {
  return targets.map(
    (target: TargetClassificationV2): TargetClassificationV2 =>
      target.kind === 'enforceable' && unscriptable.has(target.tabId)
        ? {
            kind: 'unscriptable',
            tabId: target.tabId,
            documentId: target.documentId,
            url: target.url,
          }
        : target,
  );
}

/**
 * One document's turn, with the one recovery a missing listener allows.
 *
 * A document that answers nothing gets the script put into it and the whole turn again. Chrome
 * either permits that, in which case silence the second time is a page this session cannot
 * enforce and stays fatal, or refuses it, in which case the document is excluded. Only a missing
 * listener is retried: a mismatch is an answer the frozen command cannot explain, and no amount
 * of injecting changes that.
 */
async function applyToTargetWithRecoveryV2(
  ports: EnforcementTargetPortsV2,
  driver: SweepDriverV2,
  target: EnforceableTargetV2,
): Promise<TargetOutcomeV2> {
  const first: TargetOutcomeV2 = await applyToTargetV2(driver, target);
  if (first.kind !== 'unreachable' || !first.missingReceiver) return first;
  const state: 'ready' | 'unscriptable' = await ports.ensureDocumentScript(target.tabId);
  if (state === 'unscriptable') return { kind: 'unscriptable' };
  return await applyToTargetV2(driver, target);
}

/**
 * Applies one frozen command to one enforceable document. The epoch handshake comes first for a
 * document that has never acknowledged this epoch, and its acknowledgement is recorded before the
 * enforcement command is sent. A document that answers stale gets the driver's replacement once,
 * and a document that asks for a reset gets the handshake and the same frozen command again.
 */
async function applyToTargetV2(
  driver: SweepDriverV2,
  target: EnforceableTargetV2,
): Promise<TargetOutcomeV2> {
  if (!driver.hasEpochAck(target.tabId, target.documentId)) {
    const handshake: TargetOutcomeV2 | null = await runEpochHandshakeV2(driver, target);
    if (handshake !== null) return handshake;
  }
  const command: FrozenDocumentCommand = await driver.commandFor(target);
  let outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
    driver.transport,
    command,
  );
  if (outcome.kind === 'reset-required') {
    const handshake: TargetOutcomeV2 | null = await runEpochHandshakeV2(driver, target);
    if (handshake !== null) return handshake;
    outcome = await sendDocumentEnforcementCommand(driver.transport, command);
  }
  if (outcome.kind === 'stale') {
    const replacement: FrozenDocumentCommand = await driver.onStale(target);
    outcome = await sendDocumentEnforcementCommand(driver.transport, replacement);
  }
  if (outcome.kind === 'applied') return { kind: 'acknowledged', ack: outcome.ack };
  if (outcome.kind === 'closed' || outcome.kind === 'changed') return { kind: 'skipped' };
  return unreachableTarget(target, commandFailureDetail(outcome), outcome.kind === 'no-receiver');
}

/** Returns null when the document acknowledged the epoch, or the fatal outcome that stopped it. */
async function runEpochHandshakeV2(
  driver: SweepDriverV2,
  target: EnforceableTargetV2,
): Promise<TargetOutcomeV2 | null> {
  const reset: FrozenEpochResetCommand = await driver.resetFor(target);
  const outcome: EpochResetOutcomeV2 = await sendEpochResetCommand(driver.transport, reset);
  if (outcome.kind === 'reset') {
    await driver.recordEpochAck(outcome.ack);
    return null;
  }
  if (outcome.kind === 'closed') return { kind: 'skipped' };
  return unreachableTarget(target, resetFailureDetail(outcome), outcome.kind === 'no-receiver');
}

function commandFailureDetail(outcome: FatalCommandOutcomeV2): string {
  if (outcome.kind === 'no-receiver') return 'has no enforcement receiver';
  if (outcome.kind === 'mismatch') return outcome.detail;
  if (outcome.kind === 'stale') return 'kept a newer tuple than the replacement command';
  return 'still requires an epoch reset after the handshake';
}

function resetFailureDetail(outcome: FatalResetOutcomeV2): string {
  if (outcome.kind === 'no-receiver') return 'has no enforcement receiver for the epoch reset';
  if (outcome.kind === 'mismatch') return outcome.detail;
  return `keeps the retired epoch ${outcome.currentEpoch}`;
}

function unreachableTarget(
  target: EnforceableTargetV2,
  detail: string,
  missingReceiver: boolean,
): TargetOutcomeV2 {
  return {
    kind: 'unreachable',
    detail: `tab ${target.tabId} document ${target.documentId}: ${detail}`,
    missingReceiver,
  };
}

/**
 * A tab still waiting for its top-frame document after the last pass is the spec's named fatal
 * case, so it is reported by name. Anything else is a target set that would not hold still.
 */
function unstableDetail(pending: readonly TargetClassificationV2[]): string {
  const passes: string = `${MAX_TARGET_RESOLVER_PASSES} target passes`;
  const first: TargetClassificationV2 | undefined = pending[0];
  if (first === undefined) return `the enforceable target set did not stabilize in ${passes}`;
  return `tab ${first.tabId} has no top-frame document after ${passes}`;
}

/**
 * The acknowledgements that make this pass stable, or null when it is not. Every then-current
 * enforceable target must carry an acknowledgement from this pass for the URL it still shows: a
 * document that kept its ID but moved its URL is a Changed target, and its acknowledgement attests
 * a verdict computed for a page this tab has left. The whole set must also attest one operation,
 * base revision, and runtime revision, which is the rest of the spec's success condition.
 */
function settledDocumentsV2(
  current: readonly TargetClassificationV2[],
  acknowledged: ReadonlyMap<string, DocumentEnforcementAck>,
): DocumentEnforcementAck[] | null {
  const documents: DocumentEnforcementAck[] = [];
  for (const target of enforceableOf(current)) {
    const ack: DocumentEnforcementAck | undefined = acknowledged.get(targetKey(target));
    if (ack === undefined || ack.url !== target.url) return null;
    documents.push(ack);
  }
  return hasOneVerificationIdentityV2(documents) ? documents : null;
}

/** One stable pass attests one operation, base revision, and runtime revision across its set. */
function hasOneVerificationIdentityV2(documents: readonly DocumentEnforcementAck[]): boolean {
  const first: DocumentEnforcementAck | undefined = documents[0];
  if (first === undefined) return true;
  return documents.every(
    (ack: DocumentEnforcementAck): boolean =>
      ack.operationId === first.operationId &&
      ack.basePolicyRevision === first.basePolicyRevision &&
      ack.runtimeRevision === first.runtimeRevision,
  );
}

function enforceableOf(targets: readonly TargetClassificationV2[]): EnforceableTargetV2[] {
  return targets.filter(
    (target: TargetClassificationV2): target is EnforceableTargetV2 =>
      target.kind === 'enforceable',
  );
}

/** Targets that never receive a command are recorded honestly, with the reason they were left out. */
function exclusionsOf(targets: readonly TargetClassificationV2[]): EnforcementTargetExclusion[] {
  const exclusions: EnforcementTargetExclusion[] = [];
  for (const target of targets) {
    if (target.kind !== 'known-unsupported' && target.kind !== 'unscriptable') continue;
    exclusions.push({
      tabId: target.tabId,
      documentId: target.documentId,
      url: target.url,
      reason: target.kind,
    });
  }
  return exclusions;
}

async function documentIdOf(
  ports: EnforcementTargetPortsV2,
  tabId: number,
): Promise<string | null> {
  try {
    return await ports.topFrameDocumentId(tabId);
  } catch {
    // A tab that is navigating or closing cannot answer. It stays pending for this pass.
    return null;
  }
}

function targetKey(target: EnforceableTargetV2): string {
  return documentCommandKeyV2(target.tabId, target.documentId);
}

function hasAnyPrefix(url: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix: string): boolean => url.startsWith(prefix));
}
