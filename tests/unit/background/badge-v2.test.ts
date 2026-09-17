import { describe, expect, it } from 'vitest';
import { badgeForV2, iconSpecV2 } from '../../../src/background/badge-v2';
import type { IconSpec } from '../../../src/background/icon';
import { DEFAULT_LISTS, emptySnapshotV2, rulesFromLists } from '../../../src/shared/constants';
import { formatBadge } from '../../../src/shared/time';
import type {
  SessionConfigV2,
  SessionLifecycleV2,
  SessionSnapshotV2,
} from '../../../src/shared/types';

const MIN: number = 60_000;
const NOW: number = 1_700_000_000_000;

const IDLE_COLOR: string = '#9ca3af';
const FOCUS_COLOR: string = '#22c55e';
const BREAK_COLOR: string = '#14b8a6';
const PAUSE_COLOR: string = '#f59e0b';
// The ring is drawn on the green tile, so it uses the lightened palette rather than the badge's.
const IDLE_RING: string = '#e5e7eb';
const FOCUS_RING: string = '#a7f3a9';
const BREAK_RING: string = '#5eead4';
const PAUSE_RING: string = '#fcd34d';

const ACTIVE: SessionLifecycleV2 = {
  kind: 'active',
  endAuthority: { kind: 'immediate', actionLabel: 'End session' },
};

const TIMED_CONFIG: SessionConfigV2 = {
  mode: 'blacklist',
  strictness: 'flexible',
  duration: { kind: 'timed', minutes: 50 },
  cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
  intention: 'thesis chapter',
  source: 'manual',
  scheduleOccurrence: null,
  rules: rulesFromLists(DEFAULT_LISTS),
};

const INDEFINITE_CONFIG: SessionConfigV2 = {
  ...TIMED_CONFIG,
  duration: { kind: 'until-stopped' },
  cycling: null,
};

/** A 50 minute cycling session 5 minutes into its first 25 minute focus phase. */
function timedFocus(): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: ACTIVE,
    phase: 'focus',
    config: TIMED_CONFIG,
    startedAt: NOW - 5 * MIN,
    phaseStartedAt: NOW - 5 * MIN,
    phaseEndsAt: NOW + 20 * MIN,
    sessionEndsAt: NOW + 45 * MIN,
  };
}

function indefiniteFocus(): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW),
    lifecycle: ACTIVE,
    phase: 'focus',
    config: INDEFINITE_CONFIG,
    startedAt: NOW - 5 * MIN,
    phaseStartedAt: NOW - 5 * MIN,
    phaseEndsAt: null,
    sessionEndsAt: null,
    sessionFocusedMs: 5 * MIN,
  };
}

function indefinitePause(): SessionSnapshotV2 {
  return {
    ...indefiniteFocus(),
    phase: 'paused',
    phaseStartedAt: NOW - MIN,
    phaseEndsAt: NOW + 4 * MIN,
  };
}

function nonActive(lifecycle: SessionLifecycleV2): SessionSnapshotV2 {
  return { ...emptySnapshotV2(NOW), lifecycle };
}

const STARTING: SessionLifecycleV2 = {
  kind: 'starting',
  operationId: 'op-1',
  transition: 'start',
  endAuthority: { kind: 'hidden' },
};
const CLEANUP: SessionLifecycleV2 = {
  kind: 'cleanup',
  journal: 'closure',
  id: 'journal-1',
  endAuthority: { kind: 'hidden' },
};
const ERROR: SessionLifecycleV2 = {
  kind: 'error',
  code: 'closure-cleanup-failed',
  retryAvailable: true,
  endAuthority: { kind: 'hidden' },
};

describe('badgeForV2', (): void => {
  it('counts down the total session, never the phase, while timed', (): void => {
    const focus: SessionSnapshotV2 = timedFocus();

    expect(badgeForV2(focus, true)).toEqual({
      text: formatBadge(45 * MIN),
      color: FOCUS_COLOR,
    });
    expect(badgeForV2(focus, true).text).toBe('45m');
    expect(badgeForV2(focus, true).text).not.toBe(formatBadge(20 * MIN));
  });

  it('keeps the total session countdown through break and pause', (): void => {
    const onBreak: SessionSnapshotV2 = {
      ...timedFocus(),
      phase: 'break',
      phaseStartedAt: NOW,
      phaseEndsAt: NOW + 5 * MIN,
    };
    const paused: SessionSnapshotV2 = {
      ...timedFocus(),
      phase: 'paused',
      phaseStartedAt: NOW,
      phaseEndsAt: NOW + 5 * MIN,
    };

    expect(badgeForV2(onBreak, true)).toEqual({ text: '45m', color: BREAK_COLOR });
    expect(badgeForV2(paused, true)).toEqual({ text: '45m', color: PAUSE_COLOR });
  });

  it('shows ON for indefinite focus and indefinite pause', (): void => {
    expect(badgeForV2(indefiniteFocus(), true)).toEqual({ text: 'ON', color: FOCUS_COLOR });
    expect(badgeForV2(indefinitePause(), true)).toEqual({ text: 'ON', color: PAUSE_COLOR });
  });

  it('blanks the badge whenever the countdown setting is off', (): void => {
    expect(badgeForV2(timedFocus(), false).text).toBe('');
    expect(badgeForV2(indefiniteFocus(), false).text).toBe('');
    expect(badgeForV2(indefinitePause(), false).text).toBe('');
  });

  it('blanks the badge for idle, starting, cleanup, and error', (): void => {
    expect(badgeForV2(emptySnapshotV2(NOW), true)).toEqual({ text: '', color: IDLE_COLOR });
    expect(badgeForV2(nonActive(STARTING), true).text).toBe('');
    expect(badgeForV2(nonActive(CLEANUP), true).text).toBe('');
    expect(badgeForV2(nonActive(ERROR), true).text).toBe('');
  });

  it('blanks the badge for a non-active lifecycle that still carries session fields', (): void => {
    const hostile: SessionSnapshotV2 = { ...timedFocus(), lifecycle: CLEANUP };

    expect(badgeForV2(hostile, true).text).toBe('');
  });
});

describe('iconSpecV2', (): void => {
  it('is an open padlock with no ring when idle', (): void => {
    expect(iconSpecV2(emptySnapshotV2(NOW))).toEqual({
      color: IDLE_RING,
      open: true,
      progress: 0,
      glyph: 'lock',
      ring: false,
    });
  });

  it('draws the phase ring for a timed focus phase', (): void => {
    const spec: IconSpec = iconSpecV2(timedFocus());

    expect(spec.color).toBe(FOCUS_RING);
    expect(spec.open).toBe(false);
    expect(spec.glyph).toBe('lock');
    expect(spec.ring).toBe(true);
    expect(spec.progress).toBeCloseTo(0.2, 5);
  });

  it('keeps the break cup and the pause color', (): void => {
    const onBreak: SessionSnapshotV2 = {
      ...timedFocus(),
      phase: 'break',
      phaseStartedAt: NOW,
      phaseEndsAt: NOW + 5 * MIN,
    };

    expect(iconSpecV2(onBreak).glyph).toBe('cup');
    expect(iconSpecV2(onBreak).color).toBe(BREAK_RING);
    expect(iconSpecV2(indefinitePause()).color).toBe(PAUSE_RING);
  });

  it('draws no ring for indefinite focus, which has no phase end', (): void => {
    expect(iconSpecV2(indefiniteFocus())).toEqual({
      color: FOCUS_RING,
      open: false,
      progress: 0,
      glyph: 'lock',
      ring: false,
    });
  });

  it('still draws the pause ring during an indefinite pause', (): void => {
    const spec: IconSpec = iconSpecV2(indefinitePause());

    expect(spec.ring).toBe(true);
    expect(spec.progress).toBeCloseTo(0.2, 5);
  });

  it('projects no ring from a session hidden behind a cleanup journal', (): void => {
    const hostile: SessionSnapshotV2 = { ...timedFocus(), lifecycle: CLEANUP };
    const spec: IconSpec = iconSpecV2(hostile);

    expect(spec.ring).toBe(false);
    expect(spec.progress).toBe(0);
    expect(spec.color).toBe(FOCUS_RING);
  });

  it('clamps the ring progress into zero through one', (): void => {
    expect(iconSpecV2({ ...timedFocus(), at: NOW + 60 * MIN }).progress).toBe(1);
    expect(iconSpecV2({ ...timedFocus(), at: NOW - 60 * MIN }).progress).toBe(0);
  });
});
