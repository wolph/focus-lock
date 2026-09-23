import { describe, expect, it } from 'vitest';
import { listsChangeAllowed, settingsChangeAllowed } from '../../../src/background/guard';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../../src/shared/constants';
import type { ListsConfig, ScheduleEntry, SessionState, Settings } from '../../../src/shared/types';

const hardSession: SessionState = {
  version: 2,
  sessionId: '10000000-0000-4000-8000-000000000001',
  config: {
    mode: 'blacklist',
    strictness: 'hard',
    duration: { kind: 'timed', minutes: 60 },
    cycling: null,
    intention: '',
    source: 'manual',
    scheduleOccurrence: null,
    rules: rulesFromLists(DEFAULT_LISTS),
  },
  startedAt: 0,
  sessionEndsAt: 3_600_000,
  phase: 'focus',
  phaseStartedAt: 0,
  phaseEndsAt: 3_600_000,
  cycleIndex: 0,
  pausedFrom: null,
  focusedMs: 0,
};

const frictionSession: SessionState = {
  ...hardSession,
  config: { ...hardSession.config, strictness: 'friction' },
};

const flexibleSession: SessionState = {
  ...hardSession,
  config: { ...hardSession.config, strictness: 'flexible' },
};

const withCustom: ListsConfig = {
  ...DEFAULT_LISTS,
  custom: [{ kind: 'host', pattern: 'x.com' }],
};

describe('listsChangeAllowed', () => {
  it('rejects removing a rule during a hard session, allows adding', () => {
    expect(listsChangeAllowed(hardSession, 'blacklist', withCustom, DEFAULT_LISTS)).toBe(
      'notify_guard_lists_remove_blocked',
    );
    expect(listsChangeAllowed(hardSession, 'blacklist', DEFAULT_LISTS, withCustom)).toBeNull();
  });

  it('rejects new exclusions and disabled categories during hard', () => {
    const catOn: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
    };
    const catOff: ListsConfig = { ...DEFAULT_LISTS };
    expect(listsChangeAllowed(hardSession, 'blacklist', catOn, catOff)).toBe(
      'notify_guard_lists_disable_category',
    );
    const excl: ListsConfig = { ...catOn, exclusions: { social: ['facebook.com'] } };
    expect(listsChangeAllowed(hardSession, 'blacklist', catOn, excl)).toBe(
      'notify_guard_lists_add_exclusion',
    );
  });

  it('rejects whitelist additions during a hard whitelist session', () => {
    const wl: ListsConfig = {
      ...DEFAULT_LISTS,
      whitelist: [{ kind: 'host', pattern: 'github.com' }],
    };
    expect(listsChangeAllowed(hardSession, 'whitelist', DEFAULT_LISTS, wl)).toBe(
      'notify_guard_lists_add_whitelist',
    );
  });

  it('allows removing a whitelist rule during a hard whitelist session', () => {
    const wl: ListsConfig = {
      ...DEFAULT_LISTS,
      whitelist: [{ kind: 'host', pattern: 'github.com' }],
    };
    expect(listsChangeAllowed(hardSession, 'whitelist', wl, DEFAULT_LISTS)).toBeNull();
  });

  it('allows removing an exclusion during hard', () => {
    const catOn: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
    };
    const excl: ListsConfig = { ...catOn, exclusions: { social: ['facebook.com'] } };
    expect(listsChangeAllowed(hardSession, 'blacklist', excl, catOn)).toBeNull();
  });

  it('allows blacklist-only edits during a hard whitelist session', () => {
    const current: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'x.com' }],
      categories: { ...DEFAULT_LISTS.categories, social: true },
    };
    const incoming: ListsConfig = {
      ...DEFAULT_LISTS,
      exclusions: { social: ['facebook.com'] },
    };

    expect(listsChangeAllowed(hardSession, 'whitelist', current, incoming)).toBeNull();
  });

  it('allows whitelist edits during a hard blacklist session', () => {
    const incoming: ListsConfig = {
      ...DEFAULT_LISTS,
      whitelist: [{ kind: 'host', pattern: 'github.com' }],
    };

    expect(listsChangeAllowed(hardSession, 'blacklist', DEFAULT_LISTS, incoming)).toBeNull();
  });

  it('allows everything when idle or friction', () => {
    expect(listsChangeAllowed(null, null, withCustom, DEFAULT_LISTS)).toBeNull();
    expect(listsChangeAllowed(frictionSession, 'blacklist', withCustom, DEFAULT_LISTS)).toBeNull();
  });
});

const scheduleEntry: ScheduleEntry = {
  id: 'e1',
  days: [1, 2, 3],
  start: '09:00',
  end: '12:00',
  duration: { kind: 'window' },
  mode: 'blacklist',
  strictness: 'hard',
  cycling: null,
  intention: '',
  enabled: true,
};

describe('settingsChangeAllowed', () => {
  it.each([
    ['flexible', 'friction', false],
    ['flexible', 'hard', false],
    ['friction', 'flexible', true],
    ['friction', 'hard', false],
    ['hard', 'flexible', true],
    ['hard', 'friction', true],
  ] as const)(
    'classifies default strictness %s -> %s as weakened=%s',
    (current, incoming, weakened): void => {
      const currentSettings: Settings = { ...DEFAULT_SETTINGS, defaultStrictness: current };
      const incomingSettings: Settings = { ...DEFAULT_SETTINGS, defaultStrictness: incoming };
      const reason: string | null = settingsChangeAllowed(
        hardSession,
        currentSettings,
        incomingSettings,
      );

      expect(reason !== null).toBe(weakened);
    },
  );

  it('rejects lowering the gate delay during hard, allows raising it', () => {
    const weaker: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    };
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, weaker)).toBe(
      'notify_guard_settings_shorten_delay',
    );
    const stronger: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 30_000 },
    };
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, stronger)).toBeNull();
  });

  it('rejects turning the typed phrase off during hard', () => {
    const typed: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, requireTypedPhrase: true },
    };
    const untyped: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, requireTypedPhrase: false },
    };
    expect(settingsChangeAllowed(hardSession, typed, untyped)).toBe(
      'notify_guard_settings_drop_phrase',
    );
    expect(settingsChangeAllowed(hardSession, untyped, typed)).toBeNull();
  });

  it('rejects raising the earn ratio or cap during hard', () => {
    const richer: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 1 },
    };
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, richer)).toBe(
      'notify_guard_settings_raise_earn_rate',
    );
    const bigger: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: DEFAULT_SETTINGS.pause.capMs + 1 },
    };
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, bigger)).toBe(
      'notify_guard_settings_raise_cap',
    );
  });

  it('rejects lowering pause and unlock costs during hard and allows raising them', () => {
    const lowerPause: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, pauseMs: DEFAULT_SETTINGS.pause.pauseMs - 1 },
    };
    const lowerUnlock: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, unlockMs: DEFAULT_SETTINGS.pause.unlockMs - 1 },
    };
    const higherCosts: Settings = {
      ...DEFAULT_SETTINGS,
      pause: {
        ...DEFAULT_SETTINGS.pause,
        pauseMs: DEFAULT_SETTINGS.pause.pauseMs + 1,
        unlockMs: DEFAULT_SETTINGS.pause.unlockMs + 1,
      },
    };

    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, lowerPause)).toBe(
      'notify_guard_settings_shorten_pause',
    );
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, lowerUnlock)).toBe(
      'notify_guard_settings_shorten_unlock',
    );
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, higherCosts)).toBeNull();
  });

  it('rejects disabling or shortening the schedule entry the session came from', () => {
    const fromSchedule: SessionState = {
      ...hardSession,
      config: {
        ...hardSession.config,
        source: 'schedule',
        scheduleOccurrence: {
          version: 1,
          token: 'e1@2026-09-03',
          entryId: 'e1',
          localStartDate: '2026-09-03',
        },
      },
    };
    const current: Settings = { ...DEFAULT_SETTINGS, schedule: [scheduleEntry] };
    const disabled: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...scheduleEntry, enabled: false }],
    };
    const shortened: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...scheduleEntry, end: '10:00' }],
    };
    const fewerDays: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...scheduleEntry, days: [1, 2] }],
    };
    const laterStart: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...scheduleEntry, start: '10:00' }],
    };
    const weakerStrictness: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...scheduleEntry, strictness: 'friction' }],
    };
    const weakestStrictness: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...scheduleEntry, strictness: 'flexible' }],
    };
    const removed: Settings = { ...DEFAULT_SETTINGS, schedule: [] };
    expect(settingsChangeAllowed(fromSchedule, current, disabled)).toBe(
      'notify_guard_settings_schedule_weakened',
    );
    expect(settingsChangeAllowed(fromSchedule, current, shortened)).toBe(
      'notify_guard_settings_schedule_weakened',
    );
    expect(settingsChangeAllowed(fromSchedule, current, fewerDays)).toBe(
      'notify_guard_settings_schedule_weakened',
    );
    expect(settingsChangeAllowed(fromSchedule, current, laterStart)).toBe(
      'notify_guard_settings_schedule_weakened',
    );
    expect(settingsChangeAllowed(fromSchedule, current, weakerStrictness)).toBe(
      'notify_guard_settings_schedule_weakened',
    );
    expect(settingsChangeAllowed(fromSchedule, current, weakestStrictness)).toBe(
      'notify_guard_settings_schedule_weakened',
    );
    expect(settingsChangeAllowed(fromSchedule, current, removed)).toBe(
      'notify_guard_settings_schedule_weakened',
    );
  });

  it('allows strengthening or no-effect edits to the source schedule entry', () => {
    const fromSchedule: SessionState = {
      ...hardSession,
      config: {
        ...hardSession.config,
        source: 'schedule',
        scheduleOccurrence: {
          version: 1,
          token: 'e1@2026-09-03',
          entryId: 'e1',
          localStartDate: '2026-09-03',
        },
      },
    };
    const frictionEntry: ScheduleEntry = { ...scheduleEntry, strictness: 'friction' };
    const current: Settings = { ...DEFAULT_SETTINGS, schedule: [frictionEntry] };
    const stronger: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [
        {
          ...frictionEntry,
          days: [0, ...frictionEntry.days],
          start: '08:00',
          end: '13:00',
          strictness: 'hard',
          intention: 'updated copy',
        },
      ],
    };

    expect(settingsChangeAllowed(fromSchedule, current, stronger)).toBeNull();
  });

  it('allows new schedule entries during hard', () => {
    const added: Settings = { ...DEFAULT_SETTINGS, schedule: [scheduleEntry] };
    expect(settingsChangeAllowed(hardSession, DEFAULT_SETTINGS, added)).toBeNull();
  });

  it('allows the same changes outside hard sessions', () => {
    const richer: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 1 },
    };
    expect(settingsChangeAllowed(null, DEFAULT_SETTINGS, richer)).toBeNull();
    expect(settingsChangeAllowed(frictionSession, DEFAULT_SETTINGS, richer)).toBeNull();
    expect(settingsChangeAllowed(flexibleSession, DEFAULT_SETTINGS, richer)).toBeNull();
  });
});
