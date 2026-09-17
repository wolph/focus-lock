/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../../src/shared/i18n';
import type { EventRecord } from '../../../src/shared/types';
import { SessionLog } from '../../../src/stats/SessionLog';

afterEach(cleanup);

function started(
  at: number,
  durationMin: number,
  intention: string,
  source: 'manual' | 'schedule',
  sessionId?: string,
): EventRecord {
  return {
    t: 'sessionStarted',
    at,
    source,
    mode: 'blacklist',
    strictness: 'friction',
    durationMin,
    intention,
    sessionId,
  };
}

const T9: number = new Date(2026, 7, 28, 9, 0, 0).getTime();
const T925: number = new Date(2026, 7, 28, 9, 25, 0).getTime();
const T11: number = new Date(2026, 7, 28, 11, 0, 0).getTime();
const T1110: number = new Date(2026, 7, 28, 11, 10, 0).getTime();
const T13: number = new Date(2026, 7, 28, 13, 0, 0).getTime();

/** Newest first, matching StatsBundle.recentSessions. */
const EVENTS: EventRecord[] = [
  started(T13, 15, '', 'manual'),
  { t: 'sessionCanceled', at: T1110, focusedMs: 8 * 60_000 },
  started(T11, 50, 'email sweep', 'schedule'),
  { t: 'sessionCompleted', at: T925, focusedMs: 25 * 60_000 },
  started(T9, 25, 'thesis chapter', 'manual'),
];

describe('SessionLog', () => {
  it('renders a row per session with outcome chips', () => {
    const { container, getByRole } = render(<SessionLog events={EVENTS} />);
    expect(getByRole('heading', { level: 2 }).textContent).toBe(t('stats_sessions_heading'));
    expect(container.querySelectorAll('tbody tr').length).toBe(3);
    expect(container.querySelectorAll('.session-table .chip.completed').length).toBe(1);
    expect(container.querySelectorAll('.session-table .chip.neutral').length).toBe(1);
    expect(container.querySelectorAll('.session-table .chip.running').length).toBe(1);
    expect(container.textContent).toContain('thesis chapter');
    expect(container.textContent).toContain('Ended early');
    expect(container.textContent).toContain(t('stats_sessions_col_all_sites'));
    expect(container.textContent).toContain(t('stats_sessions_col_one_site'));
  });

  it('renders a v2 row with the shared outcome wording', () => {
    const sessionId: string = '11111111-2222-4333-8444-555555555555';
    const v2Events: EventRecord[] = [
      {
        version: 2,
        t: 'sessionEnded',
        eventId: `${sessionId}:end`,
        at: T925,
        sessionId,
        outcome: 'completed',
        reason: 'timer-completed',
        focusedMs: 25 * 60_000,
        duration: { kind: 'timed', minutes: 25 },
        source: 'manual',
        scheduleOccurrence: null,
      },
      {
        version: 2,
        t: 'sessionStarted',
        eventId: `${sessionId}:start`,
        at: T9,
        sessionId,
        source: 'manual',
        mode: 'blacklist',
        strictness: 'friction',
        duration: { kind: 'timed', minutes: 25 },
        intention: 'v2 chapter',
        scheduleOccurrence: null,
      },
    ];

    const { container } = render(<SessionLog events={v2Events} />);

    // The wording is `statsOutcomeLabelV2`'s, reached through the row pairing, so the log never
    // spells an outcome of its own.
    expect(container.querySelector('.session-table .chip')?.textContent).toBe('Completed');
  });

  it('renders a running v2 session and an unclosed one in the shared wording', () => {
    const running: string = '11111111-2222-4333-8444-666666666666';
    const abandoned: string = '11111111-2222-4333-8444-777777777777';
    const v2Events: EventRecord[] = [
      {
        version: 2,
        t: 'sessionStarted',
        eventId: `${running}:start`,
        at: T13,
        sessionId: running,
        source: 'manual',
        mode: 'blacklist',
        strictness: 'flexible',
        duration: { kind: 'until-stopped' },
        intention: 'still going',
        scheduleOccurrence: null,
      },
      {
        version: 2,
        t: 'sessionStarted',
        eventId: `${abandoned}:start`,
        at: T9,
        sessionId: abandoned,
        source: 'manual',
        mode: 'blacklist',
        strictness: 'friction',
        duration: { kind: 'timed', minutes: 25 },
        intention: 'superseded',
        scheduleOccurrence: null,
      },
    ];

    const { container } = render(<SessionLog events={v2Events} />);
    const chips: string[] = [...container.querySelectorAll('.session-table .chip')].map(
      (chip: Element): string => chip.textContent ?? '',
    );

    expect(chips).toEqual(['Running', 'Ended early']);
  });

  it('renders the quiet first-run line with no sessions', () => {
    const { container, getByRole } = render(<SessionLog events={[]} />);
    expect(getByRole('heading', { level: 2 }).textContent).toBe(t('stats_sessions_heading'));
    expect(container.textContent).toContain(t('stats_sessions_empty'));
  });

  it('renders mobile article records from the same session rows', () => {
    const releaseReviewEvents: EventRecord[] = [
      { t: 'sessionCompleted', at: T925, focusedMs: 23 * 60_000 },
      started(T9, 25, 'release review', 'manual'),
    ];
    const { getByRole } = render(<SessionLog events={releaseReviewEvents} />);
    const article: HTMLElement = getByRole('article', { name: /release review/i });

    expect(article.textContent).toContain('release review');
    expect(article.textContent).toContain(new Date(T9).toLocaleDateString());
    expect(article.textContent).toContain('09:00');
    expect(article.textContent).toContain('23 m');
    expect(article.textContent).toContain('Completed');
  });

  it('switches from the desktop table to articles through the 768px tablet width', () => {
    const css: string = readFileSync(resolve(process.cwd(), 'src/stats/stats.css'), 'utf8');
    expect(css).toMatch(/\.session-articles\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)[\s\S]*?\.session-table-wrap\s*\{[^}]*display:\s*none/s,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)[\s\S]*?\.session-articles\s*\{[^}]*display:\s*grid/s,
    );
    const mobileBlock: string | undefined = css.match(
      /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(mobileBlock).toBeDefined();
    expect(mobileBlock).not.toMatch(/overflow-x:\s*(auto|scroll)/);
  });
});
