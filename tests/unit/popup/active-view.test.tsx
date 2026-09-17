/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActiveView } from '../../../src/popup/ActiveView';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  emptySnapshotV2,
  MIN_BREAK_BEFORE_EARLY_MS,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { Request, SessionRequestV2, StatsBundle } from '../../../src/shared/messages';
import {
  END_FAILED_COPY,
  END_SESSION_LABEL,
  FOCUS_PHASE_CLOCK_LABEL,
  FOCUS_TIME_LABEL,
  TOTAL_SESSION_CLOCK_LABEL,
  UNTIL_STOPPED_LABEL,
} from '../../../src/shared/session-copy';
import type {
  EndAuthorityV2,
  GateState,
  SessionConfigV2,
  SessionSnapshotV2,
} from '../../../src/shared/types';
import { resetChromeFake, sendMessageMock, tabsQueryMock } from './chrome-fake';

const NOW: number = 1_700_000_000_000;
const MIN: number = 60_000;

const IMMEDIATE: EndAuthorityV2 = { kind: 'immediate', actionLabel: 'End session' };
const HIDDEN: EndAuthorityV2 = { kind: 'hidden' };
const CLOSED_FRICTION: EndAuthorityV2 = {
  kind: 'friction-gate',
  gate: null,
  copy: { actionLabel: 'End session' },
  actions: { open: 'open-end-gate' },
};

function openFriction(gate: Partial<GateState & { kind: 'cancel' }> = {}): EndAuthorityV2 {
  return {
    kind: 'friction-gate',
    gate: {
      kind: 'cancel',
      host: null,
      openedAt: NOW - 2_000,
      readyAt: NOW + 8_000,
      requiredPhrase: null,
      forceEndAvailable: false,
      ...gate,
    },
    copy: {
      title: 'End this session',
      back: 'Keep focusing',
      phraseLabel: 'Type this to confirm:',
      confirm: 'End the session',
      intentionReminder: 'write the report',
    },
    actions: { abandon: 'abandon-gate', confirm: 'confirm-gate' },
  };
}

const TIMED_CONFIG: SessionConfigV2 = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'timed', minutes: 50 },
  cycling: DEFAULT_SETTINGS.defaultCycling,
  intention: 'write the report',
  source: 'manual',
  scheduleOccurrence: null,
  rules: rulesFromLists(DEFAULT_LISTS),
};

const INDEFINITE_CONFIG: SessionConfigV2 = {
  ...TIMED_CONFIG,
  strictness: 'flexible',
  duration: { kind: 'until-stopped' },
  cycling: null,
};

function focusSnap(endAuthority: EndAuthorityV2 = CLOSED_FRICTION): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: { kind: 'active', endAuthority },
    phase: 'focus',
    config: TIMED_CONFIG,
    startedAt: NOW - 5 * MIN,
    phaseStartedAt: NOW - 5 * MIN,
    phaseEndsAt: NOW + 20 * MIN,
    sessionEndsAt: NOW + 45 * MIN,
    bankMs: 10 * MIN,
    bankAccrualPerMs: 5 / 30,
  };
}

function indefinitePauseSnap(): SessionSnapshotV2 {
  return {
    ...focusSnap(IMMEDIATE),
    config: INDEFINITE_CONFIG,
    phase: 'paused',
    phaseStartedAt: NOW,
    phaseEndsAt: NOW + 5 * MIN,
    sessionEndsAt: null,
    sessionFocusedMs: 12 * MIN,
  };
}

function breakSnap(elapsedMs: number): SessionSnapshotV2 {
  return {
    ...focusSnap(IMMEDIATE),
    phase: 'break',
    phaseStartedAt: NOW - elapsedMs,
    phaseEndsAt: NOW + 3 * MIN,
    bankAccrualPerMs: 0,
  };
}

const statsBundle: StatsBundle = {
  days: [],
  months: [],
  streak: {
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: '2026-09',
  },
  recentSessions: [],
  totals: {
    focusMsToday: 52 * MIN,
    focusMsLast7Days: 0,
    attemptsToday: 0,
    resistedToday: 0,
  },
};

type AnyRequest = Request | SessionRequestV2;

/** Reads the view makes on its own: today's total, the work target, and the eligible tabs. */
const VIEW_READS: ReadonlySet<AnyRequest['type']> = new Set<AnyRequest['type']>([
  'getStats',
  'getWorkTarget',
  'getWorkTabs',
]);

function sessionRequests(): AnyRequest[] {
  return sendMessageMock.mock.calls
    .map(([request]: unknown[]): AnyRequest => request as AnyRequest)
    .filter((request: AnyRequest): boolean => !VIEW_READS.has(request.type));
}

/**
 * Resolves once the clicked control is enabled again, which happens in the same commit
 * as any error state. Asserting no alert before that would pass on a pending command.
 */
async function settled(button: HTMLButtonElement): Promise<void> {
  await waitFor((): void => expect(button.disabled).toBe(false));
}

beforeEach((): void => {
  resetChromeFake();
  sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
    if (request.type === 'getStats') return statsBundle;
    return { ok: true, code: 'ok' };
  });
  tabsQueryMock.mockResolvedValue([{ url: 'https://www.youtube.com/watch?v=1' }]);
});

afterEach((): void => {
  cleanup();
});

describe('ActiveView', (): void => {
  it('renders the labelled clocks, intention, credit amount, and spend buttons in focus', async (): Promise<void> => {
    const { container, getByText, getByRole } = render(
      h(ActiveView, { snapshot: focusSnap(), now: NOW }),
    );

    expect(getByText('20:00')).toBeTruthy();
    expect(getByText(FOCUS_PHASE_CLOCK_LABEL)).toBeTruthy();
    expect(getByText('45:00')).toBeTruthy();
    expect(getByText(TOTAL_SESSION_CLOCK_LABEL)).toBeTruthy();
    expect(getByText('write the report')).toBeTruthy();
    expect(container.querySelector('.meter-fill')).toBeNull();
    expect(getByText('10:00 site access credit')).toBeTruthy();
    expect(getByRole('button', { name: /Unlock this site 5:00 access, 5:00 credit/ })).toBeTruthy();
    expect(getByRole('button', { name: /Unlock all sites 5:00 access, 5:00 credit/ })).toBeTruthy();
    await waitFor((): void => {
      expect(container.querySelector('.today-line')).toBeNull();
      expect(sendMessageMock).not.toHaveBeenCalledWith({ type: 'getStats', days: 1 });
    });
  });

  it('spends pause and unlock through the v2 channel', async (): Promise<void> => {
    const pauseView = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));
    const pause: HTMLButtonElement = pauseView.getByRole('button', {
      name: /Unlock all sites 5:00 access, 5:00 credit/,
    }) as HTMLButtonElement;
    fireEvent.click(pause);
    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'openGate', gate: 'pause', host: null }]);
    });
    await settled(pause);
    expect(pauseView.queryByRole('alert')).toBeNull();
    pauseView.unmount();
    sendMessageMock.mockClear();

    const unlockView = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));
    const unlock: HTMLButtonElement = unlockView.getByRole('button', {
      name: /Unlock this site 5:00 access, 5:00 credit/,
    }) as HTMLButtonElement;
    await waitFor((): void => expect(unlock.disabled).toBe(false));
    fireEvent.click(unlock);
    await waitFor((): void => {
      expect(sessionRequests()).toEqual([
        { type: 'openGate', gate: 'unlockSite', host: 'youtube.com' },
      ]);
    });
    await settled(unlock);
    expect(unlockView.queryByRole('alert')).toBeNull();
  });

  it('ends immediately from focus through requestSessionEnd', async (): Promise<void> => {
    const { getByRole, queryByRole } = render(
      h(ActiveView, { snapshot: focusSnap(IMMEDIATE), now: NOW }),
    );
    const end: HTMLButtonElement = getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;

    fireEvent.click(end);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'requestSessionEnd' }]);
    });
    await settled(end);
    expect(queryByRole('alert')).toBeNull();
  });

  it('shows End alongside Resume now during an indefinite pause', async (): Promise<void> => {
    const { getByRole, getByText, queryByRole } = render(
      h(ActiveView, { snapshot: indefinitePauseSnap(), now: NOW }),
    );

    expect(getByText(UNTIL_STOPPED_LABEL)).toBeTruthy();
    expect(getByText(FOCUS_TIME_LABEL)).toBeTruthy();
    expect(getByRole('button', { name: 'Resume now' })).toBeTruthy();

    const end: HTMLButtonElement = getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;
    fireEvent.click(end);
    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'requestSessionEnd' }]);
    });
    await settled(end);
    expect(queryByRole('alert')).toBeNull();
  });

  it('resumes from an indefinite pause through resumeFromPause', async (): Promise<void> => {
    const { getByRole, queryByRole } = render(
      h(ActiveView, { snapshot: indefinitePauseSnap(), now: NOW }),
    );
    const resume: HTMLButtonElement = getByRole('button', {
      name: 'Resume now',
    }) as HTMLButtonElement;

    fireEvent.click(resume);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'resumeFromPause' }]);
    });
    await settled(resume);
    expect(queryByRole('alert')).toBeNull();
  });

  it('opens the End gate instead of ending for a closed friction authority', async (): Promise<void> => {
    const { getByRole, queryByRole } = render(
      h(ActiveView, { snapshot: focusSnap(CLOSED_FRICTION), now: NOW }),
    );
    const end: HTMLButtonElement = getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;

    fireEvent.click(end);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'openEndGate' }]);
    });
    await settled(end);
    expect(queryByRole('alert')).toBeNull();
  });

  it('names the reason the gate confirm is refusing, for both reasons', (): void => {
    const authority: EndAuthorityV2 = openFriction({ requiredPhrase: 'let me stop' });
    const waiting = render(h(ActiveView, { snapshot: focusSnap(authority), now: NOW }));
    const duringCountdown: HTMLButtonElement = waiting.getByRole('button', {
      name: 'End the session',
    }) as HTMLButtonElement;

    expect(duringCountdown.disabled).toBe(true);
    expect(
      document.getElementById(duringCountdown.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('A moment to decide');
    cleanup();

    const ready = render(h(ActiveView, { snapshot: focusSnap(authority), now: NOW + 9_000 }));
    const unmatched: HTMLButtonElement = ready.getByRole('button', {
      name: 'End the session',
    }) as HTMLButtonElement;

    expect(unmatched.disabled).toBe(true);
    expect(
      document.getElementById(unmatched.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('let me stop');

    fireEvent.input(ready.getByRole('textbox'), { target: { value: 'let me stop' } });
    expect(unmatched.disabled).toBe(false);
    expect(unmatched.getAttribute('aria-describedby')).toBeNull();
  });

  it('moves focus into the gate when opening it unmounts the focused control', (): void => {
    // The End button is replaced by the panel, so without this focus falls to the body and the
    // next Tab restarts from the top of the popup, on the one flow built to be taken slowly.
    const authority: EndAuthorityV2 = openFriction({ requiredPhrase: 'let me stop' });
    const view = render(h(ActiveView, { snapshot: focusSnap(authority), now: NOW + 9_000 }));

    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Keep focusing' }));
  });

  it('leaves focus alone when the gate opens while something else holds it', (): void => {
    const outside: HTMLButtonElement = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    const authority: EndAuthorityV2 = openFriction({ requiredPhrase: 'let me stop' });
    render(h(ActiveView, { snapshot: focusSnap(authority), now: NOW + 9_000 }));

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('renders the persisted cancel gate and sends its commands through the v2 channel', async (): Promise<void> => {
    const authority: EndAuthorityV2 = openFriction({ requiredPhrase: 'let me stop' });
    const view = render(h(ActiveView, { snapshot: focusSnap(authority), now: NOW + 9_000 }));

    expect(view.queryByRole('button', { name: END_SESSION_LABEL })).toBeNull();
    expect(view.getByText('Type this to confirm: let me stop')).toBeTruthy();

    fireEvent.input(view.getByRole('textbox'), { target: { value: 'let me stop' } });
    const confirm: HTMLButtonElement = view.getByRole('button', {
      name: 'End the session',
    }) as HTMLButtonElement;
    fireEvent.click(confirm);
    await waitFor((): void => {
      expect(sessionRequests()).toEqual([
        {
          type: 'confirmGate',
          typedPhrase: 'let me stop',
          expectedGate: authority.kind === 'friction-gate' ? authority.gate : null,
        },
      ]);
    });
    await settled(confirm);
    expect(view.queryByRole('alert')).toBeNull();

    const abandon: HTMLButtonElement = view.getByRole('button', {
      name: 'Keep focusing',
    }) as HTMLButtonElement;
    fireEvent.click(abandon);
    await waitFor((): void => {
      expect(sessionRequests()).toEqual([
        {
          type: 'confirmGate',
          typedPhrase: 'let me stop',
          expectedGate: authority.kind === 'friction-gate' ? authority.gate : null,
        },
        {
          type: 'abandonGate',
          expectedGate: authority.kind === 'friction-gate' ? authority.gate : null,
        },
      ]);
    });
    await settled(abandon);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('labels the gate confirm Unlock when the authority publishes it', async (): Promise<void> => {
    const opened: EndAuthorityV2 = openFriction({ requiredPhrase: null });
    const authority: EndAuthorityV2 =
      opened.kind === 'friction-gate' && opened.gate !== null
        ? { ...opened, copy: { ...opened.copy, confirm: 'Unlock' } }
        : opened;
    const view = render(
      h(ActiveView, {
        snapshot: { ...focusSnap(authority), config: INDEFINITE_CONFIG, sessionEndsAt: null },
        now: NOW + 9_000,
      }),
    );

    expect(view.queryByRole('button', { name: 'End the session' })).toBeNull();
    const confirm: HTMLButtonElement = view.getByRole('button', {
      name: 'Unlock',
    }) as HTMLButtonElement;
    fireEvent.click(confirm);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([
        {
          type: 'confirmGate',
          typedPhrase: null,
          expectedGate: authority.kind === 'friction-gate' ? authority.gate : null,
        },
      ]);
    });
  });

  it('offers the force end bypass only on a gate the worker minted it for', async (): Promise<void> => {
    const plain: EndAuthorityV2 = openFriction({ requiredPhrase: 'let me stop' });
    const plainView = render(h(ActiveView, { snapshot: focusSnap(plain), now: NOW }));
    expect(plainView.queryByRole('button', { name: 'Ignore timeout and end anyway' })).toBeNull();
    plainView.unmount();

    const authority: EndAuthorityV2 = openFriction({
      requiredPhrase: 'let me stop',
      forceEndAvailable: true,
    });
    const view = render(h(ActiveView, { snapshot: focusSnap(authority), now: NOW }));
    const forceEnd: HTMLButtonElement = view.getByRole('button', {
      name: 'Ignore timeout and end anyway',
    }) as HTMLButtonElement;
    const confirm: HTMLButtonElement = view.getByRole('button', {
      name: 'End the session',
    }) as HTMLButtonElement;

    // The gate is not ready and the phrase is untyped, but the bypass is live regardless.
    expect(confirm.disabled).toBe(true);
    expect(forceEnd.disabled).toBe(false);
    expect(forceEnd.classList.contains('gate-force-end')).toBe(true);
    expect(
      confirm.compareDocumentPosition(forceEnd) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(forceEnd);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'forceEndGate' }]);
    });
    await settled(forceEnd);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows the worker text for a rejected gate command', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      return {
        ok: false,
        code: 'gate-not-ready',
        error: 'Wait for the delay to finish.',
      };
    });
    const view = render(h(ActiveView, { snapshot: focusSnap(openFriction()), now: NOW + 9_000 }));

    fireEvent.click(view.getByRole('button', { name: 'End the session' }));

    expect(await view.findByText('Wait for the delay to finish.')).toBeTruthy();
  });

  it('hides every End control for a hidden authority', (): void => {
    const { queryByRole } = render(h(ActiveView, { snapshot: focusSnap(HIDDEN), now: NOW }));

    expect(queryByRole('button', { name: END_SESSION_LABEL })).toBeNull();
    expect(queryByRole('button', { name: 'End the session' })).toBeNull();
  });

  it('shows the worker text for a rejected end command', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      return {
        ok: false,
        code: 'end-not-allowed',
        error: 'This session cannot be ended yet.',
      };
    });
    const { getByRole, findByText } = render(
      h(ActiveView, { snapshot: focusSnap(IMMEDIATE), now: NOW }),
    );

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    expect(await findByText('This session cannot be ended yet.')).toBeTruthy();
  });

  it('falls back to the end failure copy when the transport rejects', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      throw new Error('Receiving end does not exist.');
    });
    const { getByRole, findByText } = render(
      h(ActiveView, { snapshot: focusSnap(IMMEDIATE), now: NOW }),
    );

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    expect(await findByText(END_FAILED_COPY)).toBeTruthy();
  });

  it('falls back to the end failure copy for an unknown result code', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      return { ok: false, code: 'not-a-real-code', error: 'trust me' };
    });
    const { getByRole, findByText, queryByText } = render(
      h(ActiveView, { snapshot: focusSnap(IMMEDIATE), now: NOW }),
    );

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    expect(await findByText(END_FAILED_COPY)).toBeTruthy();
    expect(queryByText('trust me')).toBeNull();
  });

  it('keeps the break early start behavior', async (): Promise<void> => {
    const early = render(
      h(ActiveView, { snapshot: breakSnap(MIN_BREAK_BEFORE_EARLY_MS - 1_000), now: NOW }),
    );
    expect(early.queryByRole('button', { name: 'Start next focus early' })).toBeNull();
    early.unmount();

    const ready = render(
      h(ActiveView, { snapshot: breakSnap(MIN_BREAK_BEFORE_EARLY_MS), now: NOW }),
    );
    const startEarly: HTMLButtonElement = ready.getByRole('button', {
      name: 'Start next focus early',
    }) as HTMLButtonElement;
    fireEvent.click(startEarly);

    await waitFor((): void => {
      expect(sessionRequests()).toEqual([{ type: 'startNextFocusEarly' }]);
    });
    await settled(startEarly);
    expect(ready.queryByRole('alert')).toBeNull();
  });

  it('renders a gate whose readyAt precedes openedAt with confirm still disabled', (): void => {
    const hostile: EndAuthorityV2 = openFriction({ openedAt: NOW, readyAt: NOW - 60_000 });
    const { getByRole } = render(h(ActiveView, { snapshot: focusSnap(hostile), now: NOW }));

    const confirm: HTMLButtonElement = getByRole('button', {
      name: 'End the session',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect((getByRole('button', { name: 'Keep focusing' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

/** The two spend controls, in render order: unlock first, then pause. */
function spendControls(container: Element): {
  unlock: HTMLButtonElement;
  pause: HTMLButtonElement;
} {
  const buttons: HTMLButtonElement[] = Array.from(
    container.querySelectorAll<HTMLButtonElement>('.spend-button'),
  );
  const unlock: HTMLButtonElement | undefined = buttons[0];
  const pause: HTMLButtonElement | undefined = buttons[1];
  if (unlock === undefined || pause === undefined) {
    throw new Error('the spend controls were not rendered');
  }
  return { unlock, pause };
}

/** The sub-line under a spend control: its disabled reason, or the active host. */
function spendSub(button: HTMLButtonElement): string | null {
  return button.querySelector('.spend-reason')?.textContent ?? null;
}

function unaffordableSnap(endAuthority: EndAuthorityV2 = CLOSED_FRICTION): SessionSnapshotV2 {
  return { ...focusSnap(endAuthority), bankMs: 0 };
}

/** One credit minute short of the five minute actions, earned in six minutes at 5 per 30. */
function nearlyAffordableSnap(endAuthority: EndAuthorityV2 = CLOSED_FRICTION): SessionSnapshotV2 {
  return { ...focusSnap(endAuthority), bankMs: 4 * MIN };
}

/**
 * `unlockDisabledReason` is `pending ?? activeSite ?? availability` and `pauseDisabledReason`
 * drops the middle link, so the pause control is what tells the two apart. The availability
 * wording comes from `accessAvailability`, counted to each action's own cost.
 */
describe('ActiveView disabled reasons', (): void => {
  it('reports active-site loading, ready, unsupported, and error states truthfully', async (): Promise<void> => {
    tabsQueryMock.mockReturnValue(new Promise((): void => {}));
    const loading = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));
    const stillLoading: HTMLButtonElement = spendControls(loading.container).unlock;
    expect(spendSub(stillLoading)).toBe('Checking the active site');
    expect(stillLoading.disabled).toBe(true);
    loading.unmount();

    tabsQueryMock.mockResolvedValue([{ url: 'https://www.youtube.com/watch?v=1' }]);
    const ready = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));
    await waitFor((): void => {
      expect(spendSub(spendControls(ready.container).unlock)).toBeNull();
      expect(spendControls(ready.container).unlock.textContent).toContain('youtube.com');
    });
    expect(spendControls(ready.container).unlock.disabled).toBe(false);
    ready.unmount();

    tabsQueryMock.mockResolvedValue([{ url: 'chrome://extensions/' }]);
    const unsupported = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));
    await waitFor((): void => {
      expect(spendSub(spendControls(unsupported.container).unlock)).toBe(
        'Open a regular website to unlock it',
      );
    });
    expect(spendControls(unsupported.container).unlock.disabled).toBe(true);
    expect(spendControls(unsupported.container).pause.disabled).toBe(false);
    unsupported.unmount();

    tabsQueryMock.mockRejectedValue(new Error('tabs query failed'));
    const failed = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));
    await waitFor((): void => {
      expect(spendSub(spendControls(failed.container).unlock)).toBe(
        'Could not identify the active site',
      );
    });
    expect(failed.getByRole('alert').textContent).toBe('Could not identify the active site.');
  });

  it('prioritizes the unsupported-tab reason over insufficient budget', async (): Promise<void> => {
    tabsQueryMock.mockResolvedValue([{ url: 'chrome://extensions/' }]);
    const { container } = render(h(ActiveView, { snapshot: nearlyAffordableSnap(), now: NOW }));

    await waitFor((): void => {
      expect(spendSub(spendControls(container).unlock)).toBe('Open a regular website to unlock it');
    });
    expect(spendSub(spendControls(container).pause)).toBe('Ready in 6:00');
    expect(spendControls(container).unlock.disabled).toBe(true);
    expect(spendControls(container).pause.disabled).toBe(true);
  });

  it('prioritizes pending action over unsupported tab and insufficient budget', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: AnyRequest): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      return new Promise((): void => {});
    });
    tabsQueryMock.mockResolvedValue([{ url: 'chrome://extensions/' }]);
    const { container, getByRole } = render(
      h(ActiveView, { snapshot: unaffordableSnap(IMMEDIATE), now: NOW }),
    );
    await waitFor((): void => {
      expect(spendSub(spendControls(container).unlock)).toBe('Open a regular website to unlock it');
    });

    fireEvent.click(getByRole('button', { name: END_SESSION_LABEL }));

    await waitFor((): void => {
      expect(spendSub(spendControls(container).unlock)).toBe('Action in progress');
    });
    expect(spendSub(spendControls(container).pause)).toBe('Action in progress');
  });

  it('counts to each action cost while a spend is unaffordable', async (): Promise<void> => {
    const snapshot: SessionSnapshotV2 = { ...nearlyAffordableSnap(), unlockCostMs: 10 * MIN };
    const { container } = render(h(ActiveView, { snapshot, now: NOW }));

    await waitFor((): void => {
      expect(spendSub(spendControls(container).pause)).toBe('Ready in 6:00');
    });
    // Ten minutes of credit needs 36 more minutes of focus, and this block ends in 20.
    expect(spendSub(spendControls(container).unlock)).toBe('Not enough time in this focus block');
    expect(container.textContent).not.toContain('Ready in 36:00');
    expect(spendControls(container).unlock.disabled).toBe(true);
    expect(spendControls(container).pause.disabled).toBe(true);
  });

  it('explains credit that this focus block can never reach', async (): Promise<void> => {
    const { container } = render(h(ActiveView, { snapshot: unaffordableSnap(), now: NOW }));

    await waitFor((): void => {
      expect(spendSub(spendControls(container).unlock)).toBe('Not enough time in this focus block');
    });
    expect(spendSub(spendControls(container).pause)).toBe('Not enough time in this focus block');
    expect(container.textContent).not.toContain('Ready in');
  });

  it('never renders ready in zero for a positive sub-second wait', async (): Promise<void> => {
    const snapshot: SessionSnapshotV2 = {
      ...focusSnap(),
      bankMs: 5 * MIN - 100,
      bankAccrualPerMs: 1,
    };
    const { container } = render(h(ActiveView, { snapshot, now: NOW }));

    await waitFor((): void => {
      expect(spendSub(spendControls(container).unlock)).toBe('Ready in 0:01');
    });
    expect(container.textContent).not.toContain('Ready in 0:00');
  });

  it('explains a cost above the credit limit instead of promising a wait', async (): Promise<void> => {
    const snapshot: SessionSnapshotV2 = { ...focusSnap(), bankMs: 0, bankCapMs: 0 };
    const { container } = render(h(ActiveView, { snapshot, now: NOW }));

    await waitFor((): void => {
      expect(spendSub(spendControls(container).unlock)).toBe('Cost exceeds the credit limit');
    });
    expect(spendSub(spendControls(container).pause)).toBe('Cost exceeds the credit limit');
    expect(container.textContent).not.toContain('Ready in');
  });

  it('explains credit earning that is turned off', async (): Promise<void> => {
    const snapshot: SessionSnapshotV2 = { ...focusSnap(), bankMs: 0, bankAccrualPerMs: 0 };
    const { container } = render(h(ActiveView, { snapshot, now: NOW }));

    await waitFor((): void => {
      expect(spendSub(spendControls(container).pause)).toBe('Credit earning is turned off');
    });
  });
});

describe('always visible session actions', (): void => {
  it('renders the actions with no disclosure to open', (): void => {
    const view: ReturnType<typeof render> = render(
      <ActiveView snapshot={focusSnap(openFriction())} now={NOW} />,
    );

    // No <details> anywhere: the actions are on screen the moment the popup opens.
    // docs/superpowers/specs/2026-09-17-popup-visibility-rules.md
    expect(view.container.querySelector('details')).toBeNull();
    expect(view.getByRole('button', { name: 'Keep focusing' })).toBeTruthy();
    expect(
      sendMessageMock.mock.calls.some(
        ([request]: unknown[]): boolean => (request as AnyRequest).type === 'getStats',
      ),
    ).toBe(false);
  });

  it('shows the credit and the spend controls without any interaction', (): void => {
    const view: ReturnType<typeof render> = render(<ActiveView snapshot={focusSnap()} now={NOW} />);

    expect(view.container.querySelector('.session-actions')).toBeTruthy();
    expect(view.container.querySelector('.session-actions .actions')).toBeTruthy();
    expect(view.container.querySelector('.session-actions .meter-label')).toBeTruthy();
  });

  it('offers the chooser itself, with no button that only reveals it', (): void => {
    const view: ReturnType<typeof render> = render(<ActiveView snapshot={focusSnap()} now={NOW} />);

    // Two controls used to exist only to move focus here. They are gone with the disclosure.
    expect(view.container.querySelector('.work-tab-control')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Choose work tab' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Change work tab' })).toBeNull();
  });

  it('offers no work tab dropdown', (): void => {
    const view: ReturnType<typeof render> = render(<ActiveView snapshot={focusSnap()} now={NOW} />);

    expect(view.container.querySelector('select')).toBeNull();
  });
});
