import { describe, expectTypeOf, it } from 'vitest';
import type {
  DocumentEnforcementAck,
  DocumentEnforcementAckRecord,
  DocumentEpochResetAck,
  EnforcementCheckpoint,
  EnforcementTargetExclusion,
  EpochResetAckRecord,
  FrozenDocumentCommand,
} from '../../../src/background/enforcement-persistence-v2';
import type { DocumentEnforcementCommand } from '../../../src/shared/enforcement-v2';
import type { Verdict } from '../../../src/shared/types';

describe('background enforcement persistence v2 contracts', (): void => {
  it('adds worker-owned tab authority only to frozen commands', (): void => {
    expectTypeOf<
      Omit<FrozenDocumentCommand, 'tabId'>
    >().toEqualTypeOf<DocumentEnforcementCommand>();
    expectTypeOf<FrozenDocumentCommand['tabId']>().toEqualTypeOf<number>();
  });

  it('pins enforcement and epoch acknowledgement fields', (): void => {
    expectTypeOf<DocumentEnforcementAck>().toEqualTypeOf<{
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
    }>();
    expectTypeOf<DocumentEpochResetAck>().toEqualTypeOf<{
      version: 1;
      operationId: string;
      enforcementEpoch: string;
      tabId: number;
      documentId: string;
      url: string;
      handledAt: number;
    }>();
  });

  it('keeps the stored acknowledgement record free of the page address', (): void => {
    expectTypeOf<EpochResetAckRecord>().toEqualTypeOf<{
      version: 1;
      operationId: string;
      enforcementEpoch: string;
      tabId: number;
      documentId: string;
      handledAt: number;
    }>();
    expectTypeOf<EpochResetAckRecord>().toEqualTypeOf<Omit<DocumentEpochResetAck, 'url'>>();
  });

  it('pins exclusions and checkpoint authority', (): void => {
    expectTypeOf<EnforcementTargetExclusion>().toEqualTypeOf<{
      tabId: number;
      documentId: string | null;
      url: string;
      reason: 'known-unsupported' | 'unscriptable';
    }>();
    expectTypeOf<EnforcementCheckpoint>().toEqualTypeOf<{
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
    }>();
  });

  it('keeps the checkpoint acknowledgement record free of the page address', (): void => {
    expectTypeOf<DocumentEnforcementAckRecord>().toEqualTypeOf<
      Omit<DocumentEnforcementAck, 'url'>
    >();
  });
});
