/** @vitest-environment jsdom */

import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_SETUP } from '../../../src/shared/constants';
import { t } from '../../../src/shared/i18n';
import type { Request, StatsBundle } from '../../../src/shared/messages';
import { App } from '../../../src/stats/App';

const BUNDLE: StatsBundle = {
  days: [
    {
      date: '2026-08-30',
      focusMs: 60_000,
      sessionsStarted: 1,
      sessionsCompleted: 1,
      attempts: { 'example.com': 1 },
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      pauseMsEarned: 10_000,
      unlocksTaken: 0,
      unlockMsSpent: 0,
      resisted: 0,
    },
  ],
  months: [],
  streak: {
    current: 1,
    freezeTokens: 0,
    lastCountedDate: '2026-08-30',
    lastFreezeGrantDate: null,
    activeDays: [30],
    activeMonth: '2026-08',
  },
  recentSessions: [
    {
      t: 'sessionStarted',
      at: 1_700_000_000_000,
      source: 'manual',
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 25,
      intention: 'report',
    },
  ],
  totals: {
    focusMsToday: 60_000,
    focusMsLast7Days: 60_000,
    attemptsToday: 1,
    resistedToday: 0,
  },
};

const sendMessageMock = vi.fn<(request: Request) => Promise<unknown>>();

describe('Stats runtime response boundaries', (): void => {
  beforeEach((): void => {
    sendMessageMock.mockReset();
    vi.stubGlobal('chrome', { runtime: { sendMessage: sendMessageMock } });
  });

  afterEach((): void => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['day', { ...BUNDLE, days: [{ ...BUNDLE.days[0], attempts: null }] }],
    ['month', { ...BUNDLE, months: [{ month: '2026-13' }] }],
    ['streak', { ...BUNDLE, streak: { ...BUNDLE.streak, activeMonth: 'August' } }],
    ['session', { ...BUNDLE, recentSessions: [{ t: 'sessionStarted', at: 1 }] }],
    ['totals', { ...BUNDLE, totals: { ...BUNDLE.totals, attemptsToday: 1.5 } }],
    [
      'legacy totals alias',
      {
        ...BUNDLE,
        totals: {
          ...BUNDLE.totals,
          focusMsWeek: 60_000,
        },
      },
    ],
  ])(
    'shows a full load error for malformed %s data',
    async (_label: string, stats: unknown): Promise<void> => {
      sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
        if (request.type === 'getStats') return stats;
        if (request.type === 'getSetupState') {
          return { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
        }
        if (request.type === 'getSettings') return DEFAULT_SETTINGS;
        if (request.type === 'exportEvents') return { json: '[]' };
        return { ok: true };
      });
      const { getByRole } = render(<App />);

      await waitFor((): void => {
        expect(getByRole('alert').textContent).toBe(t('stats_load_error'));
      });
    },
  );

  it.each([
    ['non-array root', '{"events":[]}'],
    ['malformed event', '[{"t":"attempt","at":1}]'],
  ])(
    'reports a partial load error for an export with a %s',
    async (_label: string, json: string): Promise<void> => {
      sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
        if (request.type === 'getStats') return BUNDLE;
        if (request.type === 'getSetupState') {
          return { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
        }
        if (request.type === 'getSettings') return DEFAULT_SETTINGS;
        if (request.type === 'exportEvents') return { json };
        return { ok: true };
      });
      const { getByRole } = render(<App />);

      await waitFor((): void => {
        expect(getByRole('alert').textContent).toBe(t('stats_partial_error_attempts'));
      });
    },
  );
});
