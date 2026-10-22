/**
 * Sends one frozen document command over an injected port and turns the document's answer into an
 * exact worker outcome. The worker owns the tab, so `tabId` is stripped before the send and added
 * back only when wrapping an acknowledgement. Each send has a bounded acknowledgement deadline.
 * Nothing here reads a browser API or storage, and a caller owns the reissue policy.
 *
 * This module owns the whole runtime-error vocabulary, so a caller never inspects an error message.
 * The outcomes fall into four classes, each naming one row of the spec's target-classification
 * table, and the resolver that consumes them reads their meaning here:
 *
 * 1. Acknowledged, the Enforceable row. `applied` and `reset` carry an exact acknowledgement built
 *    from the frozen command. Only these two may enter a checkpoint.
 * 2. Closed, the Closed row. `closed` means the tab disappeared during the send. Remove the target
 *    from the set and carry on: this is not fatal.
 * 3. Reevaluate, the Changed row and ordinary protocol drift. `changed` means the document answered
 *    for a URL other than the one this command named, so no acknowledgement is wrapped and the
 *    replacement target belongs to the next pass. `stale` and `reset-required` are runtime drift and
 *    a missing epoch handshake: reread durable runtime and reissue, or reset the epoch first.
 * 4. Unexpectedly unreachable, the fatal row. `no-receiver` is an ordinary enforceable document with
 *    no listener, and `mismatch` is an answer the frozen command cannot explain. Both are
 *    `tab-enforcement-failed` for the caller.
 */

import type {
  ContentEnforcementResponse,
  DocumentContentCommand,
  DocumentEnforcementCommand,
  ResetEnforcementEpochCommand,
} from '../shared/enforcement-v2';
import { parseContentEnforcementResponse } from '../shared/enforcement-v2-validation';
import { exactDataEqual, snapshotExactData } from '../shared/exact-data';
import type {
  DocumentEnforcementAck,
  DocumentEpochResetAck,
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from './enforcement-persistence-v2';
import {
  validateDetachedDocumentEnforcementAck,
  validateDetachedDocumentEpochResetAck,
} from './enforcement-persistence-v2-validation';

type AppliedResponse = Extract<ContentEnforcementResponse, { disposition: 'applied' }>;
type StaleCommandResponse = Extract<ContentEnforcementResponse, { disposition: 'stale-command' }>;
type ResetRequiredResponse = Extract<ContentEnforcementResponse, { disposition: 'reset-required' }>;
type EpochResetResponse = Extract<ContentEnforcementResponse, { disposition: 'epoch-reset' }>;
type EpochResetRejectedResponse = Extract<
  ContentEnforcementResponse,
  { disposition: 'epoch-reset-rejected' }
>;

export interface ContentTransportPortsV2 {
  sendToDocument(
    tabId: number,
    documentId: string,
    message: DocumentContentCommand,
  ): Promise<unknown>;
}

export type DocumentCommandOutcomeV2 =
  | { kind: 'applied'; ack: DocumentEnforcementAck }
  | { kind: 'stale'; response: StaleCommandResponse }
  | { kind: 'reset-required'; currentEpoch: string | null }
  | { kind: 'changed'; observedUrl: string }
  | { kind: 'closed' }
  | { kind: 'no-receiver' }
  /** The document did not answer within the deadline, so it is asked again on the next pass. */
  | { kind: 'unresponsive' }
  | { kind: 'mismatch'; detail: string; field: string | null };

export type EpochResetOutcomeV2 =
  | { kind: 'reset'; ack: DocumentEpochResetAck }
  | { kind: 'rejected'; currentEpoch: string }
  | { kind: 'closed' }
  | { kind: 'no-receiver' }
  | { kind: 'unresponsive' }
  /** `field` names the one echoed field that differed, when exactly one did. */
  | { kind: 'mismatch'; detail: string; field: string | null };

/** A send failure classifies the target itself, so both senders share these four answers. */
type SendFailureOutcomeV2 =
  | { kind: 'closed' }
  | { kind: 'no-receiver' }
  | { kind: 'unresponsive' }
  | { kind: 'mismatch'; detail: string; field: string | null };

/** The runtime's answer when a document has no listener at all. */
const NO_RECEIVER_MESSAGES: readonly string[] = [
  'Could not establish connection',
  'Receiving end does not exist',
];
/**
 * The runtime's answer when the target went away mid-send. The first two are the strings v1 already
 * treats as ignorable in `isIgnorableInjectionFailure`, and the third is what a document torn down
 * while the send is in flight produces.
 */
const CLOSED_TARGET_MESSAGES: readonly string[] = [
  'No tab with id',
  'The tab was closed',
  'The message port closed before a response was received',
];
const REJECTED_DETAIL: string = 'the document rejected the command and answered nothing';
const UNPARSABLE_DETAIL: string = 'the answer is not an exact content enforcement response';
// Leave room for reset and apply within the transition runner's ten-second freshness budget.
const DOCUMENT_ACK_TIMEOUT_MS: number = 2_000;
const DEADLINE_MESSAGE: string = 'document acknowledgement deadline exceeded';

/** A late settlement is consumed but cannot become an acknowledgement after the deadline. */
async function boundedSend(
  ports: ContentTransportPortsV2,
  tabId: number,
  documentId: string,
  message: DocumentContentCommand,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject): void => {
        timer = setTimeout((): void => {
          reject(new Error(DEADLINE_MESSAGE));
        }, DOCUMENT_ACK_TIMEOUT_MS);
      }),
      ports.sendToDocument(tabId, documentId, message),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * True only for the runtime's missing-receiver family. Every other rejection, a closed tab
 * included, stays a reported mismatch so the caller can decide what it means for its target.
 */
export function isNoReceiverError(error: unknown): boolean {
  return hasAnyFragment(errorText(error), NO_RECEIVER_MESSAGES);
}

/**
 * Applies one frozen enforcement command to its document. Only an answer that echoes every field
 * of the command, including the frozen verdict and view, becomes an acknowledgement. A stale or
 * reset answer is reported as itself and never wrapped.
 */
export async function sendDocumentEnforcementCommand(
  ports: ContentTransportPortsV2,
  command: FrozenDocumentCommand,
): Promise<DocumentCommandOutcomeV2> {
  let raw: unknown;
  try {
    raw = await boundedSend(ports, command.tabId, command.documentId, wireCommand(command));
  } catch (error: unknown) {
    return sendFailureOutcome(error);
  }
  const response: ContentEnforcementResponse | null = parseContentEnforcementResponse(raw);
  if (response === null) {
    return {
      kind: 'mismatch',
      field: null,
      detail: raw === undefined ? REJECTED_DETAIL : UNPARSABLE_DETAIL,
    };
  }
  if (response.disposition === 'applied') return appliedOutcome(command, response);
  if (response.disposition === 'stale-command') return staleOutcome(command, response);
  if (response.disposition === 'reset-required') return resetRequiredOutcome(command, response);
  return unexpectedDisposition(response.disposition, 'apply-enforcement');
}

/**
 * Runs the epoch handshake for one document. Only an exact `epoch-reset` is wrapped. A retired
 * epoch is reported with the epoch the document keeps, so the caller can stop rolling it back.
 */
export async function sendEpochResetCommand(
  ports: ContentTransportPortsV2,
  command: FrozenEpochResetCommand,
): Promise<EpochResetOutcomeV2> {
  let raw: unknown;
  try {
    raw = await boundedSend(ports, command.tabId, command.documentId, wireResetCommand(command));
  } catch (error: unknown) {
    return sendFailureOutcome(error);
  }
  const response: ContentEnforcementResponse | null = parseContentEnforcementResponse(raw);
  if (response === null) {
    return {
      kind: 'mismatch',
      field: null,
      detail: raw === undefined ? REJECTED_DETAIL : UNPARSABLE_DETAIL,
    };
  }
  if (response.disposition === 'epoch-reset') return epochResetOutcome(command, response);
  if (response.disposition === 'epoch-reset-rejected') {
    return rejectedEpochOutcome(command, response);
  }
  return unexpectedDisposition(response.disposition, 'reset-enforcement-epoch');
}

/** The worker owns the tab target, so the wire command never carries it. */
function wireCommand(command: FrozenDocumentCommand): DocumentEnforcementCommand {
  const { tabId: _tabId, ...wire }: FrozenDocumentCommand = command;
  return wire;
}

function wireResetCommand(command: FrozenEpochResetCommand): ResetEnforcementEpochCommand {
  const { tabId: _tabId, ...wire }: FrozenEpochResetCommand = command;
  return wire;
}

function appliedOutcome(
  command: FrozenDocumentCommand,
  response: AppliedResponse,
): DocumentCommandOutcomeV2 {
  const field: string | null = appliedMismatchField(command, response);
  if (field !== null) return fieldMismatch(response.disposition, field);
  // An otherwise exact answer for another URL is a target that navigated, not a broken document.
  if (response.observedUrl !== command.expectedUrl) {
    return { kind: 'changed', observedUrl: response.observedUrl };
  }
  const ack: unknown = snapshotExactData({
    version: 1,
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    sessionId: command.sessionId,
    reservedSessionId: command.reservedSessionId,
    basePolicyRevision: command.basePolicyRevision,
    runtimeRevision: command.runtimeRevision,
    tabId: command.tabId,
    documentId: command.documentId,
    url: command.expectedUrl,
    verdict: command.verdict,
    handledAt: response.handledAt,
  })?.value;
  if (!validateDetachedDocumentEnforcementAck(ack)) {
    return { kind: 'mismatch', field: null, detail: ackContractDetail('applied') };
  }
  return { kind: 'applied', ack };
}

/**
 * The first field of the command the response failed to echo, or null when the answer is exact.
 * Verdict and view are compared structurally against the frozen operation-time values. The observed
 * URL is deliberately absent: a document that navigated is the Changed row, not a mismatch.
 */
function appliedMismatchField(
  command: FrozenDocumentCommand,
  response: AppliedResponse,
): string | null {
  if (response.operationId !== command.operationId) return 'operationId';
  if (response.enforcementEpoch !== command.enforcementEpoch) return 'enforcementEpoch';
  if (response.sessionId !== command.sessionId) return 'sessionId';
  if (response.reservedSessionId !== command.reservedSessionId) return 'reservedSessionId';
  if (response.basePolicyRevision !== command.basePolicyRevision) return 'basePolicyRevision';
  if (response.runtimeRevision !== command.runtimeRevision) return 'runtimeRevision';
  if (response.documentId !== command.documentId) return 'documentId';
  if (response.presentation !== command.presentation) return 'presentation';
  if (!exactDataEqual(response.verdict, command.verdict)) return 'verdict';
  if (!exactDataEqual(response.overlay, command.overlay)) return 'overlay';
  return null;
}

/** A stale answer is drift, never an acknowledgement, but it must still be about what was sent. */
function staleOutcome(
  command: FrozenDocumentCommand,
  response: StaleCommandResponse,
): DocumentCommandOutcomeV2 {
  const echoed: string | null = echoedCommandField(command, response);
  if (echoed !== null) return fieldMismatch(response.disposition, echoed);
  const sent: StaleCommandResponse['requested'] = {
    enforcementEpoch: command.enforcementEpoch,
    sessionId: command.sessionId,
    reservedSessionId: command.reservedSessionId,
    basePolicyRevision: command.basePolicyRevision,
    runtimeRevision: command.runtimeRevision,
  };
  return exactDataEqual(response.requested, sent)
    ? { kind: 'stale', response }
    : fieldMismatch(response.disposition, 'requested tuple');
}

/**
 * A reset-required answer sends this document back through the handshake, so it must be about the
 * command that was handed to it. The observed URL is deliberately not compared: a document that
 * answered for another URL is the Changed row, which only an applied answer can report.
 */
function resetRequiredOutcome(
  command: FrozenDocumentCommand,
  response: ResetRequiredResponse,
): DocumentCommandOutcomeV2 {
  const echoed: string | null = echoedCommandField(command, response);
  if (echoed !== null) return fieldMismatch(response.disposition, echoed);
  return response.requestedEpoch === command.enforcementEpoch
    ? { kind: 'reset-required', currentEpoch: response.currentEpoch }
    : fieldMismatch(response.disposition, 'requestedEpoch');
}

/**
 * The identity fields every disposition echoes from the command it answered. An answer about a
 * different operation or document is evidence about something else, whatever it claims. The epoch
 * is left to each disposition's own comparison, which the response validator already ties to the
 * echoed `enforcementEpoch`.
 */
function echoedCommandField(
  command: FrozenDocumentCommand,
  response: StaleCommandResponse | ResetRequiredResponse,
): string | null {
  if (response.operationId !== command.operationId) return 'operationId';
  if (response.documentId !== command.documentId) return 'documentId';
  return null;
}

function epochResetOutcome(
  command: FrozenEpochResetCommand,
  response: EpochResetResponse,
): EpochResetOutcomeV2 {
  const field: string | null = resetMismatchField(command, response);
  if (field !== null) return fieldMismatch(response.disposition, field);
  const ack: unknown = snapshotExactData({
    version: 1,
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    tabId: command.tabId,
    documentId: command.documentId,
    url: command.expectedUrl,
    handledAt: response.handledAt,
  })?.value;
  if (!validateDetachedDocumentEpochResetAck(ack)) {
    return { kind: 'mismatch', field: null, detail: ackContractDetail('epoch-reset') };
  }
  return { kind: 'reset', ack };
}

function rejectedEpochOutcome(
  command: FrozenEpochResetCommand,
  response: EpochResetRejectedResponse,
): EpochResetOutcomeV2 {
  const field: string | null = resetMismatchField(command, response);
  if (field !== null) return fieldMismatch(response.disposition, field);
  return { kind: 'rejected', currentEpoch: response.currentEpoch };
}

/** The fields a document can only know from the reset command it was handed. */
function resetMismatchField(
  command: FrozenEpochResetCommand,
  response: EpochResetResponse | EpochResetRejectedResponse,
): string | null {
  if (response.operationId !== command.operationId) return 'operationId';
  if (response.enforcementEpoch !== command.enforcementEpoch) return 'enforcementEpoch';
  if (response.documentId !== command.documentId) return 'documentId';
  if (response.observedUrl !== command.expectedUrl) return 'observedUrl';
  return null;
}

function fieldMismatch(
  disposition: string,
  field: string,
): { kind: 'mismatch'; detail: string; field: string } {
  return {
    kind: 'mismatch',
    field,
    detail: `${disposition} answer: ${field} does not match the sent command`,
  };
}

function unexpectedDisposition(
  disposition: string,
  command: string,
): { kind: 'mismatch'; detail: string; field: null } {
  return {
    kind: 'mismatch',
    field: null,
    detail: `unexpected ${disposition} answer to the ${command} command`,
  };
}

function ackContractDetail(disposition: string): string {
  return `${disposition} answer does not wrap into an exact acknowledgement`;
}

/**
 * Classifies a rejected send. A missing listener, a vanished tab and a document too busy to answer
 * before the deadline are different target rows, so none is reported as a mismatch: only an error
 * this module cannot name is fatal. A slow page is not a broken one.
 */
function sendFailureOutcome(error: unknown): SendFailureOutcomeV2 {
  const message: string = errorText(error);
  if (message === DEADLINE_MESSAGE) return { kind: 'unresponsive' };
  if (hasAnyFragment(message, NO_RECEIVER_MESSAGES)) return { kind: 'no-receiver' };
  if (hasAnyFragment(message, CLOSED_TARGET_MESSAGES)) return { kind: 'closed' };
  return { kind: 'mismatch', field: null, detail: message };
}

function hasAnyFragment(message: string, fragments: readonly string[]): boolean {
  return fragments.some((fragment: string): boolean => message.includes(fragment));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
