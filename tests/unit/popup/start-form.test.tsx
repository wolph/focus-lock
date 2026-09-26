/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSessionStartRequestV2 } from '../../../src/background/request-validation';
import { START_FAILED_COPY } from '../../../src/popup/command-errors';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../../src/shared/constants';
import {
  type Request,
  type SessionRequestV2,
  STALE_SESSION_RULES_ERROR,
  type StartSessionResponseV2,
} from '../../../src/shared/messages';
import {
  HARD_UNAVAILABLE_REASON,
  LOCK_UNTIL_MANUAL_UNLOCK_LABEL,
  START_UNTIL_STOPPED_LABEL,
  UNTIL_STOPPED_LABEL,
  untilStoppedHint,
} from '../../../src/shared/session-copy';
import type { ListsConfig, SettingsV2 } from '../../../src/shared/types';
import { localStore, openOptionsPageMock, resetChromeFake, sendMessageMock } from './chrome-fake';

vi.mock('../../../src/core/categories', () => ({
  ALL_CATEGORIES: [
    { id: 'social', title: 'Social', hosts: ['facebook.com'] },
    { id: 'video', title: 'Video and streaming', hosts: ['youtube.com'] },
  ],
}));

import { StartForm } from '../../../src/popup/StartForm';

const SETTINGS: SettingsV2 = { ...DEFAULT_SETTINGS, schedule: [] };
const TIMED_START_LABEL: string = 'Start 25 min focus';
const FORCED_CYCLES_LABEL: string = 'Cycles forced by Until stopped';
const FRICTION_HINT: string = untilStoppedHint('friction', DEFAULT_SETTINGS.gate);
const FLEXIBLE_HINT: string = untilStoppedHint('flexible', DEFAULT_SETTINGS.gate);

type StartRequest = Extract<SessionRequestV2, { type: 'startSession' }>;

/** Every request except the work tab listing, which the form reads on its own. */
function requests(): SessionRequestV2[] {
  return sendMessageMock.mock.calls
    .map(([request]: unknown[]): Request => request as Request)
    .filter((request: Request): request is SessionRequestV2 => request.type !== 'getWorkTabs');
}

function startRequests(): StartRequest[] {
  return requests().filter(
    (request: SessionRequestV2): request is StartRequest => request.type === 'startSession',
  );
}

function answerStartWith(response: StartSessionResponseV2): void {
  sendMessageMock.mockImplementation(async (request: SessionRequestV2): Promise<unknown> => {
    if (request.type === 'startSession') return response;
    return undefined;
  });
}

beforeEach((): void => {
  resetChromeFake();
  answerStartWith({ ok: true, code: 'ok' });
});

afterEach((): void => {
  cleanup();
});

describe('StartForm duration and forced controls', (): void => {
  it('keeps the chosen type, disables Hard, and forces no cycles while Until stopped is selected', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));

    const friction: HTMLElement = view.getByRole('button', { name: 'Friction' });
    const hard: HTMLElement = view.getByRole('button', { name: 'Hard lock' });
    expect(friction.getAttribute('aria-pressed')).toBe('true');
    expect(friction.getAttribute('aria-disabled')).toBeNull();
    expect(hard.getAttribute('aria-disabled')).toBe('true');
    expect(hard.textContent).toContain(HARD_UNAVAILABLE_REASON);
    // No forced wrapper around the type any more: the choices are live, Hard alone refuses.
    expect(hard.closest('.forced-control')).toBeNull();

    const forcedCycles: HTMLElement = view.getByRole('group', { name: FORCED_CYCLES_LABEL });
    const cycles: HTMLInputElement = view.getByRole('checkbox') as HTMLInputElement;
    expect(forcedCycles.getAttribute('aria-disabled')).toBe('true');
    expect(forcedCycles.contains(cycles)).toBe(true);
    expect(cycles.checked).toBe(false);

    expect(view.getByText(FRICTION_HINT)).toBeTruthy();
    expect(view.getByRole('button', { name: LOCK_UNTIL_MANUAL_UNLOCK_LABEL })).toBeTruthy();
  });

  it('switches the hint and start label with the type, and refuses Hard', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('button', { name: 'Hard lock' }));

    expect(view.getByRole('button', { name: 'Friction' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(view.getByRole('button', { name: 'Hard lock' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(view.getByRole('button', { name: LOCK_UNTIL_MANUAL_UNLOCK_LABEL })).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Flexible' }));

    expect(view.getByRole('button', { name: 'Flexible' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(view.getByText(FLEXIBLE_HINT)).toBeTruthy();
    expect(view.queryByText(FRICTION_HINT)).toBeNull();
    expect(view.getByRole('button', { name: START_UNTIL_STOPPED_LABEL })).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: '25 min' }));

    // The type chosen during the detour is the draft's type, and Hard is available again.
    expect(view.getByRole('button', { name: 'Flexible' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(
      view.getByRole('button', { name: 'Hard lock' }).getAttribute('aria-disabled'),
    ).toBeNull();
    expect(view.queryByText(FLEXIBLE_HINT)).toBeNull();
  });

  it('restores the timed session type, cycles, and start label when a preset returns', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('button', { name: '25 min' }));

    expect(view.queryByRole('group', { name: FORCED_CYCLES_LABEL })).toBeNull();
    expect(view.getByRole('button', { name: 'Friction' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(view.queryByText(FRICTION_HINT)).toBeNull();
    expect(view.getByRole('button', { name: TIMED_START_LABEL })).toBeTruthy();
  });

  it('restores typed custom minutes through the pressed Until stopped chip', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '45' } });
    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));

    expect(view.getByRole('button', { name: LOCK_UNTIL_MANUAL_UNLOCK_LABEL })).toBeTruthy();
    expect((view.getByLabelText('Custom minutes') as HTMLInputElement).value).toBe('45');

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));

    expect((view.getByLabelText('Custom minutes') as HTMLInputElement).value).toBe('45');
    expect(view.getByRole('button', { name: 'Start 45 min focus' })).toBeTruthy();
  });

  it('restores a non-default session type and cycle choice after the detour', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: 'Hard lock' }));
    fireEvent.click(view.getByRole('checkbox'));
    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('button', { name: '25 min' }));

    expect(view.getByRole('button', { name: 'Hard lock' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(view.getByRole('button', { name: TIMED_START_LABEL })).toBeTruthy();
  });

  it('keeps the stored preset when custom minutes are typed during the detour', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: '50 min' }));
    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '7' } });

    expect(view.getByRole('button', { name: 'Start 7 min focus' })).toBeTruthy();

    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '' } });

    expect(view.getByRole('button', { name: 'Start 50 min focus' })).toBeTruthy();
  });
});

describe('StartForm presets and the timed hint', (): void => {
  it('opens on the focus preset with cycles and states the plan under the presets', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    expect(view.getByRole('status').textContent).toBe('25 min uninterrupted focus');
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('turns cycles off for deep work, keeps them for the other presets, and follows the checkbox', async (): Promise<void> => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: '50 min' }));

    expect(view.getByRole('status').textContent).toBe('50 min uninterrupted focus');
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(view.getByRole('checkbox'));

    expect(view.getByRole('status').textContent).toBe('50 min total, with 25 min focus blocks');
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(view.getByRole('button', { name: '15 min' }));

    expect(view.getByRole('status').textContent).toBe('15 min uninterrupted focus');
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(view.getByRole('button', { name: '50 min' }));
    fireEvent.click(view.getByRole('button', { name: 'Start 50 min focus' }));

    await waitFor((): void => expect(startRequests()).toHaveLength(1));
    expect(startRequests()[0]?.config.duration).toEqual({ kind: 'timed', minutes: 50 });
    expect(startRequests()[0]?.config.cycling).toBeNull();
  });

  it('keeps the timed hint off while the length is unusable or Until stopped is selected', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '0' } });
    expect(view.queryByRole('status')).toBeNull();

    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '40' } });
    expect(view.getByRole('status').textContent).toBe('40 min total, with 25 min focus blocks');

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    expect(view.getByRole('status').textContent).toBe(FRICTION_HINT);
  });
});

describe('StartForm start command', (): void => {
  it('sends the exact Friction until-stopped start request the worker accepts', async (): Promise<void> => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'ship the release' } });
    fireEvent.click(view.getByRole('button', { name: LOCK_UNTIL_MANUAL_UNLOCK_LABEL }));

    await waitFor((): void => expect(startRequests()).toHaveLength(1));
    const request: StartRequest | undefined = startRequests()[0];
    expect(request).toEqual({
      type: 'startSession',
      config: {
        mode: 'blacklist',
        strictness: 'friction',
        duration: { kind: 'until-stopped' },
        cycling: null,
        intention: 'ship the release',
        source: 'manual',
        scheduleOccurrence: null,
        rules: rulesFromLists(DEFAULT_LISTS),
      },
    });
    expect(parseSessionStartRequestV2(request)).toEqual(request);
  });

  it('sends the exact Flexible until-stopped start request the worker accepts', async (): Promise<void> => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('button', { name: 'Flexible' }));
    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'ship the release' } });
    fireEvent.click(view.getByRole('button', { name: START_UNTIL_STOPPED_LABEL }));

    await waitFor((): void => expect(startRequests()).toHaveLength(1));
    const request: StartRequest | undefined = startRequests()[0];
    expect(request).toEqual({
      type: 'startSession',
      config: {
        mode: 'blacklist',
        strictness: 'flexible',
        duration: { kind: 'until-stopped' },
        cycling: null,
        intention: 'ship the release',
        source: 'manual',
        scheduleOccurrence: null,
        rules: rulesFromLists(DEFAULT_LISTS),
      },
    });
    expect(parseSessionStartRequestV2(request)).toEqual(request);
  });

  it('sends the timed request when a preset is selected', async (): Promise<void> => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));

    await waitFor((): void => expect(startRequests()).toHaveLength(1));
    expect(startRequests()[0]?.config.duration).toEqual({ kind: 'timed', minutes: 25 });
    expect(startRequests()[0]?.config.strictness).toBe('friction');
  });

  it('refuses to send a start without a usable session length', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.input(view.getByLabelText('Custom minutes'), { target: { value: '0' } });
    fireEvent.click(view.getByRole('button', { name: 'Start invalid time focus' }));

    expect(view.getByRole('alert').textContent).toContain('session length');
    expect(startRequests()).toHaveLength(0);
  });

  it('shows the worker error text for every rejected start code', async (): Promise<void> => {
    const codes: readonly StartSessionResponseV2['code'][] = [
      'invalid-request',
      'transition-cleanup-pending',
      'closure-cleanup-pending',
      'data-clear-pending',
    ];

    for (const code of codes) {
      resetChromeFake();
      answerStartWith({ ok: false, code, error: `worker said ${code}` } as StartSessionResponseV2);
      const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

      fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));

      await waitFor((): void => {
        expect(view.getByRole('alert').textContent).toBe(`worker said ${code}`);
      });
      cleanup();
    }
  });

  it('keeps the draft after a transition failure that still needs cleanup', async (): Promise<void> => {
    answerStartWith({
      ok: false,
      code: 'tab-enforcement-failed',
      error: 'Blocking could not start on an open tab.',
      cleanupPending: true,
    });
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'write the report' } });
    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    fireEvent.click(view.getByRole('button', { name: LOCK_UNTIL_MANUAL_UNLOCK_LABEL }));

    await waitFor((): void => {
      expect(view.getByRole('alert').textContent).toBe('Blocking could not start on an open tab.');
    });
    expect((view.getByLabelText('Intention') as HTMLInputElement).value).toBe('write the report');
    expect(view.getByRole('button', { name: LOCK_UNTIL_MANUAL_UNLOCK_LABEL })).toBeTruthy();
  });

  it('shows the fallback when the worker answers with a malformed response', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({ ok: false, code: 'nope', error: 'unknown' });
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));

    await waitFor((): void => {
      expect(view.getByRole('alert').textContent).toBe('Could not start session. Try again.');
    });
  });

  it('fetches and rebases current lists after a stale response before a new explicit start', async (): Promise<void> => {
    const refreshed: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, video: true },
      custom: [{ kind: 'host', pattern: 'fresh.example' }],
    };
    let startCount: number = 0;
    sendMessageMock.mockImplementation(async (request: SessionRequestV2): Promise<unknown> => {
      if (request.type !== 'startSession') return refreshed;
      startCount += 1;
      return startCount === 1
        ? { ok: false, code: 'invalid-request', error: STALE_SESSION_RULES_ERROR }
        : { ok: true, code: 'ok' };
    });
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: 'Social' }));
    fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));
    await view.findByText('fresh.example');

    expect(requests().map((request: SessionRequestV2): string => request.type)).toEqual([
      'startSession',
      'getLists',
    ]);
    expect(view.getByRole('alert').textContent).toBe(STALE_SESSION_RULES_ERROR);

    fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));

    await waitFor((): void => {
      expect(startRequests()).toHaveLength(2);
      expect(startRequests()[1]?.config.rules).toEqual(
        expect.objectContaining({
          baselineRevision: rulesFromLists(refreshed).baselineRevision,
          permanentBlacklist: refreshed.custom,
          categories: expect.objectContaining({ social: true, video: true }),
        }),
      );
    });
    // The reset after the accepted start uses the refreshed lists, not the stale prop.
    expect(view.getByText('fresh.example')).toBeTruthy();
  });

  it('clears the intention after a successful start and keeps the length and type', async (): Promise<void> => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'ship the release' } });
    fireEvent.click(view.getByRole('button', { name: 'Hard lock' }));
    fireEvent.click(view.getByRole('button', { name: UNTIL_STOPPED_LABEL }));
    // Hard clamps to Friction for an indefinite draft, so the button locks rather than starts.
    fireEvent.click(view.getByRole('button', { name: LOCK_UNTIL_MANUAL_UNLOCK_LABEL }));

    await waitFor((): void => {
      expect((view.getByLabelText('Intention') as HTMLInputElement).value).toBe('');
    });
    // The next session opens on what this one used: still Until stopped, and the Hard choice is
    // still held behind the Friction it clamps to, so a timed length brings Hard back.
    expect(
      view.getByRole('button', { name: UNTIL_STOPPED_LABEL }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(view.getByRole('button', { name: 'Friction' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(view.getByRole('button', { name: '25 min' }));
    expect(view.getByRole('button', { name: 'Hard lock' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows the start fallback when the transport itself rejects', async (): Promise<void> => {
    sendMessageMock.mockRejectedValue(new Error('port closed'));
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'ship the release' } });
    fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));

    const alert: HTMLElement = await view.findByRole('alert');
    expect(alert.textContent).toBe(START_FAILED_COPY);
    expect((view.getByLabelText('Intention') as HTMLInputElement).value).toBe('ship the release');
  });

  it('keeps fallback category controls out of the draft', (): void => {
    const view = render(
      <StartForm settings={SETTINGS} lists={DEFAULT_LISTS} categoriesEditable={false} />,
    );
    const social: HTMLButtonElement = view.getByRole('button', {
      name: 'Social',
    }) as HTMLButtonElement;

    expect(social.disabled).toBe(true);
    fireEvent.click(social);

    expect(social.getAttribute('aria-pressed')).toBe('false');
    expect(requests()).toHaveLength(0);
  });
});

describe('StartForm settings link, list rebase, and layout', (): void => {
  it('opens permanent Settings without touching the draft', async (): Promise<void> => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);
    fireEvent.input(view.getByLabelText('Intention'), { target: { value: 'write the report' } });

    fireEvent.click(view.getByRole('button', { name: 'Open Settings for permanent defaults' }));

    await waitFor((): void => {
      expect(openOptionsPageMock).toHaveBeenCalledOnce();
    });
    expect((view.getByLabelText('Intention') as HTMLInputElement).value).toBe('write the report');
    expect(requests()).toHaveLength(0);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('reports a Settings page that will not open', async (): Promise<void> => {
    openOptionsPageMock.mockRejectedValue(new Error('no options page'));
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: 'Open Settings for permanent defaults' }));

    await waitFor((): void => {
      expect(view.getByRole('alert').textContent).toBe('Could not open Settings. Try again.');
    });
    expect(requests()).toHaveLength(0);
  });

  it('rebases the draft onto refreshed lists while keeping the user deviation', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);
    fireEvent.click(view.getByRole('button', { name: 'Social' }));
    expect(view.getByRole('button', { name: 'Social' }).getAttribute('aria-pressed')).toBe('true');
    expect(
      view.getByRole('button', { name: 'Video and streaming' }).getAttribute('aria-pressed'),
    ).toBe('false');

    const refreshed: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, video: true },
      custom: [{ kind: 'host', pattern: 'fresh.example' }],
    };
    view.rerender(<StartForm settings={SETTINGS} lists={refreshed} />);

    expect(view.getByText('fresh.example')).toBeTruthy();
    expect(
      view.getByRole('button', { name: 'Video and streaming' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(view.getByRole('button', { name: 'Social' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('reports lists it cannot reload after a stale start', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: SessionRequestV2): Promise<unknown> => {
      if (request.type === 'startSession') {
        return { ok: false, code: 'invalid-request', error: STALE_SESSION_RULES_ERROR };
      }
      return { categories: 'not a lists config' };
    });
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    fireEvent.click(view.getByRole('button', { name: TIMED_START_LABEL }));

    await waitFor((): void => {
      expect(view.getByRole('alert').textContent).toBe(
        'Defaults changed, but current lists could not be loaded. Reload the popup.',
      );
    });
    expect(requests().map((request: SessionRequestV2): string => request.type)).toEqual([
      'startSession',
      'getLists',
    ]);
  });

  it('labels the intention field and the blocking mode group', (): void => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    const intention: HTMLInputElement = view.getByLabelText('Intention') as HTMLInputElement;
    expect(intention.placeholder).toBe('What are you working on?');
    const mode: HTMLElement = view.getByRole('group', { name: 'Blocking mode' });
    expect(mode.querySelector('legend')?.textContent).toBe('Blocking mode');
  });

  it('keeps the start action and its error outside the scrolling region', async (): Promise<void> => {
    openOptionsPageMock.mockRejectedValue(new Error('no options page'));
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);
    const scroll: Element | null = view.container.querySelector('.start-form__scroll');
    const actions: Element | null = view.container.querySelector('.start-form__actions');
    if (scroll === null || actions === null) throw new Error('the start form layout is missing');

    const start: HTMLElement = view.getByRole('button', { name: TIMED_START_LABEL });
    expect(actions.contains(start)).toBe(true);
    expect(scroll.contains(start)).toBe(false);

    fireEvent.click(view.getByRole('button', { name: 'Open Settings for permanent defaults' }));

    const alert: HTMLElement = await view.findByRole('alert');
    expect(actions.contains(alert)).toBe(true);
    expect(scroll.contains(alert)).toBe(false);
  });
});

describe('quiet session settings', (): void => {
  it('starts collapsed and opens the chooser from Change', (): void => {
    const view: ReturnType<typeof render> = render(
      <StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />,
    );
    const details: HTMLDetailsElement = view.getByText('Session settings')
      .parentElement as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(view.getByRole('button', { name: 'Change' }));
    expect(details.open).toBe(true);
  });

  it('keeps custom minutes visible and focuses invalid duration without opening settings', async (): Promise<void> => {
    const view: ReturnType<typeof render> = render(
      <StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />,
    );
    const details: HTMLDetailsElement = view.getByText('Session settings')
      .parentElement as HTMLDetailsElement;
    details.open = true;
    const custom: HTMLInputElement = view.getByRole('spinbutton', {
      name: 'Custom minutes',
    }) as HTMLInputElement;
    fireEvent.input(custom, { target: { value: '0' } });
    details.open = false;
    fireEvent.click(view.getByRole('button', { name: /^Start/ }));
    expect(details.open).toBe(false);
    expect(custom.value).toBe('0');
    await waitFor((): void => expect(document.activeElement).toBe(custom));
    expect(view.getByRole('alert').closest('details')).toBeNull();
  });
});

it('keeps invalid allowed-domain feedback outside collapsed settings', (): void => {
  const view: ReturnType<typeof render> = render(
    <StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />,
  );
  const details: HTMLDetailsElement = view.getByText('Session settings')
    .parentElement as HTMLDetailsElement;
  details.open = true;
  fireEvent.click(view.getByRole('radio', { name: /Allow selected sites only/ }));
  fireEvent.input(view.getByLabelText('Add an allowed domain'), { target: { value: 'http://[' } });
  fireEvent.click(view.getByRole('button', { name: 'Add allowed domain' }));
  details.open = false;
  expect(view.getByRole('alert').closest('details')).toBeNull();
});

describe('StartForm remembers the last length and session type', (): void => {
  it('opens on the length and type chosen the previous time', async (): Promise<void> => {
    localStore.set('popupChoices', {
      version: 1,
      duration: { kind: 'timed', presetMin: 50, customMin: '' },
      strictness: 'hard',
    });

    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);

    await waitFor((): void =>
      expect(view.getByRole('button', { name: '50 min' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
    expect(view.getByRole('button', { name: 'Hard lock' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('stores a length and type as soon as they are picked', async (): Promise<void> => {
    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);
    // Let the empty store be read first, which is what allows writing to begin.
    await waitFor((): void => expect(view.getByRole('button', { name: '15 min' })).toBeTruthy());
    await new Promise((resolve: (value: unknown) => void): void => {
      setTimeout(resolve, 0);
    });

    fireEvent.click(view.getByRole('button', { name: '15 min' }));
    fireEvent.click(view.getByRole('button', { name: 'Flexible' }));

    await waitFor((): void =>
      expect(localStore.get('popupChoices')).toEqual({
        version: 1,
        duration: { kind: 'timed', presetMin: 15, customMin: '' },
        strictness: 'flexible',
      }),
    );
  });

  it('never overwrites what was remembered with the defaults it opened on', async (): Promise<void> => {
    const stored: unknown = {
      version: 1,
      duration: { kind: 'until-stopped', timed: { presetMin: 50, customMin: '' } },
      strictness: 'flexible',
    };
    localStore.set('popupChoices', structuredClone(stored));

    const view = render(<StartForm settings={SETTINGS} lists={DEFAULT_LISTS} />);
    await waitFor((): void =>
      expect(view.getByRole('button', { name: 'Flexible' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );

    expect(localStore.get('popupChoices')).toEqual(stored);
  });
});
