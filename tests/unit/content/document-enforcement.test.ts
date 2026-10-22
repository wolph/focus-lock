// @vitest-environment jsdom
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentEnforcementHostV2 } from '../../../src/content/document-enforcement';
import { installDocumentEnforcement } from '../../../src/content/document-enforcement';
import { clearDocumentOverlay } from '../../../src/content/overlay-v2';
import type {
  ContentEnforcementResponse,
  DocumentEnforcementCommand,
  DocumentOverlayView,
  ResetEnforcementEpochCommand,
} from '../../../src/shared/enforcement-v2';
import { parseContentEnforcementResponse } from '../../../src/shared/enforcement-v2-validation';
import type { Verdict } from '../../../src/shared/types';

type StartingOverlay = Extract<DocumentOverlayView, { presentation: 'starting' }>;
type ActiveOverlay = Extract<DocumentOverlayView, { presentation: 'active' }>;
type ActiveCopy = ActiveOverlay['copy'];
type MessageListener = (
  message: unknown,
  respond: (response: ContentEnforcementResponse | undefined) => void,
) => void;

const NOW: number = 1_750_000_000_000;
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const OPERATION_A: string = '20000000-0000-4000-8000-000000000001';
const OPERATION_B: string = '20000000-0000-4000-8000-000000000002';
const OPERATION_C: string = '20000000-0000-4000-8000-000000000003';
const OPERATION_D: string = '20000000-0000-4000-8000-000000000004';
const EPOCH_A: string = '30000000-0000-4000-8000-000000000001';
const PROVENANCE: string = 'Blocked by Social media: example.com';
const UNTIL_STOPPED_TEXT: Extract<ActiveCopy['status'], { kind: 'until-stopped' }>['text'] =
  'Until stopped';
const STOPPED_TITLE: string = 'Locked - Focus Lock';
const BLOCKED_VERDICT: Verdict = {
  blocked: true,
  reason: 'category',
  categoryId: 'social',
  matchedPattern: 'example.com',
};
const CLEAR_VERDICT: Verdict = {
  blocked: false,
  reason: 'no-session',
  categoryId: null,
  matchedPattern: null,
};

interface Harness {
  scope: Record<string, unknown>;
  host: DocumentEnforcementHostV2;
  requestVerdict: Mock<(url: string, docState: 'fresh' | 'loaded') => Promise<unknown>>;
  listeners: MessageListener[];
}

let stopSpy: Mock<() => void>;
let observers: MutationObserver[];
/** Loops installed by earlier tests keep their pageshow listener on the shared jsdom window. */
const installed: Harness[] = [];

function activeCopy(overrides: Partial<ActiveCopy> = {}): ActiveCopy {
  return {
    status: { kind: 'until-stopped', text: UNTIL_STOPPED_TEXT },
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
    ...overrides,
  };
}

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
      bankMs: 300_000,
      bankAccrualPerMs: 0.2,
      bankCapMs: 300_000,
      pauseCostMs: 60_000,
      unlockCostMs: 120_000,
    },
    gate: null,
    activeUnlocks: [],
    attemptsToday: 2,
    stoppedPage: false,
    actions: { state: 'ready', end: 'request-end', pause: 'request-gate', unlock: 'request-gate' },
    copy: activeCopy(),
    ...overrides,
  };
}

function startingOverlay(overrides: Partial<StartingOverlay> = {}): StartingOverlay {
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
    ...overrides,
  };
}

function resetCommand(
  overrides: Partial<ResetEnforcementEpochCommand> = {},
): ResetEnforcementEpochCommand {
  return {
    version: 1,
    command: 'reset-enforcement-epoch',
    operationId: OPERATION_A,
    enforcementEpoch: EPOCH_A,
    documentId: 'document-1',
    expectedUrl: window.location.href,
    ...overrides,
  };
}

function enforcementCommand(
  overrides: Partial<DocumentEnforcementCommand> = {},
): DocumentEnforcementCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: OPERATION_B,
    enforcementEpoch: EPOCH_A,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    documentId: 'document-1',
    expectedUrl: window.location.href,
    presentation: 'active',
    verdict: BLOCKED_VERDICT,
    overlay: activeOverlay(),
    ...overrides,
  };
}

function startingCommand(
  overrides: Partial<DocumentEnforcementCommand> = {},
): DocumentEnforcementCommand {
  return enforcementCommand({
    operationId: OPERATION_C,
    sessionId: null,
    reservedSessionId: SESSION_ID,
    runtimeRevision: 0,
    presentation: 'starting',
    overlay: startingOverlay(),
    ...overrides,
  });
}

function clearCommand(
  overrides: Partial<DocumentEnforcementCommand> = {},
): DocumentEnforcementCommand {
  return enforcementCommand({
    operationId: OPERATION_D,
    presentation: 'clear',
    verdict: CLEAR_VERDICT,
    overlay: null,
    ...overrides,
  });
}

function newHarness(): Harness {
  const listeners: MessageListener[] = [];
  const scope: Record<string, unknown> = {};
  const requestVerdict: Mock<(url: string, docState: 'fresh' | 'loaded') => Promise<unknown>> =
    vi.fn(async (): Promise<unknown> => ({ commands: [] }));
  const host: DocumentEnforcementHostV2 = {
    scope,
    document,
    window,
    now: (): number => Date.now(),
    requestVerdict,
    addMessageListener: (listener: MessageListener): void => {
      listeners.push(listener);
    },
  };
  const harness: Harness = { scope, host, requestVerdict, listeners };
  installed.push(harness);
  return harness;
}

async function install(harness: Harness): Promise<void> {
  installDocumentEnforcement(harness.host);
  await vi.advanceTimersByTimeAsync(0);
}

function deliver(harness: Harness, message: unknown): (ContentEnforcementResponse | undefined)[] {
  const responses: (ContentEnforcementResponse | undefined)[] = [];
  const respond: (response: ContentEnforcementResponse | undefined) => void = (
    response: ContentEnforcementResponse | undefined,
  ): void => {
    responses.push(response);
  };
  for (const listener of harness.listeners) listener(message, respond);
  return responses;
}

function setReadyState(state: DocumentReadyState): void {
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    get: (): DocumentReadyState => state,
  });
}

function shadowRoot(): ShadowRoot | undefined {
  return (globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow;
}

function overlayText(): string {
  const root: ShadowRoot | undefined = shadowRoot();
  if (root === undefined) throw new Error('Focus Lock shadow root was not mounted');
  return root.textContent ?? '';
}

function panelNode(): Element {
  const root: ShadowRoot | undefined = shadowRoot();
  const panel: Element | null | undefined = root?.querySelector('.panel');
  if (panel === null || panel === undefined) throw new Error('overlay panel was not rendered');
  return panel;
}

beforeEach((): void => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW + 5_000);
  stopSpy = vi.fn<() => void>();
  vi.stubGlobal('stop', stopSpy);
  observers = [];
  const RealObserver: typeof MutationObserver = globalThis.MutationObserver;
  vi.stubGlobal(
    'MutationObserver',
    class TrackedObserver extends RealObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
});

afterEach((): void => {
  for (const harness of installed) harness.requestVerdict.mockResolvedValue({ commands: [] });
  clearDocumentOverlay();
  for (const observer of observers) observer.disconnect();
  Reflect.deleteProperty(document, 'readyState');
  document.documentElement.replaceChildren(
    document.createElement('head'),
    document.createElement('body'),
  );
  document.title = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('installDocumentEnforcement fresh navigation', () => {
  it('stops a blocked fresh document and renders the starting page', async (): Promise<void> => {
    setReadyState('loading');
    const harness: Harness = newHarness();
    harness.requestVerdict.mockResolvedValue({
      commands: [resetCommand(), startingCommand()],
    });

    await install(harness);

    expect(harness.requestVerdict).toHaveBeenCalledWith(window.location.href, 'fresh');
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(document.title).toBe(STOPPED_TITLE);
    expect(document.querySelector('body')).toBeNull();
    expect(overlayText()).toContain('Focus Lock is starting');
    expect(overlayText()).toContain('Applying your selected rules.');
  });

  it('leaves an allowed fresh document untouched', async (): Promise<void> => {
    setReadyState('loading');
    const harness: Harness = newHarness();
    harness.requestVerdict.mockResolvedValue({ commands: [resetCommand(), clearCommand()] });

    await install(harness);

    expect(stopSpy).not.toHaveBeenCalled();
    expect(document.querySelector('focus-lock-overlay')).toBeNull();
    expect(document.title).not.toBe(STOPPED_TITLE);
  });

  it('fails open when the worker cannot answer the navigation', async (): Promise<void> => {
    setReadyState('loading');
    const harness: Harness = newHarness();
    harness.requestVerdict.mockRejectedValue(new Error('receiving end does not exist'));

    await install(harness);

    expect(document.querySelector('focus-lock-overlay')).toBeNull();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('claims the document lifecycle once per scope', async (): Promise<void> => {
    const harness: Harness = newHarness();

    await install(harness);
    await install(harness);

    expect(harness.requestVerdict).toHaveBeenCalledOnce();
    expect(harness.listeners).toHaveLength(1);
  });

  it('stops a fresh blocked document whose page planted a host and the stopped title', async (): Promise<void> => {
    setReadyState('loading');
    document.title = STOPPED_TITLE;
    document.documentElement.append(document.createElement('focus-lock-overlay'));
    const harness: Harness = newHarness();
    harness.requestVerdict.mockResolvedValue({
      commands: [resetCommand(), startingCommand()],
    });

    await install(harness);

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(document.querySelector('body')).toBeNull();
    expect(overlayText()).toContain('Focus Lock is starting');
  });

  it('prunes a page-created host from a stopped document and keeps its own', async (): Promise<void> => {
    setReadyState('loading');
    const harness: Harness = newHarness();
    harness.requestVerdict.mockResolvedValue({
      commands: [resetCommand(), startingCommand()],
    });
    await install(harness);
    const own: Element | null = document.querySelector('focus-lock-overlay');

    const planted: HTMLElement = document.createElement('focus-lock-overlay');
    document.documentElement.append(planted);
    await vi.advanceTimersByTimeAsync(0);

    expect(planted.isConnected).toBe(false);
    expect(own?.isConnected).toBe(true);
    expect(document.querySelectorAll('focus-lock-overlay')).toHaveLength(1);
    expect(document.head?.isConnected).toBe(true);
  });

  it('re-appends its own host when the page detaches it', async (): Promise<void> => {
    setReadyState('loading');
    const harness: Harness = newHarness();
    harness.requestVerdict.mockResolvedValue({
      commands: [resetCommand(), startingCommand()],
    });
    await install(harness);
    const own: Element | null = document.querySelector('focus-lock-overlay');
    if (own === null) throw new Error('Focus Lock host was not mounted');

    own.remove();
    await vi.advanceTimersByTimeAsync(0);

    expect(own.isConnected).toBe(true);
  });

  it('re-appends a detached host before repainting a loaded document', async (): Promise<void> => {
    setReadyState('complete');
    const harness: Harness = newHarness();
    harness.requestVerdict.mockResolvedValue({
      commands: [resetCommand(), startingCommand()],
    });
    await install(harness);
    const own: Element | null = document.querySelector('focus-lock-overlay');
    if (own === null) throw new Error('Focus Lock host was not mounted');

    own.remove();
    deliver(harness, enforcementCommand());

    expect(own.isConnected).toBe(true);
    expect(overlayText()).toContain(UNTIL_STOPPED_TEXT);
  });
});

describe('installDocumentEnforcement command loop', () => {
  it('ignores a message the command parser rejects', async (): Promise<void> => {
    const harness: Harness = newHarness();
    await install(harness);

    expect(deliver(harness, { type: 'applyBlock', verdict: BLOCKED_VERDICT })).toHaveLength(0);
    expect(deliver(harness, null)).toHaveLength(0);
    expect(document.querySelector('focus-lock-overlay')).toBeNull();
  });

  it('answers reset-required for an enforcement command with no epoch handshake', async (): Promise<void> => {
    const harness: Harness = newHarness();
    await install(harness);

    const responses: (ContentEnforcementResponse | undefined)[] = deliver(
      harness,
      enforcementCommand(),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]?.disposition).toBe('reset-required');
    expect(document.querySelector('focus-lock-overlay')).toBeNull();
  });

  it('answers epoch-reset then applied and renders the until-stopped copy', async (): Promise<void> => {
    const harness: Harness = newHarness();
    await install(harness);

    const reset: (ContentEnforcementResponse | undefined)[] = deliver(harness, resetCommand());
    const applied: (ContentEnforcementResponse | undefined)[] = deliver(
      harness,
      enforcementCommand(),
    );

    expect(reset[0]?.disposition).toBe('epoch-reset');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.disposition).toBe('applied');
    expect(parseContentEnforcementResponse(applied[0])).not.toBeNull();
    expect(overlayText()).toContain(UNTIL_STOPPED_TEXT);
    expect(overlayText()).toContain('End session');
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('answers stale-command for a lower tuple and keeps the rendered view', async (): Promise<void> => {
    const harness: Harness = newHarness();
    await install(harness);
    deliver(harness, resetCommand());
    deliver(harness, enforcementCommand());
    const panel: Element = panelNode();

    const responses: (ContentEnforcementResponse | undefined)[] = deliver(
      harness,
      enforcementCommand({ operationId: OPERATION_D, runtimeRevision: 6 }),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]?.disposition).toBe('stale-command');
    expect(panelNode()).toBe(panel);
    expect(overlayText()).toContain('Finish the release notes');
  });

  it('answers nothing for an equal tuple carrying a different view', async (): Promise<void> => {
    const harness: Harness = newHarness();
    await install(harness);
    deliver(harness, resetCommand());
    deliver(harness, enforcementCommand());
    const panel: Element = panelNode();

    const responses: (ContentEnforcementResponse | undefined)[] = deliver(
      harness,
      enforcementCommand({
        operationId: OPERATION_D,
        overlay: activeOverlay({
          attemptsToday: 9,
          copy: activeCopy({ intention: 'Ship the beta' }),
        }),
      }),
    );

    expect(responses).toEqual([undefined]);
    expect(panelNode()).toBe(panel);
    expect(overlayText()).toContain('Finish the release notes');
    expect(overlayText()).not.toContain('Ship the beta');
  });

  it('does not re-render a replayed command after a worker restart', async (): Promise<void> => {
    const harness: Harness = newHarness();
    await install(harness);
    deliver(harness, resetCommand());
    deliver(harness, enforcementCommand());
    const panel: Element = panelNode();

    const responses: (ContentEnforcementResponse | undefined)[] = deliver(
      harness,
      enforcementCommand(),
    );

    expect(responses[0]?.disposition).toBe('applied');
    expect(panelNode()).toBe(panel);
  });

  it('clears the overlay for a clear command with a higher runtime revision', async (): Promise<void> => {
    const harness: Harness = newHarness();
    await install(harness);
    deliver(harness, resetCommand());
    deliver(harness, enforcementCommand());

    const responses: (ContentEnforcementResponse | undefined)[] = deliver(
      harness,
      clearCommand({ runtimeRevision: 8 }),
    );

    expect(responses[0]?.disposition).toBe('applied');
    expect(document.querySelector('focus-lock-overlay')).toBeNull();
  });

  it('clears the overlay for an allowed verdict that carries no view', async (): Promise<void> => {
    const harness: Harness = newHarness();
    await install(harness);
    deliver(harness, resetCommand());
    deliver(harness, enforcementCommand());

    const responses: (ContentEnforcementResponse | undefined)[] = deliver(
      harness,
      enforcementCommand({
        operationId: OPERATION_D,
        runtimeRevision: 8,
        verdict: { blocked: false, reason: 'unlock', categoryId: null, matchedPattern: 'x.com' },
        overlay: null,
      }),
    );

    expect(responses[0]?.disposition).toBe('applied');
    expect(document.querySelector('focus-lock-overlay')).toBeNull();
  });

  it('drops a hostile command before the state machine sees it', async (): Promise<void> => {
    const harness: Harness = newHarness();
    await install(harness);
    deliver(harness, resetCommand());
    deliver(harness, enforcementCommand());
    const panel: Element = panelNode();
    const hostileStatus: unknown = new Proxy(
      { kind: 'until-stopped', text: UNTIL_STOPPED_TEXT },
      {
        getOwnPropertyDescriptor(): PropertyDescriptor {
          throw new Error('hostile status copy');
        },
      },
    );
    const overlay: ActiveOverlay = activeOverlay();
    const hostile: unknown = {
      ...enforcementCommand({ operationId: OPERATION_D, runtimeRevision: 9 }),
      overlay: { ...overlay, copy: { ...overlay.copy, status: hostileStatus } },
    };

    const responses: (ContentEnforcementResponse | undefined)[] = deliver(harness, hostile);

    expect(responses).toHaveLength(0);
    expect(panelNode()).toBe(panel);
  });

  it('re-reads the work target for a workTargetChanged message and answers nothing', async (): Promise<void> => {
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (): Promise<unknown> => ({
        ok: true,
        sessionId: SESSION_ID,
        state: 'missing',
        title: null,
      }),
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const harness: Harness = newHarness();
    await install(harness);
    deliver(harness, resetCommand());
    deliver(harness, enforcementCommand());
    await vi.advanceTimersByTimeAsync(0);
    const before: number = sendMessage.mock.calls.length;

    const responses: (ContentEnforcementResponse | undefined)[] = deliver(harness, {
      type: 'workTargetChanged',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(responses).toEqual([]);
    expect(sendMessage.mock.calls.length).toBe(before + 1);
    expect(sendMessage.mock.calls.at(-1)?.[0]).toEqual({ type: 'getWorkTarget' });
    expect(harness.requestVerdict.mock.calls).toHaveLength(1);
  });

  it('re-requests the verdict for a reevaluate broadcast and a persisted pageshow', async (): Promise<void> => {
    const harness: Harness = newHarness();
    await install(harness);

    deliver(harness, { type: 'reevaluate' });
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.requestVerdict.mock.calls).toEqual([
      [window.location.href, 'loaded'],
      [window.location.href, 'loaded'],
      [window.location.href, 'loaded'],
    ]);
    expect(stopSpy).not.toHaveBeenCalled();
  });
});
