import type {
  DocumentEnforcementCommand,
  ResetEnforcementEpochCommand,
} from '../shared/enforcement-v2';
import type { Verdict } from '../shared/types';

export interface FrozenDocumentCommand extends DocumentEnforcementCommand {
  tabId: number;
}

export interface FrozenEpochResetCommand extends ResetEnforcementEpochCommand {
  tabId: number;
}

export interface DocumentEnforcementAck {
  version: 1;
  operationId: string;
  enforcementEpoch: string;
  sessionId: string | null;
  reservedSessionId: string | null;
  basePolicyRevision: number;
  runtimeRevision: number;
  tabId: number;
  documentId: string;
  url: string;
  verdict: Verdict;
  handledAt: number;
}

/**
 * What a checkpoint keeps of an enforcement acknowledgement. The one reader after publication
 * matches a record on its tab and document and replaces it whole, so the record is the transport's
 * answer without the page address it echoed, for the same reason `EpochResetAckRecord` carries
 * none: a checkpoint lives for the session, and every audited page is in it, blocked or not.
 */
export interface DocumentEnforcementAckRecord {
  version: 1;
  operationId: string;
  enforcementEpoch: string;
  sessionId: string | null;
  reservedSessionId: string | null;
  basePolicyRevision: number;
  runtimeRevision: number;
  tabId: number;
  documentId: string;
  verdict: Verdict;
  handledAt: number;
}

export interface DocumentEpochResetAck {
  version: 1;
  operationId: string;
  enforcementEpoch: string;
  tabId: number;
  documentId: string;
  url: string;
  handledAt: number;
}

/**
 * What the runtime keeps of an epoch reset acknowledgement. Every reader of `epochResetAcks` asks
 * one question, whether this document acknowledged this epoch, so the record is the document and
 * the epoch. The page address the transport's acknowledgement echoes stays out of it: a record is
 * kept for as long as its tab is open, in and between sessions, and an address kept that long is
 * browsing history the runtime has no use for.
 */
export interface EpochResetAckRecord {
  version: 1;
  operationId: string;
  enforcementEpoch: string;
  tabId: number;
  documentId: string;
  handledAt: number;
}

export interface EnforcementTargetExclusion {
  tabId: number;
  documentId: string | null;
  url: string;
  /**
   * Why this target was left out. `known-unsupported` is decided by the URL alone, and
   * `unscriptable` is an ordinary page Chrome refused to let the script into, which is learned by
   * trying rather than by reading the address.
   */
  reason: 'known-unsupported' | 'unscriptable';
}

export interface EnforcementCheckpoint {
  version: 1;
  operationId: string;
  enforcementEpoch: string;
  sessionId: string;
  basePolicyRevision: number;
  kind: 'activation' | 'recovery' | 'resume-strengthening';
  registrationAuditedAt: number;
  completedAt: number;
  targetGeneration: number;
  documents: DocumentEnforcementAckRecord[];
  exclusions: EnforcementTargetExclusion[];
}
