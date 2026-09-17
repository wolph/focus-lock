/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDuration } from '../../../src/shared/format';
import { t, tPlural } from '../../../src/shared/i18n';
import type { StatsBundle } from '../../../src/shared/messages';
import type { DailyAgg, MonthlyAgg, PauseEconomy, StreakState } from '../../../src/shared/types';
import { Streak } from '../../../src/stats/Streak';
import { Tiles } from '../../../src/stats/Tiles';

const NOW: number = new Date(2026, 7, 28, 14, 0, 0).getTime();

const ECONOMY: PauseEconomy = {
  earnRatio: 5 / 30,
  capMs: 30 * 60_000,
  pauseMs: 5 * 60_000,
  unlockMs: 5 * 60_000,
};

type AggregateActivity = Omit<DailyAgg, 'date'>;
type AggregateRepresentation = 'daily' | 'monthly';

interface AggregateActivityCase {
  name: string;
  representation: AggregateRepresentation;
  activity: Partial<AggregateActivity>;
}

const EMPTY_ACTIVITY: AggregateActivity = {
  focusMs: 0,
  sessionsStarted: 0,
  sessionsCompleted: 0,
  attempts: {},
  attemptsOther: 0,
  pausesTaken: 0,
  pauseMsSpent: 0,
  pauseMsEarned: 0,
  unlocksTaken: 0,
  unlockMsSpent: 0,
  resisted: 0,
};

function day(date: string, overrides: Partial<AggregateActivity>): DailyAgg {
  return { date, ...EMPTY_ACTIVITY, ...overrides };
}

function month(month: string, overrides: Partial<AggregateActivity>): MonthlyAgg {
  return { month, ...EMPTY_ACTIVITY, ...overrides };
}

const ACTIVITY_CASES: readonly AggregateActivityCase[] = [
  { name: 'focus duration', representation: 'daily', activity: { focusMs: 1 } },
  { name: 'session start', representation: 'monthly', activity: { sessionsStarted: 1 } },
  { name: 'session completion', representation: 'daily', activity: { sessionsCompleted: 1 } },
  {
    name: 'mapped attempt',
    representation: 'monthly',
    activity: { attempts: { 'example.com': 1 } },
  },
  { name: 'other attempt', representation: 'daily', activity: { attemptsOther: 1 } },
  { name: 'pause count', representation: 'monthly', activity: { pausesTaken: 1 } },
  { name: 'pause spend', representation: 'daily', activity: { pauseMsSpent: 1 } },
  { name: 'optional pause earning', representation: 'monthly', activity: { pauseMsEarned: 1 } },
  { name: 'unlock count', representation: 'daily', activity: { unlocksTaken: 1 } },
  {
    name: 'optional unlock spend',
    representation: 'monthly',
    activity: { unlockMsSpent: 1 },
  },
  { name: 'resisted temptation', representation: 'daily', activity: { resisted: 1 } },
];

const STREAK: StreakState = {
  current: 4,
  freezeTokens: 2,
  lastCountedDate: '2026-08-28',
  lastFreezeGrantDate: '2026-08-24',
  activeDays: [25, 26, 27, 28],
  activeMonth: '2026-08',
};

const BUNDLE: StatsBundle = {
  days: [
    day('2026-08-27', { focusMs: 50 * 60_000, sessionsStarted: 1, sessionsCompleted: 1 }),
    day('2026-08-28', {
      focusMs: 65 * 60_000,
      sessionsStarted: 2,
      sessionsCompleted: 1,
      attempts: { 'facebook.com': 3, 'youtube.com': 2 },
      attemptsOther: 1,
      pausesTaken: 1,
      pauseMsSpent: 5 * 60_000,
      pauseMsEarned: 17 * 60_000,
      unlocksTaken: 1,
      unlockMsSpent: 2 * 60_000,
      resisted: 2,
    }),
  ],
  months: [],
  streak: STREAK,
  recentSessions: [],
  totals: {
    focusMsToday: 65 * 60_000,
    focusMsLast7Days: 115 * 60_000,
    attemptsToday: 6,
    resistedToday: 2,
  },
};

const EMPTY: StatsBundle = {
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

afterEach(cleanup);

function tileValue(container: Element, label: string): string {
  const labels: Element[] = Array.from(container.querySelectorAll('.tile-label'));
  const match: Element | undefined = labels.find(
    (el: Element): boolean => el.textContent === label,
  );
  if (match === undefined) throw new Error(`no tile labeled ${label}`);
  const value: Element | null = match.parentElement?.querySelector('.tile-value') ?? null;
  return value?.textContent ?? '';
}

function tileSubline(container: Element, label: string): string {
  const labels: Element[] = Array.from(container.querySelectorAll('.tile-label'));
  const match: Element | undefined = labels.find(
    (el: Element): boolean => el.textContent === label,
  );
  if (match === undefined) throw new Error(`no tile labeled ${label}`);
  return match.parentElement?.querySelector('.tile-subline')?.textContent ?? '';
}

describe('formatDuration', () => {
  it('renders human units, minutes padded under an hour marker', () => {
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 m');
    expect(formatDuration(125 * 60_000)).toBe('2 h 05 m');
    expect(formatDuration(45 * 60_000)).toBe('45 m');
    expect(formatDuration(0)).toBe('0 m');
  });
  it('never goes negative', () => {
    expect(formatDuration(-5)).toBe('0 m');
  });
});

describe('Tiles', () => {
  it('renders exact period labels, totals, and separate pause and unlock spending', () => {
    const { container } = render(<Tiles bundle={BUNDLE} economy={ECONOMY} now={NOW} />);
    expect(tileValue(container, t('stats_tile_focus_today'))).toBe('1 h 05 m');
    expect(tileValue(container, t('stats_tile_focus_last_7_days'))).toBe('1 h 55 m');
    expect(tileValue(container, t('stats_tile_attempts_today'))).toBe('6');
    expect(tileValue(container, t('stats_tile_gate_dismissed_today'))).toBe('2');
    expect(tileValue(container, t('stats_tile_credit_spent_today'))).toBe('7 m');
    expect(tileSubline(container, t('stats_tile_credit_spent_today'))).toBe(
      t('stats_tile_credit_subline_spent', {
        ALL_SITES: '5 m',
        ONE_SITE: '2 m',
        EARNED: '17 m',
      }),
    );
    expect(container.textContent).not.toContain('Current streak');
    expect(container.textContent).not.toContain('2 freezes banked');
    expect(container.textContent).not.toContain('Temptations resisted');
    expect(container.querySelectorAll('.tile')).toHaveLength(5);
  });

  it('renders the quiet zero-state line for an empty bundle', () => {
    const { container } = render(<Tiles bundle={EMPTY} economy={ECONOMY} now={NOW} />);
    expect(container.textContent).toContain(t('stats_empty'));
    expect(container.querySelectorAll('.tile').length).toBe(0);
  });

  it.each([
    { label: 'pause only', pauseMs: 5 * 60_000, unlockMs: 0 },
    { label: 'unlock only', pauseMs: 0, unlockMs: 2 * 60_000 },
  ])(
    'shows both spending components when today has $label spending',
    ({ pauseMs, unlockMs }: { pauseMs: number; unlockMs: number }): void => {
      const bundle: StatsBundle = {
        ...BUNDLE,
        days: [
          day('2026-08-28', {
            pauseMsSpent: pauseMs,
            unlockMsSpent: unlockMs,
          }),
        ],
      };

      const { container } = render(<Tiles bundle={bundle} economy={ECONOMY} now={NOW} />);

      expect(tileSubline(container, t('stats_tile_credit_spent_today'))).toBe(
        t('stats_tile_credit_subline_spent', {
          ALL_SITES: formatDuration(pauseMs),
          ONE_SITE: formatDuration(unlockMs),
          EARNED: '0 m',
        }),
      );
    },
  );

  it('treats the worker live zero aggregate as first-run history', () => {
    const liveFirstRun: StatsBundle = {
      ...EMPTY,
      days: [day('2026-08-28', {})],
    };

    const { container } = render(<Tiles bundle={liveFirstRun} economy={ECONOMY} now={NOW} />);

    expect(container.textContent).toContain(t('stats_empty'));
    expect(container.querySelectorAll('.tile')).toHaveLength(0);
  });

  it.each(ACTIVITY_CASES)(
    'renders tiles for $name in a $representation aggregate',
    ({ representation, activity }: AggregateActivityCase): void => {
      const bundle: StatsBundle = {
        ...EMPTY,
        days: representation === 'daily' ? [day('2026-08-28', activity)] : [],
        months: representation === 'monthly' ? [month('2026-07', activity)] : [],
      };

      const { container } = render(<Tiles bundle={bundle} economy={ECONOMY} now={NOW} />);

      expect(container.querySelectorAll('.tile')).toHaveLength(5);
      expect(container.textContent).not.toContain(t('stats_empty'));
    },
  );
});

describe('Streak', () => {
  it('renders the chain, freeze chips, and one calendar dot per active day', () => {
    const { container } = render(
      <Streak streak={{ ...STREAK, activeDays: [28, 25, 27, 26] }} now={NOW} />,
    );
    expect(container.querySelector('.streak-chain')?.textContent).toContain('4');
    expect(container.querySelectorAll('.freeze-chip').length).toBe(2);
    expect(container.querySelectorAll('.cal-day.active').length).toBe(4);
    // August has 31 day cells regardless of activity
    expect(container.querySelectorAll('.cal-day').length).toBe(31);
    expect(container.textContent).toContain(
      tPlural('stats_streak_active_days', 4, { MONTH: 'August 2026' }),
    );
    expect(container.querySelector('.cal-grid')?.getAttribute('aria-label')).toBe(
      t('stats_streak_active_dates', { MONTH: 'August 2026', DAYS: '25, 26, 27, 28' }),
    );
  });

  it('names an empty current-month calendar without exposing every day', () => {
    const { container } = render(<Streak streak={{ ...STREAK, activeDays: [] }} now={NOW} />);

    expect(container.querySelector('.cal-grid')?.getAttribute('aria-label')).toBe(
      t('stats_streak_no_active_dates', { MONTH: 'August 2026' }),
    );
    expect(container.querySelectorAll('.cal-day[aria-label]')).toHaveLength(0);
  });

  it('renders a quiet first-run line when there is no streak yet', () => {
    const { container } = render(<Streak streak={EMPTY.streak} now={NOW} />);
    expect(container.textContent).toContain(t('stats_streak_empty'));
  });
});
