/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/options/App';
import { Schedule } from '../../../src/options/Schedule';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  emptySnapshot,
  rulesFromLists,
} from '../../../src/shared/constants';
import { settingsTimedCopy } from '../../../src/shared/session-copy';
import type { ScheduleEntry, SessionSnapshot } from '../../../src/shared/types';
import { installChromeFake } from './chrome-fake';

afterEach((): void => {
  cleanup();
});

beforeEach((): void => {
  const fake = installChromeFake();
  fake.respond('getSettings', DEFAULT_SETTINGS);
  fake.respond('getLists', DEFAULT_LISTS);
  fake.respond('getSnapshot', emptySnapshot(0));
});

const entry: ScheduleEntry = {
  id: 'weekdays',
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

describe('Schedule saved entry', () => {
  it('renders every selected day as an individual pill', (): void => {
    const { getByRole, getByText } = render(
      <Schedule entries={[entry]} defaults={DEFAULT_SETTINGS} onChange={vi.fn()} />,
    );
    const days: HTMLElement = getByRole('group', { name: 'Selected days' });
    expect(days.querySelectorAll('.entry-day-pill')).toHaveLength(3);
    expect(getByText('Mon', { selector: '.entry-day-pill' })).toBeTruthy();
    expect(getByText('Tue', { selector: '.entry-day-pill' })).toBeTruthy();
    expect(getByText('Wed', { selector: '.entry-day-pill' })).toBeTruthy();
  });
});

describe('Options navigation', () => {
  it('links visibly to the Overview page and renders one page heading', async (): Promise<void> => {
    const { getByRole } = render(<App />);
    await waitFor((): void => {
      expect(getByRole('link', { name: 'Overview' }).getAttribute('href')).toBe(
        '../stats/stats.html',
      );
    });
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  it('keeps the autosave status quiet until it has something to report', (): void => {
    const css: string = readFileSync(resolve('src/options/options.css'), 'utf8');
    // The save bar and the layout that made room for it are gone with the draft they served.
    expect(css).not.toMatch(/\.dirty-save-bar/s);
    expect(css).not.toMatch(/\.options--sticky-save/s);
    expect(css).toMatch(/\.autosave-status\s*\{[^}]*color:\s*var\(--muted\)/s);
    expect(css).toMatch(/\.autosave-status--error\s*\{[^}]*color:\s*var\(--warn\)/s);
  });

  it('uses the exact read-only session status copy', async (): Promise<void> => {
    const endsAt: number = new Date(2026, 7, 28, 16, 45).getTime();
    const startedAt: number = endsAt - 25 * 60_000;
    const at: number = endsAt - 1_000;
    const snapshot: SessionSnapshot = {
      ...emptySnapshot(at),
      lifecycle: { kind: 'active', endAuthority: { kind: 'hidden' } },
      phase: 'focus',
      config: {
        mode: 'blacklist',
        strictness: 'hard',
        duration: { kind: 'timed', minutes: 25 },
        cycling: null,
        intention: '',
        source: 'manual',
        scheduleOccurrence: null,
        rules: rulesFromLists(DEFAULT_LISTS),
      },
      startedAt,
      phaseStartedAt: startedAt,
      phaseEndsAt: endsAt,
      sessionEndsAt: endsAt,
      sessionFocusedMs: at - startedAt,
    };
    const fake = installChromeFake();
    fake.respond('getSettings', DEFAULT_SETTINGS);
    fake.respond('getLists', DEFAULT_LISTS);
    fake.respond('getSnapshot', snapshot);
    const { getByRole } = render(<App />);
    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(settingsTimedCopy('16:45'));
    });
  });
});
