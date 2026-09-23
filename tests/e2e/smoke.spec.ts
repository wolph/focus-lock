import {
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
  type Worker,
} from '@playwright/test';
import { resolveExtensionDist } from './extension-dist';
import { expect, test } from './fixtures';

interface CssColors {
  backgroundColor: string;
  color: string;
}

interface ElementBounds {
  label: string;
  left: number;
  right: number;
}

interface ChartTextBounds {
  bottom: number;
  label: string;
  left: number;
  right: number;
  top: number;
  viewBoxHeight: number;
  viewBoxWidth: number;
}

interface ChartTextGap {
  first: string;
  gap: number;
  second: string;
}

interface ChartTextSeparation {
  direct: string;
  separation: number;
  tick: string;
}

interface HbarRowGeometry {
  barLeft: number;
  barRight: number;
  domainRight: number;
  label: string;
  valueLeft: number;
  valueRight: number;
  viewBoxWidth: number;
}

interface StatsLayoutMetrics {
  chartLabelScreenFontSizes: number[];
  chartTextBounds: ChartTextBounds[];
  chartTextGaps: ChartTextGap[];
  chartTextSeparations: ChartTextSeparation[];
  documentWidth: number;
  viewportWidth: number;
  elements: ElementBounds[];
  heatCellWidths: number[];
  heatLabelFontSizes: number[];
  heatStripColumns: number;
  hbarRows: HbarRowGeometry[];
  horizontalScrollers: string[];
  visibleChartCount: number;
  visibleReadableTableCount: number;
}

function relativeLuminance(channel: number): number {
  const normalized: number = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function rgbChannels(value: string): [number, number, number] {
  const matches: string[] = value.match(/[\d.]+/g) ?? [];
  if (matches.length < 3) throw new Error(`Expected an RGB color, received ${value}`);
  return [Number(matches[0]), Number(matches[1]), Number(matches[2])];
}

function contrastRatio(foreground: string, background: string): number {
  const [fr, fg, fb]: [number, number, number] = rgbChannels(foreground);
  const [br, bg, bb]: [number, number, number] = rgbChannels(background);
  const foregroundLuminance: number =
    0.2126 * relativeLuminance(fr) +
    0.7152 * relativeLuminance(fg) +
    0.0722 * relativeLuminance(fb);
  const backgroundLuminance: number =
    0.2126 * relativeLuminance(br) +
    0.7152 * relativeLuminance(bg) +
    0.0722 * relativeLuminance(bb);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

async function elementContrast(page: Page, selector: string): Promise<number> {
  const colors: CssColors = await page
    .locator(selector)
    .first()
    .evaluate((element: Element) => {
      const style: CSSStyleDeclaration = getComputedStyle(element);
      return { backgroundColor: style.backgroundColor, color: style.color };
    });
  return contrastRatio(colors.color, colors.backgroundColor);
}

test('extension loads and the worker answers getSnapshot', async ({ context, extensionId }) => {
  // chrome.runtime.sendMessage never loops back to the sending context, so the
  // worker cannot ask itself. An extension page exercises the real path instead.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  const snapshot: { phase: string } = await page.evaluate(async () => {
    return await chrome.runtime.sendMessage({ type: 'getSnapshot' });
  });
  expect(snapshot.phase).toBe('idle');
});

test('popup page renders', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await expect(page.getByRole('heading', { level: 1, name: 'Focus Lock' })).toBeVisible();
});

test('popup keeps its preferred height and fits controls into shorter hosts', async ({
  extPage,
}) => {
  await expect(extPage.locator('.start-form')).toBeVisible();
  const viewports: ReadonlyArray<{ width: number; height: number }> = [
    { width: 480, height: 760 },
    { width: 480, height: 600 },
    { width: 480, height: 400 },
    { width: 340, height: 760 },
    { width: 340, height: 600 },
    { width: 375, height: 400 },
    { width: 768, height: 600 },
  ];
  for (const viewport of viewports) {
    await extPage.setViewportSize(viewport);
    const bodyWidth: number = await extPage
      .locator('body')
      .evaluate((element: HTMLElement): number => element.getBoundingClientRect().width);
    expect(bodyWidth).toBe(Math.min(480, viewport.width));
    const appWidth: number = await extPage
      .locator('.app')
      .evaluate((element: HTMLElement): number => element.getBoundingClientRect().width);
    expect(appWidth).toBe(Math.min(480, viewport.width));
    const bodyHeight: number = await extPage
      .locator('body')
      .evaluate((element: HTMLElement): number => element.getBoundingClientRect().height);
    expect(bodyHeight).toBe(600);
    const appHeight: number = await extPage
      .locator('.app')
      .evaluate((element: HTMLElement): number => element.getBoundingClientRect().height);
    expect(appHeight).toBe(Math.min(bodyHeight, viewport.height));
    await expect(extPage.locator('.start-button')).toBeInViewport({ ratio: 1 });
    const scroll: Locator = extPage.locator('.start-form__scroll');
    expect(
      await scroll.evaluate((element: HTMLElement): number => element.clientHeight),
    ).toBeGreaterThan(0);
    if (viewport.height < bodyHeight) {
      await scroll.evaluate((element: HTMLElement): void => {
        element.scrollTop = element.scrollHeight;
      });
      expect(
        await scroll.evaluate((element: HTMLElement): number => element.scrollTop),
      ).toBeGreaterThan(0);
      await expect(extPage.locator('.start-button')).toBeInViewport({ ratio: 1 });
    }
  }
  await extPage.evaluate(async (): Promise<void> => {
    await chrome.action.openPopup();
  });
  await expect
    .poll(async (): Promise<number | undefined> => {
      return await extPage.evaluate((): number | undefined => {
        const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
        return popup?.document.querySelector('.start-button') ? popup.innerWidth : undefined;
      });
    })
    .toBe(480);
});

test('Stats navigation round-trips through an Options section', async ({
  context,
  extensionId,
}) => {
  const page: Page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);

  const statsNavigation = page.getByRole('navigation', { name: 'Product navigation' });
  await expect(statsNavigation).toBeVisible();
  await expect(statsNavigation.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const optionsDestinations: ReadonlyArray<{ name: string; id: string }> = [
    { name: 'Blocking', id: 'blocking' },
    { name: 'Schedule', id: 'schedule' },
    { name: 'Session behavior', id: 'behavior' },
    { name: 'Site access credit', id: 'budget' },
    { name: 'Notifications', id: 'notifications' },
    { name: 'Privacy and data', id: 'privacy' },
  ];
  for (const destination of optionsDestinations) {
    await expect(statsNavigation.getByRole('link', { name: destination.name })).toHaveAttribute(
      'href',
      `../options/options.html#${destination.id}`,
    );
  }

  await statsNavigation.getByRole('link', { name: 'Site access credit' }).click();
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/src/options/options.html#budget`);
  const optionsNavigation = page.getByRole('navigation', { name: 'Product navigation' });
  await expect(optionsNavigation).toBeVisible();
  await expect(optionsNavigation.getByRole('link', { name: 'Site access credit' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { level: 2, name: 'Site access credit' })).toBeVisible();

  await optionsNavigation.getByRole('link', { name: 'Overview' }).click();
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/src/stats/stats.html`);
  const returnedNavigation = page.getByRole('navigation', { name: 'Product navigation' });
  await expect(returnedNavigation.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Your focus record' })).toBeVisible();
});

test('Stats content stays inside responsive viewports', async ({
  context,
  extensionId,
  extPage,
}) => {
  await extPage.evaluate(async (): Promise<void> => {
    const seedDate: Date = new Date();
    seedDate.setDate(seedDate.getDate() - 1);
    const year: string = String(seedDate.getFullYear());
    const month: string = String(seedDate.getMonth() + 1).padStart(2, '0');
    const day: string = String(seedDate.getDate()).padStart(2, '0');
    const date: string = `${year}-${month}-${day}`;
    const firstSeedDate: Date = new Date();
    firstSeedDate.setDate(firstSeedDate.getDate() - 13);
    const firstYear: string = String(firstSeedDate.getFullYear());
    const firstMonth: string = String(firstSeedDate.getMonth() + 1).padStart(2, '0');
    const firstDay: string = String(firstSeedDate.getDate()).padStart(2, '0');
    const firstDate: string = `${firstYear}-${firstMonth}-${firstDay}`;
    const now: number = Date.now();

    await chrome.storage.sync.set({
      [`agg:e2e-responsive-first:${firstDate}`]: {
        date: firstDate,
        focusMs: 60 * 60_000,
        sessionsStarted: 1,
        sessionsCompleted: 1,
        attempts: {},
        attemptsOther: 0,
        pausesTaken: 0,
        pauseMsSpent: 0,
        pauseMsEarned: 0,
        unlocksTaken: 0,
        unlockMsSpent: 0,
        resisted: 0,
      },
      [`agg:e2e-responsive:${date}`]: {
        date,
        focusMs: 40 * 60_000,
        sessionsStarted: 1,
        sessionsCompleted: 1,
        attempts: {
          'blocked.example': 2,
          'an-extremely-long-domain-name-used-for-responsive-verification.example': 9_999_999,
        },
        attemptsOther: 0,
        pausesTaken: 1,
        pauseMsSpent: 2 * 60_000,
        pauseMsEarned: 6 * 60_000,
        unlocksTaken: 1,
        unlockMsSpent: 60_000,
        resisted: 1,
      },
    });
    await chrome.storage.local.set({
      events: [
        {
          t: 'sessionStarted',
          at: now - 30 * 60_000,
          source: 'manual',
          mode: 'blacklist',
          strictness: 'friction',
          durationMin: 25,
          intention: 'Responsive layout regression with a deliberately long session intention',
          sessionId: 'responsive-layout',
        },
        {
          t: 'sessionCompleted',
          at: now,
          focusedMs: 25 * 60_000,
          sessionId: 'responsive-layout',
        },
      ],
    });
  });

  const page: Page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);
  await expect(page.locator('.tile-row')).toBeVisible();
  await expect(page.locator('.chart')).toHaveCount(3);
  await expect(page.locator('.session-table')).toBeVisible();

  const viewports: ReadonlyArray<{ width: number; height: number }> = [
    { width: 375, height: 812 },
    { width: 480, height: 812 },
    { width: 481, height: 812 },
    { width: 600, height: 812 },
    { width: 601, height: 812 },
    { width: 767, height: 900 },
    { width: 768, height: 900 },
    { width: 900, height: 900 },
    { width: 901, height: 900 },
    { width: 1280, height: 850 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(
      (): Promise<void> =>
        new Promise<void>((resolve: () => void): void => {
          requestAnimationFrame((): void => {
            requestAnimationFrame((): void => resolve());
          });
        }),
    );
    const metrics: StatsLayoutMetrics = await page.evaluate((): StatsLayoutMetrics => {
      function bounds(selector: string): ElementBounds[] {
        const elements: Element[] = Array.from(document.querySelectorAll(selector));
        if (elements.length === 0) throw new Error(`Missing Stats element: ${selector}`);
        return elements.map((element: Element, index: number): ElementBounds => {
          const rect: DOMRect = element.getBoundingClientRect();
          return { label: `${selector}[${index}]`, left: rect.left, right: rect.right };
        });
      }

      const heatStrip: HTMLElement | null = document.querySelector('.heat-strip');
      if (heatStrip === null) throw new Error('Missing Stats hourly heat strip');
      const visibleCharts: SVGSVGElement[] = Array.from(
        document.querySelectorAll<SVGSVGElement>('.chart'),
      ).filter((chart: SVGSVGElement): boolean => getComputedStyle(chart).display !== 'none');
      const chartLabels: SVGTextElement[] = visibleCharts.flatMap(
        (chart: SVGSVGElement): SVGTextElement[] =>
          Array.from(
            chart.querySelectorAll<SVGTextElement>('.axis-text, .value-label, .direct-label'),
          ),
      );
      return {
        chartLabelScreenFontSizes: chartLabels.map((label: SVGTextElement): number => {
          const matrix: DOMMatrix | null = label.getScreenCTM();
          if (matrix === null) throw new Error('Missing Stats chart screen transform');
          const screenScaleY: number = Math.hypot(matrix.c, matrix.d);
          return Number.parseFloat(getComputedStyle(label).fontSize) * screenScaleY;
        }),
        chartTextBounds: chartLabels.map((label: SVGTextElement): ChartTextBounds => {
          const box: DOMRect = label.getBBox();
          const svg: SVGSVGElement | null = label.ownerSVGElement;
          if (svg === null) throw new Error('Missing Stats chart owner SVG');
          return {
            bottom: box.y + box.height,
            label: label.textContent ?? '',
            left: box.x,
            right: box.x + box.width,
            top: box.y,
            viewBoxHeight: svg.viewBox.baseVal.height,
            viewBoxWidth: svg.viewBox.baseVal.width,
          };
        }),
        chartTextGaps: visibleCharts
          .filter((chart: SVGSVGElement): boolean => !chart.classList.contains('hbar'))
          .flatMap((chart: SVGSVGElement): ChartTextGap[] => {
            const labels: Array<{ box: DOMRect; text: string }> = Array.from(
              chart.querySelectorAll<SVGTextElement>('.axis-text'),
            )
              .map((label: SVGTextElement): { box: DOMRect; text: string } => ({
                box: label.getBBox(),
                text: label.textContent ?? '',
              }))
              .filter(
                ({ box }: { box: DOMRect; text: string }): boolean =>
                  box.y > chart.viewBox.baseVal.height * 0.8,
              )
              .sort(
                (
                  first: { box: DOMRect; text: string },
                  second: { box: DOMRect; text: string },
                ): number => first.box.x - second.box.x,
              );
            return labels
              .slice(1)
              .map((label: { box: DOMRect; text: string }, index: number): ChartTextGap => {
                const previous: { box: DOMRect; text: string } | undefined = labels[index];
                if (previous === undefined) throw new Error('Missing previous Stats chart label');
                return {
                  first: previous.text,
                  gap: label.box.x - (previous.box.x + previous.box.width),
                  second: label.text,
                };
              });
          }),
        chartTextSeparations: visibleCharts
          .filter((chart: SVGSVGElement): boolean => !chart.classList.contains('hbar'))
          .flatMap((chart: SVGSVGElement): ChartTextSeparation[] => {
            const direct: SVGTextElement | null = chart.querySelector('.direct-label');
            if (direct === null) throw new Error('Missing Stats direct chart label');
            const directBox: DOMRect = direct.getBBox();
            const ticks: SVGTextElement[] = Array.from(
              chart.querySelectorAll<SVGTextElement>('.axis-text'),
            ).filter(
              (tick: SVGTextElement): boolean =>
                tick.getBBox().y <= chart.viewBox.baseVal.height * 0.8,
            );
            return ticks.map((tick: SVGTextElement): ChartTextSeparation => {
              const tickBox: DOMRect = tick.getBBox();
              return {
                direct: direct.textContent ?? '',
                separation: Math.max(
                  tickBox.x - (directBox.x + directBox.width),
                  directBox.x - (tickBox.x + tickBox.width),
                  tickBox.y - (directBox.y + directBox.height),
                  directBox.y - (tickBox.y + tickBox.height),
                ),
                tick: tick.textContent ?? '',
              };
            });
          }),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        elements: [
          ...bounds('.stats-page'),
          ...bounds('.tile'),
          ...bounds('.card'),
          ...bounds('.chart-wrap'),
          ...bounds('.session-table-wrap'),
        ],
        heatCellWidths: Array.from(document.querySelectorAll<HTMLElement>('.heat-cell')).map(
          (cell: HTMLElement): number => cell.getBoundingClientRect().width,
        ),
        heatLabelFontSizes: Array.from(
          document.querySelectorAll<HTMLElement>('.heat-cell-label'),
        ).map((label: HTMLElement): number => Number.parseFloat(getComputedStyle(label).fontSize)),
        heatStripColumns: getComputedStyle(heatStrip)
          .gridTemplateColumns.split(/\s+/)
          .filter((column: string): boolean => column.length > 0).length,
        horizontalScrollers: Array.from(document.querySelectorAll<HTMLElement>('*'))
          .filter((element: HTMLElement): boolean => {
            const overflowX: string = getComputedStyle(element).overflowX;
            return (
              (overflowX === 'auto' || overflowX === 'scroll') &&
              element.scrollWidth > element.clientWidth
            );
          })
          .map((element: HTMLElement): string => {
            const classes: string = Array.from(element.classList)
              .map((className: string): string => `.${className}`)
              .join('');
            return `${element.tagName.toLowerCase()}${classes}`;
          }),
        hbarRows: visibleCharts
          .filter((chart: SVGSVGElement): boolean => chart.classList.contains('hbar'))
          .flatMap((chart: SVGSVGElement): SVGGElement[] =>
            Array.from(chart.querySelectorAll<SVGGElement>('.hbar-row')),
          )
          .map((row: SVGGElement): HbarRowGeometry => {
            const domain: SVGTextElement | null = row.querySelector('.axis-text');
            const bar: SVGGraphicsElement | null = row.querySelector('.hbar-mark');
            const value: SVGTextElement | null = row.querySelector('.value-label');
            const svg: SVGSVGElement | null = row.ownerSVGElement;
            if (domain === null || bar === null || value === null || svg === null) {
              throw new Error('Incomplete Stats horizontal chart row');
            }
            const domainBox: DOMRect = domain.getBBox();
            const barBox: DOMRect = bar.getBBox();
            const valueBox: DOMRect = value.getBBox();
            return {
              barLeft: barBox.x,
              barRight: barBox.x + barBox.width,
              domainRight: domainBox.x + domainBox.width,
              label: domain.textContent ?? '',
              valueLeft: valueBox.x,
              valueRight: valueBox.x + valueBox.width,
              viewBoxWidth: svg.viewBox.baseVal.width,
            };
          }),
        visibleChartCount: visibleCharts.length,
        visibleReadableTableCount: Array.from(
          document.querySelectorAll<HTMLTableElement>(
            '.chart-wrap:not(.hourly-heat-wrap) .chart-table table',
          ),
        ).filter((table: HTMLTableElement): boolean => table.checkVisibility()).length,
      };
    });

    expect(metrics.documentWidth, JSON.stringify({ viewport, metrics })).toBeLessThanOrEqual(
      metrics.viewportWidth,
    );
    for (const element of metrics.elements) {
      const evidence: string = JSON.stringify({ viewport, element });
      expect(element.left, evidence).toBeGreaterThanOrEqual(0);
      expect(element.right, evidence).toBeLessThanOrEqual(metrics.viewportWidth);
    }
    const expectedHeatColumns: number = viewport.width <= 600 ? 6 : viewport.width <= 900 ? 12 : 24;
    expect(metrics.heatStripColumns, JSON.stringify({ viewport, metrics })).toBe(
      expectedHeatColumns,
    );
    expect(metrics.heatCellWidths).toHaveLength(24);
    expect(Math.max(...metrics.heatCellWidths) - Math.min(...metrics.heatCellWidths)).toBeLessThan(
      0.02,
    );
    expect(Math.min(...metrics.heatLabelFontSizes)).toBeGreaterThanOrEqual(12);
    if (viewport.width <= 600) {
      expect(metrics.horizontalScrollers, JSON.stringify({ viewport, metrics })).toEqual([]);
    } else {
      expect(
        metrics.horizontalScrollers.every(
          (selector: string): boolean => selector === 'div.session-table-wrap',
        ),
        JSON.stringify({ viewport, horizontalScrollers: metrics.horizontalScrollers }),
      ).toBe(true);
    }
    if (metrics.visibleChartCount === 0) {
      expect(metrics.visibleReadableTableCount).toBe(3);
      expect(metrics.chartLabelScreenFontSizes).toEqual([]);
    } else {
      expect(metrics.chartLabelScreenFontSizes.length).toBeGreaterThan(0);
      expect
        .soft(
          Math.min(...metrics.chartLabelScreenFontSizes),
          JSON.stringify({
            viewport,
            chartLabelScreenFontSizes: metrics.chartLabelScreenFontSizes,
          }),
        )
        .toBeGreaterThanOrEqual(12);
    }
    for (const label of metrics.chartTextBounds) {
      const evidence: string = JSON.stringify({ viewport, label });
      expect.soft(label.left, evidence).toBeGreaterThanOrEqual(0);
      expect.soft(label.top, evidence).toBeGreaterThanOrEqual(0);
      expect.soft(label.right, evidence).toBeLessThanOrEqual(label.viewBoxWidth);
      expect.soft(label.bottom, evidence).toBeLessThanOrEqual(label.viewBoxHeight);
    }
    for (const gap of metrics.chartTextGaps) {
      expect.soft(gap.gap, JSON.stringify({ viewport, gap })).toBeGreaterThanOrEqual(2);
    }
    for (const separation of metrics.chartTextSeparations) {
      expect
        .soft(separation.separation, JSON.stringify({ viewport, separation }))
        .toBeGreaterThanOrEqual(2);
    }
    for (const row of metrics.hbarRows) {
      const evidence: string = JSON.stringify({ viewport, row });
      expect.soft(row.domainRight, evidence).toBeLessThanOrEqual(row.barLeft);
      expect.soft(row.barRight, evidence).toBeLessThanOrEqual(row.valueLeft);
      expect.soft(row.valueRight, evidence).toBeLessThanOrEqual(row.viewBoxWidth);
    }
  }

  // A headed 375px Chrome viewport leaves 360 CSS pixels after its vertical scrollbar.
  await page.setViewportSize({ width: 360, height: 812 });
  await page.evaluate((): void => {
    const elements: Element[] = [document.documentElement, ...document.querySelectorAll('*')];
    const fontSizes: number[] = elements.map((element: Element): number =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    elements.forEach((element: Element, index: number): void => {
      const fontSize: number | undefined = fontSizes[index];
      if (
        (element instanceof HTMLElement || element instanceof SVGElement) &&
        fontSize !== undefined &&
        Number.isFinite(fontSize)
      ) {
        element.style.fontSize = `${fontSize * 2}px`;
      }
    });
  });
  const scaledTextMetrics: {
    columns: number;
    documentOverflow: number;
    labelsFit: boolean;
    outOfBounds: string[];
    horizontalScrollers: string[];
    visibleReadableTableCount: number;
  } = await page.evaluate(
    (): {
      columns: number;
      documentOverflow: number;
      labelsFit: boolean;
      outOfBounds: string[];
      horizontalScrollers: string[];
      visibleReadableTableCount: number;
    } => {
      const strip: HTMLElement | null = document.querySelector('.heat-strip');
      if (strip === null) throw new Error('Missing scaled Stats heat strip');
      const labels: HTMLElement[] = Array.from(
        document.querySelectorAll<HTMLElement>('.heat-cell-label'),
      );
      const visibleBounds: Element[] = Array.from(
        document.querySelectorAll('.stats-page details, .stats-page table'),
      ).filter((element: Element): boolean => element.checkVisibility());
      const viewportWidth: number = document.documentElement.clientWidth;
      return {
        columns: getComputedStyle(strip)
          .gridTemplateColumns.split(/\s+/)
          .filter((column: string): boolean => column.length > 0).length,
        documentOverflow: document.documentElement.scrollWidth - viewportWidth,
        horizontalScrollers: Array.from(document.querySelectorAll<HTMLElement>('*'))
          .filter((element: HTMLElement): boolean => {
            const overflowX: string = getComputedStyle(element).overflowX;
            return (
              (overflowX === 'auto' || overflowX === 'scroll') &&
              element.scrollWidth > element.clientWidth
            );
          })
          .map((element: HTMLElement): string => element.className),
        labelsFit: labels.every((label: HTMLElement): boolean => {
          const cell: HTMLElement | null = label.closest('.heat-cell');
          if (cell === null) return false;
          return label.getBoundingClientRect().width <= cell.getBoundingClientRect().width;
        }),
        outOfBounds: visibleBounds
          .filter((element: Element): boolean => {
            const bounds: DOMRect = element.getBoundingClientRect();
            return bounds.left < 0 || bounds.right > viewportWidth;
          })
          .map((element: Element): string => {
            const bounds: DOMRect = element.getBoundingClientRect();
            return `${element.tagName.toLowerCase()}.${element.className}:${bounds.left}-${bounds.right}`;
          }),
        visibleReadableTableCount: Array.from(
          document.querySelectorAll<HTMLTableElement>(
            '.chart-wrap:not(.hourly-heat-wrap) .chart-table table',
          ),
        ).filter((table: HTMLTableElement): boolean => table.checkVisibility()).length,
      };
    },
  );
  expect(scaledTextMetrics).toEqual({
    columns: 6,
    documentOverflow: 0,
    horizontalScrollers: [],
    labelsFit: true,
    outOfBounds: [],
    visibleReadableTableCount: 3,
  });

  const containerCases: ReadonlyArray<{ chartVisible: boolean; width: number }> = [
    { width: 559, chartVisible: false },
    { width: 560, chartVisible: false },
    { width: 561, chartVisible: true },
    { width: 700, chartVisible: true },
  ];
  await page.setViewportSize({ width: 1280, height: 850 });
  for (const containerCase of containerCases) {
    const labelSize: {
      chartVisible: boolean;
      containerWidth: number;
      internal: number | null;
      screen: number | null;
      tableVisible: boolean;
    } = await page
      .locator('.chart-wrap')
      .first()
      .evaluate(
        async (
          chartWrap: HTMLElement,
          width: number,
        ): Promise<{
          chartVisible: boolean;
          containerWidth: number;
          internal: number | null;
          screen: number | null;
          tableVisible: boolean;
        }> => {
          chartWrap.style.width = `${width}px`;
          const chart: SVGSVGElement | null = chartWrap.querySelector('.chart');
          const table: HTMLTableElement | null = chartWrap.querySelector('.chart-table table');
          const label: SVGTextElement | null = chartWrap.querySelector('.axis-text');
          if (chart === null || table === null || label === null) {
            throw new Error('Missing Stats chart fallback threshold element');
          }
          await new Promise<void>((resolve: () => void): number => requestAnimationFrame(resolve));
          await new Promise<void>((resolve: () => void): number => requestAnimationFrame(resolve));
          const chartVisible: boolean = getComputedStyle(chart).display !== 'none';
          if (!chartVisible) {
            return {
              chartVisible,
              containerWidth: chartWrap.getBoundingClientRect().width,
              internal: null,
              screen: null,
              tableVisible: table.checkVisibility(),
            };
          }
          const matrix: DOMMatrix | null = label.getScreenCTM();
          if (matrix === null) throw new Error('Missing Stats chart threshold transform');
          const internal: number = Number.parseFloat(getComputedStyle(label).fontSize);
          return {
            chartVisible,
            containerWidth: chartWrap.getBoundingClientRect().width,
            internal,
            screen: internal * Math.hypot(matrix.c, matrix.d),
            tableVisible: table.checkVisibility(),
          };
        },
        containerCase.width,
      );
    expect(labelSize.containerWidth).toBe(containerCase.width);
    expect(labelSize.chartVisible).toBe(containerCase.chartVisible);
    if (containerCase.chartVisible) {
      expect(labelSize.internal).toBeGreaterThanOrEqual(12);
      expect(labelSize.screen).toBeGreaterThanOrEqual(12);
      expect(labelSize.tableVisible).toBe(false);
    } else {
      expect(labelSize.internal).toBeNull();
      expect(labelSize.screen).toBeNull();
      expect(labelSize.tableVisible).toBe(true);
    }
  }
});

test('blockable test site loads without a session', async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(siteUrl('/plain.html'));
  await expect(page.locator('#marker')).toHaveText('plain page');
});

test('options page fits a mobile viewport', async ({ context, extensionId }) => {
  const page: Page = await context.newPage();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();

  const horizontalOverflowPx: number = await page.evaluate(
    (): number => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(horizontalOverflowPx).toBeLessThanOrEqual(0);
});

// biome-ignore lint/correctness/noEmptyPattern: this regression owns its isolated extension context
test('a refused Settings write reports itself and puts the control back', async ({}, testInfo) => {
  const dist: string = resolveExtensionDist();
  const context: BrowserContext = await chromium.launchPersistentContext(
    testInfo.outputPath('task5-options-profile'),
    {
      channel: 'chromium',
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    },
  );
  try {
    const existingWorker: Worker | undefined = context.serviceWorkers()[0];
    const worker: Worker = existingWorker ?? (await context.waitForEvent('serviceworker'));
    const extensionId: string = new URL(worker.url()).host;
    const page: Page = await context.newPage();
    await page.addInitScript((): void => {
      const sendMessage: typeof chrome.runtime.sendMessage = chrome.runtime.sendMessage.bind(
        chrome.runtime,
      );
      Object.defineProperty(chrome.runtime, 'sendMessage', {
        configurable: true,
        value: async (...args: Parameters<typeof chrome.runtime.sendMessage>): Promise<unknown> => {
          const request: unknown = args[0];
          if (
            typeof request === 'object' &&
            request !== null &&
            'type' in request &&
            request.type === 'updateLists'
          ) {
            return { ok: false, error: 'Blocking changes could not be saved. Try again.' };
          }
          return await sendMessage(...args);
        },
      });
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html#blocking`);
    await expect(page.getByRole('heading', { level: 2, name: 'Blocking' })).toBeVisible();

    await page.getByRole('textbox', { name: 'Pattern' }).first().fill('example.com');
    await page.getByRole('button', { name: 'Add rule' }).first().click();

    // The write goes out on its own, and its refusal is reported with the controls that tried it.
    const alert: Locator = page.getByRole('alert');
    await expect(alert).toHaveText('Blocking changes could not be saved. Try again.');
    const panel: Locator = page.locator('[data-settings-section="blocking"]');
    expect(
      await alert.evaluate(
        (element: Element, panelSelector: string): boolean =>
          element.closest(panelSelector) !== null,
        '[data-settings-section="blocking"]',
      ),
    ).toBe(true);
    await expect(panel.getByRole('heading', { level: 2, name: 'Blocking' })).toBeVisible();

    const geometry: { bottom: number; top: number; viewportHeight: number } = await alert.evaluate(
      (element: Element) => {
        const bounds: DOMRect = element.getBoundingClientRect();
        return { bottom: bounds.bottom, top: bounds.top, viewportHeight: window.innerHeight };
      },
    );
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);

    // The rule the worker refused is not left sitting in the editor as though it had been stored.
    await expect(page.getByRole('cell', { name: 'example.com' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('options current navigation meets light text contrast', async ({ context, extensionId }) => {
  const page: Page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  expect(await elementContrast(page, '.settings-nav-item.current')).toBeGreaterThanOrEqual(4.5);
});

test('options primary button meets dark text contrast', async ({ context, extensionId }) => {
  const page: Page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  // Settings saves as you type, so the page carries a primary button only where a form has to be
  // committed as a whole. The schedule entry editor is that form.
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html#schedule`);
  await expect(page.getByRole('heading', { level: 2, name: 'Schedule' })).toBeVisible();
  await page.getByRole('button', { name: 'Add schedule entry' }).click();
  await expect(page.getByRole('button', { name: 'Save entry' })).toBeVisible();
  expect(await elementContrast(page, 'button.primary')).toBeGreaterThanOrEqual(4.5);
});
