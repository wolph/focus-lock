import {
  canonicalSessionIdentity,
  isKnownUnsupportedUrlV2,
  parseResetEnforcementEpochCommand,
  validateDetachedDocumentEnforcementCommandFields,
  validateDetachedVerdict,
} from '../shared/enforcement-v2-validation';
import { snapshotExactData } from '../shared/exact-data';
import {
  everyDenseEntry,
  exactRecord,
  isNonBlankString,
  isNonNegativeInteger,
  isRecord,
  isSafeTimestamp,
  isUuid,
} from '../shared/v2-domain-intrinsics';
import type {
  DocumentEnforcementAck,
  DocumentEnforcementAckRecord,
  DocumentEpochResetAck,
  EnforcementCheckpoint,
  EnforcementTargetExclusion,
  EpochResetAckRecord,
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from './enforcement-persistence-v2';

type UnknownRecord = Record<string, unknown>;

/** Operation-time authority every acknowledgement in one checkpoint must match. */
interface CheckpointHeader {
  operationId: string;
  enforcementEpoch: string;
  sessionId: string;
  basePolicyRevision: number;
}

/** The wire command keys plus the worker-owned tab authority this file adds. */
const FROZEN_COMMAND_KEYS: readonly string[] = [
  'version',
  'command',
  'operationId',
  'enforcementEpoch',
  'sessionId',
  'reservedSessionId',
  'basePolicyRevision',
  'runtimeRevision',
  'documentId',
  'expectedUrl',
  'presentation',
  'verdict',
  'overlay',
  'tabId',
];
const ENFORCEMENT_ACK_KEYS: readonly string[] = [
  'version',
  'operationId',
  'enforcementEpoch',
  'sessionId',
  'reservedSessionId',
  'basePolicyRevision',
  'runtimeRevision',
  'tabId',
  'documentId',
  'url',
  'verdict',
  'handledAt',
];
/** The checkpoint's record is the acknowledgement without the page address the transport echoed. */
const ENFORCEMENT_ACK_RECORD_KEYS: readonly string[] = [
  'version',
  'operationId',
  'enforcementEpoch',
  'sessionId',
  'reservedSessionId',
  'basePolicyRevision',
  'runtimeRevision',
  'tabId',
  'documentId',
  'verdict',
  'handledAt',
];
const EPOCH_RESET_ACK_KEYS: readonly string[] = [
  'version',
  'operationId',
  'enforcementEpoch',
  'tabId',
  'documentId',
  'url',
  'handledAt',
];
/** The stored record is the acknowledgement without the page address the transport echoed. */
const EPOCH_RESET_ACK_RECORD_KEYS: readonly string[] = [
  'version',
  'operationId',
  'enforcementEpoch',
  'tabId',
  'documentId',
  'handledAt',
];
const EXCLUSION_KEYS: readonly string[] = ['tabId', 'documentId', 'url', 'reason'];
const CHECKPOINT_KEYS: readonly string[] = [
  'version',
  'operationId',
  'enforcementEpoch',
  'sessionId',
  'basePolicyRevision',
  'kind',
  'registrationAuditedAt',
  'completedAt',
  'targetGeneration',
  'documents',
  'exclusions',
];
const CHECKPOINT_KINDS: ReadonlySet<string> = new Set<string>([
  'activation',
  'recovery',
  'resume-strengthening',
]);

export function parseFrozenDocumentCommand(value: unknown): FrozenDocumentCommand | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedFrozenDocumentCommand(snapshot) ? snapshot : null;
}

export function parseDocumentEnforcementAck(value: unknown): DocumentEnforcementAck | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedDocumentEnforcementAck(snapshot) ? snapshot : null;
}

export function parseDocumentEnforcementAckRecord(
  value: unknown,
): DocumentEnforcementAckRecord | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedDocumentEnforcementAckRecord(snapshot) ? snapshot : null;
}

export function parseDocumentEpochResetAck(value: unknown): DocumentEpochResetAck | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedDocumentEpochResetAck(snapshot) ? snapshot : null;
}

export function parseEpochResetAckRecord(value: unknown): EpochResetAckRecord | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedEpochResetAckRecord(snapshot) ? snapshot : null;
}

export function parseEnforcementTargetExclusion(value: unknown): EnforcementTargetExclusion | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedEnforcementTargetExclusion(snapshot) ? snapshot : null;
}

export function parseEnforcementCheckpoint(value: unknown): EnforcementCheckpoint | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedEnforcementCheckpoint(snapshot) ? snapshot : null;
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. The frozen record owns the
 * wider key set, so the exact-key check happens here before the shared command fields are checked.
 */
/**
 * A frozen reset command is the shared wire command plus the worker-owned tab, so the shared parser
 * checks every wire field and only the tab is added here. Both the overlay builder and the all-data
 * journal validate this shape, so it has one definition rather than a private copy in each.
 */
export function validateDetachedFrozenEpochResetCommand(
  value: unknown,
): value is FrozenEpochResetCommand {
  if (!isRecord(value) || !isNonNegativeInteger(value.tabId)) return false;
  const { tabId: _tabId, ...wire }: Record<string, unknown> = value;
  return parseResetEnforcementEpochCommand(wire) !== null;
}

/** The keys the worker adds to a wire command when it freezes one. */
const WORKER_OWNED_COMMAND_KEYS: readonly string[] = ['tabId'];

export function validateDetachedFrozenDocumentCommand(
  value: unknown,
): value is FrozenDocumentCommand {
  const candidate: UnknownRecord | null = exactRecord(value, FROZEN_COMMAND_KEYS);
  return (
    candidate !== null &&
    isNonNegativeInteger(candidate.tabId) &&
    validateDetachedDocumentEnforcementCommandFields(candidate, WORKER_OWNED_COMMAND_KEYS)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedDocumentEnforcementAck(
  value: unknown,
): value is DocumentEnforcementAck {
  const candidate: UnknownRecord | null = exactRecord(value, ENFORCEMENT_ACK_KEYS);
  return (
    candidate !== null &&
    candidate.version === 1 &&
    isUuid(candidate.operationId) &&
    isUuid(candidate.enforcementEpoch) &&
    canonicalSessionIdentity(candidate.sessionId, candidate.reservedSessionId) !== null &&
    isNonNegativeInteger(candidate.basePolicyRevision) &&
    isNonNegativeInteger(candidate.runtimeRevision) &&
    isNonNegativeInteger(candidate.tabId) &&
    isNonBlankString(candidate.documentId) &&
    isNonBlankString(candidate.url) &&
    validateDetachedVerdict(candidate.verdict) &&
    isSafeTimestamp(candidate.handledAt)
  );
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. A record carrying a `url`
 * is refused: it is the shape a build before the record stored, and every reader of a checkpoint
 * matches on the tab and the document, never on the address.
 */
export function validateDetachedDocumentEnforcementAckRecord(
  value: unknown,
): value is DocumentEnforcementAckRecord {
  const candidate: UnknownRecord | null = exactRecord(value, ENFORCEMENT_ACK_RECORD_KEYS);
  return (
    candidate !== null &&
    candidate.version === 1 &&
    isUuid(candidate.operationId) &&
    isUuid(candidate.enforcementEpoch) &&
    canonicalSessionIdentity(candidate.sessionId, candidate.reservedSessionId) !== null &&
    isNonNegativeInteger(candidate.basePolicyRevision) &&
    isNonNegativeInteger(candidate.runtimeRevision) &&
    isNonNegativeInteger(candidate.tabId) &&
    isNonBlankString(candidate.documentId) &&
    validateDetachedVerdict(candidate.verdict) &&
    isSafeTimestamp(candidate.handledAt)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedDocumentEpochResetAck(
  value: unknown,
): value is DocumentEpochResetAck {
  const candidate: UnknownRecord | null = exactRecord(value, EPOCH_RESET_ACK_KEYS);
  return (
    candidate !== null &&
    candidate.version === 1 &&
    isUuid(candidate.operationId) &&
    isUuid(candidate.enforcementEpoch) &&
    isNonNegativeInteger(candidate.tabId) &&
    isNonBlankString(candidate.documentId) &&
    isNonBlankString(candidate.url) &&
    isSafeTimestamp(candidate.handledAt)
  );
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. A record carrying a `url`
 * is refused outright: it is the shape a build before the record stored, and the runtime drops it
 * rather than keeping an address the record exists not to hold.
 */
export function validateDetachedEpochResetAckRecord(value: unknown): value is EpochResetAckRecord {
  const candidate: UnknownRecord | null = exactRecord(value, EPOCH_RESET_ACK_RECORD_KEYS);
  return (
    candidate !== null &&
    candidate.version === 1 &&
    isUuid(candidate.operationId) &&
    isUuid(candidate.enforcementEpoch) &&
    isNonNegativeInteger(candidate.tabId) &&
    isNonBlankString(candidate.documentId) &&
    isSafeTimestamp(candidate.handledAt)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedEnforcementTargetExclusion(
  value: unknown,
): value is EnforcementTargetExclusion {
  const candidate: UnknownRecord | null = exactRecord(value, EXCLUSION_KEYS);
  return (
    candidate !== null &&
    isNonNegativeInteger(candidate.tabId) &&
    (candidate.documentId === null || isNonBlankString(candidate.documentId)) &&
    // The producer excludes a target only where Chrome forbids the content script. Which pages
    // those are is known two ways: from the address, for the pages Chrome names in its own rules,
    // and from the attempt, for a document that refused the script when one was put into it. A
    // stored exclusion has to match the way its reason is learned.
    isNonBlankString(candidate.url) &&
    (candidate.reason === 'unscriptable'
      ? isHttpUrl(candidate.url) && !isKnownUnsupportedUrlV2(candidate.url)
      : candidate.reason === 'known-unsupported' && isKnownUnsupportedUrlV2(candidate.url))
  );
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedEnforcementCheckpoint(
  value: unknown,
): value is EnforcementCheckpoint {
  const candidate: UnknownRecord | null = exactRecord(value, CHECKPOINT_KEYS);
  if (candidate === null) return false;
  const header: CheckpointHeader | null = checkpointHeader(candidate);
  if (header === null) return false;
  const documents: unknown = candidate.documents;
  const exclusions: unknown = candidate.exclusions;
  if (
    !everyDenseEntry(documents, validateDetachedDocumentEnforcementAckRecord) ||
    !everyDenseEntry(exclusions, validateDetachedEnforcementTargetExclusion)
  ) {
    return false;
  }
  return acknowledgementsAgree(header, documents) && exclusionsAgree(documents, exclusions);
}

/** Returns the checkpoint's own operation-time authority, or null when a leaf is out of domain. */
function checkpointHeader(candidate: UnknownRecord): CheckpointHeader | null {
  const operationId: unknown = candidate.operationId;
  const enforcementEpoch: unknown = candidate.enforcementEpoch;
  const sessionId: unknown = candidate.sessionId;
  const basePolicyRevision: unknown = candidate.basePolicyRevision;
  const registrationAuditedAt: unknown = candidate.registrationAuditedAt;
  const completedAt: unknown = candidate.completedAt;
  if (
    candidate.version !== 1 ||
    !isUuid(operationId) ||
    !isUuid(enforcementEpoch) ||
    !isUuid(sessionId) ||
    !isNonNegativeInteger(basePolicyRevision) ||
    !isCheckpointKind(candidate.kind) ||
    !isSafeTimestamp(registrationAuditedAt) ||
    !isSafeTimestamp(completedAt) ||
    registrationAuditedAt > completedAt ||
    !isNonNegativeInteger(candidate.targetGeneration)
  ) {
    return null;
  }
  return { operationId, enforcementEpoch, sessionId, basePolicyRevision };
}

/**
 * Every acknowledgement repeats the checkpoint's operation authority, shares the one operation-time
 * runtime revision, and holds a unique target identity. The checkpoint stores no current runtime
 * revision, so none is compared here, and `handledAt` is a content-script clock reading that no
 * rule bounds by the checkpoint's own audit and completion times.
 */
function acknowledgementsAgree(
  header: CheckpointHeader,
  documents: readonly DocumentEnforcementAckRecord[],
): boolean {
  const operationRevision: number | undefined = documents[0]?.runtimeRevision;
  const identities: Set<string> = new Set<string>();
  for (const acknowledgement of documents) {
    if (
      acknowledgement.operationId !== header.operationId ||
      acknowledgement.enforcementEpoch !== header.enforcementEpoch ||
      acknowledgement.basePolicyRevision !== header.basePolicyRevision ||
      acknowledgement.runtimeRevision !== operationRevision ||
      canonicalSessionIdentity(acknowledgement.sessionId, acknowledgement.reservedSessionId) !==
        header.sessionId
    ) {
      return false;
    }
    identities.add(documentIdentity(acknowledgement.tabId, acknowledgement.documentId));
  }
  return identities.size === documents.length;
}

/** One top-frame tab target is either acknowledged or excluded, never both. */
function exclusionsAgree(
  documents: readonly DocumentEnforcementAckRecord[],
  exclusions: readonly EnforcementTargetExclusion[],
): boolean {
  const acknowledgedTabs: Set<number> = new Set<number>(
    documents.map((record: DocumentEnforcementAckRecord): number => record.tabId),
  );
  const identities: Set<string> = new Set<string>();
  for (const exclusion of exclusions) {
    if (acknowledgedTabs.has(exclusion.tabId)) return false;
    identities.add(documentIdentity(exclusion.tabId, exclusion.documentId));
  }
  return identities.size === exclusions.length;
}

/**
 * A tab with no document ID is its own identity, not the text "null". A document identified by the
 * literal string "null" is a different target, and folding the two onto one key refuses a
 * checkpoint that legitimately carries both. The document form is tagged, so no document ID can
 * spell the null form.
 */
function documentIdentity(tabId: number, documentId: string | null): string {
  return documentId === null ? `${tabId}:none` : `${tabId}:document:${documentId}`;
}

function isCheckpointKind(value: unknown): value is EnforcementCheckpoint['kind'] {
  return typeof value === 'string' && CHECKPOINT_KINDS.has(value);
}
