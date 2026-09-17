/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_SETUP } from '../../../src/shared/constants';
import { t } from '../../../src/shared/i18n';
import type { Request, StatsBundle } from '../../../src/shared/messages';
import type { StorageMode } from '../../../src/shared/types';
import { App, requestSetupScope } from '../../../src/stats/App';

const bundle: StatsBundle = {
  days: [],
  months: [],
  streak: {
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: '2026-08',
  },
  recentSessions: [],
  totals: { focusMsToday: 0, focusMsLast7Days: 0, attemptsToday: 0, resistedToday: 0 },
};

const sendMessageMock = vi.fn<(request: Request) => Promise<unknown>>();
const SYNC_SCOPE: string = 'Synced totals from this Chrome account. Local-only panels are labeled.';
const LOCAL_SCOPE: string = 'Totals from this machine. Focus Lock statistics are not synced.';
const SCOPE_LOADING: string = 'Checking whether these totals are synced.';
const SCOPE_UNAVAILABLE: string =
  'Statistics scope is unavailable. Totals may include synced data. Hourly attempts and recent sessions are from this machine.';

interface Deferred<T> {
  promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = (): void => {};
  let reject: (reason: unknown) => void = (): void => {};
  const promise: Promise<T> = new Promise<T>(
    (done: (value: T) => void, fail: (reason: unknown) => void): void => {
      resolve = done;
      reject = fail;
    },
  );
  return { promise, reject, resolve };
}

function completedSetup(storageMode: StorageMode): unknown {
  return { ...DEFAULT_SETUP, completed: true, storageMode };
}

describe('Stats request errors', (): void => {
  beforeEach((): void => {
    sendMessageMock.mockReset();
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: sendMessageMock },
    });
  });

  afterEach((): void => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('settles a worker rejection response with readable feedback', async (): Promise<void> => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => {});
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') return { ok: false, error: 'worker failed' };
      if (request.type === 'getSetupState') return completedSetup('local');
      if (request.type === 'getSettings') return DEFAULT_SETTINGS;
      if (request.type === 'exportEvents') return { json: '[]' };
      return { ok: true };
    });
    const { getByRole, queryByText } = render(<App />);

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe(t('stats_load_error'));
    });
    expect(queryByText(t('stats_loading'))).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reports partial data failures while keeping loaded stats visible', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') return bundle;
      if (request.type === 'getSetupState') return completedSetup('local');
      if (request.type === 'getSettings') return { ok: false, error: 'worker failed' };
      if (request.type === 'exportEvents') return { ok: false, error: 'worker failed' };
      return { ok: true };
    });
    const { getByRole, getByText } = render(<App />);

    await waitFor((): void => {
      expect(getByText(t('stats_empty'))).toBeTruthy();
      expect(getByRole('alert').textContent).toBe(
        'Hourly attempts and site access credit settings are unavailable.',
      );
    });
  });

  it.each([
    {
      storageMode: 'sync' as const,
      expected: SYNC_SCOPE,
      excluded: LOCAL_SCOPE,
    },
    {
      storageMode: 'local' as const,
      expected: LOCAL_SCOPE,
      excluded: SYNC_SCOPE,
    },
  ])(
    'labels the page from validated $storageMode setup storage',
    async ({
      storageMode,
      expected,
      excluded,
    }: {
      storageMode: StorageMode;
      expected: string;
      excluded: string;
    }): Promise<void> => {
      sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
        if (request.type === 'getStats') return bundle;
        if (request.type === 'getSetupState') return completedSetup(storageMode);
        if (request.type === 'getSettings') return DEFAULT_SETTINGS;
        if (request.type === 'exportEvents') return { json: '[]' };
        return { ok: true };
      });
      const { getByText, queryByText } = render(<App />);

      await waitFor((): void => expect(getByText(expected)).toBeTruthy());
      expect(queryByText(excluded)).toBeNull();
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'getStats', days: 30 });
    },
  );

  it('shows a scope status while setup is pending and replaces it after late settlement', async (): Promise<void> => {
    const setup: Deferred<unknown> = deferred<unknown>();
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') return bundle;
      if (request.type === 'getSetupState') return setup.promise;
      if (request.type === 'getSettings') return DEFAULT_SETTINGS;
      if (request.type === 'exportEvents') return { json: '[]' };
      return { ok: true };
    });
    const { getByRole, getByText, queryByText } = render(<App />);

    await waitFor((): void => expect(getByText(t('stats_empty'))).toBeTruthy());
    const scopeRegion: HTMLElement = getByRole('status');
    expect(scopeRegion.textContent).toBe(SCOPE_LOADING);
    expect(queryByText(SYNC_SCOPE)).toBeNull();
    expect(queryByText(LOCAL_SCOPE)).toBeNull();

    setup.resolve(completedSetup('sync'));
    await waitFor((): void => expect(getByText(SYNC_SCOPE)).toBeTruthy());
    expect(getByRole('status')).toBe(scopeRegion);
    expect(scopeRegion.textContent).toBe(SYNC_SCOPE);
    expect(queryByText(SCOPE_LOADING)).toBeNull();
  });

  it('keeps stats visible after a rejected scope request and retries it', async (): Promise<void> => {
    let setupRequests: number = 0;
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') return bundle;
      if (request.type === 'getSetupState') {
        setupRequests += 1;
        if (setupRequests === 1) throw new Error('worker unavailable');
        return completedSetup('local');
      }
      if (request.type === 'getSettings') return DEFAULT_SETTINGS;
      if (request.type === 'exportEvents') return { json: '[]' };
      return { ok: true };
    });
    const { getByRole, getByText } = render(<App />);

    await waitFor((): void => expect(getByRole('status').textContent).toContain(SCOPE_UNAVAILABLE));
    expect(getByText(t('stats_empty'))).toBeTruthy();
    const scopeRegion: HTMLElement = getByRole('status');
    fireEvent.click(getByRole('button', { name: t('stats_scope_retry') }));
    expect(getByRole('status')).toBe(scopeRegion);
    expect(scopeRegion.textContent).toBe(SCOPE_LOADING);
    await waitFor((): void => expect(getByText(LOCAL_SCOPE)).toBeTruthy());
    expect(getByRole('status')).toBe(scopeRegion);
    expect(scopeRegion.textContent).toBe(LOCAL_SCOPE);
    expect(setupRequests).toBe(2);
  });

  it.each([
    ['malformed', { ...DEFAULT_SETUP, completed: true, storageMode: 'sync', extra: true }],
    ['incomplete', { ...DEFAULT_SETUP, completed: false, storageMode: null }],
  ])(
    'keeps the scope uncertain for a %s setup response',
    async (_label: string, setup: unknown): Promise<void> => {
      sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
        if (request.type === 'getStats') return bundle;
        if (request.type === 'getSetupState') return setup;
        if (request.type === 'getSettings') return DEFAULT_SETTINGS;
        if (request.type === 'exportEvents') return { json: '[]' };
        return { ok: true };
      });
      const { getByRole, getByText, queryByText } = render(<App />);

      await waitFor((): void =>
        expect(getByRole('status').textContent).toContain(SCOPE_UNAVAILABLE),
      );
      expect(getByText(t('stats_empty'))).toBeTruthy();
      expect(queryByText(SYNC_SCOPE)).toBeNull();
      expect(queryByText(LOCAL_SCOPE)).toBeNull();
    },
  );

  it('cancels a pending scope resolution before it can update state', async (): Promise<void> => {
    const setup: Deferred<unknown> = deferred<unknown>();
    const update = vi.fn();
    const cancel: () => void = requestSetupScope(update, (): Promise<unknown> => setup.promise);

    cancel();
    setup.resolve(completedSetup('sync'));
    await setup.promise;
    expect(update).not.toHaveBeenCalled();
  });

  it('cancels a pending scope rejection before it can update state', async (): Promise<void> => {
    const setup: Deferred<unknown> = deferred<unknown>();
    const update = vi.fn();
    const cancel: () => void = requestSetupScope(update, (): Promise<unknown> => setup.promise);

    cancel();
    setup.reject(new Error('worker unavailable'));
    await expect(setup.promise).rejects.toThrow('worker unavailable');
    expect(update).not.toHaveBeenCalled();
  });
});
