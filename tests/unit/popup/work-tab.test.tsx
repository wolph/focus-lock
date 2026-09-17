/** @vitest-environment jsdom */
import './chrome-fake';

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSessionStartRequestV2 } from '../../../src/background/request-validation';
import { ActiveView } from '../../../src/popup/ActiveView';
import { App } from '../../../src/popup/App';
import { StartForm } from '../../../src/popup/StartForm';
import { WorkTabControl } from '../../../src/popup/WorkTabControl';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshotV2,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { Request, StatsBundle } from '../../../src/shared/messages';
import { isSessionSnapshot } from '../../../src/shared/runtime-validation';
import { END_SESSION_LABEL } from '../../../src/shared/session-copy';
import type {
  EndAuthorityV2,
  SessionConfigV2,
  SessionSnapshotV2,
  SettingsV2,
  SetupState,
} from '../../../src/shared/types';
import {
  WORK_TARGET_NOT_SAVED_ERROR,
  type WorkTargetResult,
} from '../../../src/shared/work-target';
import { emitMessage, resetChromeFake, sendMessageMock, tabsQueryMock } from './chrome-fake';

const NOW: number = 1_700_000_000_000;
const MIN: number = 60_000;
const SETTINGS: SettingsV2 = { ...DEFAULT_SETTINGS, schedule: [] };
const START_BUTTON: RegExp = /^Start 25 min/;
const SESSION_ID: string = '11111111-1111-4111-8111-111111111111';
const RETURN_FAILED_COPY: string = 'Could not return to work. Try again.';

const TABS: { tabId: number; title: string }[] = [
  { tabId: 12, title: 'Report' },
  { tabId: 14, title: 'Notes' },
];

const CLOSED_FRICTION: EndAuthorityV2 = {
  kind: 'friction-gate',
  gate: null,
  copy: { actionLabel: 'End session' },
  actions: { open: 'open-end-gate' },
};

const OPEN_FRICTION: EndAuthorityV2 = {
  kind: 'friction-gate',
  gate: {
    kind: 'cancel',
    host: null,
    openedAt: NOW - 2_000,
    readyAt: NOW + 8_000,
    requiredPhrase: null,
    forceEndAvailable: false,
  },
  copy: {
    title: 'End this session',
    back: 'Keep focusing',
    phraseLabel: 'Type this to confirm:',
    confirm: 'End the session',
    intentionReminder: null,
  },
  actions: { abandon: 'abandon-gate', confirm: 'confirm-gate' },
};

const CONFIG: SessionConfigV2 = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'timed', minutes: 50 },
  cycling: null,
  intention: 'write the report',
  source: 'manual',
  scheduleOccurrence: null,
  rules: rulesFromLists(DEFAULT_LISTS),
};

const COMPLETED_SETUP: SetupState = {
  ...DEFAULT_SETUP,
  completed: true,
  storageMode: 'local',
  websiteAccess: 'granted',
  blockingRegistration: 'ready',
};

const STATS: StatsBundle = {
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
  totals: { focusMsToday: 0, focusMsLast7Days: 0, attemptsToday: 0, resistedToday: 0 },
};

function activeSnap(endAuthority: EndAuthorityV2 = CLOSED_FRICTION): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: { kind: 'active', endAuthority },
    phase: 'focus',
    config: CONFIG,
    startedAt: NOW - 5 * MIN,
    phaseStartedAt: NOW - 5 * MIN,
    phaseEndsAt: NOW + 45 * MIN,
    sessionEndsAt: NOW + 45 * MIN,
    sessionFocusedMs: 5 * MIN,
    bankMs: 10 * MIN,
    bankAccrualPerMs: 5 / 30,
  };
}

function readyTarget(): WorkTargetResult {
  return {
    ok: true,
    sessionId: SESSION_ID,
    state: 'ready',
    title: 'Report',
    hostname: 'work.example',
  };
}

function missingTarget(): WorkTargetResult {
  return { ok: true, sessionId: SESSION_ID, state: 'missing', title: null };
}

type Answer = (request: Request) => unknown;

/** Routes each request type to an answer, with a v2 command acceptance for everything else. */
function answerWith(answers: Partial<Record<Request['type'], Answer>>): void {
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
    const answer: Answer | undefined = answers[request.type];
    if (answer !== undefined) return answer(request);
    if (request.type === 'getStats') return STATS;
    if (request.type === 'getWorkTabs') return { ok: true, tabs: TABS };
    return { ok: true, code: 'ok' };
  });
}

function requestsOf<T extends Request['type']>(type: T): Extract<Request, { type: T }>[] {
  return sendMessageMock.mock.calls
    .map(([request]: unknown[]): Request => request as Request)
    .filter((request: Request): request is Extract<Request, { type: T }> => request.type === type);
}

function workTabSelect(view: ReturnType<typeof render>): HTMLSelectElement {
  return view.getByLabelText('Work tab') as HTMLSelectElement;
}

beforeEach((): void => {
  resetChromeFake();
  tabsQueryMock.mockResolvedValue([
    { id: 12, windowId: 3, active: true, url: 'https://work.example/' },
  ]);
  answerWith({});
});

afterEach((): void => {
  cleanup();
});

describe('StartForm work tab', (): void => {
  it('defaults to the suitable active tab and sends the tab, window, and draft rules', async (): Promise<void> => {
    const view = render(h(StartForm, { settings: SETTINGS, lists: DEFAULT_LISTS }));

    await waitFor((): void => expect(workTabSelect(view).value).toBe('12'));
    expect(requestsOf('getWorkTabs')[0]).toEqual({
      type: 'getWorkTabs',
      mode: 'blacklist',
      windowId: 3,
      rules: rulesFromLists(DEFAULT_LISTS),
    });

    fireEvent.change(workTabSelect(view), { target: { value: '14' } });
    emitMessage({ type: 'workTargetChanged' });
    await waitFor((): void => expect(requestsOf('getWorkTabs').length).toBeGreaterThan(1));
    expect(workTabSelect(view).value).toBe('14');

    fireEvent.click(view.getByRole('button', { name: START_BUTTON }));

    await waitFor((): void => expect(requestsOf('startSession')).toHaveLength(1));
    const request: Request | undefined = requestsOf('startSession')[0];
    expect(request).toEqual({
      type: 'startSession',
      config: expect.objectContaining({ duration: { kind: 'timed', minutes: 25 } }),
      workTabId: 14,
      windowId: 3,
    });
    expect(parseSessionStartRequestV2(request)).toEqual(request);
  });

  it('starts with the two-key request when no work tab is chosen', async (): Promise<void> => {
    answerWith({ getWorkTabs: (): unknown => ({ ok: true, tabs: [] }) });
    const view = render(h(StartForm, { settings: SETTINGS, lists: DEFAULT_LISTS }));

    await waitFor((): void => expect(workTabSelect(view).disabled).toBe(false));
    expect(workTabSelect(view).value).toBe('');
    fireEvent.click(view.getByRole('button', { name: START_BUTTON }));

    await waitFor((): void => expect(requestsOf('startSession')).toHaveLength(1));
    expect(Object.keys(requestsOf('startSession')[0] ?? {})).toEqual(['type', 'config']);
  });

  it('lists eligible tabs again when the draft changes its blocking mode', async (): Promise<void> => {
    const view = render(h(StartForm, { settings: SETTINGS, lists: DEFAULT_LISTS }));
    await waitFor((): void => expect(workTabSelect(view).value).toBe('12'));

    fireEvent.click(view.getByRole('radio', { name: /Allow selected sites only/ }));

    await waitFor((): void => {
      expect(requestsOf('getWorkTabs').at(-1)).toEqual(
        expect.objectContaining({ type: 'getWorkTabs', mode: 'whitelist', windowId: 3 }),
      );
    });
  });

  it('puts the current tab first and preserves an explicit alternative after refresh', async (): Promise<void> => {
    tabsQueryMock.mockResolvedValue([{ id: 14, windowId: 3 }]);
    const view: ReturnType<typeof render> = render(
      h(StartForm, { settings: SETTINGS, lists: DEFAULT_LISTS }),
    );
    await waitFor((): void => expect(workTabSelect(view).value).toBe('14'));
    expect(workTabSelect(view).options[0]?.textContent).toBe('Notes (Current)');
    expect(view.queryByRole('button', { name: 'Make this my work tab' })).toBeNull();
    fireEvent.change(workTabSelect(view), { target: { value: '12' } });
    emitMessage({ type: 'workTargetChanged' });
    await waitFor((): void => expect(workTabSelect(view).disabled).toBe(false));
    expect(workTabSelect(view).value).toBe('12');
    expect(workTabSelect(view).options[0]?.textContent).toBe('Notes (Current)');
  });

  it('omits an ineligible current tab while retaining eligible alternatives', async (): Promise<void> => {
    answerWith({
      getWorkTabs: (): unknown => ({ ok: true, tabs: [{ tabId: 14, title: 'Notes' }] }),
    });
    const view = render(h(StartForm, { settings: SETTINGS, lists: DEFAULT_LISTS }));

    await waitFor((): void => expect(view.getByText('Notes')).toBeDefined());
    expect(workTabSelect(view).value).toBe('');
    expect(
      Array.from(workTabSelect(view).options).some(
        (option: HTMLOptionElement): boolean => option.textContent?.includes('(Current)') === true,
      ),
    ).toBe(false);

    fireEvent.change(workTabSelect(view), { target: { value: '14' } });
    fireEvent.click(view.getByRole('button', { name: START_BUTTON }));
    await waitFor((): void =>
      expect(requestsOf('startSession')[0]).toEqual(
        expect.objectContaining({ type: 'startSession', workTabId: 14, windowId: 3 }),
      ),
    );
  });

  it('hands a work-target-not-saved answer to the caller and keeps the form quiet', async (): Promise<void> => {
    answerWith({
      startSession: (): unknown => ({
        ok: false,
        code: 'work-target-not-saved',
        error: WORK_TARGET_NOT_SAVED_ERROR,
      }),
    });
    const feedback: (string | null)[] = [];
    const view = render(
      h(StartForm, {
        settings: SETTINGS,
        lists: DEFAULT_LISTS,
        onStartFeedback: (message: string | null): void => {
          feedback.push(message);
        },
      }),
    );
    await waitFor((): void => expect(workTabSelect(view).value).toBe('12'));

    fireEvent.click(view.getByRole('button', { name: START_BUTTON }));

    await waitFor((): void => expect(feedback).toContain(WORK_TARGET_NOT_SAVED_ERROR));
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows a work-target-not-saved answer inline when nobody else will', async (): Promise<void> => {
    answerWith({
      startSession: (): unknown => ({
        ok: false,
        code: 'work-target-not-saved',
        error: WORK_TARGET_NOT_SAVED_ERROR,
      }),
    });
    const view = render(h(StartForm, { settings: SETTINGS, lists: DEFAULT_LISTS }));
    await waitFor((): void => expect(workTabSelect(view).value).toBe('12'));

    fireEvent.click(view.getByRole('button', { name: START_BUTTON }));

    await waitFor((): void =>
      expect(view.getByRole('alert').textContent).toBe(WORK_TARGET_NOT_SAVED_ERROR),
    );
  });
});

describe('WorkTabControl', (): void => {
  it('saves the actual current tab during a session and ignores its reply after replacement', async (): Promise<void> => {
    let resolveSave: (value: unknown) => void = (): void => {};
    answerWith({
      getWorkTabs: (): unknown => ({ ok: true, tabs: [{ tabId: 12, title: 'Report' }] }),
      setWorkTarget: (): unknown =>
        new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveSave = resolve;
        }),
    });
    const refresh: () => void = (): void => {};
    const view = render(
      h(WorkTabControl, {
        snapshot: activeSnap(),
        work: { target: missingTarget(), windowId: 3, refresh },
      }),
    );
    await waitFor((): void =>
      expect(
        (view.getByRole('button', { name: 'Make this my work tab' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(requestsOf('getWorkTabs')[0]).toEqual({
      type: 'getWorkTabs',
      mode: 'blacklist',
      windowId: 3,
      rules: CONFIG.rules,
    });
    expect(view.getByText('Choose or replace your work tab.')).toBeDefined();

    fireEvent.click(view.getByRole('button', { name: 'Make this my work tab' }));
    await waitFor((): void =>
      expect(requestsOf('setWorkTarget')[0]).toEqual({
        type: 'setWorkTarget',
        sessionId: SESSION_ID,
        tabId: 12,
        windowId: 3,
      }),
    );
    expect(view.getByText('Saving work tab...')).toBeDefined();

    view.rerender(
      h(WorkTabControl, {
        snapshot: { ...activeSnap(), startedAt: NOW - MIN },
        work: {
          target: {
            ok: true,
            sessionId: '22222222-2222-4222-8222-222222222222',
            state: 'missing',
            title: null,
          },
          windowId: 3,
          refresh,
        },
      }),
    );
    resolveSave({ ok: false, error: 'Old save failed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(view.queryByText('Old save failed')).toBeNull();
  });

  it('names the ready work tab and reports a refused save', async (): Promise<void> => {
    answerWith({ setWorkTarget: (): unknown => ({ ok: false, error: 'That tab is gone.' }) });
    const view = render(
      h(WorkTabControl, {
        snapshot: activeSnap(),
        work: { target: readyTarget(), windowId: 3, refresh: (): void => {} },
      }),
    );

    expect(view.getByText('Work tab: Report')).toBeDefined();
    // The dropdown is gone by product rule, so the save runs through the chooser button.
    // docs/superpowers/specs/2026-09-17-popup-visibility-rules.md
    expect(view.container.querySelector('select')).toBeNull();
    const useThisTab: HTMLButtonElement = await waitFor((): HTMLButtonElement => {
      const button: HTMLButtonElement | null = view.container.querySelector(
        '.this-tab-button',
      ) as HTMLButtonElement | null;
      if (button === null || button.disabled) throw new Error('the control is not ready');
      return button;
    });
    fireEvent.click(useThisTab);

    expect(await view.findByText('That tab is gone.')).toBeDefined();
  });
});

describe('ActiveView return to work', (): void => {
  it('offers Back to work for a ready target and sends returnToWork through the shared lock', async (): Promise<void> => {
    let resolveReturn: (value: unknown) => void = (): void => {};
    answerWith({
      getWorkTarget: (): unknown => readyTarget(),
      returnToWork: (): unknown =>
        new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveReturn = resolve;
        }),
    });
    const view = render(h(ActiveView, { snapshot: activeSnap(), now: NOW }));

    const back: HTMLButtonElement = (await view.findByRole('button', {
      name: 'Back to work: Report (work.example)',
    })) as HTMLButtonElement;
    expect(back.classList.contains('return-work-button')).toBe(true);
    expect(back.textContent).toContain('Back to work');
    expect(back.textContent).toContain('Report');
    expect(back.textContent).toContain('work.example');
    const targetReads: number = requestsOf('getWorkTarget').length;

    fireEvent.click(back);

    await waitFor((): void =>
      expect(requestsOf('returnToWork')).toEqual([
        { type: 'returnToWork', sessionId: SESSION_ID, windowId: 3 },
      ]),
    );
    const end: HTMLButtonElement = view.getByRole('button', {
      name: END_SESSION_LABEL,
    }) as HTMLButtonElement;
    expect(end.disabled).toBe(true);
    fireEvent.click(end);
    expect(requestsOf('openEndGate')).toHaveLength(0);

    await act(async (): Promise<void> => {
      resolveReturn({ ok: true });
    });
    await waitFor((): void => expect(end.disabled).toBe(false));
    expect(view.queryByRole('alert')).toBeNull();
    await waitFor((): void =>
      expect(requestsOf('getWorkTarget').length).toBeGreaterThan(targetReads),
    );
  });

  it('reports a refused return with the worker text and a malformed answer with the fallback', async (): Promise<void> => {
    answerWith({
      getWorkTarget: (): unknown => readyTarget(),
      returnToWork: (): unknown => ({ ok: false, error: 'That tab is no longer open.' }),
    });
    const refused = render(h(ActiveView, { snapshot: activeSnap(), now: NOW }));
    fireEvent.click(await refused.findByRole('button', { name: /^Back to work:/ }));
    expect((await refused.findByRole('alert')).textContent).toBe('That tab is no longer open.');
    refused.unmount();

    answerWith({
      getWorkTarget: (): unknown => readyTarget(),
      returnToWork: (): unknown => ({ ok: true, code: 'ok' }),
    });
    const malformed = render(h(ActiveView, { snapshot: activeSnap(), now: NOW }));
    fireEvent.click(await malformed.findByRole('button', { name: /^Back to work:/ }));
    expect((await malformed.findByRole('alert')).textContent).toBe(RETURN_FAILED_COPY);
  });

  it('hides Back to work while a gate is open or the target is not ready', async (): Promise<void> => {
    answerWith({ getWorkTarget: (): unknown => readyTarget() });
    const gated = render(h(ActiveView, { snapshot: activeSnap(OPEN_FRICTION), now: NOW }));
    await waitFor((): void => expect(requestsOf('getWorkTarget').length).toBeGreaterThan(0));
    expect(gated.getByText('Work tab: Report')).toBeDefined();
    expect(gated.queryByRole('button', { name: /^Back to work:/ })).toBeNull();
    gated.unmount();

    answerWith({ getWorkTarget: (): unknown => missingTarget() });
    const missing = render(h(ActiveView, { snapshot: activeSnap(), now: NOW }));
    expect(await missing.findByText('Choose or replace your work tab.')).toBeDefined();
    expect(missing.queryByRole('button', { name: /^Back to work:/ })).toBeNull();
  });
});

describe('App partial start', (): void => {
  it('keeps a work-target-not-saved message visible after the form unmounts', async (): Promise<void> => {
    let started: boolean = false;
    const idle: SessionSnapshotV2 = emptySnapshotV2(NOW);
    const active: SessionSnapshotV2 = activeSnap();
    expect(isSessionSnapshot(active)).toBe(true);
    answerWith({
      getSetupState: (): unknown => COMPLETED_SETUP,
      getSnapshot: (): unknown => (started ? active : idle),
      getSettings: (): unknown => DEFAULT_SETTINGS,
      getLists: (): unknown => DEFAULT_LISTS,
      getWorkTarget: (): unknown => missingTarget(),
      startSession: async (): Promise<unknown> => {
        started = true;
        emitMessage({ type: 'stateChanged', snapshot: active });
        await Promise.resolve();
        return { ok: false, code: 'work-target-not-saved', error: WORK_TARGET_NOT_SAVED_ERROR };
      },
    });
    const view = render(h(App, null));

    fireEvent.click(await view.findByRole('button', { name: START_BUTTON }));

    expect((await view.findByText(WORK_TARGET_NOT_SAVED_ERROR)).getAttribute('role')).toBe('alert');
    expect(view.queryByRole('button', { name: START_BUTTON })).toBeNull();
  });
});

describe('quiet work tab disclosures', (): void => {
  it('opens and focuses the idle chooser while retaining the selected tab and draft', async (): Promise<void> => {
    const view: ReturnType<typeof render> = render(
      <StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />,
    );
    await waitFor((): void => expect(workTabSelect(view).disabled).toBe(false));
    const details: HTMLDetailsElement = view.getByText('Session settings')
      .parentElement as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(view.getByRole('button', { name: 'Change' }));
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(workTabSelect(view));
    fireEvent.change(workTabSelect(view), { target: { value: '14' } });
    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '37' } });
    fireEvent.click(view.getByRole('button', { name: 'Flexible' }));
    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'Finish notes' } });
    details.open = false;
    fireEvent.click(view.getByRole('button', { name: 'Change' }));
    expect(workTabSelect(view).value).toBe('14');
    expect((view.getByLabelText('Custom minutes') as HTMLInputElement).value).toBe('37');
    expect(view.getByRole('button', { name: 'Flexible' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((view.getByLabelText('Intention') as HTMLInputElement).value).toBe('Finish notes');
    expect(view.getByRole('button', { name: 'Start 37 min focus' })).toBeTruthy();
  });

  it('keeps the actions on screen across ticks and across a new session', async (): Promise<void> => {
    answerWith({ getWorkTarget: readyTarget });
    const snapshot: SessionSnapshotV2 = activeSnap();
    const view: ReturnType<typeof render> = render(<ActiveView snapshot={snapshot} now={NOW} />);
    const visible = (): boolean =>
      view.container.querySelector('.session-actions .actions') !== null;

    expect(visible()).toBe(true);
    view.rerender(<ActiveView snapshot={{ ...snapshot, at: NOW + 1000 }} now={NOW + 1000} />);
    expect(visible()).toBe(true);
    // A new session used to close the disclosure. There is nothing left to close.
    view.rerender(<ActiveView snapshot={{ ...snapshot, startedAt: NOW }} now={NOW + 1000} />);
    expect(visible()).toBe(true);
    expect(view.container.querySelector('details')).toBeNull();
  });

  it('makes phase recovery primary and returning to work secondary', async (): Promise<void> => {
    answerWith({ getWorkTarget: readyTarget });
    const snapshot: SessionSnapshotV2 = { ...activeSnap(), phase: 'paused' };
    const view: ReturnType<typeof render> = render(<ActiveView snapshot={snapshot} now={NOW} />);
    await waitFor((): void =>
      expect(view.getByRole('button', { name: /^Back to work/ })).toBeTruthy(),
    );
    expect(
      view.getByRole('button', { name: 'Resume now' }).classList.contains('start-button'),
    ).toBe(true);
    expect(
      view.getByRole('button', { name: /^Back to work/ }).classList.contains('secondary-button'),
    ).toBe(true);
    view.rerender(
      <ActiveView
        snapshot={{ ...snapshot, phase: 'break', phaseStartedAt: NOW - 120000 }}
        now={NOW}
      />,
    );
    expect(
      view
        .getByRole('button', { name: 'Start next focus early' })
        .classList.contains('start-button'),
    ).toBe(true);
    expect(
      view.getByRole('button', { name: /^Back to work/ }).classList.contains('secondary-button'),
    ).toBe(true);
  });

  it('restores focus to work after the gate ends', async (): Promise<void> => {
    answerWith({ getWorkTarget: readyTarget });
    const view: ReturnType<typeof render> = render(
      <ActiveView snapshot={activeSnap()} now={NOW} />,
    );
    await waitFor((): void =>
      expect(view.getByRole('button', { name: /^Back to work/ })).toBeTruthy(),
    );
    view.rerender(<ActiveView snapshot={activeSnap(OPEN_FRICTION)} now={NOW} />);
    view.getByRole('button', { name: 'Keep focusing' }).focus();
    view.rerender(<ActiveView snapshot={activeSnap()} now={NOW} />);
    expect(document.activeElement).toBe(view.getByRole('button', { name: /^Back to work/ }));
  });
});
