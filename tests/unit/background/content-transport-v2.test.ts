import { describe, expect, it, vi } from 'vitest';
import {
  type ContentTransportPortsV2,
  type DocumentCommandOutcomeV2,
  type EpochResetOutcomeV2,
  isNoReceiverError,
  sendDocumentEnforcementCommand,
  sendEpochResetCommand,
} from '../../../src/background/content-transport-v2';
import type {
  DocumentEnforcementAck,
  DocumentEpochResetAck,
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from '../../../src/background/enforcement-persistence-v2';
import type {
  ContentEnforcementResponse,
  DocumentContentCommand,
  DocumentOverlayView,
} from '../../../src/shared/enforcement-v2';
import { exactDataEqual } from '../../../src/shared/exact-data';
import type { Verdict } from '../../../src/shared/types';

type UnknownRecord = Record<string, unknown>;
type AppliedResponse = Extract<ContentEnforcementResponse, { disposition: 'applied' }>;
type StaleCommandResponse = Extract<ContentEnforcementResponse, { disposition: 'stale-command' }>;
type ResetRequiredResponse = Extract<ContentEnforcementResponse, { disposition: 'reset-required' }>;
type EpochResetResponse = Extract<ContentEnforcementResponse, { disposition: 'epoch-reset' }>;
type EpochResetRejectedResponse = Extract<
  ContentEnforcementResponse,
  { disposition: 'epoch-reset-rejected' }
>;
type ActiveOverlay = Extract<DocumentOverlayView, { presentation: 'active' }>;
type StartingOverlay = Extract<DocumentOverlayView, { presentation: 'starting' }>;

interface SentMessage {
  tabId: number;
  documentId: string;
  message: DocumentContentCommand;
}

interface FakePort {
  ports: ContentTransportPortsV2;
  sent: SentMessage[];
}

const NOW: number = 1_750_000_000_000;
const HANDLED_AT: number = NOW + 25;
const LATER_HANDLED_AT: number = NOW + 400;
const TAB_ID: number = 7;
const DOCUMENT_ID: string = 'document-1';
const OTHER_DOCUMENT_ID: string = 'document-2';
const TARGET_URL: string = 'https://example.com/path';
const OTHER_URL: string = 'https://example.com/other';
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const OTHER_SESSION_ID: string = '10000000-0000-4000-8000-000000000002';
const RESERVED_SESSION_ID: string = '10000000-0000-4000-8000-000000000003';
const OTHER_RESERVED_SESSION_ID: string = '10000000-0000-4000-8000-000000000004';
const OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
const OTHER_OPERATION_ID: string = '20000000-0000-4000-8000-000000000002';
const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';
const OTHER_EPOCH_ID: string = '30000000-0000-4000-8000-000000000002';
const PROVENANCE: string = 'Blocked by Social media: example.com';
const WIRE_COMMAND_KEYS: readonly string[] = [
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
];
const WIRE_RESET_KEYS: readonly string[] = [
  'version',
  'command',
  'operationId',
  'enforcementEpoch',
  'documentId',
  'expectedUrl',
];
const BLOCKED_VERDICT: Verdict = {
  blocked: true,
  reason: 'category',
  categoryId: 'social',
  matchedPattern: 'example.com',
};

function activeOverlay(overrides: Partial<ActiveOverlay> = {}): ActiveOverlay {
  return {
    version: 1,
    presentation: 'active',
    theme: 'dark',
    sessionId: SESSION_ID,
    phase: 'focus',
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    timing: {
      capturedAt: NOW,
      phaseStartedAt: NOW - 1_000,
      phaseEndsAt: null,
      sessionEndsAt: null,
    },
    economy: {
      bankMs: 60_000,
      bankAccrualPerMs: 1 / 6,
      bankCapMs: 300_000,
      pauseCostMs: 60_000,
      unlockCostMs: 120_000,
    },
    gate: null,
    activeUnlocks: [],
    attemptsToday: 2,
    stoppedPage: false,
    actions: { state: 'ready', end: 'request-end', pause: 'request-gate', unlock: 'request-gate' },
    copy: {
      status: {
        kind: 'until-stopped',
        text: 'Until stopped',
      },
      lockedUntil: null,
      intention: 'Finish the release notes',
      verdictProvenance: PROVENANCE,
      stoppedPage: null,
      bankUnit: 'site access credit',
      pauseAction: 'Unlock all sites 1:00 - costs 1:00 credit',
      unlockAction: 'Unlock this site 2:00 - costs 2:00 credit',
      endAction: 'End session',
      bankWaitPrefix: 'Ready in',
      gateTitle: null,
      gateBack: 'Keep focusing',
      gatePhraseLabel: 'Type this to confirm:',
      gateForceEnd: 'Ignore timeout and end anyway',
      gateConfirm: null,
      transportError: 'Focus Lock could not update this action. Try again.',
      backToWork: 'Back to work',
      chooseWorkTab: 'Choose a work tab',
      changeWorkTab: 'Change work tab',
      accessSummary: 'Need a break or site access?',
      accessNote: 'You can step away at any time. Site access uses credit.',
      costAboveLimit: 'Cost exceeds the credit limit',
      earningOff: 'Credit earning is turned off',
      notEnoughFocus: 'Not enough time in this focus block',
      gateSaid: null,
      nextStep: 'Your next step',
      remainingSuffix: null,
      minuteLabel: 'min',
      underMinuteLabel: 'Less than a minute',
      updatingLabel: 'Updating session',
    },
    ...overrides,
  };
}

function startingOverlay(): StartingOverlay {
  return {
    version: 1,
    presentation: 'starting',
    capturedAt: NOW,
    theme: 'dark',
    stoppedPage: false,
    copy: {
      title: 'Focus Lock is starting',
      detail: 'Applying your selected rules.',
      verdictProvenance: PROVENANCE,
      stoppedPage: null,
    },
    actions: { end: 'hidden' },
  };
}

function documentCommand(overrides: Partial<FrozenDocumentCommand> = {}): FrozenDocumentCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    documentId: DOCUMENT_ID,
    expectedUrl: TARGET_URL,
    presentation: 'active',
    verdict: { ...BLOCKED_VERDICT },
    overlay: activeOverlay(),
    tabId: TAB_ID,
    ...overrides,
  };
}

function startingCommand(): FrozenDocumentCommand {
  return documentCommand({
    sessionId: null,
    reservedSessionId: RESERVED_SESSION_ID,
    runtimeRevision: 0,
    presentation: 'starting',
    overlay: startingOverlay(),
  });
}

function resetCommand(overrides: Partial<FrozenEpochResetCommand> = {}): FrozenEpochResetCommand {
  return {
    version: 1,
    command: 'reset-enforcement-epoch',
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    documentId: DOCUMENT_ID,
    expectedUrl: TARGET_URL,
    tabId: TAB_ID,
    ...overrides,
  };
}

function appliedFor(
  command: FrozenDocumentCommand,
  overrides: Partial<AppliedResponse> = {},
): AppliedResponse {
  return {
    version: 1,
    disposition: 'applied',
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    sessionId: command.sessionId,
    reservedSessionId: command.reservedSessionId,
    basePolicyRevision: command.basePolicyRevision,
    runtimeRevision: command.runtimeRevision,
    documentId: command.documentId,
    observedUrl: command.expectedUrl,
    presentation: command.presentation,
    verdict: command.verdict,
    overlay: command.overlay,
    handledAt: HANDLED_AT,
    ...overrides,
  };
}

function staleFor(
  command: FrozenDocumentCommand,
  overrides: Partial<StaleCommandResponse> = {},
): StaleCommandResponse {
  return {
    version: 1,
    disposition: 'stale-command',
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    documentId: command.documentId,
    observedUrl: command.expectedUrl,
    requested: {
      enforcementEpoch: command.enforcementEpoch,
      sessionId: command.sessionId,
      reservedSessionId: command.reservedSessionId,
      basePolicyRevision: command.basePolicyRevision,
      runtimeRevision: command.runtimeRevision,
    },
    current: {
      enforcementEpoch: command.enforcementEpoch,
      sessionId: command.sessionId,
      reservedSessionId: command.reservedSessionId,
      basePolicyRevision: command.basePolicyRevision,
      runtimeRevision: command.runtimeRevision + 2,
    },
    handledAt: HANDLED_AT,
    ...overrides,
  };
}

function resetRequiredFor(
  command: FrozenDocumentCommand,
  overrides: Partial<ResetRequiredResponse> = {},
): ResetRequiredResponse {
  return {
    version: 1,
    disposition: 'reset-required',
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    documentId: command.documentId,
    observedUrl: command.expectedUrl,
    requestedEpoch: command.enforcementEpoch,
    currentEpoch: null,
    handledAt: HANDLED_AT,
    ...overrides,
  };
}

function epochResetFor(
  command: FrozenEpochResetCommand,
  overrides: Partial<EpochResetResponse> = {},
): EpochResetResponse {
  return {
    version: 1,
    disposition: 'epoch-reset',
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    documentId: command.documentId,
    observedUrl: command.expectedUrl,
    handledAt: HANDLED_AT,
    ...overrides,
  };
}

function epochResetRejectedFor(
  command: FrozenEpochResetCommand,
  overrides: Partial<EpochResetRejectedResponse> = {},
): EpochResetRejectedResponse {
  return {
    version: 1,
    disposition: 'epoch-reset-rejected',
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    currentEpoch: OTHER_EPOCH_ID,
    reason: 'retired-epoch',
    documentId: command.documentId,
    observedUrl: command.expectedUrl,
    handledAt: HANDLED_AT,
    ...overrides,
  };
}

function fakePort(...replies: readonly unknown[]): FakePort {
  const sent: SentMessage[] = [];
  let index: number = 0;
  const ports: ContentTransportPortsV2 = {
    sendToDocument: async (
      tabId: number,
      documentId: string,
      message: DocumentContentCommand,
    ): Promise<unknown> => {
      sent.push({ tabId, documentId, message });
      const reply: unknown = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { ports, sent };
}

function throwingPort(error: unknown): ContentTransportPortsV2 {
  return {
    sendToDocument: async (): Promise<unknown> => {
      throw error;
    },
  };
}

function withKey(value: object, key: string, replacement: unknown): UnknownRecord {
  return { ...value, [key]: replacement };
}

function detailOf(outcome: DocumentCommandOutcomeV2 | EpochResetOutcomeV2): string {
  return outcome.kind === 'mismatch' ? outcome.detail : `expected a mismatch, got ${outcome.kind}`;
}

describe('v2 content transport send', (): void => {
  it('clears deadlines for immediate success and rejection and consumes late rejection', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      await sendDocumentEnforcementCommand(
        fakePort(appliedFor(documentCommand())).ports,
        documentCommand(),
      );
      await sendEpochResetCommand(throwingPort(new Error('send failed')), resetCommand());
      expect(vi.getTimerCount()).toBe(0);
      let reject: (reason: unknown) => void = (): void => {};
      const pending: Promise<unknown> = new Promise((_resolve, fail): void => {
        reject = fail;
      });
      const outcome: Promise<DocumentCommandOutcomeV2> = sendDocumentEnforcementCommand(
        { sendToDocument: (): Promise<unknown> => pending },
        documentCommand(),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await outcome).kind).toBe('unresponsive');
      reject(new Error('late transport failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds unanswered apply and reset commands without acknowledging late answers', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      let resolve: (value: unknown) => void = (): void => {};
      const pending: Promise<unknown> = new Promise((done): void => {
        resolve = done;
      });
      const ports: ContentTransportPortsV2 = { sendToDocument: (): Promise<unknown> => pending };
      const outcomes: Array<DocumentCommandOutcomeV2 | EpochResetOutcomeV2> = [];
      void sendDocumentEnforcementCommand(ports, documentCommand()).then((outcome): void => {
        outcomes.push(outcome);
      });
      void sendEpochResetCommand(ports, resetCommand()).then((outcome): void => {
        outcomes.push(outcome);
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(outcomes.map((outcome): string => outcome.kind)).toEqual([
        'unresponsive',
        'unresponsive',
      ]);
      resolve(appliedFor(documentCommand()));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcomes).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the frozen command stripped of the worker-owned tab', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const port: FakePort = fakePort(appliedFor(command));

    await sendDocumentEnforcementCommand(port.ports, command);

    expect(port.sent).toHaveLength(1);
    const sent: SentMessage = port.sent[0] as SentMessage;
    expect(sent.tabId).toBe(TAB_ID);
    expect(sent.documentId).toBe(DOCUMENT_ID);
    expect(Reflect.ownKeys(sent.message).sort()).toEqual([...WIRE_COMMAND_KEYS].sort());
    expect(sent.message).not.toHaveProperty('tabId');
    expect(command.tabId).toBe(TAB_ID);
  });

  it('sends the frozen reset command stripped of the worker-owned tab', async (): Promise<void> => {
    const command: FrozenEpochResetCommand = resetCommand();
    const port: FakePort = fakePort(epochResetFor(command));

    await sendEpochResetCommand(port.ports, command);

    const sent: SentMessage = port.sent[0] as SentMessage;
    expect(Reflect.ownKeys(sent.message).sort()).toEqual([...WIRE_RESET_KEYS].sort());
    expect(sent.message).not.toHaveProperty('tabId');
  });

  it('wraps an exact applied response into a detached acknowledgement', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(appliedFor(command)).ports,
      command,
    );

    expect(outcome.kind).toBe('applied');
    const ack: DocumentEnforcementAck = (outcome as { ack: DocumentEnforcementAck }).ack;
    expect(ack).toEqual({
      version: 1,
      operationId: OPERATION_ID,
      enforcementEpoch: EPOCH_ID,
      sessionId: SESSION_ID,
      reservedSessionId: null,
      basePolicyRevision: 4,
      runtimeRevision: 7,
      tabId: TAB_ID,
      documentId: DOCUMENT_ID,
      url: TARGET_URL,
      verdict: BLOCKED_VERDICT,
      handledAt: HANDLED_AT,
    });

    expect(ack.verdict).not.toBe(command.verdict);
    command.verdict.reason = 'custom';
    expect(ack.verdict.reason).toBe('category');
  });

  it('wraps a provisional starting acknowledgement with the reserved identity', async (): Promise<void> => {
    const command: FrozenDocumentCommand = startingCommand();
    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(appliedFor(command)).ports,
      command,
    );

    expect(outcome.kind).toBe('applied');
    const ack: DocumentEnforcementAck = (outcome as { ack: DocumentEnforcementAck }).ack;
    expect(ack.sessionId).toBeNull();
    expect(ack.reservedSessionId).toBe(RESERVED_SESSION_ID);
    expect(ack.runtimeRevision).toBe(0);
  });

  it('names the field of every single-field applied divergence', async (): Promise<void> => {
    const active: FrozenDocumentCommand = documentCommand();
    const starting: FrozenDocumentCommand = startingCommand();
    const cases: ReadonlyArray<readonly [string, FrozenDocumentCommand, unknown]> = [
      ['operationId', active, appliedFor(active, { operationId: OTHER_OPERATION_ID })],
      ['enforcementEpoch', active, appliedFor(active, { enforcementEpoch: OTHER_EPOCH_ID })],
      [
        'sessionId',
        active,
        appliedFor(active, {
          sessionId: OTHER_SESSION_ID,
          overlay: activeOverlay({ sessionId: OTHER_SESSION_ID }),
        }),
      ],
      [
        'reservedSessionId',
        starting,
        appliedFor(starting, { reservedSessionId: OTHER_RESERVED_SESSION_ID }),
      ],
      ['basePolicyRevision', active, appliedFor(active, { basePolicyRevision: 5 })],
      ['runtimeRevision', active, appliedFor(active, { runtimeRevision: 8 })],
      ['documentId', active, appliedFor(active, { documentId: OTHER_DOCUMENT_ID })],
      [
        'presentation',
        active,
        appliedFor(active, { presentation: 'starting', overlay: startingOverlay() }),
      ],
      [
        'verdict',
        active,
        appliedFor(active, { verdict: { ...BLOCKED_VERDICT, matchedPattern: 'other.example' } }),
      ],
      ['overlay', active, appliedFor(active, { overlay: activeOverlay({ attemptsToday: 3 }) })],
    ];

    for (const [field, command, response] of cases) {
      const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
        fakePort(response).ports,
        command,
      );
      expect(outcome.kind).toBe('mismatch');
      expect(detailOf(outcome)).toContain(field);
    }
  });

  it('returns a stale response only when it echoes the tuple that was sent', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const response: StaleCommandResponse = staleFor(command);
    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(response).ports,
      command,
    );

    expect(outcome.kind).toBe('stale');
    expect((outcome as { response: StaleCommandResponse }).response).toEqual(response);

    const drifted: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(
        staleFor(command, {
          requested: {
            enforcementEpoch: EPOCH_ID,
            sessionId: SESSION_ID,
            reservedSessionId: null,
            basePolicyRevision: 4,
            runtimeRevision: 6,
          },
        }),
      ).ports,
      command,
    );

    expect(drifted.kind).toBe('mismatch');
    expect(detailOf(drifted)).toContain('requested');
  });

  it('refuses a stale answer about another operation or document', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const foreignOperation: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(staleFor(command, { operationId: OTHER_OPERATION_ID })).ports,
      command,
    );
    const foreignDocument: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(staleFor(command, { documentId: OTHER_DOCUMENT_ID })).ports,
      command,
    );

    expect(foreignOperation.kind).toBe('mismatch');
    expect(detailOf(foreignOperation)).toContain('operationId');
    expect(foreignDocument.kind).toBe('mismatch');
    expect(detailOf(foreignDocument)).toContain('documentId');
  });

  it('refuses a reset-required about another operation or document', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const foreignOperation: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(resetRequiredFor(command, { operationId: OTHER_OPERATION_ID })).ports,
      command,
    );
    const foreignDocument: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(resetRequiredFor(command, { documentId: OTHER_DOCUMENT_ID })).ports,
      command,
    );

    expect(foreignOperation.kind).toBe('mismatch');
    expect(detailOf(foreignOperation)).toContain('operationId');
    expect(foreignDocument.kind).toBe('mismatch');
    expect(detailOf(foreignDocument)).toContain('documentId');
  });

  it('reports the current epoch of a reset-required that echoes the sent epoch', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const fresh: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(resetRequiredFor(command)).ports,
      command,
    );
    const rotated: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(resetRequiredFor(command, { currentEpoch: OTHER_EPOCH_ID })).ports,
      command,
    );
    const foreign: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(
        resetRequiredFor(command, {
          enforcementEpoch: OTHER_EPOCH_ID,
          requestedEpoch: OTHER_EPOCH_ID,
        }),
      ).ports,
      command,
    );

    expect(fresh).toEqual({ kind: 'reset-required', currentEpoch: null });
    expect(rotated).toEqual({ kind: 'reset-required', currentEpoch: OTHER_EPOCH_ID });
    expect(foreign.kind).toBe('mismatch');
    expect(detailOf(foreign)).toContain('requestedEpoch');
  });

  it('rejects a disposition that answers a different command', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const reset: FrozenEpochResetCommand = resetCommand();

    const wrongForEnforcement: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(epochResetFor(reset)).ports,
      command,
    );
    const wrongForReset: EpochResetOutcomeV2 = await sendEpochResetCommand(
      fakePort(appliedFor(command)).ports,
      reset,
    );

    expect(wrongForEnforcement.kind).toBe('mismatch');
    expect(detailOf(wrongForEnforcement)).toContain('epoch-reset');
    expect(wrongForReset.kind).toBe('mismatch');
    expect(detailOf(wrongForReset)).toContain('applied');
  });

  it('classifies a receiver-absent rejection from both senders', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const reset: FrozenEpochResetCommand = resetCommand();
    const absent: readonly unknown[] = [
      new Error('Could not establish connection. Receiving end does not exist.'),
      new Error('Receiving end does not exist.'),
    ];

    for (const error of absent) {
      expect(isNoReceiverError(error)).toBe(true);
      expect(await sendDocumentEnforcementCommand(throwingPort(error), command)).toEqual({
        kind: 'no-receiver',
      });
      expect(await sendEpochResetCommand(throwingPort(error), reset)).toEqual({
        kind: 'no-receiver',
      });
    }
  });

  it('classifies a vanished target as closed rather than a fatal mismatch', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const reset: FrozenEpochResetCommand = resetCommand();
    const gone: readonly Error[] = [
      new Error('No tab with id: 7.'),
      new Error('The tab was closed.'),
      new Error('The message port closed before a response was received.'),
    ];

    for (const error of gone) {
      expect(isNoReceiverError(error)).toBe(false);
      expect(await sendDocumentEnforcementCommand(throwingPort(error), command)).toEqual({
        kind: 'closed',
      });
      expect(await sendEpochResetCommand(throwingPort(error), reset)).toEqual({ kind: 'closed' });
    }
  });

  it('reports every other rejection as a mismatch carrying its text', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const reset: FrozenEpochResetCommand = resetCommand();

    const unnamed: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      throwingPort(new Error('Frame with ID 0 was removed.')),
      command,
    );
    expect(unnamed.kind).toBe('mismatch');
    expect(detailOf(unnamed)).toContain('Frame with ID 0 was removed.');

    const thrownText: EpochResetOutcomeV2 = await sendEpochResetCommand(
      throwingPort('boom'),
      reset,
    );
    expect(thrownText.kind).toBe('mismatch');
    expect(detailOf(thrownText)).toContain('boom');
    expect(isNoReceiverError('boom')).toBe(false);
  });

  it('treats an exact answer for another URL as a changed target', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(appliedFor(command, { observedUrl: OTHER_URL })).ports,
      command,
    );

    expect(outcome).toEqual({ kind: 'changed', observedUrl: OTHER_URL });
    expect(outcome).not.toHaveProperty('ack');
  });

  it('prefers the mismatch when a changed URL arrives with a broken echo', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(appliedFor(command, { observedUrl: OTHER_URL, runtimeRevision: 8 })).ports,
      command,
    );

    expect(outcome.kind).toBe('mismatch');
    expect(detailOf(outcome)).toContain('runtimeRevision');
  });

  it('wraps an exact epoch reset and reports a retired-epoch rejection', async (): Promise<void> => {
    const command: FrozenEpochResetCommand = resetCommand();
    const accepted: EpochResetOutcomeV2 = await sendEpochResetCommand(
      fakePort(epochResetFor(command)).ports,
      command,
    );
    const rejected: EpochResetOutcomeV2 = await sendEpochResetCommand(
      fakePort(epochResetRejectedFor(command)).ports,
      command,
    );

    expect(accepted.kind).toBe('reset');
    const ack: DocumentEpochResetAck = (accepted as { ack: DocumentEpochResetAck }).ack;
    expect(ack).toEqual({
      version: 1,
      operationId: OPERATION_ID,
      enforcementEpoch: EPOCH_ID,
      tabId: TAB_ID,
      documentId: DOCUMENT_ID,
      url: TARGET_URL,
      handledAt: HANDLED_AT,
    });
    expect(rejected).toEqual({ kind: 'rejected', currentEpoch: OTHER_EPOCH_ID });
  });

  it('names the field of every reset acknowledgement divergence', async (): Promise<void> => {
    const command: FrozenEpochResetCommand = resetCommand();
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['operationId', epochResetFor(command, { operationId: OTHER_OPERATION_ID })],
      ['enforcementEpoch', epochResetFor(command, { enforcementEpoch: OTHER_EPOCH_ID })],
      ['documentId', epochResetFor(command, { documentId: OTHER_DOCUMENT_ID })],
      ['observedUrl', epochResetFor(command, { observedUrl: OTHER_URL })],
      ['operationId', epochResetRejectedFor(command, { operationId: OTHER_OPERATION_ID })],
      ['documentId', epochResetRejectedFor(command, { documentId: OTHER_DOCUMENT_ID })],
      ['observedUrl', epochResetRejectedFor(command, { observedUrl: OTHER_URL })],
    ];

    for (const [field, response] of cases) {
      const outcome: EpochResetOutcomeV2 = await sendEpochResetCommand(
        fakePort(response).ports,
        command,
      );
      expect(outcome.kind).toBe('mismatch');
      expect(detailOf(outcome)).toContain(field);
    }
  });

  it('treats an undefined answer as the content rejection signal', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const reset: FrozenEpochResetCommand = resetCommand();

    const enforcement: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(undefined).ports,
      command,
    );
    const handshake: EpochResetOutcomeV2 = await sendEpochResetCommand(
      fakePort(undefined).ports,
      reset,
    );

    expect(enforcement.kind).toBe('mismatch');
    expect(detailOf(enforcement)).toContain('rejected');
    expect(handshake.kind).toBe('mismatch');
    expect(detailOf(handshake)).toContain('rejected');
  });

  it('rejects unparsable, tab-bearing, and live proxy responses', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    let handledAtReads: number = 0;
    const drifting: unknown = new Proxy<UnknownRecord>(
      { ...appliedFor(command) },
      {
        getOwnPropertyDescriptor: (
          target: UnknownRecord,
          key: string | symbol,
        ): PropertyDescriptor | undefined => {
          const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
            target,
            key,
          );
          if (key !== 'handledAt' || descriptor === undefined) return descriptor;
          handledAtReads += 1;
          return { ...descriptor, value: HANDLED_AT + handledAtReads };
        },
      },
    );
    const hostile: readonly unknown[] = [
      drifting,
      withKey(appliedFor(command), 'tabId', TAB_ID),
      withKey(appliedFor(command), 'extra', true),
      { disposition: 'applied' },
      null,
      'applied',
    ];

    for (const response of hostile) {
      const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
        fakePort(response).ports,
        command,
      );
      expect(outcome.kind).toBe('mismatch');
    }
  });

  it('refuses to wrap an acknowledgement the persistence contract rejects', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand({ tabId: -1 });
    const outcome: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      fakePort(appliedFor(command)).ports,
      command,
    );

    expect(outcome.kind).toBe('mismatch');
    expect(detailOf(outcome)).toContain('acknowledgement');
  });

  it('replays one frozen command into equal acknowledgements apart from handledAt', async (): Promise<void> => {
    const command: FrozenDocumentCommand = documentCommand();
    const port: FakePort = fakePort(
      appliedFor(command),
      appliedFor(command, { handledAt: LATER_HANDLED_AT }),
    );

    const first: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      port.ports,
      command,
    );
    const second: DocumentCommandOutcomeV2 = await sendDocumentEnforcementCommand(
      port.ports,
      command,
    );

    expect(first.kind).toBe('applied');
    expect(second.kind).toBe('applied');
    const firstAck: DocumentEnforcementAck = (first as { ack: DocumentEnforcementAck }).ack;
    const secondAck: DocumentEnforcementAck = (second as { ack: DocumentEnforcementAck }).ack;
    expect(firstAck.handledAt).toBe(HANDLED_AT);
    expect(secondAck.handledAt).toBe(LATER_HANDLED_AT);
    expect(exactDataEqual({ ...firstAck, handledAt: 0 }, { ...secondAck, handledAt: 0 })).toBe(
      true,
    );
    expect(port.sent).toHaveLength(2);
  });
});
