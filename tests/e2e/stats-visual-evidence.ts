import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page, Worker } from '@playwright/test';
import type * as StatsEvidenceIntegrityModule from '../../scripts/stats-evidence-integrity';
import type { BrowserDiagnostics } from './browser-diagnostics';
import type * as StatsVisualSeedsModule from './stats-visual-seeds';
import type { StatsVisualSeed, StatsVisualStateId } from './stats-visual-seeds';

const {
  buildStatsVisualSeed,
  STATS_VISUAL_CLOCK_AUDIT_AT,
  STATS_VISUAL_SEED_AT,
  STATS_VISUAL_STATES,
} = (await import(
  new URL('./stats-visual-seeds.ts', import.meta.url).href
)) as typeof StatsVisualSeedsModule;
const { assertStatsEvidenceDiskParity, statsPngDimensions } = (await import(
  new URL('../../scripts/stats-evidence-integrity.ts', import.meta.url).href
)) as typeof StatsEvidenceIntegrityModule;

export { STATS_VISUAL_STATES };

export type StatsVisualBuildSource = 'dev' | 'production';
export type StatsVisualCaptureScope =
  | 'charts'
  | 'full'
  | 'heat-strip'
  | 'sessions'
  | 'tables'
  | 'tiles';

export interface StatsVisualThemeCase {
  colorScheme: 'dark' | 'light';
  id: 'auto-dark' | 'auto-light' | 'dark-light-media' | 'light-dark-media';
  theme: 'auto' | 'dark' | 'light';
}

export interface StatsVisualEvidenceRecord {
  buildSource: StatsVisualBuildSource;
  bytes: number;
  file: string;
  image: { height: number; width: number };
  scope: StatsVisualCaptureScope;
  seed: StatsVisualSeedIdentity;
  sha256: string;
  state: StatsVisualStateId;
  themeCase: StatsVisualThemeCase['id'];
  viewport: { height: number; width: number };
}

export interface StatsVisualSeedIdentity {
  at: number;
  sha256: string;
  state: StatsVisualStateId;
}

export interface StatsVisualDiagnosticCounts {
  blockedRequests: number;
  consoleErrors: number;
  pageErrors: number;
  requestErrors: number;
  workerErrors: number;
}

export interface StatsVisualGeometry {
  chartTextFontSizes: number[];
  clock: StatsVisualClockAudit;
  diagnostics: StatsVisualDiagnosticCounts;
  disclosureCount: number;
  disclosureRowCounts: number[];
  disclosuresKeyboardUsable: boolean;
  documentHorizontalOverflow: number;
  hasSessions: boolean;
  renderedState: { sha256: string; snapshot: string };
  sessionArticleWidths: Array<{ clientWidth: number; scrollWidth: number }>;
  sessionArticlesClientWidth: number | null;
  sessionArticlesDisplay: string | null;
  sessionArticlesHorizontalOverflow: number | null;
  sessionArticlesScrollWidth: number | null;
  sessionTableClientWidth: number | null;
  sessionTableDisplay: string | null;
  sessionTableScrollWidth: number | null;
  viewport: { height: number; width: number };
}

export interface StatsVisualClockAudit {
  beforeFreeze: number;
  now: number;
}

export interface StatsVisualRenderedRecord {
  renderedState: { sha256: string; snapshot: string };
  state: StatsVisualStateId;
  themeCase: StatsVisualThemeCase['id'];
  viewport: { height: number; width: number };
}

export const STATS_VISUAL_CAPTURE_SCOPES: readonly StatsVisualCaptureScope[] = [
  'full',
  'tiles',
  'heat-strip',
  'charts',
  'tables',
  'sessions',
];

export const STATS_VISUAL_THEME_CASES: readonly StatsVisualThemeCase[] = [
  { colorScheme: 'light', id: 'auto-light', theme: 'auto' },
  { colorScheme: 'dark', id: 'auto-dark', theme: 'auto' },
  { colorScheme: 'dark', id: 'light-dark-media', theme: 'light' },
  { colorScheme: 'light', id: 'dark-light-media', theme: 'dark' },
];

export const STATS_VISUAL_VIEWPORTS: readonly { height: number; width: number }[] = [
  { height: 667, width: 375 },
  { height: 800, width: 768 },
  { height: 800, width: 1280 },
];

export function expectedStatsVisualEvidenceCount(): number {
  return (
    STATS_VISUAL_STATES.length *
    STATS_VISUAL_THEME_CASES.length *
    STATS_VISUAL_VIEWPORTS.length *
    STATS_VISUAL_CAPTURE_SCOPES.length
  );
}

function evidenceKey(record: StatsVisualEvidenceRecord): string {
  return `${record.buildSource}/${record.state}/${record.themeCase}/${String(record.viewport.width)}/${record.scope}`;
}

export function statsVisualSeedIdentity(
  state: StatsVisualStateId,
  seed: StatsVisualSeed,
  at: number = STATS_VISUAL_SEED_AT,
): StatsVisualSeedIdentity {
  return {
    at,
    sha256: createHash('sha256').update(JSON.stringify({ at, seed, state })).digest('hex'),
    state,
  };
}

export function assertStatsVisualInventoryCoverage(
  inventory: readonly StatsVisualEvidenceRecord[],
  buildSource: StatsVisualBuildSource,
): void {
  const observed: string[] = inventory.map(evidenceKey);
  const duplicates: string[] = observed.filter(
    (key: string, index: number): boolean => observed.indexOf(key) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(`Duplicate Stats visual evidence: ${[...new Set(duplicates)].join(', ')}`);
  }
  const required: string[] = STATS_VISUAL_STATES.flatMap((state) =>
    STATS_VISUAL_THEME_CASES.flatMap((themeCase) =>
      STATS_VISUAL_VIEWPORTS.flatMap((viewport) =>
        STATS_VISUAL_CAPTURE_SCOPES.map(
          (scope: StatsVisualCaptureScope): string =>
            `${buildSource}/${state.id}/${themeCase.id}/${String(viewport.width)}/${scope}`,
        ),
      ),
    ),
  );
  const observedSet: Set<string> = new Set(observed);
  const requiredSet: Set<string> = new Set(required);
  const missing: string[] = required.filter((key: string): boolean => !observedSet.has(key));
  const unexpected: string[] = observed.filter((key: string): boolean => !requiredSet.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Stats visual inventory differs. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`,
    );
  }
  for (const record of inventory) {
    const expectedFile: string = statsEvidenceFile(
      buildSource,
      record.state,
      STATS_VISUAL_THEME_CASES.find(
        (themeCase: StatsVisualThemeCase): boolean => themeCase.id === record.themeCase,
      ) as StatsVisualThemeCase,
      record.viewport,
      record.scope,
    );
    const expectedViewport = STATS_VISUAL_VIEWPORTS.find(
      (viewport): boolean => viewport.width === record.viewport.width,
    );
    if (
      expectedViewport === undefined ||
      expectedViewport.height !== record.viewport.height ||
      record.file !== expectedFile ||
      !Number.isInteger(record.bytes) ||
      record.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      record.seed.at !== STATS_VISUAL_SEED_AT ||
      record.seed.state !== record.state ||
      !/^[a-f0-9]{64}$/.test(record.seed.sha256) ||
      record.image.height < 1 ||
      record.image.width < 1 ||
      record.image.width > record.viewport.width ||
      (record.scope === 'full' &&
        (record.image.width !== record.viewport.width ||
          record.image.height < record.viewport.height))
    ) {
      throw new Error(`Stats visual evidence metadata is invalid for ${record.file}.`);
    }
  }
}

export async function assertStatsVisualEvidenceDirectory(
  evidenceDir: string,
  inventory: readonly StatsVisualEvidenceRecord[],
): Promise<void> {
  await assertStatsEvidenceDiskParity(evidenceDir, inventory);
}

function seedIdentityByState(
  inventory: readonly StatsVisualEvidenceRecord[],
): Map<StatsVisualStateId, string> {
  const identities: Map<StatsVisualStateId, string> = new Map();
  for (const record of inventory) {
    const serialized: string = JSON.stringify(record.seed);
    const previous: string | undefined = identities.get(record.state);
    if (previous !== undefined && previous !== serialized) {
      throw new Error(`Stats seed identity differs within ${record.state}.`);
    }
    identities.set(record.state, serialized);
  }
  return identities;
}

export function assertStatsVisualSeedParity(
  dev: readonly StatsVisualEvidenceRecord[],
  production: readonly StatsVisualEvidenceRecord[],
): void {
  const devIdentities: Map<StatsVisualStateId, string> = seedIdentityByState(dev);
  const productionIdentities: Map<StatsVisualStateId, string> = seedIdentityByState(production);
  for (const state of STATS_VISUAL_STATES) {
    if (
      devIdentities.get(state.id) === undefined ||
      devIdentities.get(state.id) !== productionIdentities.get(state.id)
    ) {
      throw new Error(`Stats dev and production seed parity failed for ${state.id}.`);
    }
  }
}

export function assertStatsVisualRenderedParity(
  dev: readonly StatsVisualRenderedRecord[],
  production: readonly StatsVisualRenderedRecord[],
): void {
  const key = (record: StatsVisualRenderedRecord): string =>
    `${record.state}/${record.themeCase}/${String(record.viewport.width)}x${String(record.viewport.height)}`;
  const index = (
    records: readonly StatsVisualRenderedRecord[],
  ): Map<string, StatsVisualRenderedRecord> =>
    new Map(
      records.map((record: StatsVisualRenderedRecord): [string, StatsVisualRenderedRecord] => [
        key(record),
        record,
      ]),
    );
  const devMap: Map<string, StatsVisualRenderedRecord> = index(dev);
  const productionMap: Map<string, StatsVisualRenderedRecord> = index(production);
  if (
    devMap.size !== dev.length ||
    productionMap.size !== production.length ||
    productionMap.size !== devMap.size ||
    [...devMap.keys()].some((recordKey: string): boolean => !productionMap.has(recordKey))
  ) {
    throw new Error('Stats rendered parity inventory differs.');
  }
  for (const record of production) {
    const expected: StatsVisualRenderedRecord | undefined = devMap.get(key(record));
    if (
      expected === undefined ||
      expected.renderedState.sha256 !== record.renderedState.sha256 ||
      expected.renderedState.snapshot !== record.renderedState.snapshot
    ) {
      throw new Error(`Stats rendered parity failed for ${key(record)}.`);
    }
  }
}

export async function installStatsVisualPageClock(page: Page): Promise<void> {
  await page.addInitScript(
    ({ auditAt, frozenAt }): void => {
      Date.now = (): number => auditAt;
      (
        globalThis as typeof globalThis & { __focusLockStatsClockBeforeFreeze?: number }
      ).__focusLockStatsClockBeforeFreeze = Date.now();
      Date.now = (): number => frozenAt;
    },
    { auditAt: STATS_VISUAL_CLOCK_AUDIT_AT, frozenAt: STATS_VISUAL_SEED_AT },
  );
}

export async function freezeStatsVisualWorkerClock(worker: Worker): Promise<StatsVisualClockAudit> {
  return await worker.evaluate(
    ({ auditAt, frozenAt }): StatsVisualClockAudit => {
      Date.now = (): number => auditAt;
      const beforeFreeze: number = Date.now();
      Date.now = (): number => frozenAt;
      return { beforeFreeze, now: Date.now() };
    },
    { auditAt: STATS_VISUAL_CLOCK_AUDIT_AT, frozenAt: STATS_VISUAL_SEED_AT },
  );
}

export function diagnosticCounts(diagnostics: BrowserDiagnostics): StatsVisualDiagnosticCounts {
  return {
    blockedRequests: diagnostics.blockedRequests.length,
    consoleErrors: diagnostics.consoleErrors.length,
    pageErrors: diagnostics.pageErrors.length,
    requestErrors: diagnostics.requestErrors.length,
    workerErrors: diagnostics.workerErrors.length,
  };
}

export function assertStatsVisualDiagnostics(diagnostics: StatsVisualDiagnosticCounts): void {
  const nonZeroDiagnostic: [string, number] | undefined = Object.entries(diagnostics).find(
    ([, count]: [string, number]): boolean => count !== 0,
  );
  if (nonZeroDiagnostic !== undefined) {
    throw new Error(
      `Stats visual diagnostics are not empty: ${nonZeroDiagnostic[0]}=${String(nonZeroDiagnostic[1])}.`,
    );
  }
}

export function assertStatsVisualGeometry(geometry: StatsVisualGeometry): void {
  if (
    geometry.clock.beforeFreeze !== STATS_VISUAL_CLOCK_AUDIT_AT ||
    geometry.clock.now !== STATS_VISUAL_SEED_AT
  ) {
    throw new Error('Stats visual page clock is not frozen at the evidence timestamp.');
  }
  const minimumFontSize: number = Math.min(...geometry.chartTextFontSizes);
  if (!Number.isFinite(minimumFontSize) || minimumFontSize < 12) {
    throw new Error(`Stats chart text is below 12 CSS px: ${String(minimumFontSize)}.`);
  }
  if (geometry.documentHorizontalOverflow !== 0) {
    throw new Error(
      `Stats document has ${String(geometry.documentHorizontalOverflow)} px horizontal overflow.`,
    );
  }
  if (
    geometry.disclosureCount < 1 ||
    geometry.disclosureRowCounts.length !== geometry.disclosureCount ||
    geometry.disclosureRowCounts.some((count: number): boolean => count < 1) ||
    !geometry.disclosuresKeyboardUsable
  ) {
    throw new Error(
      `Stats table disclosures are not all keyboard usable: ${String(geometry.disclosureCount)} disclosures.`,
    );
  }
  if (geometry.hasSessions && geometry.viewport.width <= 768) {
    if (geometry.hasSessions && geometry.sessionTableDisplay !== 'none') {
      throw new Error('The wide session table is visible at a responsive article width.');
    }
    if (geometry.hasSessions && geometry.sessionArticlesDisplay === 'none') {
      throw new Error('Responsive session articles are hidden.');
    }
    if (geometry.sessionTableClientWidth !== 0 || geometry.sessionTableScrollWidth !== 0) {
      throw new Error('The hidden responsive session table still occupies scrollable width.');
    }
    if (
      geometry.hasSessions &&
      geometry.sessionArticlesHorizontalOverflow !== null &&
      geometry.sessionArticlesHorizontalOverflow !== 0
    ) {
      throw new Error('Responsive session articles require sideways scrolling.');
    }
    const overflowingArticle: { clientWidth: number; scrollWidth: number } | undefined =
      geometry.sessionArticleWidths.find(
        (article: { clientWidth: number; scrollWidth: number }): boolean =>
          article.scrollWidth > article.clientWidth,
      );
    if (
      geometry.sessionArticlesClientWidth === null ||
      geometry.sessionArticlesScrollWidth === null ||
      geometry.sessionArticlesScrollWidth > geometry.sessionArticlesClientWidth ||
      overflowingArticle !== undefined
    ) {
      throw new Error('A responsive session article requires sideways scrolling.');
    }
  }
  if (geometry.hasSessions && geometry.viewport.width > 768) {
    if (geometry.sessionTableDisplay === 'none' || geometry.sessionArticlesDisplay !== 'none') {
      throw new Error('The desktop session table is not the sole visible representation.');
    }
    if (
      geometry.sessionArticlesClientWidth !== 0 ||
      geometry.sessionArticlesScrollWidth !== 0 ||
      geometry.sessionArticleWidths.some(
        (article: { clientWidth: number; scrollWidth: number }): boolean =>
          article.clientWidth !== 0 || article.scrollWidth !== 0,
      ) ||
      geometry.sessionTableClientWidth === null ||
      geometry.sessionTableScrollWidth === null ||
      geometry.sessionTableScrollWidth > geometry.sessionTableClientWidth
    ) {
      throw new Error('The desktop session table requires sideways scrolling.');
    }
  }
  assertStatsVisualDiagnostics(geometry.diagnostics);
}

export type ApplyStatsVisualTheme = (page: Page, themeCase: StatsVisualThemeCase) => Promise<void>;

export interface StatsVisualCaptureResult {
  geometry: Array<
    StatsVisualGeometry & {
      state: StatsVisualStateId;
      themeCase: StatsVisualThemeCase['id'];
    }
  >;
  records: StatsVisualEvidenceRecord[];
}

export function statsEvidenceFile(
  buildSource: StatsVisualBuildSource,
  state: StatsVisualStateId,
  themeCase: StatsVisualThemeCase,
  viewport: { height: number; width: number },
  scope: StatsVisualCaptureScope,
): string {
  return `stats-${buildSource}-${state}-${themeCase.id}-${String(viewport.width)}-${scope}.png`;
}

async function captureStatsVisualTarget(input: {
  buildSource: StatsVisualBuildSource;
  evidenceDir: string;
  scope: StatsVisualCaptureScope;
  seed: StatsVisualSeedIdentity;
  state: StatsVisualStateId;
  target: Locator | Page;
  themeCase: StatsVisualThemeCase;
  viewport: { height: number; width: number };
}): Promise<StatsVisualEvidenceRecord> {
  const file: string = statsEvidenceFile(
    input.buildSource,
    input.state,
    input.themeCase,
    input.viewport,
    input.scope,
  );
  const absolutePath: string = path.join(path.resolve(input.evidenceDir), file);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  if ('page' in input.target) {
    await input.target.screenshot({ animations: 'disabled', path: absolutePath });
  } else {
    await input.target.screenshot({ animations: 'disabled', fullPage: true, path: absolutePath });
  }
  const payload: Buffer = await readFile(absolutePath);
  const image: { height: number; width: number } = statsPngDimensions(payload);
  return {
    buildSource: input.buildSource,
    bytes: (await stat(absolutePath)).size,
    file,
    image,
    scope: input.scope,
    seed: input.seed,
    sha256: createHash('sha256').update(payload).digest('hex'),
    state: input.state,
    themeCase: input.themeCase.id,
    viewport: input.viewport,
  };
}

export async function seedProductionStatsVisualState(
  controlPage: Page,
  worker: Worker,
  state: StatsVisualStateId,
  now: number = STATS_VISUAL_SEED_AT,
): Promise<StatsVisualSeed> {
  const seed: StatsVisualSeed = buildStatsVisualSeed(state, now);
  const workerNow: number = await worker.evaluate((): number => Date.now());
  if (workerNow !== now) {
    throw new Error(`Stats evidence worker clock drifted to ${String(workerNow)}.`);
  }
  const response: unknown = await controlPage.evaluate(
    async (storageMode: 'local' | 'sync'): Promise<unknown> =>
      await chrome.runtime.sendMessage({
        deleteRemote: false,
        storageMode,
        type: 'setStorageMode',
      }),
    seed.storageMode,
  );
  if (
    typeof response !== 'object' ||
    response === null ||
    !('ok' in response) ||
    response.ok !== true
  ) {
    throw new Error(
      `Could not select the Stats evidence storage mode: ${JSON.stringify(response)}`,
    );
  }
  await worker.evaluate(async (payload: StatsVisualSeed): Promise<void> => {
    const aggregateKeys = (items: Record<string, unknown>): string[] =>
      Object.keys(items).filter(
        (key: string): boolean =>
          key === 'streak' ||
          key === 'aggregatePrune' ||
          key === 'aggregateTombstones' ||
          key === 'blockedAggregatePublications' ||
          /^aggm?:/.test(key),
      );
    const [localItems, syncItems]: [Record<string, unknown>, Record<string, unknown>] =
      await Promise.all([chrome.storage.local.get(null), chrome.storage.sync.get(null)]);
    const localKeys: string[] = aggregateKeys(localItems);
    const syncKeys: string[] = aggregateKeys(syncItems);
    if (localKeys.length > 0) await chrome.storage.local.remove(localKeys);
    if (syncKeys.length > 0) await chrome.storage.sync.remove(syncKeys);
    await chrome.storage.local.set({ events: payload.events });
    const aggregates: Record<string, unknown> = Object.fromEntries(
      payload.bundle.days.map((day): [string, unknown] => [`agg:stats-task5:${day.date}`, day]),
    );
    aggregates.streak = payload.bundle.streak;
    if (payload.storageMode === 'sync') await chrome.storage.sync.set(aggregates);
    else await chrome.storage.local.set(aggregates);
  }, seed);
  return seed;
}

async function disclosuresKeyboardUsable(page: Page): Promise<boolean> {
  await page.evaluate(
    async (): Promise<void> =>
      await new Promise<void>((resolve: () => void): void => {
        requestAnimationFrame((): void => {
          requestAnimationFrame(resolve);
        });
      }),
  );
  const summaries: Locator = page.locator('.chart-table > summary');
  const count: number = await summaries.count();
  for (let index: number = 0; index < count; index += 1) {
    const summary: Locator = summaries.nth(index);
    await summary.focus();
    const focused: boolean = await summary.evaluate(
      (element: Element): boolean => document.activeElement === element,
    );
    const before: boolean = await summary.evaluate(
      (element: Element): boolean => (element.parentElement as HTMLDetailsElement).open,
    );
    await summary.press('Space');
    await page.waitForFunction(
      ({ open, position }): boolean =>
        (document.querySelectorAll<HTMLDetailsElement>('.chart-table')[position]?.open ?? open) !==
        open,
      { open: before, position: index },
      { timeout: 1_000 },
    );
    const after: boolean = !before;
    await page.evaluate(
      async (): Promise<void> =>
        await new Promise<void>((resolve: () => void): void => {
          requestAnimationFrame((): void => {
            requestAnimationFrame(resolve);
          });
        }),
    );
    await summary.press('Space');
    await page.waitForFunction(
      ({ open, position }): boolean =>
        (document.querySelectorAll<HTMLDetailsElement>('.chart-table')[position]?.open ?? !open) ===
        open,
      { open: before, position: index },
      { timeout: 1_000 },
    );
    const restored: boolean = before;
    if (!focused || before === after || restored !== before) {
      throw new Error(
        `Stats disclosure ${String(index)} keyboard audit failed: focused=${String(focused)}, before=${String(before)}, after=${String(after)}, restored=${String(restored)}.`,
      );
    }
  }
  return count > 0;
}

async function statsVisualGeometry(
  page: Page,
  hasSessions: boolean,
  diagnostics: StatsVisualDiagnosticCounts,
): Promise<StatsVisualGeometry> {
  const keyboardUsable: boolean = await disclosuresKeyboardUsable(page);
  const observed = await page.evaluate(
    ({ diagnosticCounts: counts, keyboard, sessions }) => {
      const visible: (element: Element) => boolean = (element: Element): boolean => {
        const bounds: DOMRect = element.getBoundingClientRect();
        const style: CSSStyleDeclaration = getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const chartText: Element[] = Array.from(
        document.querySelectorAll(
          '.axis-text, .value-label, .direct-label, .heat-cell-label, .chart-table summary, .chart-table th, .chart-table td',
        ),
      ).filter(visible);
      const chartTextFontSizes: number[] = chartText.map((element: Element): number => {
        const base: number = Number.parseFloat(getComputedStyle(element).fontSize);
        if (!(element instanceof SVGGraphicsElement)) return base;
        const matrix: DOMMatrix | null = element.getScreenCTM();
        if (matrix === null) throw new Error('Missing Stats chart text transform.');
        return base * Math.hypot(matrix.c, matrix.d);
      });
      const root: HTMLElement = document.documentElement;
      const sessionTable: HTMLElement | null = document.querySelector('.session-table-wrap');
      const sessionArticles: HTMLElement | null = document.querySelector('.session-articles');
      const articleWidths: Array<{ clientWidth: number; scrollWidth: number }> = [];
      let articleOverflow: number | null = sessionArticles === null ? null : 0;
      if (sessionArticles !== null) {
        for (const article of sessionArticles.querySelectorAll<HTMLElement>('.session-article')) {
          articleWidths.push({
            clientWidth: article.clientWidth,
            scrollWidth: article.scrollWidth,
          });
          articleOverflow = Math.max(
            articleOverflow ?? 0,
            article.scrollWidth - article.clientWidth,
          );
        }
      }
      const disclosureRowCounts: number[] = [];
      for (const body of document.querySelectorAll<HTMLTableSectionElement>('.chart-table tbody')) {
        disclosureRowCounts.push(body.rows.length);
      }
      const normalizedText = (element: Element): string =>
        (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      const renderedSnapshot: string = JSON.stringify({
        bodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim(),
        cards: Array.from(document.querySelectorAll('.card')).map(normalizedText),
        details: Array.from(document.querySelectorAll<HTMLDetailsElement>('.chart-table')).map(
          (detail: HTMLDetailsElement) => ({ open: detail.open, text: normalizedText(detail) }),
        ),
        resolvedTheme: {
          background: getComputedStyle(document.body).backgroundColor,
          color: getComputedStyle(document.body).color,
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
          theme: document.documentElement.dataset.theme ?? '',
        },
        tables: Array.from(document.querySelectorAll('.chart-table tbody tr')).map(normalizedText),
      });
      return {
        chartTextFontSizes,
        clock: {
          beforeFreeze:
            (globalThis as typeof globalThis & { __focusLockStatsClockBeforeFreeze?: number })
              .__focusLockStatsClockBeforeFreeze ?? Number.NaN,
          now: Date.now(),
        },
        diagnostics: counts,
        disclosureCount: document.querySelectorAll('.chart-table > summary').length,
        disclosureRowCounts,
        disclosuresKeyboardUsable: keyboard,
        documentHorizontalOverflow: root.scrollWidth - root.clientWidth,
        hasSessions: sessions,
        renderedSnapshot,
        sessionArticleWidths: articleWidths,
        sessionArticlesClientWidth: sessionArticles?.clientWidth ?? null,
        sessionArticlesDisplay:
          sessionArticles === null ? null : getComputedStyle(sessionArticles).display,
        sessionArticlesHorizontalOverflow: articleOverflow,
        sessionArticlesScrollWidth: sessionArticles?.scrollWidth ?? null,
        sessionTableClientWidth: sessionTable?.clientWidth ?? null,
        sessionTableDisplay: sessionTable === null ? null : getComputedStyle(sessionTable).display,
        sessionTableScrollWidth: sessionTable?.scrollWidth ?? null,
        viewport: { height: window.innerHeight, width: window.innerWidth },
      };
    },
    { diagnosticCounts: diagnostics, keyboard: keyboardUsable, sessions: hasSessions },
  );
  const { renderedSnapshot, ...geometry } = observed;
  return {
    ...geometry,
    renderedState: {
      sha256: createHash('sha256').update(renderedSnapshot).digest('hex'),
      snapshot: renderedSnapshot,
    },
  };
}

function cardWithHeading(page: Page, heading: string): Locator {
  return page.locator('.card').filter({ has: page.getByRole('heading', { name: heading }) });
}

async function assertRenderedStatsVisualState(
  page: Page,
  state: StatsVisualStateId,
): Promise<void> {
  const hourlyValues: number[] = await cardWithHeading(page, 'Attempts by hour, this machine only')
    .locator('.chart-table tbody td')
    .allTextContents()
    .then((values: string[]): number[] =>
      values.map((value: string): number => Number.parseInt(value, 10)),
    );
  const activeHours: number = hourlyValues.filter((value: number): boolean => value > 0).length;
  const expectedActiveHours: number =
    state === 'one-active-hour-sync' ? 1 : state === 'all-hours-boundaries-local' ? 24 : 0;
  if (hourlyValues.length !== 24 || activeHours !== expectedActiveHours) {
    throw new Error(
      `Stats hourly state ${state} expected 24 rows and ${String(expectedActiveHours)} active hours, received ${String(hourlyValues.length)} and ${String(activeHours)}.`,
    );
  }
  if (state === 'no-activity-local') {
    if ((await page.getByText('Stats appear after your first session.').count()) !== 1) {
      throw new Error('The no-activity Stats state did not render its empty summary.');
    }
    return;
  }
  if (state === 'one-active-hour-sync') {
    if ((await page.getByText('Prepare the release summary').count()) !== 2) {
      throw new Error('The completed one-hour session is missing a responsive representation.');
    }
    return;
  }
  const longDomain: string =
    'a-very-long-research-subdomain-for-layout-boundary-verification.example.org';
  /**
   * The count is rendered through `Intl.NumberFormat`, so its group separator belongs to whichever
   * locale the browser is running in: `1,234,567` in English, `1.234.567` in German, and a narrow
   * no-break space in French. Matching the digits with an optional separator between each group
   * keeps this assertion about the number being on the page rather than about one locale's
   * typography, which is what it was always trying to say.
   */
  const boundaryCount: RegExp = /^1[\s.,]?234[\s.,]?567$/;
  if (
    (await page.getByText(longDomain, { exact: true }).count()) < 1 ||
    (await page.getByText(boundaryCount).count()) < 1 ||
    (await page.getByText('Completed', { exact: true }).count()) < 1 ||
    (await page.getByText('Ended early', { exact: true }).count()) < 1
  ) {
    throw new Error('The Stats boundary state is missing domain, count, or session outcomes.');
  }
}

async function captureStatsVisualScopes(input: {
  buildSource: StatsVisualBuildSource;
  evidenceDir: string;
  page: Page;
  seed: StatsVisualSeedIdentity;
  state: StatsVisualStateId;
  themeCase: StatsVisualThemeCase;
  viewport: { height: number; width: number };
}): Promise<StatsVisualEvidenceRecord[]> {
  const tiles: Locator =
    (await input.page.locator('.tile-row').count()) > 0
      ? input.page.locator('.tile-row')
      : input.page.getByText('Stats appear after your first session.');
  const heatStrip: Locator = cardWithHeading(input.page, 'Attempts by hour, this machine only');
  const sessions: Locator = cardWithHeading(input.page, 'Recent sessions on this machine');
  const tables: Locator = input.page.locator('.charts');
  const targets: Readonly<Record<StatsVisualCaptureScope, Locator | Page>> = {
    charts: input.page.locator('.charts'),
    full: input.page,
    'heat-strip': heatStrip,
    sessions,
    tables,
    tiles,
  };
  const records: StatsVisualEvidenceRecord[] = [];
  for (const scope of STATS_VISUAL_CAPTURE_SCOPES) {
    const target: Locator | Page = targets[scope];
    if (scope === 'full') {
      await input.page.evaluate(async (): Promise<void> => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        window.scrollTo({ left: 0, top: 0 });
        await new Promise<void>((resolve: () => void): void => {
          requestAnimationFrame((): void => {
            requestAnimationFrame(resolve);
          });
        });
      });
    }
    if (scope === 'tables') {
      const tableAudit: { disclosureCount: number; rowCounts: number[] } =
        await input.page.evaluate((): { disclosureCount: number; rowCounts: number[] } => {
          const disclosures: HTMLDetailsElement[] = Array.from(
            document.querySelectorAll<HTMLDetailsElement>('.chart-table'),
          );
          for (const disclosure of disclosures) disclosure.open = true;
          const rowCounts: number[] = [];
          for (const disclosure of disclosures) {
            rowCounts.push(disclosure.querySelectorAll('tbody tr').length);
          }
          return { disclosureCount: disclosures.length, rowCounts };
        });
      if (
        tableAudit.disclosureCount < 1 ||
        tableAudit.rowCounts.length !== tableAudit.disclosureCount ||
        tableAudit.rowCounts.some((count: number): boolean => count < 1)
      ) {
        throw new Error(
          `Stats focused table evidence has empty tables: ${JSON.stringify(tableAudit)}.`,
        );
      }
    }
    if ('page' in target) await target.scrollIntoViewIfNeeded();
    records.push(
      await captureStatsVisualTarget({
        buildSource: input.buildSource,
        evidenceDir: input.evidenceDir,
        scope,
        seed: input.seed,
        state: input.state,
        target,
        themeCase: input.themeCase,
        viewport: input.viewport,
      }),
    );
  }
  return records;
}

export async function captureStatsVisualMatrix(input: {
  applyTheme: ApplyStatsVisualTheme;
  beforeState?: (state: StatsVisualStateId) => Promise<StatsVisualSeed>;
  buildSource: StatsVisualBuildSource;
  curatedImagePath?: string;
  diagnostics: () => StatsVisualDiagnosticCounts;
  evidenceDir: string;
  page: Page;
  statsUrl: string | ((state: StatsVisualStateId) => string);
}): Promise<StatsVisualCaptureResult> {
  const records: StatsVisualEvidenceRecord[] = [];
  const geometry: StatsVisualCaptureResult['geometry'] = [];
  for (const state of STATS_VISUAL_STATES) {
    const seed: StatsVisualSeed =
      input.beforeState === undefined
        ? buildStatsVisualSeed(state.id, STATS_VISUAL_SEED_AT)
        : await input.beforeState(state.id);
    const seedIdentity: StatsVisualSeedIdentity = statsVisualSeedIdentity(state.id, seed);
    for (const themeCase of STATS_VISUAL_THEME_CASES) {
      for (const viewport of STATS_VISUAL_VIEWPORTS) {
        await input.page.setViewportSize(viewport);
        const statsUrl: string =
          typeof input.statsUrl === 'string' ? input.statsUrl : input.statsUrl(state.id);
        await input.page.goto(statsUrl);
        await input.applyTheme(input.page, themeCase);
        await input.page.getByRole('heading', { level: 1, name: 'Your focus record' }).waitFor();
        await input.page
          .getByText(
            state.storageMode === 'sync'
              ? 'Synced totals from this Chrome account. Local-only panels are labeled.'
              : 'Totals from this machine. Focus Lock statistics are not synced.',
          )
          .waitFor();
        await assertRenderedStatsVisualState(input.page, state.id);
        const observed: StatsVisualGeometry = await statsVisualGeometry(
          input.page,
          state.hasSessions,
          input.diagnostics(),
        );
        assertStatsVisualGeometry(observed);
        geometry.push({ ...observed, state: state.id, themeCase: themeCase.id });
        if (
          input.curatedImagePath !== undefined &&
          state.id === 'all-hours-boundaries-local' &&
          themeCase.id === 'dark-light-media' &&
          viewport.width === 1280
        ) {
          await mkdir(path.dirname(path.resolve(input.curatedImagePath)), { recursive: true });
          await input.page.screenshot({
            animations: 'disabled',
            fullPage: true,
            path: path.resolve(input.curatedImagePath),
          });
        }
        records.push(
          ...(await captureStatsVisualScopes({
            buildSource: input.buildSource,
            evidenceDir: input.evidenceDir,
            page: input.page,
            seed: seedIdentity,
            state: state.id,
            themeCase,
            viewport,
          })),
        );
      }
    }
    if (seed.storageMode !== state.storageMode) {
      throw new Error(`Stats evidence seed mode differs for ${state.id}.`);
    }
  }
  assertStatsVisualInventoryCoverage(records, input.buildSource);
  return { geometry, records };
}
