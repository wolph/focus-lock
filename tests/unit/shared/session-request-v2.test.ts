import { afterEach, beforeEach, describe, expect, expectTypeOf, it, type Mock, vi } from 'vitest';
import {
  type CommandResponseV2,
  type RetryCleanupResultCodeV2,
  type SessionCommandResultCodeV2,
  type SessionRequestV2,
  type SessionResponseMapV2,
  type StartSessionResponseV2,
  sendRequest,
} from '../../../src/shared/messages';
import type { GateState, SessionConfigV2 } from '../../../src/shared/types';
import { MANUAL_INDEFINITE_CONFIG } from './v2-runtime-fixtures';

const sendMessageMock: Mock = vi.fn();

interface ChromeHost {
  chrome?: unknown;
}

const START_SESSION: Extract<SessionRequestV2, { type: 'startSession' }> = {
  type: 'startSession',
  config: MANUAL_INDEFINITE_CONFIG,
};
const REQUEST_SESSION_END: Extract<SessionRequestV2, { type: 'requestSessionEnd' }> = {
  type: 'requestSessionEnd',
};
const OPEN_END_GATE: Extract<SessionRequestV2, { type: 'openEndGate' }> = { type: 'openEndGate' };
const FORCE_END_GATE: Extract<SessionRequestV2, { type: 'forceEndGate' }> = {
  type: 'forceEndGate',
};
const EXPECTED_GATE: GateState = {
  kind: 'cancel',
  host: null,
  openedAt: 1,
  readyAt: 2,
  requiredPhrase: null,
  forceEndAvailable: false,
};
const ABANDON_GATE: Extract<SessionRequestV2, { type: 'abandonGate' }> = {
  type: 'abandonGate',
  expectedGate: EXPECTED_GATE,
};
const CONFIRM_GATE: Extract<SessionRequestV2, { type: 'confirmGate' }> = {
  type: 'confirmGate',
  expectedGate: EXPECTED_GATE,
  typedPhrase: 'I am ending this session before: Review the release',
};
const OPEN_GATE: Extract<SessionRequestV2, { type: 'openGate' }> = {
  type: 'openGate',
  gate: 'unlockSite',
  host: 'example.com',
};
const RESUME_FROM_PAUSE: Extract<SessionRequestV2, { type: 'resumeFromPause' }> = {
  type: 'resumeFromPause',
};
const START_NEXT_FOCUS_EARLY: Extract<SessionRequestV2, { type: 'startNextFocusEarly' }> = {
  type: 'startNextFocusEarly',
};
const RETRY_TRANSITION_CLEANUP: Extract<SessionRequestV2, { type: 'retryTransitionCleanup' }> = {
  type: 'retryTransitionCleanup',
};
const RETRY_CLOSURE_CLEANUP: Extract<SessionRequestV2, { type: 'retryClosureCleanup' }> = {
  type: 'retryClosureCleanup',
};
const RETRY_DATA_CLEAR: Extract<SessionRequestV2, { type: 'retryDataClear' }> = {
  type: 'retryDataClear',
};

interface ChannelCall {
  readonly request: SessionRequestV2;
  readonly send: () => Promise<unknown>;
}

/** One entry per SessionRequestV2 member, each sent through its own generic instantiation. */
const CHANNEL_CALLS: readonly ChannelCall[] = [
  {
    request: START_SESSION,
    send: (): Promise<SessionResponseMapV2['startSession']> => sendRequest(START_SESSION),
  },
  {
    request: REQUEST_SESSION_END,
    send: (): Promise<SessionResponseMapV2['requestSessionEnd']> =>
      sendRequest(REQUEST_SESSION_END),
  },
  {
    request: OPEN_END_GATE,
    send: (): Promise<SessionResponseMapV2['openEndGate']> => sendRequest(OPEN_END_GATE),
  },
  {
    request: ABANDON_GATE,
    send: (): Promise<SessionResponseMapV2['abandonGate']> => sendRequest(ABANDON_GATE),
  },
  {
    request: CONFIRM_GATE,
    send: (): Promise<SessionResponseMapV2['confirmGate']> => sendRequest(CONFIRM_GATE),
  },
  {
    request: OPEN_GATE,
    send: (): Promise<SessionResponseMapV2['openGate']> => sendRequest(OPEN_GATE),
  },
  {
    request: FORCE_END_GATE,
    send: (): Promise<SessionResponseMapV2['forceEndGate']> => sendRequest(FORCE_END_GATE),
  },
  {
    request: RESUME_FROM_PAUSE,
    send: (): Promise<SessionResponseMapV2['resumeFromPause']> => sendRequest(RESUME_FROM_PAUSE),
  },
  {
    request: START_NEXT_FOCUS_EARLY,
    send: (): Promise<SessionResponseMapV2['startNextFocusEarly']> =>
      sendRequest(START_NEXT_FOCUS_EARLY),
  },
  {
    request: RETRY_TRANSITION_CLEANUP,
    send: (): Promise<SessionResponseMapV2['retryTransitionCleanup']> =>
      sendRequest(RETRY_TRANSITION_CLEANUP),
  },
  {
    request: RETRY_CLOSURE_CLEANUP,
    send: (): Promise<SessionResponseMapV2['retryClosureCleanup']> =>
      sendRequest(RETRY_CLOSURE_CLEANUP),
  },
  {
    request: RETRY_DATA_CLEAR,
    send: (): Promise<SessionResponseMapV2['retryDataClear']> => sendRequest(RETRY_DATA_CLEAR),
  },
];

beforeEach((): void => {
  sendMessageMock.mockReset();
  // Boundary cast: the fake implements only the runtime slice this channel uses.
  (globalThis as ChromeHost).chrome = { runtime: { sendMessage: sendMessageMock } };
});

afterEach((): void => {
  Reflect.deleteProperty(globalThis, 'chrome');
});

describe('v2 session request channel', (): void => {
  it('pins every v2 session request variant', (): void => {
    expectTypeOf<Extract<SessionRequestV2, { type: 'startSession' }>>().toEqualTypeOf<
      | { type: 'startSession'; config: SessionConfigV2 }
      | { type: 'startSession'; config: SessionConfigV2; workTabId: number; windowId: number }
    >();
    expectTypeOf<Extract<SessionRequestV2, { type: 'requestSessionEnd' }>>().toEqualTypeOf<{
      type: 'requestSessionEnd';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'openEndGate' }>>().toEqualTypeOf<{
      type: 'openEndGate';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'abandonGate' }>>().toEqualTypeOf<{
      type: 'abandonGate';
      expectedGate: GateState;
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'confirmGate' }>>().toEqualTypeOf<{
      type: 'confirmGate';
      expectedGate: GateState;
      typedPhrase: string | null;
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'openGate' }>>().toEqualTypeOf<{
      type: 'openGate';
      gate: 'pause' | 'unlockSite' | 'excludeSite';
      host: string | null;
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'forceEndGate' }>>().toEqualTypeOf<{
      type: 'forceEndGate';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'resumeFromPause' }>>().toEqualTypeOf<{
      type: 'resumeFromPause';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'startNextFocusEarly' }>>().toEqualTypeOf<{
      type: 'startNextFocusEarly';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'retryTransitionCleanup' }>>().toEqualTypeOf<{
      type: 'retryTransitionCleanup';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'retryClosureCleanup' }>>().toEqualTypeOf<{
      type: 'retryClosureCleanup';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'retryDataClear' }>>().toEqualTypeOf<{
      type: 'retryDataClear';
    }>();
    expectTypeOf<SessionRequestV2['type']>().toEqualTypeOf<
      | 'startSession'
      | 'requestSessionEnd'
      | 'openEndGate'
      | 'abandonGate'
      | 'confirmGate'
      | 'openGate'
      | 'forceEndGate'
      | 'resumeFromPause'
      | 'startNextFocusEarly'
      | 'retryTransitionCleanup'
      | 'retryClosureCleanup'
      | 'retryDataClear'
    >();
  });

  it('maps every request type to its v2 response', (): void => {
    expectTypeOf<SessionResponseMapV2['startSession']>().toEqualTypeOf<StartSessionResponseV2>();
    expectTypeOf<SessionResponseMapV2['requestSessionEnd']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['openEndGate']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['abandonGate']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['confirmGate']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['openGate']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['forceEndGate']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['resumeFromPause']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['startNextFocusEarly']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['retryTransitionCleanup']>().toEqualTypeOf<
      CommandResponseV2<RetryCleanupResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['retryClosureCleanup']>().toEqualTypeOf<
      CommandResponseV2<RetryCleanupResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['retryDataClear']>().toEqualTypeOf<
      CommandResponseV2<RetryCleanupResultCodeV2>
    >();
    expectTypeOf<keyof SessionResponseMapV2>().toEqualTypeOf<SessionRequestV2['type']>();
  });

  it('posts every request object unchanged and returns the resolved response', async (): Promise<void> => {
    let call: ChannelCall;
    for (call of CHANNEL_CALLS) {
      sendMessageMock.mockReset();
      const resolved: { ok: true; code: 'ok' } = { ok: true, code: 'ok' };
      sendMessageMock.mockResolvedValueOnce(resolved);

      const response: unknown = await call.send();

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0]).toHaveLength(1);
      expect(sendMessageMock.mock.calls[0]?.[0]).toBe(call.request);
      expect(response).toBe(resolved);
    }
  });

  it('infers the mapped response type for each response family', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({ ok: true, code: 'ok' });

    // Asserted on the call, not on an annotated local: annotating first would make every
    // one of these true whatever the sender infers.
    expectTypeOf(sendRequest(START_SESSION)).resolves.toEqualTypeOf<StartSessionResponseV2>();
    expectTypeOf(sendRequest(CONFIRM_GATE)).resolves.toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf(sendRequest(RETRY_DATA_CLEAR)).resolves.toEqualTypeOf<
      CommandResponseV2<RetryCleanupResultCodeV2>
    >();

    const start: StartSessionResponseV2 = await sendRequest(START_SESSION);
    const command: CommandResponseV2<SessionCommandResultCodeV2> = await sendRequest(CONFIRM_GATE);
    const retry: CommandResponseV2<RetryCleanupResultCodeV2> = await sendRequest(RETRY_DATA_CLEAR);

    expect([start, command, retry]).toEqual([
      { ok: true, code: 'ok' },
      { ok: true, code: 'ok' },
      { ok: true, code: 'ok' },
    ]);
  });

  it('surfaces worker rejections verbatim instead of swallowing them', async (): Promise<void> => {
    const rejection: CommandResponseV2<SessionCommandResultCodeV2> = {
      ok: false,
      code: 'confirmation-mismatch',
      error: 'That phrase does not match.',
    };
    sendMessageMock.mockResolvedValueOnce(rejection);

    await expect(sendRequest(CONFIRM_GATE)).resolves.toBe(rejection);
  });

  it('propagates a failed runtime transport instead of resolving', async (): Promise<void> => {
    sendMessageMock.mockRejectedValueOnce(new Error('Receiving end does not exist.'));

    await expect(sendRequest(REQUEST_SESSION_END)).rejects.toThrow('Receiving end does not exist.');
  });
});
