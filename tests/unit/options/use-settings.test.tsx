/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { App } from '../../../src/options/App';
import type { SettingsStore } from '../../../src/options/use-settings';
import { useSettingsStore } from '../../../src/options/use-settings';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshot,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { PendingPolicyChange } from '../../../src/background/pending-policy-changes';
import type { Request } from '../../../src/shared/messages';
import { settingsTimedCopy } from '../../../src/shared/session-copy';
import type {
  ListsConfig,
  SessionConfig,
  SessionSnapshot,
  Settings,
  SetupState,
} from '../../../src/shared/types';
import type { ChromeFake } from './chrome-fake';
import { installChromeFake } from './chrome-fake';

/** The one-shot guard `use-settings.ts` writes before it reloads. */
const RELOAD_FLAG: string = 'focusLockSnapshotReload';

let fake: ChromeFake;
let captured: SettingsStore | null = null;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = (): void => {};
  const promise: Promise<T> = new Promise<T>((done: (value: T) => void): void => {
    resolve = done;
  });
  return { promise, resolve };
}

function Harness(): VNode {
  captured = useSettingsStore();
  return <output>{captured.lists === null ? 'loading' : 'ready'}</output>;
}

function store(): SettingsStore {
  if (captured === null) throw new Error('store not mounted');
  return captured;
}

function hardSnapshot(sessionEndsAt: number): SessionSnapshot {
  const config: SessionConfig = {
    mode: 'blacklist',
    strictness: 'hard',
    duration: { kind: 'timed', minutes: 25 },
    cycling: null,
    intention: 'write the report',
    source: 'manual',
    scheduleOccurrence: null,
    rules: rulesFromLists(DEFAULT_LISTS),
  };
  const startedAt: number = sessionEndsAt - 25 * 60_000;
  const at: number = sessionEndsAt - 15 * 60_000;
  return {
    ...emptySnapshot(at),
    // Hard hides the end control, which is what the status disclosure stands in for.
    lifecycle: { kind: 'active', endAuthority: { kind: 'hidden' } },
    phase: 'focus',
    config,
    startedAt,
    phaseStartedAt: startedAt,
    phaseEndsAt: sessionEndsAt,
    sessionEndsAt,
    sessionFocusedMs: at - startedAt,
  };
}

beforeEach((): void => {
  captured = null;
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  fake = installChromeFake();
  fake.respond('getSettings', DEFAULT_SETTINGS);
  fake.respond('getLists', DEFAULT_LISTS);
  fake.respond('getSnapshot', emptySnapshot(0));
});

afterEach((): void => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

/**
 * jsdom refuses to redefine location's own properties, so the whole global is stubbed. The spread
 * carries the URL: jsdom gives Location its attributes as own enumerable members, not as
 * prototype accessors, so href and the rest survive it. That is what the assertion pins, because
 * a jsdom that moved them onto the prototype would leave anything reading the URL under this
 * stub with undefined, and the failure would surface far from here.
 */
function stubReload(): Mock<() => void> {
  const reload: Mock<() => void> = vi.fn<() => void>();
  const href: string = window.location.href;
  vi.stubGlobal('location', { ...window.location, reload });
  expect(location.href).toBe(href);
  return reload;
}

describe('useSettingsStore', () => {
  it('loads settings, lists, and snapshot on mount', async (): Promise<void> => {
    render(<Harness />);
    await waitFor((): void => {
      expect(store().lists).not.toBeNull();
    });
    expect(store().settings).toEqual(DEFAULT_SETTINGS);
    expect(store().lists).toEqual(DEFAULT_LISTS);
    expect(store().snapshot).toEqual(emptySnapshot(0));
    expect(store().loadError).toBeNull();
  });

  it('loads the held edits a hard lock refused', async (): Promise<void> => {
    const held: PendingPolicyChange = {
      path: 'settings.gate.delayMs',
      intent: { kind: 'value', value: 5_000 },
      reasonKey: 'notify_guard_settings_shorten_delay',
      at: 10,
    };
    fake.respond('getPendingChanges', { changes: [held] });
    render(<Harness />);
    await waitFor((): void => expect(store().lists).not.toBeNull());

    expect(store().pendingChanges).toEqual([held]);
  });

  it('drops a held edit the person cancels and reads the queue back', async (): Promise<void> => {
    const held: PendingPolicyChange = {
      path: 'lists',
      intent: {
        kind: 'lists-delta',
        removeCustom: ['host:reddit.com'],
        addWhitelist: [],
        disableCategories: [],
        addExclusions: {},
      },
      reasonKey: 'notify_guard_lists_remove_blocked',
      at: 11,
    };
    fake.respond('getPendingChanges', { changes: [held] });
    fake.respond('cancelPendingChange', { ok: true });
    render(<Harness />);
    await waitFor((): void => expect(store().pendingChanges).toHaveLength(1));

    fake.respond('getPendingChanges', { changes: [] });
    await act(async (): Promise<void> => {
      await store().cancelPendingChange('lists');
    });

    expect(fake.sent).toContainEqual({ type: 'cancelPendingChange', path: 'lists' });
    expect(store().pendingChanges).toEqual([]);
  });

  it('follows the stored queue when the worker drains it', async (): Promise<void> => {
    const held: PendingPolicyChange = {
      path: 'settings.pause.capMs',
      intent: { kind: 'value', value: 1 },
      reasonKey: 'notify_guard_settings_raise_cap',
      at: 12,
    };
    fake.respond('getPendingChanges', { changes: [held] });
    render(<Harness />);
    await waitFor((): void => expect(store().pendingChanges).toHaveLength(1));

    fake.respond('getPendingChanges', { changes: [] });
    await act(async (): Promise<void> => {
      fake.emitStorageChange({ pendingChanges: { oldValue: [held] } });
      await Promise.resolve();
    });

    await waitFor((): void => expect(store().pendingChanges).toEqual([]));
  });

  it('loads the durable setup state with the settings surfaces', async (): Promise<void> => {
    fake.respond('getSetupState', DEFAULT_SETUP);
    render(<Harness />);
    await waitFor((): void => expect(store().lists).not.toBeNull());

    const privacyStore: SettingsStore & { setup?: SetupState | null } = store();
    expect(privacyStore.setup).toEqual(DEFAULT_SETUP);
  });

  it('rejects malformed durable setup state without publishing partial settings', async (): Promise<void> => {
    fake.respond('getSetupState', { ...DEFAULT_SETUP, unexpected: true });
    render(<Harness />);

    await waitFor((): void =>
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.'),
    );
    expect(store().settings).toBeNull();
    expect(store().setup).toBeNull();
  });

  it('reports the boot failure reason and exposes retryBoot when the worker did not start', async (): Promise<void> => {
    // A worker whose boot failed answers every load request with a rejection and the setup record
    // with the boot overlay. The page asks for the reason and offers the retry, then loads again.
    let started: boolean = false;
    const rejection: { ok: false; error: string } = {
      ok: false,
      error: 'Focus Lock did not finish starting: invalid local setup state',
    };
    fake.respond('getSettings', (): unknown => (started ? DEFAULT_SETTINGS : rejection));
    fake.respond('getLists', (): unknown => (started ? DEFAULT_LISTS : rejection));
    fake.respond('getSnapshot', (): unknown => (started ? emptySnapshot(0) : rejection));
    fake.respond(
      'getSetupState',
      (): SetupState =>
        started ? { ...DEFAULT_SETUP } : { ...DEFAULT_SETUP, storageError: 'boot-failed' },
    );
    fake.respond('getBootFailure', (): unknown =>
      started
        ? { ok: true, failure: null }
        : {
            ok: true,
            failure: { stage: 'policy-storage', message: 'invalid local setup state', at: 5 },
          },
    );
    fake.respond('retryBoot', (): { ok: true } => {
      started = true;
      return { ok: true };
    });
    render(<Harness />);

    await waitFor((): void => {
      expect(store().loadError).toBe('Focus Lock could not start: invalid local setup state');
    });
    expect(store().bootFailure).toEqual({
      stage: 'policy-storage',
      message: 'invalid local setup state',
      at: 5,
    });
    expect(store().settings).toBeNull();

    let result: string | null = 'unset';
    await act(async (): Promise<void> => {
      result = await store().retryBoot();
    });

    expect(result).toBeNull();
    expect(fake.sent).toContainEqual({ type: 'retryBoot' });
    await waitFor((): void => expect(store().lists).not.toBeNull());
    expect(store().loadError).toBeNull();
    expect(store().bootFailure).toBeNull();
    expect(store().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the generic load error when the worker is running but answers malformed data', async (): Promise<void> => {
    fake.respond('getSettings', { ...DEFAULT_SETTINGS, unexpected: true });
    fake.respond('getBootFailure', { ok: true, failure: null });
    render(<Harness />);

    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().bootFailure).toBeNull();
    expect(fake.sent).toContainEqual({ type: 'getBootFailure' });
  });

  it('refreshes durable setup state after changing storage mode', async (): Promise<void> => {
    let setup: SetupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    fake.respond('getSetupState', (): SetupState => structuredClone(setup));
    fake.respond('setStorageMode', (request: Request): { ok: true } => {
      expect(request).toEqual({
        type: 'setStorageMode',
        storageMode: 'sync',
        deleteRemote: false,
      });
      setup = { ...setup, storageMode: 'sync', syncWriteStatus: 'pending' };
      return { ok: true };
    });
    render(<Harness />);
    await waitFor((): void => expect(store().setup?.storageMode).toBe('local'));

    let result: string | null = 'unset';
    await act(async (): Promise<void> => {
      result = await store().setStorageMode('sync');
    });

    expect(result).toBeNull();
    expect(store().setup?.storageMode).toBe('sync');
    expect(store().setup?.syncWriteStatus).toBe('pending');
  });

  it('uses the dedicated retry boundary and refreshes durable Sync completion', async (): Promise<void> => {
    let setup: SetupState = {
      ...DEFAULT_SETUP,
      completed: true,
      storageMode: 'sync',
      syncWriteStatus: 'error',
      storageError: 'sync-publish-failed',
    };
    fake.respond('getSetupState', (): SetupState => structuredClone(setup));
    fake.respond('retrySync' as Request['type'], (request: Request): object => {
      expect(request).toEqual({ type: 'retrySync' });
      setup = { ...setup, syncWriteStatus: 'idle', storageError: null };
      return { ok: true, syncWriteStatus: 'idle' };
    });
    render(<Harness />);
    await waitFor((): void => expect(store().setup?.syncWriteStatus).toBe('error'));

    let result: string | null = 'unset';
    await act(async (): Promise<void> => {
      result = await (
        store() as SettingsStore & { retrySync(): Promise<string | null> }
      ).retrySync();
    });

    expect(result).toBeNull();
    expect(store().setup?.syncWriteStatus).toBe('idle');
    expect(fake.sent).toContainEqual({ type: 'retrySync' });
  });

  it('rejects a false retry success that does not prove durable completion', async (): Promise<void> => {
    fake.respond('retrySync' as Request['type'], { ok: true });
    render(<Harness />);
    await waitFor((): void => expect(store().setup).not.toBeNull());

    let result: string | null = null;
    await act(async (): Promise<void> => {
      result = await (
        store() as SettingsStore & { retrySync(): Promise<string | null> }
      ).retrySync();
    });

    expect(result).toBe('Could not retry Chrome Sync. Try again.');
  });

  it('keeps a newer broadcast theme when the initial load resolves later', async (): Promise<void> => {
    const settings: Deferred<Settings> = deferred<Settings>();
    fake.respond('getSettings', settings.promise);
    render(<Harness />);
    await waitFor((): void =>
      expect(fake.sent.some((request: Request): boolean => request.type === 'getSettings')).toBe(
        true,
      ),
    );
    await act(async (): Promise<void> => {
      fake.emit({ type: 'stateChanged', snapshot: { ...emptySnapshot(0), theme: 'dark' } });
      settings.resolve({ ...DEFAULT_SETTINGS, streakGoalMin: 37 });
    });
    await waitFor((): void => expect(store().settings).not.toBeNull());
    expect(store().settings?.theme).toBe('dark');
    expect(store().settings?.streakGoalMin).toBe(37);
    expect(store().snapshot?.theme).toBe('dark');
  });

  it('rejects a malformed initial settings response without publishing it', async (): Promise<void> => {
    fake.respond('getSettings', { ok: false, error: 'worker unavailable' });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
    expect(store().lists).toBeNull();
  });

  it('reloads once for a snapshot response it cannot validate', async (): Promise<void> => {
    const reload: Mock<() => void> = stubReload();
    fake.respond('getSnapshot', { ok: false, error: 'worker unavailable' });
    render(<Harness />);

    // jsdom cannot navigate, so the guard flag and the reload call are what the page leaves behind.
    await waitFor((): void => {
      expect(sessionStorage.getItem(RELOAD_FLAG)).toBe('1');
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(store().loadError).toBeNull();
    expect(store().snapshot).toBeNull();
  });

  it('never reloads a page whose session storage refuses to remember the attempt', async (): Promise<void> => {
    const reload: Mock<() => void> = stubReload();
    vi.stubGlobal('sessionStorage', {
      getItem: (): string | null => {
        throw new Error('storage is blocked');
      },
      setItem: (): void => {
        throw new Error('storage is blocked');
      },
    });
    fake.respond('getSnapshot', { ok: false, error: 'worker unavailable' });
    render(<Harness />);

    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('rejects a worker rejection snapshot response once the reloaded page fails again', async (): Promise<void> => {
    const reload: Mock<() => void> = stubReload();
    sessionStorage.setItem(RELOAD_FLAG, '1');
    fake.respond('getSnapshot', { ok: false, error: 'worker unavailable' });
    render(<Harness />);

    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
    expect(store().lists).toBeNull();
    expect(store().snapshot).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('rejects a non-positive freeze cadence from the worker', async (): Promise<void> => {
    fake.respond('getSettings', { ...DEFAULT_SETTINGS, streakFreezeIntervalDays: 0 });
    render(<Harness />);

    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
  });

  it.each([
    ['zero preset', { presetsMin: [0, 25, 50] }],
    ['sub-millisecond preset', { presetsMin: [0.000_001, 25, 50] }],
    ['unsafe preset', { presetsMin: [15, Number.MAX_SAFE_INTEGER, 50] }],
    ['preset past the relative-duration cap', { presetsMin: [15, 72_000_000_001, 50] }],
    ['maximum safe integer freeze cadence', { streakFreezeIntervalDays: Number.MAX_SAFE_INTEGER }],
    ['freeze cadence past the Date range', { streakFreezeIntervalDays: 100_000_001 }],
  ])('rejects %s from the worker', async (_label: string, update: object): Promise<void> => {
    fake.respond('getSettings', { ...DEFAULT_SETTINGS, ...update });
    render(<Harness />);

    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
  });

  it('loads fractional and exact upper-bound settings from the worker', async (): Promise<void> => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      presetsMin: [0.1, 25.5, 72_000_000_000],
      streakFreezeIntervalDays: 100_000_000,
    };
    fake.respond('getSettings', settings);
    render(<Harness />);

    await waitFor((): void => {
      expect(store().settings).toEqual(settings);
    });
    expect(store().loadError).toBeNull();
  });

  it('reports a rejected initial lists request without publishing partial state', async (): Promise<void> => {
    fake.respond('getLists', (): never => {
      throw new Error('worker unavailable');
    });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
    expect(store().lists).toBeNull();
  });

  it('saveLists resolves null on ok and the store serves the saved lists', async (): Promise<void> => {
    fake.respond('updateLists', { ok: true });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().lists).not.toBeNull();
    });
    const next: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'nu.nl' }],
    };
    let result: string | null = 'unset';
    await act(async (): Promise<void> => {
      result = await store().saveLists(next);
    });
    expect(result).toBeNull();
    expect(store().lists).toEqual(next);
  });

  it('saveLists resolves the rejection string verbatim and keeps the current lists', async (): Promise<void> => {
    const rejection: string = 'a hard session is running: weakening changes are locked until 16:45';
    fake.respond('updateLists', { ok: false, error: rejection });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().lists).not.toBeNull();
    });
    const next: ListsConfig = { ...DEFAULT_LISTS, custom: [] };
    let result: string | null = null;
    await act(async (): Promise<void> => {
      result = await store().saveLists(next);
    });
    expect(result).toBe(rejection);
    expect(store().lists).toEqual(DEFAULT_LISTS);
  });

  it('saveSettings mirrors the same contract', async (): Promise<void> => {
    const rejection: string = 'a hard session is running: strictness cannot be weakened';
    fake.respond('updateSettings', { ok: false, error: rejection });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().settings).not.toBeNull();
    });
    let result: string | null = null;
    await act(async (): Promise<void> => {
      result = await store().saveSettings({
        section: 'budget',
        value: {
          pause: DEFAULT_SETTINGS.pause,
          streakGoalMin: 50,
          streakFreezeIntervalDays: DEFAULT_SETTINGS.streakFreezeIntervalDays,
          retentionDays: DEFAULT_SETTINGS.retentionDays,
        },
      });
    });
    expect(result).toBe(rejection);
    expect(store().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('saveTheme updates the committed theme after the worker accepts it', async (): Promise<void> => {
    fake.respond('updateTheme', { ok: true });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().settings).not.toBeNull();
    });

    let result: string | null = 'unset';
    await act(async (): Promise<void> => {
      result = await store().saveTheme('dark');
    });

    expect(result).toBeNull();
    expect(fake.sent).toContainEqual({ type: 'updateTheme', theme: 'dark' });
    expect(store().settings?.theme).toBe('dark');
  });

  it('saveTheme keeps the committed theme after the worker rejects it', async (): Promise<void> => {
    fake.respond('updateTheme', { ok: false, error: 'theme write rejected' });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().settings).not.toBeNull();
    });

    let result: string | null = null;
    await act(async (): Promise<void> => {
      result = await store().saveTheme('dark');
    });

    expect(result).toBe('theme write rejected');
    expect(store().settings?.theme).toBe('auto');
  });

  it('updates the committed theme from a validated stateChanged broadcast', async (): Promise<void> => {
    render(<Harness />);
    await waitFor((): void => expect(store().settings).not.toBeNull());
    await act(async (): Promise<void> => {
      fake.emit({ type: 'stateChanged', snapshot: { ...emptySnapshot(0), theme: 'dark' } });
    });
    expect(store().settings?.theme).toBe('dark');
  });
});

describe('App frame', () => {
  it('offers the all-data deletion beside the boot retry after an inline confirmation', async (): Promise<void> => {
    let cleared: boolean = false;
    const rejection: { ok: false; error: string } = {
      ok: false,
      error: 'Focus Lock did not finish starting: invalid local setup state',
    };
    fake.respond('getSettings', (): unknown => (cleared ? DEFAULT_SETTINGS : rejection));
    fake.respond('getLists', (): unknown => (cleared ? DEFAULT_LISTS : rejection));
    fake.respond('getSnapshot', (): unknown => (cleared ? emptySnapshot(0) : rejection));
    fake.respond(
      'getSetupState',
      (): SetupState =>
        cleared ? { ...DEFAULT_SETUP } : { ...DEFAULT_SETUP, storageError: 'boot-failed' },
    );
    fake.respond('getBootFailure', (): unknown =>
      cleared
        ? { ok: true, failure: null }
        : {
            ok: true,
            failure: { stage: 'policy-storage', message: 'invalid local setup state', at: 5 },
          },
    );
    fake.respond('retryBoot', (): unknown => (cleared ? { ok: true } : rejection));
    fake.respond('clearFocusLockData', (request: Request): unknown => {
      expect(request).toEqual({ type: 'clearFocusLockData', scope: 'all' });
      cleared = true;
      return { ok: true, scope: 'all', status: 'cleared' };
    });
    const { getByRole, queryByRole } = render(<App />);

    const first: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement =>
        getByRole('button', { name: 'Delete all Focus Lock data' }) as HTMLButtonElement,
    );
    expect(getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(queryByRole('button', { name: 'Delete everything and start over' })).toBeNull();

    fireEvent.click(first);
    expect(getByRole('button', { name: 'Delete everything and start over' })).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Keep my data' }));
    expect(queryByRole('button', { name: 'Delete everything and start over' })).toBeNull();
    expect(fake.sent).not.toContainEqual({ type: 'clearFocusLockData', scope: 'all' });

    fireEvent.click(getByRole('button', { name: 'Delete all Focus Lock data' }));
    fireEvent.click(getByRole('button', { name: 'Delete everything and start over' }));

    // The worker booted into setup after the clear, so the page loads without the error.
    await waitFor((): void => {
      expect(queryByRole('alert')).toBeNull();
    });
    expect(fake.sent).toContainEqual({ type: 'clearFocusLockData', scope: 'all' });
    expect(queryByRole('button', { name: 'Delete all Focus Lock data' })).toBeNull();
  });

  it('renders the six merged nav sections', async (): Promise<void> => {
    const { getByRole } = render(<App />);
    await waitFor((): void => {
      expect(getByRole('link', { name: 'Blocking' })).toBeTruthy();
    });
    for (const label of [
      'Blocking',
      'Schedule',
      'Session behavior',
      'Site access credit',
      'Notifications',
      'Privacy and data',
    ]) {
      expect(getByRole('link', { name: label })).toBeTruthy();
    }
    expect(getByRole('heading', { level: 1, name: 'Focus Lock settings' })).toBeTruthy();
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  it('uses the initial hash, follows old aliases, and falls back to Blocking', async (): Promise<void> => {
    window.history.replaceState(null, '', '/#schedule');
    const { getByRole } = render(<App />);
    await waitFor((): void => expect(getByRole('heading', { name: 'Schedule' })).toBeTruthy());
    expect(getByRole('link', { name: 'Schedule' }).getAttribute('aria-current')).toBe('page');

    window.location.hash = '#categories';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor((): void => expect(getByRole('heading', { name: 'Blocking' })).toBeTruthy());

    window.location.hash = '#invalid';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor((): void => expect(getByRole('heading', { name: 'Blocking' })).toBeTruthy());
  });

  it('keeps unfinished local rule input across section navigation', async (): Promise<void> => {
    const { getAllByLabelText, getByRole } = render(<App />);
    await waitFor((): void => expect(getByRole('heading', { name: 'Blocking' })).toBeTruthy());
    const pattern: HTMLInputElement = getAllByLabelText('Pattern')[0] as HTMLInputElement;
    fireEvent.input(pattern, { target: { value: 'unfinished.example' } });
    fireEvent.click(getByRole('link', { name: 'Schedule' }));
    expect(getByRole('heading', { name: 'Schedule' })).toBeTruthy();
    fireEvent.click(getByRole('link', { name: 'Blocking' }));
    expect((getAllByLabelText('Pattern')[0] as HTMLInputElement).value).toBe('unfinished.example');
  });

  it('owns dirty state per destination and discards only the active section', async (): Promise<void> => {
    const { getByLabelText, getByRole, getByText } = render(<App />);
    await waitFor((): void => expect(getByRole('link', { name: 'Session behavior' })).toBeTruthy());

    fireEvent.click(getByRole('link', { name: 'Session behavior' }));
    const preset: HTMLInputElement = getByLabelText(
      'Short session preset (minutes)',
    ) as HTMLInputElement;
    expect((getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.input(preset, { target: { value: '12' } });
    expect(getByText('Unsaved changes')).toBeTruthy();
    expect((getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(getByRole('link', { name: 'Schedule' }));
    expect(getByText('No unsaved changes')).toBeTruthy();
    expect((getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(getByRole('link', { name: 'Session behavior' }));
    expect((getByLabelText('Short session preset (minutes)') as HTMLInputElement).value).toBe('12');
    fireEvent.click(getByRole('button', { name: 'Discard changes' }));
    expect((getByLabelText('Short session preset (minutes)') as HTMLInputElement).value).toBe('15');
    expect(getByText('No unsaved changes')).toBeTruthy();
  });

  it('keeps the sticky save actions pending until the destination save settles', async (): Promise<void> => {
    const update: Deferred<{ ok: true }> = deferred<{ ok: true }>();
    fake.respond('updateSettings', update.promise);
    const { getByLabelText, getByRole, getByText } = render(<App />);
    await waitFor((): void =>
      expect(getByRole('link', { name: 'Site access credit' })).toBeTruthy(),
    );
    fireEvent.click(getByRole('link', { name: 'Site access credit' }));
    fireEvent.input(getByLabelText('Daily streak goal (focus minutes)'), {
      target: { value: '30' },
    });

    fireEvent.click(getByRole('button', { name: 'Save changes' }));
    expect(getByText('Saving changes')).toBeTruthy();
    expect((getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((getByRole('button', { name: 'Discard changes' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async (): Promise<void> => update.resolve({ ok: true }));
    await waitFor((): void => expect(getByText('No unsaved changes')).toBeTruthy());
  });

  it('keeps a deferred rejection owned by its originating destination', async (): Promise<void> => {
    const update: Deferred<{ ok: false; error: string }> = deferred<{ ok: false; error: string }>();
    fake.respond('updateSettings', update.promise);
    const { getByLabelText, getByRole, getByText, queryByRole } = render(<App />);
    await waitFor((): void =>
      expect(getByRole('link', { name: 'Site access credit' })).toBeTruthy(),
    );

    fireEvent.click(getByRole('link', { name: 'Site access credit' }));
    fireEvent.input(getByLabelText('Daily streak goal (focus minutes)'), {
      target: { value: '30' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));
    expect(getByText('Saving changes')).toBeTruthy();

    fireEvent.click(getByRole('link', { name: 'Notifications' }));
    expect(getByText('No unsaved changes')).toBeTruthy();
    expect(queryByRole('alert')).toBeNull();

    await act(async (): Promise<void> => {
      update.resolve({ ok: false, error: 'budget write rejected' });
    });
    await waitFor((): void => expect(getByText('No unsaved changes')).toBeTruthy());
    expect(queryByRole('alert')).toBeNull();

    fireEvent.click(getByRole('link', { name: 'Site access credit' }));
    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('budget write rejected');
    });
    expect(getByText('Unsaved changes')).toBeTruthy();
    expect((getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('preserves an accepted theme when it is requested before a destination save', async (): Promise<void> => {
    const themeUpdate: Deferred<{ ok: true }> = deferred<{ ok: true }>();
    const settingsUpdate: Deferred<{ ok: true }> = deferred<{ ok: true }>();
    fake.respond('updateTheme', themeUpdate.promise);
    fake.respond('updateSettings', settingsUpdate.promise);
    const { getByLabelText, getByRole } = render(<App />);
    const theme: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement => getByRole('button', { name: /Theme: Auto/i }) as HTMLButtonElement,
    );

    fireEvent.click(theme);
    fireEvent.click(getByRole('link', { name: 'Site access credit' }));
    fireEvent.input(getByLabelText('Daily streak goal (focus minutes)'), {
      target: { value: '30' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    expect(
      fake.sent.filter((request: Request): boolean => request.type === 'updateSettings'),
    ).toHaveLength(0);
    await act(async (): Promise<void> => themeUpdate.resolve({ ok: true }));
    await waitFor((): void =>
      expect(
        fake.sent.some(
          (request: Request): boolean =>
            request.type === 'updateSettings' &&
            request.settings.theme === 'light' &&
            request.settings.streakGoalMin === 30,
        ),
      ).toBe(true),
    );
    await act(async (): Promise<void> => settingsUpdate.resolve({ ok: true }));
    await waitFor((): void => expect(getByRole('button', { name: /Theme: Light/i })).toBeTruthy());
  });

  it('preserves a later accepted theme when a destination save is already pending', async (): Promise<void> => {
    const settingsUpdate: Deferred<{ ok: true }> = deferred<{ ok: true }>();
    const themeUpdate: Deferred<{ ok: true }> = deferred<{ ok: true }>();
    fake.respond('updateSettings', settingsUpdate.promise);
    fake.respond('updateTheme', themeUpdate.promise);
    const { getByLabelText, getByRole, getByText } = render(<App />);
    await waitFor((): void =>
      expect(getByRole('link', { name: 'Site access credit' })).toBeTruthy(),
    );

    fireEvent.click(getByRole('link', { name: 'Site access credit' }));
    fireEvent.input(getByLabelText('Daily streak goal (focus minutes)'), {
      target: { value: '30' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));
    fireEvent.click(getByRole('button', { name: /Theme: Auto/i }));

    expect(
      fake.sent.filter((request: Request): boolean => request.type === 'updateTheme'),
    ).toHaveLength(0);
    await act(async (): Promise<void> => settingsUpdate.resolve({ ok: true }));
    await waitFor((): void =>
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateTheme')).toBe(
        true,
      ),
    );
    await act(async (): Promise<void> => themeUpdate.resolve({ ok: true }));
    await waitFor((): void => expect(getByRole('button', { name: /Theme: Light/i })).toBeTruthy());
    expect((getByLabelText('Daily streak goal (focus minutes)') as HTMLInputElement).value).toBe(
      '30',
    );
    expect(getByText('No unsaved changes')).toBeTruthy();
  });

  it('rebases a queued Notifications save on an accepted Site access credit save', async (): Promise<void> => {
    const budgetUpdate: Deferred<{ ok: true }> = deferred<{ ok: true }>();
    const notificationsUpdate: Deferred<{ ok: true }> = deferred<{ ok: true }>();
    let writeIndex: number = 0;
    fake.respond('updateSettings', (): Promise<{ ok: true }> => {
      writeIndex += 1;
      return writeIndex === 1 ? budgetUpdate.promise : notificationsUpdate.promise;
    });
    const { getByLabelText, getByRole } = render(<App />);
    await waitFor((): void =>
      expect(getByRole('link', { name: 'Site access credit' })).toBeTruthy(),
    );

    fireEvent.click(getByRole('link', { name: 'Site access credit' }));
    fireEvent.input(getByLabelText('Daily streak goal (focus minutes)'), {
      target: { value: '30' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));
    fireEvent.click(getByRole('link', { name: 'Notifications' }));
    fireEvent.click(getByLabelText('Show a system notification when a session completes'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await act(async (): Promise<void> => budgetUpdate.resolve({ ok: true }));
    await waitFor((): void =>
      expect(
        fake.sent.filter((request: Request): boolean => request.type === 'updateSettings'),
      ).toHaveLength(2),
    );
    const updates: Extract<Request, { type: 'updateSettings' }>[] = fake.sent.filter(
      (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
        request.type === 'updateSettings',
    );
    expect(updates[1]?.settings.streakGoalMin).toBe(30);
    expect(updates[1]?.settings.sessionCompleteNotification).toBe(false);
    await act(async (): Promise<void> => notificationsUpdate.resolve({ ok: true }));
  });

  it('rebases a queued Session behavior save on an accepted Notifications save', async (): Promise<void> => {
    const notificationsUpdate: Deferred<{ ok: true }> = deferred<{ ok: true }>();
    const behaviorUpdate: Deferred<{ ok: true }> = deferred<{ ok: true }>();
    let writeIndex: number = 0;
    fake.respond('updateSettings', (): Promise<{ ok: true }> => {
      writeIndex += 1;
      return writeIndex === 1 ? notificationsUpdate.promise : behaviorUpdate.promise;
    });
    const { getByLabelText, getByRole } = render(<App />);
    await waitFor((): void => expect(getByRole('link', { name: 'Notifications' })).toBeTruthy());

    fireEvent.click(getByRole('link', { name: 'Notifications' }));
    fireEvent.click(getByLabelText('Show a system notification when a session completes'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));
    fireEvent.click(getByRole('link', { name: 'Session behavior' }));
    fireEvent.input(getByLabelText('Short session preset (minutes)'), {
      target: { value: '12' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await act(async (): Promise<void> => notificationsUpdate.resolve({ ok: true }));
    await waitFor((): void =>
      expect(
        fake.sent.filter((request: Request): boolean => request.type === 'updateSettings'),
      ).toHaveLength(2),
    );
    const updates: Extract<Request, { type: 'updateSettings' }>[] = fake.sent.filter(
      (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
        request.type === 'updateSettings',
    );
    expect(updates[1]?.settings.sessionCompleteNotification).toBe(false);
    expect(updates[1]?.settings.presetsMin).toEqual([12, 25, 50]);
    await act(async (): Promise<void> => behaviorUpdate.resolve({ ok: true }));
  });

  it('keeps a rejected save message inside the sticky action wrapper', async (): Promise<void> => {
    fake.respond('updateLists', { ok: false, error: 'blocking write rejected' });
    const { getAllByLabelText, getAllByRole, getByRole } = render(<App />);
    await waitFor((): void => expect(getByRole('heading', { name: 'Blocking' })).toBeTruthy());
    fireEvent.input(getAllByLabelText('Pattern')[0] as HTMLElement, {
      target: { value: 'example.com' },
    });
    fireEvent.click(getAllByRole('button', { name: 'Add rule' })[0] as HTMLElement);
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    const alert: HTMLElement = await waitFor((): HTMLElement => getByRole('alert'));
    const wrapper: Element | null = alert.closest('.dirty-save-bar');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.contains(getByRole('button', { name: 'Save changes' }))).toBe(true);
    expect(wrapper?.contains(getByRole('button', { name: 'Discard changes' }))).toBe(true);
    expect(wrapper?.contains(document.querySelector('.dirty-save-state'))).toBe(true);
  });

  it('keeps a live theme update in the draft used by a later section save', async (): Promise<void> => {
    fake.respond('updateTheme', { ok: true });
    fake.respond('updateSettings', { ok: true });
    const { getByLabelText, getByRole } = render(<App />);
    const theme: HTMLButtonElement = await waitFor((): HTMLButtonElement => {
      const button: HTMLButtonElement = getByRole('button', {
        name: /Theme: Auto/i,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(theme);
    await waitFor((): void =>
      expect(fake.sent).toContainEqual({ type: 'updateTheme', theme: 'light' }),
    );
    await act(async (): Promise<void> => {
      fake.emit({ type: 'stateChanged', snapshot: { ...emptySnapshot(0), theme: 'dark' } });
    });
    await waitFor((): void => expect(getByRole('button', { name: /Theme: Dark/i })).toBeTruthy());
    window.location.hash = '#budget';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor((): void =>
      expect(getByLabelText('Daily streak goal (focus minutes)')).toBeTruthy(),
    );
    fireEvent.input(getByLabelText('Daily streak goal (focus minutes)'), {
      target: { value: '30' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));
    await waitFor((): void =>
      expect(
        fake.sent.some(
          (request: Request): boolean =>
            request.type === 'updateSettings' && request.settings.theme === 'dark',
        ),
      ).toBe(true),
    );
  });

  it('shows the session status with the end time', async (): Promise<void> => {
    const endsAt: number = new Date(2026, 7, 28, 16, 45).getTime();
    fake.respond('getSnapshot', hardSnapshot(endsAt));
    const { getByText } = render(<App />);
    await waitFor((): void => {
      expect(getByText(settingsTimedCopy('16:45'))).toBeTruthy();
    });
  });

  it('shows no status while idle and picks up a stateChanged broadcast', async (): Promise<void> => {
    const { getByText, queryByText } = render(<App />);
    await waitFor((): void => {
      expect(getByText('Blocking')).toBeTruthy();
    });
    const statusText: string = settingsTimedCopy('09:30');
    expect(queryByText(statusText)).toBeNull();
    const endsAt: number = new Date(2026, 7, 29, 9, 30).getTime();
    await act(async (): Promise<void> => {
      fake.emit({ type: 'stateChanged', snapshot: hardSnapshot(endsAt) });
    });
    expect(getByText(statusText)).toBeTruthy();
  });

  it('shows a quiet load error instead of rendering malformed settings', async (): Promise<void> => {
    fake.respond('getLists', { categories: {} });
    const { getByRole, queryByText } = render(<App />);
    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe(
        'Could not load settings. Reload the page to try again.',
      );
    });
    expect(queryByText('Loading settings')).toBeNull();
  });

  it('saves list and category draft changes together', async (): Promise<void> => {
    const committed: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
    };
    fake.respond('getLists', committed);
    fake.respond('updateLists', { ok: true });
    const { getAllByLabelText, getAllByRole, getByLabelText, getByRole } = render(<App />);
    await waitFor((): void => {
      expect(getByLabelText('Social media')).toBeTruthy();
    });

    fireEvent.click(getByLabelText('Social media'));
    fireEvent.input(getAllByLabelText('Pattern')[0] as HTMLElement, {
      target: { value: 'nu.nl' },
    });
    fireEvent.click(getAllByRole('button', { name: 'Add rule' })[0] as HTMLElement);
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor((): void => {
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateLists')).toBe(
        true,
      );
    });
    const update: Extract<Request, { type: 'updateLists' }> | undefined = fake.sent.find(
      (request: Request): request is Extract<Request, { type: 'updateLists' }> =>
        request.type === 'updateLists',
    );
    expect(update?.lists.custom).toEqual([{ kind: 'host', pattern: 'nu.nl' }]);
    expect(update?.lists.categories.social).toBe(false);
  });

  it('does not include an unsaved strictness weakening in a pause save', async (): Promise<void> => {
    const committed: Settings = { ...DEFAULT_SETTINGS, defaultStrictness: 'hard' };
    fake.respond('getSettings', committed);
    fake.respond('updateSettings', { ok: true });
    const { getByLabelText, getByRole }: ReturnType<typeof render> = render(<App />);
    await waitFor((): void => {
      expect(getByRole('link', { name: 'Session behavior' })).toBeTruthy();
    });

    fireEvent.click(getByRole('link', { name: 'Session behavior' }));
    fireEvent.click(
      getByLabelText('Friction: stopping early uses the configured deliberation gate'),
    );
    fireEvent.click(getByRole('link', { name: 'Site access credit' }));
    fireEvent.input(getByLabelText('Daily streak goal (focus minutes)'), {
      target: { value: '30' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor((): void => {
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateSettings')).toBe(
        true,
      );
    });
    const update: Extract<Request, { type: 'updateSettings' }> | undefined = fake.sent.find(
      (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
        request.type === 'updateSettings',
    );
    expect(update?.settings.streakGoalMin).toBe(30);
    expect(update?.settings.defaultStrictness).toBe('hard');
  });

  it('persists preset controls through the strictness section save', async (): Promise<void> => {
    fake.respond('updateSettings', { ok: true });
    const { getByLabelText, getByRole }: ReturnType<typeof render> = render(<App />);
    await waitFor((): void => {
      expect(getByRole('link', { name: 'Session behavior' })).toBeTruthy();
    });
    fireEvent.click(getByRole('link', { name: 'Session behavior' }));
    fireEvent.input(getByLabelText('Short session preset (minutes)'), {
      target: { value: '12' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor((): void => {
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateSettings')).toBe(
        true,
      );
    });
    const update: Extract<Request, { type: 'updateSettings' }> | undefined = fake.sent.find(
      (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
        request.type === 'updateSettings',
    );
    expect(update?.settings.presetsMin).toEqual([12, 25, 50]);
  });

  it('persists freeze cadence through the pause section save', async (): Promise<void> => {
    fake.respond('getSettings', {
      ...DEFAULT_SETTINGS,
      streakFreezeIntervalDays: 7,
      sessionCompleteNotification: true,
    });
    fake.respond('updateSettings', { ok: true });
    const { getByLabelText, getByRole }: ReturnType<typeof render> = render(<App />);
    await waitFor((): void => {
      expect(getByRole('link', { name: 'Site access credit' })).toBeTruthy();
    });
    fireEvent.click(getByRole('link', { name: 'Site access credit' }));
    fireEvent.input(getByLabelText('Freeze token interval (days)'), { target: { value: '9' } });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor((): void => {
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateSettings')).toBe(
        true,
      );
    });
    const update: Extract<Request, { type: 'updateSettings' }> | undefined = fake.sent.find(
      (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
        request.type === 'updateSettings',
    );
    expect(update?.settings.streakFreezeIntervalDays).toBe(9);
  });

  it('persists notification preference through the sounds section save', async (): Promise<void> => {
    fake.respond('getSettings', {
      ...DEFAULT_SETTINGS,
      streakFreezeIntervalDays: 7,
      sessionCompleteNotification: true,
    });
    fake.respond('updateSettings', { ok: true });
    const { getByLabelText, getByRole }: ReturnType<typeof render> = render(<App />);
    await waitFor((): void => {
      expect(getByRole('link', { name: 'Notifications' })).toBeTruthy();
    });
    fireEvent.click(getByRole('link', { name: 'Notifications' }));
    fireEvent.click(getByLabelText('Show a system notification when a session completes'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor((): void => {
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateSettings')).toBe(
        true,
      );
    });
    const update: Extract<Request, { type: 'updateSettings' }> | undefined = fake.sent.find(
      (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
        request.type === 'updateSettings',
    );
    expect(update?.settings.sessionCompleteNotification).toBe(false);
  });
});
