/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, within } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../../src/shared/i18n';
import type { StatsBundle } from '../../../src/shared/messages';
import type { DailyAgg, EventRecord } from '../../../src/shared/types';
import { attemptsByHour, Charts, topSites } from '../../../src/stats/Charts';
import { BarChart } from '../../../src/stats/charts/BarChart';
import { HBarChart } from '../../../src/stats/charts/HBarChart';
import { HourlyHeatStrip } from '../../../src/stats/charts/HourlyHeatStrip';

afterEach(cleanup);

const NOW: number = new Date(2026, 7, 28, 14, 0, 0).getTime();

function cssHexTokens(css: string, token: string): string[] {
  const pattern: RegExp = new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'gi');
  return Array.from(css.matchAll(pattern), (match: RegExpMatchArray): string => match[1] ?? '');
}

function relativeLuminance(hex: string): number {
  const channels: number[] = [1, 3, 5].map((offset: number): number => {
    const channel: number = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrastRatio(first: string, second: string): number {
  const lighter: number = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker: number = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function day(date: string, overrides: Partial<DailyAgg>): DailyAgg {
  return {
    date,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    unlocksTaken: 0,
    resisted: 0,
    ...overrides,
  };
}

function bundleWith(days: DailyAgg[]): StatsBundle {
  return {
    days,
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
}

describe('BarChart', () => {
  it('keeps a keyboard-closed table closed during same-width resize callbacks', () => {
    const callbacks: ResizeObserverCallback[] = [];
    const originalResizeObserver: typeof ResizeObserver | undefined = globalThis.ResizeObserver;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }

      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver;
    try {
      const { container } = render(
        <BarChart
          data={[{ label: 'a', value: 1 }]}
          format={(value: number): string => String(value)}
        />,
      );
      const details: HTMLDetailsElement = container.querySelector(
        '.chart-table',
      ) as HTMLDetailsElement;
      expect(details.open).toBe(true);

      details.open = false;
      callbacks[0]?.(
        [{ contentRect: { width: 375 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );

      expect(details.open).toBe(false);
    } finally {
      if (originalResizeObserver === undefined)
        Reflect.deleteProperty(globalThis, 'ResizeObserver');
      else globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('renders one mark per datum with proportional heights', () => {
    const { container } = render(
      <BarChart
        data={[
          { label: 'a', value: 10 },
          { label: 'b', value: 20 },
          { label: 'c', value: 0 },
        ]}
        format={(v: number): string => `${v} m`}
      />,
    );
    const marks: Element[] = Array.from(container.querySelectorAll('.bar-mark'));
    expect(marks.length).toBe(3);
    const heights: number[] = marks.map((m: Element): number =>
      Number(m.getAttribute('data-h') ?? '-1'),
    );
    expect(heights[2]).toBe(0);
    expect((heights[1] ?? 0) / (heights[0] ?? 1)).toBeCloseTo(2, 5);
  });

  it('end-anchors the selective label when the rightmost value is the maximum', () => {
    const { container } = render(
      <BarChart
        data={[
          { label: '28 Aug', value: 10 },
          { label: '29 Aug', value: 65 },
        ]}
        format={(v: number): string => `${v} minutes focused`}
      />,
    );
    const labels: Element[] = Array.from(container.querySelectorAll('.direct-label'));
    expect(labels).toHaveLength(1);
    expect(labels[0]?.getAttribute('text-anchor')).toBe('end');
    expect(Number(labels[0]?.getAttribute('x'))).toBeLessThanOrEqual(560);
  });

  it('renders the quiet empty line for empty and all-zero data', () => {
    const empty = render(<BarChart data={[]} format={(v: number): string => String(v)} />);
    expect(empty.container.textContent).toContain(t('stats_chart_empty_default'));
    const zeros = render(
      <BarChart
        data={[
          { label: 'a', value: 0 },
          { label: 'b', value: 0 },
        ]}
        format={(v: number): string => String(v)}
      />,
    );
    expect(zeros.container.querySelectorAll('.bar-mark').length).toBe(0);
    expect(zeros.container.textContent).toContain(t('stats_chart_empty_default'));
  });

  it('exposes keyboard data points and a headed data table', () => {
    const { container } = render(
      <BarChart
        data={[
          { label: '28 Aug', value: 10 },
          { label: '29 Aug', value: 20 },
        ]}
        format={(v: number): string => `${v} m`}
        label="Focus minutes per day"
      />,
    );
    const chart: SVGElement | null = container.querySelector('svg.chart');
    expect(chart?.getAttribute('aria-hidden')).toBeNull();
    const title: Element | null = chart?.querySelector('title') ?? null;
    const description: Element | null = chart?.querySelector('desc') ?? null;
    expect(title?.textContent).toBe('Focus minutes per day');
    expect(description?.textContent).toContain('keyboard');
    expect(chart?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(chart?.getAttribute('aria-describedby')).toBe(description?.id);
    const points: Element[] = Array.from(chart?.querySelectorAll('[tabindex="0"]') ?? []);
    expect(points).toHaveLength(2);
    expect(points[0]?.getAttribute('aria-label')).toBe(
      t('stats_chart_point', { LABEL: '28 Aug', VALUE: '10 m' }),
    );

    const columnHeaders: Element[] = Array.from(
      container.querySelectorAll('.chart-table thead th[scope="col"]'),
    );
    expect(columnHeaders.map((header: Element): string | null => header.textContent)).toEqual([
      t('stats_chart_table_category'),
      t('stats_chart_table_value'),
    ]);
    expect(container.querySelectorAll('.chart-table tbody th[scope="row"]')).toHaveLength(2);
    expect(container.querySelectorAll('.chart-table summary')).toHaveLength(1);
  });
});

describe('HBarChart', () => {
  it('renders one row per datum with the formatted value at the tip', () => {
    const { container } = render(
      <HBarChart
        data={[
          { label: 'facebook.com', value: 12 },
          { label: 'youtube.com', value: 4 },
        ]}
        format={(v: number): string => String(v)}
      />,
    );
    expect(container.querySelectorAll('.hbar-mark').length).toBe(2);
    expect(container.textContent).toContain('facebook.com');
    expect(container.textContent).toContain('12');
  });

  it('renders the quiet empty line with no data', () => {
    const { container } = render(<HBarChart data={[]} format={(v: number): string => String(v)} />);
    expect(container.textContent).toContain(t('stats_chart_empty_default'));
  });

  it('exposes keyboard data points and a headed data table', () => {
    const { container } = render(
      <HBarChart
        data={[
          { label: 'facebook.com', value: 12 },
          { label: 'youtube.com', value: 4 },
        ]}
        format={(v: number): string => String(v)}
        label="Top blocked sites"
      />,
    );
    const chart: SVGElement | null = container.querySelector('svg.chart');
    expect(chart?.getAttribute('aria-hidden')).toBeNull();
    const title: Element | null = chart?.querySelector('title') ?? null;
    const description: Element | null = chart?.querySelector('desc') ?? null;
    expect(title?.textContent).toBe('Top blocked sites');
    expect(description?.textContent).toContain('keyboard');
    expect(chart?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(chart?.getAttribute('aria-describedby')).toBe(description?.id);
    const points: Element[] = Array.from(chart?.querySelectorAll('[tabindex="0"]') ?? []);
    expect(points).toHaveLength(2);
    expect(points[0]?.getAttribute('aria-label')).toBe(
      t('stats_chart_point', { LABEL: 'facebook.com', VALUE: '12' }),
    );

    expect(container.querySelectorAll('.chart-table thead th[scope="col"]')).toHaveLength(2);
    expect(container.querySelectorAll('.chart-table tbody th[scope="row"]')).toHaveLength(2);
    expect(container.querySelectorAll('.chart-table summary')).toHaveLength(1);
  });

  it('renders a contrast-safe focus-visible ring around every keyboard row', () => {
    const { container } = render(
      <HBarChart
        data={[
          { label: 'facebook.com', value: 12 },
          { label: 'youtube.com', value: 4 },
        ]}
        format={(value: number): string => String(value)}
      />,
    );
    const rings: Element[] = Array.from(container.querySelectorAll('.hbar-focus-ring'));
    expect(rings).toHaveLength(2);

    const css: string = readFileSync(resolve(process.cwd(), 'src/stats/stats.css'), 'utf8');
    expect(css).toMatch(
      /\.hbar-row:focus-visible \.hbar-focus-ring\s*\{[^}]*stroke:\s*var\(--chart-focus\)/s,
    );
    const focusColors: string[] = cssHexTokens(css, '--chart-focus');
    const surfaceColors: string[] = cssHexTokens(css, '--surface');
    expect(focusColors.length).toBeGreaterThan(0);
    expect(focusColors).toHaveLength(surfaceColors.length);
    for (let index: number = 0; index < focusColors.length; index += 1) {
      expect(
        contrastRatio(focusColors[index] ?? '', surfaceColors[index] ?? ''),
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('HourlyHeatStrip', () => {
  it('renders 24 equal labeled intensity cells under one accessible image', () => {
    const values: number[] = Array.from({ length: 24 }, (_value: unknown, hour: number): number =>
      hour === 9 ? 4 : hour === 14 ? 2 : 0,
    );
    const { container, getByRole, getByText } = render(<HourlyHeatStrip values={values} />);

    expect(getByRole('img', { name: t('stats_heat_strip_label') })).toBeTruthy();
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(1);
    expect(container.querySelectorAll('.heat-cell')).toHaveLength(24);
    expect(container.querySelectorAll('.heat-cell[role]')).toHaveLength(0);
    const cells: Element[] = Array.from(container.querySelectorAll('.heat-cell'));
    expect(cells.map((cell: Element): string | null => cell.getAttribute('data-hour'))).toEqual(
      Array.from(
        { length: 24 },
        (_value: unknown, hour: number): string => `${String(hour).padStart(2, '0')}:00`,
      ),
    );
    expect(cells[9]?.getAttribute('style')).toContain('--intensity: 1');
    expect(cells[14]?.getAttribute('style')).toContain('--intensity: 0.5');
    expect(cells[0]?.getAttribute('style')).toContain('--intensity: 0');
    expect(getByText(t('stats_chart_table_summary'))).toBeTruthy();
    expect(container.querySelectorAll('.chart-table tbody tr')).toHaveLength(24);
    expect(container.querySelector('.chart-table table')).toBeTruthy();
  });

  it('defines equal heat columns and a readable chart fallback without tiny SVG text', () => {
    const css: string = readFileSync(resolve(process.cwd(), 'src/stats/stats.css'), 'utf8');
    expect(css).toMatch(
      /\.heat-strip\s*\{[^}]*grid-template-columns:\s*repeat\(24,\s*minmax\(0,\s*1fr\)\)/s,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*900px\)[\s\S]*?\.heat-strip\s*\{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/s,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*600px\)[\s\S]*?\.heat-strip\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/s,
    );
    expect(css).toMatch(/\.heat-cell-label\s*\{[^}]*font-size:\s*12px/s);
    expect(css).toMatch(/\.axis-text[^}]*font-size:\s*12px/s);
    expect(css).not.toMatch(/@container[^}]*\.axis-text/s);
    expect(css).toMatch(
      /@container\s*\(max-width:\s*560px\)[\s\S]*?\.chart-wrap:not\(\.hourly-heat-wrap\) > \.chart\s*\{[^}]*display:\s*none/s,
    );
    expect(css).toMatch(
      /@container\s*\(max-width:\s*560px\)[\s\S]*?\.chart-wrap:not\(\.hourly-heat-wrap\)[\s\S]*?table-layout:\s*fixed/s,
    );
    expect(css).toMatch(
      /@container\s*\(max-width:\s*560px\)[\s\S]*?\.chart-wrap:not\(\.hourly-heat-wrap\)[\s\S]*?overflow-wrap:\s*anywhere/s,
    );
  });
});

describe('topSites', () => {
  it('merges attempts across days, caps at ten sites plus other', () => {
    const hosts: Record<string, number> = {};
    for (let i = 0; i < 12; i += 1) hosts[`site${i}.com`] = 12 - i;
    const bundle: StatsBundle = bundleWith([
      day('2026-08-27', { attempts: hosts, attemptsOther: 3 }),
      day('2026-08-28', { attempts: { 'site0.com': 5 }, attemptsOther: 1 }),
    ]);
    const rows: Array<{ label: string; value: number }> = topSites(bundle);
    expect(rows.length).toBe(11);
    expect(rows[0]).toEqual({ label: 'site0.com', value: 17 });
    const other: { label: string; value: number } | undefined = rows[10];
    // two hosts past the top ten (2 + 1) plus attemptsOther (3 + 1)
    expect(other).toEqual({ label: 'other', value: 7 });
  });
});

describe('attemptsByHour', () => {
  it('buckets attempt events by local hour and ignores other events', () => {
    const at = (hour: number): number => new Date(2026, 7, 28, hour, 30, 0).getTime();
    const events: EventRecord[] = [
      {
        t: 'attempt',
        at: at(9),
        url: 'https://x.com/',
        host: 'x.com',
        tabId: 1,
        kind: 'navigation',
      },
      { t: 'attempt', at: at(9), url: 'https://x.com/', host: 'x.com', tabId: 1, kind: 'existing' },
      {
        t: 'attempt',
        at: at(14),
        url: 'https://y.com/',
        host: 'y.com',
        tabId: 2,
        kind: 'navigation',
      },
      { t: 'sessionCompleted', at: at(15), focusedMs: 0 },
    ];
    const buckets: number[] = attemptsByHour(events);
    expect(buckets.length).toBe(24);
    expect(buckets[9]).toBe(2);
    expect(buckets[14]).toBe(1);
    expect(buckets.reduce((a: number, b: number): number => a + b, 0)).toBe(3);
  });
});

describe('Charts', () => {
  it('renders exact periods and keeps daily tables at 14 days while top sites uses 30 days', () => {
    const hourlyAttempt: EventRecord = {
      t: 'attempt',
      at: new Date(2026, 7, 28, 9, 30, 0).getTime(),
      url: 'https://current.example/',
      host: 'current.example',
      tabId: 1,
      kind: 'navigation',
    };
    const bundle: StatsBundle = bundleWith([
      day('2026-08-09', { focusMs: 10 * 60_000, attempts: { 'old.example': 7 } }),
      day('2026-08-28', { focusMs: 30 * 60_000, attempts: { 'current.example': 2 } }),
    ]);
    const { getAllByRole } = render(<Charts bundle={bundle} events={[hourlyAttempt]} now={NOW} />);
    const headings: HTMLElement[] = getAllByRole('heading', { level: 2 });
    expect(headings.map((heading: HTMLElement): string => heading.textContent ?? '')).toEqual([
      t('stats_chart_focus_heading'),
      t('stats_chart_attempts_heading'),
      t('stats_chart_sites_heading'),
      t('stats_chart_hours_heading'),
    ]);

    const sections: HTMLElement[] = headings.map((heading: HTMLElement): HTMLElement => {
      const section: HTMLElement | null = heading.closest('section');
      if (section === null) throw new Error('chart heading is not inside its panel');
      return section;
    });
    for (const section of sections) {
      expect(within(section).getByText(t('stats_chart_table_summary'))).toBeTruthy();
    }
    expect(sections[0]?.querySelectorAll('.chart-table tbody tr')).toHaveLength(14);
    expect(sections[1]?.querySelectorAll('.chart-table tbody tr')).toHaveLength(14);
    expect(sections[2]?.textContent).toContain('old.example');
    expect(sections[3]?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      t('stats_heat_strip_label'),
    );
    expect(sections[3]?.querySelectorAll('.heat-cell')).toHaveLength(24);
    expect(sections[3]?.querySelector('svg')).toBeNull();
    expect(sections[3]?.querySelectorAll('.chart-table tbody tr')).toHaveLength(24);
  });
});
