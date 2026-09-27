import { describe, expect, it } from 'vitest';
import type {
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from '../../../src/background/enforcement-persistence-v2';
import { validateDetachedFrozenDocumentCommand } from '../../../src/background/enforcement-persistence-v2-validation';
import type {
  ActiveViewInputV2,
  DocumentCommandInputV2,
  StartingViewInputV2,
} from '../../../src/background/overlay-view-v2';
import {
  buildActiveOverlayView,
  buildFrozenDocumentCommandV2,
  buildFrozenEpochResetCommandV2,
  buildStartingOverlayView,
  formatLockedUntilV2,
  overlayEndActionLabelV2,
  overlayEndActionV2,
} from '../../../src/background/overlay-view-v2';
import { DEFAULT_LISTS, rulesFromLists } from '../../../src/shared/constants';
import type { DocumentOverlayView } from '../../../src/shared/enforcement-v2';
import {
  parseResetEnforcementEpochCommand,
  validateDetachedDocumentOverlayView,
} from '../../../src/shared/enforcement-v2-validation';
import { CoreError } from '../../../src/shared/errors';
import type {
  CycleConfig,
  GateState,
  SessionConfigV2,
  SessionDuration,
  SessionStateV2,
  SiteUnlock,
  Strictness,
  Verdict,
} from '../../../src/shared/types';
import { verdictLabel } from '../../../src/shared/verdict-label';

type StartingOverlay = Extract<DocumentOverlayView, { presentation: 'starting' }>;
type ActiveOverlay = Extract<DocumentOverlayView, { presentation: 'active' }>;
type ActiveEconomy = ActiveViewInputV2['economy'];

const NOW: number = 1_750_000_000_000;
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const OTHER_SESSION_ID: string = '10000000-0000-4000-8000-000000000002';
const OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';
const DOCUMENT_ID: string = 'document-1';
const EXPECTED_URL: string = 'https://example.com/path';
const BLOCKED_VERDICT: Verdict = {
  blocked: true,
  reason: 'category',
  categoryId: 'social',
  matchedPattern: 'example.com',
};
const ALLOWED_VERDICT: Verdict = {
  blocked: false,
  reason: 'unlock',
  categoryId: null,
  matchedPattern: 'example.com',
};
const NO_SESSION_VERDICT: Verdict = {
  blocked: false,
  reason: 'no-session',
  categoryId: null,
  matchedPattern: null,
};

function expectInvalidRule(run: () => unknown): void {
  expect(run).toThrow(CoreError);
  try {
    run();
    expect.unreachable('expected an invalid-rule CoreError');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe('invalid-rule');
  }
}

function sessionConfig(overrides: Partial<SessionConfigV2> = {}): SessionConfigV2 {
  return {
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'timed', minutes: 25 },
    cycling: null,
    intention: 'Finish the release notes',
    source: 'manual',
    scheduleOccurrence: null,
    rules: rulesFromLists(DEFAULT_LISTS),
    ...overrides,
  };
}

function timedSession(config: Partial<SessionConfigV2> = {}): SessionStateV2 {
  const merged: SessionConfigV2 = sessionConfig(config);
  const startedAt: number = NOW - 60_000;
  const minutes: number = merged.duration.kind === 'timed' ? merged.duration.minutes : 25;
  return {
    version: 2,
    sessionId: SESSION_ID,
    config: merged,
    startedAt,
    sessionEndsAt: startedAt + minutes * 60_000,
    phase: 'focus',
    phaseStartedAt: startedAt,
    phaseEndsAt: NOW + 60_000,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 60_000,
  };
}

function untilStoppedSession(config: Partial<SessionConfigV2> = {}): SessionStateV2 {
  return {
    ...timedSession({ duration: { kind: 'until-stopped' }, ...config }),
    sessionEndsAt: null,
    phaseEndsAt: null,
  };
}

function economy(overrides: Partial<ActiveEconomy> = {}): ActiveEconomy {
  return {
    bankMs: 60_000,
    bankAccrualPerMs: 1 / 6,
    bankCapMs: 300_000,
    pauseCostMs: 60_000,
    unlockCostMs: 120_000,
    ...overrides,
  };
}

function activeInput(overrides: Partial<ActiveViewInputV2> = {}): ActiveViewInputV2 {
  return {
    targetUrl: EXPECTED_URL,
    capturedAt: NOW,
    theme: 'dark',
    session: timedSession(),
    economy: economy(),
    gate: null,
    activeUnlocks: [],
    attemptsToday: 2,
    stoppedPage: false,
    verdict: BLOCKED_VERDICT,
    ...overrides,
  };
}

describe('unlock gate document binding', (): void => {
  it.each([
    ['https://www.reddit.com/r/test', 'reddit.com', true],
    ['https://facebook.com', 'reddit.com', false],
    ['https://127.0.0.1/path', '127.0.0.1', true],
    ['https://127.0.0.2', '127.0.0.1', false],
    ['http://localhost/path', 'localhost', true],
    ['http://[::1]/path', '[::1]', true],
    ['http://[::2]/path', '[::1]', false],
    ['invalid', 'localhost', false],
  ])('binds %s to %s: %s', (targetUrl: string, host: string, visible: boolean): void => {
    const view: ActiveOverlay = buildActiveOverlayView(
      activeInput({ targetUrl, gate: gateState({ kind: 'unlockSite', host }) }),
    ) as ActiveOverlay;
    expect(view.gate !== null).toBe(visible);
    expect(view.actions.state).toBe(visible ? 'gate' : 'ready');
    expect(view.copy.gateTitle).toBe(visible ? `Unlock ${host} 2:00` : null);
  });
});

function startingInput(overrides: Partial<StartingViewInputV2> = {}): StartingViewInputV2 {
  return {
    capturedAt: NOW,
    theme: 'dark',
    stoppedPage: false,
    verdict: BLOCKED_VERDICT,
    ...overrides,
  };
}

function gateState(overrides: Partial<GateState> = {}): GateState {
  return {
    kind: 'pause',
    host: null,
    openedAt: NOW - 5_000,
    readyAt: NOW + 5_000,
    requiredPhrase: 'I am pausing blocking',
    forceEndAvailable: false,
    ...overrides,
  };
}

function activeView(overrides: Partial<ActiveViewInputV2> = {}): ActiveOverlay {
  const view: DocumentOverlayView = buildActiveOverlayView(activeInput(overrides));
  if (view.presentation !== 'active') throw new Error('expected an active overlay view');
  return view;
}

function startingView(overrides: Partial<StartingViewInputV2> = {}): StartingOverlay {
  const view: DocumentOverlayView = buildStartingOverlayView(startingInput(overrides));
  if (view.presentation !== 'starting') throw new Error('expected a starting overlay view');
  return view;
}

function commandInput(overrides: Partial<DocumentCommandInputV2> = {}): DocumentCommandInputV2 {
  return {
    tabId: 11,
    documentId: DOCUMENT_ID,
    expectedUrl: EXPECTED_URL,
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: 4,
    runtimeRevision: 7,
    verdict: BLOCKED_VERDICT,
    presentation: 'active',
    overlay: activeView(),
    ...overrides,
  };
}

describe('buildStartingOverlayView', () => {
  it('carries the exact starting copy, the verdict provenance, and no enabled action', () => {
    const view: StartingOverlay = startingView();

    expect(view.version).toBe(1);
    expect(view.presentation).toBe('starting');
    expect(view.capturedAt).toBe(NOW);
    expect(view.theme).toBe('dark');
    expect(view.copy.title).toBe('Focus Lock is starting');
    expect(view.copy.detail).toBe('Applying your selected rules.');
    expect(view.copy.verdictProvenance).toBe(verdictLabel(BLOCKED_VERDICT));
    expect(view.copy.stoppedPage).toBeNull();
    expect(view.actions.end).toBe('hidden');
    expect(validateDetachedDocumentOverlayView(view)).toBe(true);
  });

  it('adds the stopped-page copy only for a stopped document', () => {
    const stopped: StartingOverlay = startingView({ stoppedPage: true });

    expect(stopped.stoppedPage).toBe(true);
    expect(stopped.copy.stoppedPage).toBe(
      'This page did not load. It will load by itself when the session ends.',
    );
    expect(validateDetachedDocumentOverlayView(stopped)).toBe(true);
    expect(startingView({ stoppedPage: false }).copy.stoppedPage).toBeNull();
  });

  it('rejects a capture time outside the safe timestamp range', () => {
    expectInvalidRule(
      (): DocumentOverlayView => buildStartingOverlayView(startingInput({ capturedAt: -1 })),
    );
  });
});

describe('buildActiveOverlayView timed focus', () => {
  it('builds the timed row with its locked-until status and spend copy', () => {
    const view: ActiveOverlay = activeView();
    const session: SessionStateV2 = timedSession();
    const lockedUntil: string = formatLockedUntilV2(session.sessionEndsAt ?? 0);

    expect(view.sessionId).toBe(SESSION_ID);
    expect(view.theme).toBe('dark');
    expect(view.phase).toBe('focus');
    expect(view.mode).toBe('blacklist');
    expect(view.strictness).toBe('flexible');
    expect(view.duration).toEqual({ kind: 'timed', minutes: 25 });
    expect(view.timing).toEqual({
      capturedAt: NOW,
      phaseStartedAt: session.phaseStartedAt,
      phaseEndsAt: session.phaseEndsAt,
      sessionEndsAt: session.sessionEndsAt,
    });
    expect(view.copy.status).toEqual({ kind: 'timed', text: `Locked until ${lockedUntil}` });
    expect(view.copy.lockedUntil).toBe(lockedUntil);
    expect(view.copy.nextStep).toBe('Your next step');
    expect(view.copy.remainingSuffix).toBe('left in this session');
    expect(view.copy.minuteLabel).toBe('min');
    expect(view.copy.underMinuteLabel).toBe('Less than a minute');
    expect(view.copy.updatingLabel).toBe('Updating session');
    expect(view.copy.pauseAction).toBe('Unlock all sites 1:00 - costs 1:00 credit');
    expect(view.copy.unlockAction).toBe('Unlock this site 2:00 - costs 2:00 credit');
    expect(view.copy.bankUnit).toBe('site access credit');
    expect(view.copy.endAction).toBe('End session');
    expect(view.copy.bankWaitPrefix).toBe('Ready in');
    expect('bankWaitFallback' in view.copy).toBe(false);
    expect(view.copy.accessSummary).toBe('Need a break or site access?');
    expect(view.copy.backToWork).toBe('Back to work');
    expect(view.copy.chooseWorkTab).toBe('Choose a work tab');
    expect(view.copy.changeWorkTab).toBe('Change work tab');
    expect(view.copy.accessNote).toBe('You can step away at any time. Site access uses credit.');
    expect(view.copy.costAboveLimit).toBe('Cost exceeds the credit limit');
    expect(view.copy.earningOff).toBe('Credit earning is turned off');
    expect(view.copy.notEnoughFocus).toBe('Not enough time in this focus block');
    expect(view.copy.gateSaid).toBeNull();
    expect(view.copy.gateBack).toBe('Keep focusing');
    expect(view.copy.gatePhraseLabel).toBe('Type this to confirm:');
    expect(view.copy.transportError).toBe('Focus Lock could not update this action. Try again.');
    expect(view.copy.verdictProvenance).toBe(verdictLabel(BLOCKED_VERDICT));
    expect(view.actions).toEqual({
      state: 'ready',
      end: 'request-end',
      pause: 'request-gate',
      unlock: 'request-gate',
    });
    expect(validateDetachedDocumentOverlayView(view)).toBe(true);
  });

  it('names the wall clock the session is locked until', () => {
    const capturedAt: number = new Date(2026, 8, 3, 14, 0).getTime();
    const session: SessionStateV2 = {
      ...timedSession(),
      startedAt: capturedAt - 60_000,
      phaseStartedAt: capturedAt - 60_000,
      phaseEndsAt: capturedAt + 60_000,
      sessionEndsAt: new Date(2026, 8, 3, 14, 35).getTime(),
    };

    const view: ActiveOverlay = activeView({ capturedAt, session });

    expect(view.copy.lockedUntil).toBe('14:35');
    expect(view.copy.status).toEqual({ kind: 'timed', text: 'Locked until 14:35' });
    expect(validateDetachedDocumentOverlayView(view)).toBe(true);
  });

  it('hides the end action for a Hard session and routes Friction through its gate', () => {
    const hard: ActiveOverlay = activeView({ session: timedSession({ strictness: 'hard' }) });
    const friction: ActiveOverlay = activeView({
      session: timedSession({ strictness: 'friction' }),
    });

    expect(hard.actions.end).toBe('hidden');
    // Not `request-end`: `requestSessionEnd` is refused for any strictness but Flexible, so a
    // Friction overlay asking for it renders a control the worker answers with an error forever.
    expect(friction.actions.end).toBe('open-end-gate');
    expect(validateDetachedDocumentOverlayView(hard)).toBe(true);
    expect(validateDetachedDocumentOverlayView(friction)).toBe(true);
  });

  it('carries the economy row and the live counters it was given', () => {
    const unlocks: SiteUnlock[] = [{ host: 'example.com', until: NOW + 30_000 }];
    const view: ActiveOverlay = activeView({ activeUnlocks: unlocks, attemptsToday: 1 });

    expect(view.economy).toEqual(economy());
    expect(view.activeUnlocks).toEqual(unlocks);
    expect(view.attemptsToday).toBe(1);
    // The count still travels, because every blocked attempt repaints every open page, but the
    // lock screen no longer says it, so the copy carries no sentence for it.
    expect('attempts' in view.copy).toBe(false);
  });

  it('trims the intention and writes the next-step prompt for a blank one', () => {
    expect(activeView().copy.intention).toBe('Finish the release notes');
    expect(
      activeView({ session: timedSession({ intention: '  Ship the beta  ' }) }).copy.intention,
    ).toBe('Ship the beta');
    expect(activeView({ session: timedSession({ intention: '   ' }) }).copy.intention).toBe(
      'Continue your current task',
    );
  });

  it('names the break only when one follows this focus block before the session ends', () => {
    const cycling: CycleConfig = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };
    const phaseEndsAt: number = NOW + 60_000;
    const cycled: (cycleIndex: number, sessionEndsAt: number) => ActiveOverlay = (
      cycleIndex: number,
      sessionEndsAt: number,
    ): ActiveOverlay =>
      activeView({
        session: { ...timedSession({ cycling }), cycleIndex, phaseEndsAt, sessionEndsAt },
      });

    expect(cycled(0, phaseEndsAt + 5 * 60_000 + 60_000).copy.remainingSuffix).toBe(
      'until your break',
    );
    // The machine completes early when the final break would leave no focus time behind it.
    expect(cycled(0, phaseEndsAt + 5 * 60_000).copy.remainingSuffix).toBe('left in this session');
    // The fourth block's break is the long one, and it runs past this shorter session end.
    expect(cycled(3, phaseEndsAt + 10 * 60_000).copy.remainingSuffix).toBe('left in this session');
    expect(cycled(3, phaseEndsAt + 16 * 60_000).copy.remainingSuffix).toBe('until your break');
    expect(
      activeView({
        session: {
          ...timedSession({ cycling: { ...cycling, shortBreakMin: 0 } }),
          phaseEndsAt,
          sessionEndsAt: phaseEndsAt + 60_000,
        },
      }).copy.remainingSuffix,
    ).toBe('left in this session');
    expect(activeView({ session: timedSession() }).copy.remainingSuffix).toBe(
      'left in this session',
    );
  });

  it('marks a stopped document with its exact copy', () => {
    const view: ActiveOverlay = activeView({ stoppedPage: true });

    expect(view.stoppedPage).toBe(true);
    expect(view.copy.stoppedPage).toBe(
      'This page did not load. It will load by itself when the session ends.',
    );
    expect(validateDetachedDocumentOverlayView(view)).toBe(true);
  });
});

describe('buildActiveOverlayView until-stopped focus', () => {
  it('builds the Flexible indefinite row with an immediate End', () => {
    const view: ActiveOverlay = activeView({ session: untilStoppedSession() });

    expect(view.duration).toEqual({ kind: 'until-stopped' });
    expect(view.copy.status).toEqual({ kind: 'until-stopped', text: 'Until stopped' });
    expect(view.copy.lockedUntil).toBeNull();
    expect(view.copy.remainingSuffix).toBeNull();
    expect(view.timing.phaseEndsAt).toBeNull();
    expect(view.timing.sessionEndsAt).toBeNull();
    expect(view.actions.end).toBe('request-end');
    expect(view.copy.endAction).toBe('End session');
    expect(validateDetachedDocumentOverlayView(view)).toBe(true);
  });

  it('routes a Friction indefinite row through its gate and labels the action Unlock', () => {
    const closed: ActiveOverlay = activeView({
      session: untilStoppedSession({ strictness: 'friction' }),
    });
    const open: ActiveOverlay = activeView({
      session: untilStoppedSession({ strictness: 'friction' }),
      gate: gateState({ kind: 'cancel', requiredPhrase: 'I am ending this session' }),
    });

    expect(closed.actions.end).toBe('open-end-gate');
    expect(closed.copy.endAction).toBe('Unlock');
    expect(closed.copy.gateConfirm).toBeNull();
    expect(open.actions).toEqual({
      state: 'gate',
      end: 'hidden',
      pause: 'hidden',
      unlock: 'hidden',
    });
    expect(open.copy.endAction).toBe('Unlock');
    expect(open.copy.gateTitle).toBe('Unlock');
    expect(open.copy.gateConfirm).toBe('Unlock');
    expect(validateDetachedDocumentOverlayView(closed)).toBe(true);
    expect(validateDetachedDocumentOverlayView(open)).toBe(true);
  });
});

describe('buildActiveOverlayView gate rows', () => {
  it('hides every ordinary action and names the gate for a pause gate', () => {
    const view: ActiveOverlay = activeView({ gate: gateState() });

    expect(view.actions).toEqual({
      state: 'gate',
      end: 'hidden',
      pause: 'hidden',
      unlock: 'hidden',
    });
    expect(view.copy.gateTitle).toBe('Unlock all sites 1:00 - costs 1:00 credit');
    expect(view.copy.gateConfirm).toBe('Unlock all sites');
    expect(view.copy.gateSaid).toBe('You said: Finish the release notes');
    expect(view.gate).toEqual(gateState());
    expect(validateDetachedDocumentOverlayView(view)).toBe(true);
  });

  it('builds a cancel gate opened after the frozen capture time', () => {
    // `capturedAt` is a frozen anchor, not a clock reading. A committed Friction End opens its
    // cancel gate later and freezes a replacement view that keeps the original anchor.
    const later: GateState = gateState({
      kind: 'cancel',
      requiredPhrase: 'I am ending this session',
      openedAt: NOW + 3_000,
      readyAt: NOW + 8_000,
    });
    const view: ActiveOverlay = activeView({ gate: later });

    expect(view.gate).toEqual(later);
    expect(view.timing.capturedAt).toBe(NOW);
    expect(validateDetachedDocumentOverlayView(view)).toBe(true);
  });

  it('builds a first freeze exactly at the phase end', () => {
    const view: ActiveOverlay = activeView({ capturedAt: NOW + 60_000 });

    expect(view.timing.capturedAt).toBe(view.timing.phaseEndsAt);
    expect(validateDetachedDocumentOverlayView(view)).toBe(true);
  });

  it('names the unlock gate by host and the cancel gate by session', () => {
    const unlock: ActiveOverlay = activeView({
      gate: gateState({
        kind: 'unlockSite',
        host: 'example.com',
        requiredPhrase: 'I am allowing this site: example.com',
      }),
    });
    const cancel: ActiveOverlay = activeView({
      gate: gateState({
        kind: 'cancel',
        requiredPhrase: 'I am ending this session before: Finish the release notes',
      }),
    });

    expect(unlock.copy.gateTitle).toBe('Unlock example.com 2:00');
    // The gate contract binds a non-blank host to this kind, so an unlock gate without one is an
    // input no validator produced. The builder refuses it rather than borrowing "this site".
    expect(
      (): ActiveOverlay =>
        activeView({
          gate: gateState({
            kind: 'unlockSite',
            host: null,
            requiredPhrase: 'I am allowing this site: example.com',
          }),
        }),
    ).toThrow('a site gate names the host it acts on');
    expect(unlock.copy.gateConfirm).toBe('Unlock this site');
    expect(cancel.copy.gateTitle).toBe('End this session');
    expect(cancel.copy.gateConfirm).toBe('End the session');
    expect(cancel.copy.gateForceEnd).toBe('Ignore timeout and end anyway');
    expect(unlock.copy.gateForceEnd).toBe('Ignore timeout and end anyway');
    expect(validateDetachedDocumentOverlayView(unlock)).toBe(true);
    expect(validateDetachedDocumentOverlayView(cancel)).toBe(true);
  });

  it('quotes the intention in the gate only when one was given', () => {
    const blank: ActiveOverlay = activeView({
      gate: gateState(),
      session: timedSession({ intention: '   ' }),
    });

    expect(blank.copy.intention).toBe('Continue your current task');
    expect(blank.copy.gateSaid).toBeNull();
    expect(activeView({ session: timedSession({ intention: '   ' }) }).copy.gateSaid).toBeNull();
    expect(validateDetachedDocumentOverlayView(blank)).toBe(true);
  });

  it('leaves the gate copy null when no gate is open', () => {
    const view: ActiveOverlay = activeView();

    expect(view.gate).toBeNull();
    expect(view.copy.gateTitle).toBeNull();
    expect(view.copy.gateConfirm).toBeNull();
    expect(view.copy.gateSaid).toBeNull();
    expect(view.actions.state).toBe('ready');
  });

  it('hides the end action of a timed Flexible session while a gate is open', () => {
    const view: ActiveOverlay = activeView({ gate: gateState({ kind: 'cancel' }) });

    expect(view.actions.end).toBe('hidden');
    expect(validateDetachedDocumentOverlayView(view)).toBe(true);
  });
});

describe('buildActiveOverlayView refusals', () => {
  it('refuses a session that is not in focus', () => {
    const paused: SessionStateV2 = {
      ...timedSession(),
      phase: 'paused',
      pausedFrom: { phase: 'focus', phaseEndsAt: NOW + 60_000 },
    };
    const onBreak: SessionStateV2 = {
      ...timedSession({
        cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
      }),
      phase: 'break',
    };

    expectInvalidRule(
      (): DocumentOverlayView => buildActiveOverlayView(activeInput({ session: paused })),
    );
    expectInvalidRule(
      (): DocumentOverlayView => buildActiveOverlayView(activeInput({ session: onBreak })),
    );
  });

  it('refuses an indefinite pause, which never receives an active view', () => {
    const paused: SessionStateV2 = {
      ...untilStoppedSession(),
      phase: 'paused',
      phaseEndsAt: NOW + 60_000,
      pausedFrom: { phase: 'focus', phaseEndsAt: null },
    };

    expectInvalidRule(
      (): DocumentOverlayView => buildActiveOverlayView(activeInput({ session: paused })),
    );
  });

  it('refuses a capture time after the phase end', () => {
    expectInvalidRule(
      (): DocumentOverlayView => buildActiveOverlayView(activeInput({ capturedAt: NOW + 61_000 })),
    );
  });

  it('refuses a negative attempt count', () => {
    expectInvalidRule(
      (): DocumentOverlayView => buildActiveOverlayView(activeInput({ attemptsToday: -1 })),
    );
  });

  it('refuses an unlock that expires before the capture time', () => {
    expectInvalidRule(
      (): DocumentOverlayView =>
        buildActiveOverlayView(
          activeInput({ activeUnlocks: [{ host: 'example.com', until: NOW - 1 }] }),
        ),
    );
  });

  it('refuses a Hard until-stopped session', () => {
    expectInvalidRule(
      (): DocumentOverlayView =>
        buildActiveOverlayView(
          activeInput({ session: untilStoppedSession({ strictness: 'hard' }) }),
        ),
    );
  });
});

describe('buildActiveOverlayView detachment', () => {
  it('detaches the gate and the unlock list from the caller', () => {
    const gate: GateState = gateState();
    const unlocks: SiteUnlock[] = [{ host: 'example.com', until: NOW + 30_000 }];
    const view: ActiveOverlay = activeView({ gate, activeUnlocks: unlocks });

    gate.readyAt = NOW + 900_000;
    unlocks.push({ host: 'other.example', until: NOW + 60_000 });
    if (unlocks[0] !== undefined) unlocks[0].host = 'mutated.example';

    expect(view.gate?.readyAt).toBe(NOW + 5_000);
    expect(view.activeUnlocks).toEqual([{ host: 'example.com', until: NOW + 30_000 }]);
  });
});

describe('formatLockedUntilV2 and overlayEndActionV2', () => {
  it('formats a local wall clock with a padded minute', () => {
    expect(formatLockedUntilV2(new Date(2026, 8, 3, 9, 5).getTime())).toBe('9:05');
    expect(formatLockedUntilV2(new Date(2026, 8, 3, 14, 35).getTime())).toBe('14:35');
  });

  it('refuses a locked-until time outside the safe timestamp range', () => {
    expectInvalidRule((): string => formatLockedUntilV2(Number.NaN));
  });

  it('offers the end action by strictness alone and labels a Friction indefinite page Unlock', () => {
    const timed: SessionDuration = { kind: 'timed', minutes: 25 };
    const indefinite: SessionDuration = { kind: 'until-stopped' };
    const strictnesses: Strictness[] = ['flexible', 'friction', 'hard'];

    expect(strictnesses.map((s: Strictness): string => overlayEndActionV2(s))).toEqual([
      'request-end',
      'open-end-gate',
      'hidden',
    ]);
    expect(strictnesses.map((s: Strictness): string => overlayEndActionLabelV2(s, timed))).toEqual([
      'End session',
      'End session',
      'End session',
    ]);
    expect(
      strictnesses.map((s: Strictness): string => overlayEndActionLabelV2(s, indefinite)),
    ).toEqual(['End session', 'Unlock', 'End session']);
  });
});

describe('buildFrozenDocumentCommandV2', () => {
  it('freezes an active command that carries its own session view', () => {
    const command: FrozenDocumentCommand = buildFrozenDocumentCommandV2(commandInput());

    expect(command.version).toBe(1);
    expect(command.command).toBe('apply-enforcement');
    expect(command.tabId).toBe(11);
    expect(command.documentId).toBe(DOCUMENT_ID);
    expect(command.expectedUrl).toBe(EXPECTED_URL);
    expect(command.presentation).toBe('active');
    expect(command.verdict).toEqual(BLOCKED_VERDICT);
    expect(command.overlay).toEqual(activeView());
    expect(validateDetachedFrozenDocumentCommand(command)).toBe(true);
  });

  it('freezes a starting command from the reserved session identity', () => {
    const command: FrozenDocumentCommand = buildFrozenDocumentCommandV2(
      commandInput({
        sessionId: null,
        reservedSessionId: SESSION_ID,
        runtimeRevision: 0,
        presentation: 'starting',
        overlay: startingView(),
      }),
    );

    expect(command.sessionId).toBeNull();
    expect(command.reservedSessionId).toBe(SESSION_ID);
    expect(validateDetachedFrozenDocumentCommand(command)).toBe(true);
  });

  it('freezes a clear command with a null overlay and the canonical no-session verdict', () => {
    const command: FrozenDocumentCommand = buildFrozenDocumentCommandV2(
      commandInput({ presentation: 'clear', verdict: NO_SESSION_VERDICT, overlay: null }),
    );

    expect(command.overlay).toBeNull();
    expect(command.verdict).toEqual(NO_SESSION_VERDICT);
    expect(validateDetachedFrozenDocumentCommand(command)).toBe(true);
  });

  it('freezes an allowed verdict without a view', () => {
    const command: FrozenDocumentCommand = buildFrozenDocumentCommandV2(
      commandInput({ presentation: 'active', verdict: ALLOWED_VERDICT, overlay: null }),
    );

    expect(command.overlay).toBeNull();
    expect(validateDetachedFrozenDocumentCommand(command)).toBe(true);
  });

  it('refuses a clear command that carries a view or a different verdict', () => {
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenDocumentCommandV2(
          commandInput({ presentation: 'clear', verdict: NO_SESSION_VERDICT }),
        ),
    );
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenDocumentCommandV2(
          commandInput({ presentation: 'clear', verdict: ALLOWED_VERDICT, overlay: null }),
        ),
    );
  });

  it('refuses a blocked verdict whose view does not match its presentation', () => {
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenDocumentCommandV2(
          commandInput({ presentation: 'starting', overlay: activeView() }),
        ),
    );
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenDocumentCommandV2(
          commandInput({ presentation: 'active', overlay: startingView() }),
        ),
    );
    expectInvalidRule(
      (): FrozenDocumentCommand => buildFrozenDocumentCommandV2(commandInput({ overlay: null })),
    );
  });

  it('refuses an allowed verdict that carries a view', () => {
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenDocumentCommandV2(commandInput({ verdict: ALLOWED_VERDICT })),
    );
  });

  it('refuses an active view whose session is not the command session', () => {
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenDocumentCommandV2(commandInput({ sessionId: OTHER_SESSION_ID })),
    );
  });

  it('refuses a command that names both or neither session identity', () => {
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenDocumentCommandV2(
          commandInput({ sessionId: SESSION_ID, reservedSessionId: SESSION_ID }),
        ),
    );
    expectInvalidRule(
      (): FrozenDocumentCommand =>
        buildFrozenDocumentCommandV2(
          commandInput({ sessionId: null, reservedSessionId: null, overlay: null }),
        ),
    );
  });

  it('refuses a tab that is not a tab ID', () => {
    expectInvalidRule(
      (): FrozenDocumentCommand => buildFrozenDocumentCommandV2(commandInput({ tabId: -1 })),
    );
  });

  it('detaches the frozen command from the view it was given', () => {
    const overlay: ActiveOverlay = activeView();
    const command: FrozenDocumentCommand = buildFrozenDocumentCommandV2(commandInput({ overlay }));

    overlay.attemptsToday = 99;

    expect(command.overlay).not.toBeNull();
    expect((command.overlay as ActiveOverlay).attemptsToday).toBe(2);
  });
});

describe('buildFrozenEpochResetCommandV2', () => {
  it('freezes the reset handshake for one document', () => {
    const reset: FrozenEpochResetCommand = buildFrozenEpochResetCommandV2({
      tabId: 11,
      documentId: DOCUMENT_ID,
      expectedUrl: EXPECTED_URL,
      operationId: OPERATION_ID,
      enforcementEpoch: EPOCH_ID,
    });

    expect(reset).toEqual({
      version: 1,
      command: 'reset-enforcement-epoch',
      operationId: OPERATION_ID,
      enforcementEpoch: EPOCH_ID,
      documentId: DOCUMENT_ID,
      expectedUrl: EXPECTED_URL,
      tabId: 11,
    });
    const { tabId: _tabId, ...wire }: FrozenEpochResetCommand = reset;
    expect(parseResetEnforcementEpochCommand(wire)).toEqual(wire);
  });

  it('refuses a blank document, a bad epoch, and a bad tab', () => {
    expectInvalidRule(
      (): FrozenEpochResetCommand =>
        buildFrozenEpochResetCommandV2({
          tabId: 11,
          documentId: '  ',
          expectedUrl: EXPECTED_URL,
          operationId: OPERATION_ID,
          enforcementEpoch: EPOCH_ID,
        }),
    );
    expectInvalidRule(
      (): FrozenEpochResetCommand =>
        buildFrozenEpochResetCommandV2({
          tabId: 11,
          documentId: DOCUMENT_ID,
          expectedUrl: EXPECTED_URL,
          operationId: OPERATION_ID,
          enforcementEpoch: 'not-a-uuid',
        }),
    );
    expectInvalidRule(
      (): FrozenEpochResetCommand =>
        buildFrozenEpochResetCommandV2({
          tabId: 1.5,
          documentId: DOCUMENT_ID,
          expectedUrl: EXPECTED_URL,
          operationId: OPERATION_ID,
          enforcementEpoch: EPOCH_ID,
        }),
    );
  });
});
