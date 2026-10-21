import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CDPSession, Locator, Page, TestInfo, Worker } from '@playwright/test';
import { PNG } from 'pngjs';
import type { FrozenDocumentCommand } from '../../src/background/enforcement-persistence-v2';
import type { RuntimeStateV2 } from '../../src/background/runtime-v2-types';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../src/shared/constants';
import type { Ack } from '../../src/shared/messages';
import type { ListsConfig, OnboardingDraft, SessionConfig, Settings } from '../../src/shared/types';
import { assertNoUnexpectedBrowserDiagnostics } from './browser-diagnostics';
import {
  browserDiagnosticsFor,
  expect,
  readRuntimeV2,
  sendExtensionRequest,
  test,
} from './fixtures';
import { openPopupSection } from './popup-disclosures';
import { buildStatsVisualSeed, type StatsVisualSeed } from './stats-visual-seeds';

const REPOSITORY_ROOT: string = fileURLToPath(new URL('../../', import.meta.url));
const SCREENSHOT_DIRECTORY: string = path.join(REPOSITORY_ROOT, 'store/assets/screenshots');
const STORE_SCREENSHOT_SPEC: string = fileURLToPath(import.meta.url);
const SCREENSHOT_FILES: readonly string[] = [
  '01-start-session.png',
  '02-blocked-page.png',
  '03-onboarding.png',
  '04-stats.png',
  '05-privacy-data.png',
];

/**
 * What the tracked images claim about the build that produced them.
 *
 * It lives beside the directory rather than inside it, because the inventory asserts that
 * directory holds exactly the five images and nothing else.
 */
const SCREENSHOT_PROVENANCE_PATH: string = path.join(
  REPOSITORY_ROOT,
  'store/assets/screenshots-provenance.json',
);
const DIST_DIRECTORY: string = path.join(REPOSITORY_ROOT, 'dist');
const RECAPTURE_HINT: string =
  'Rebuild and recapture: `npm run build`, then `UPDATE_STORE_SCREENSHOTS=1 npx playwright test tests/e2e/store-screenshots.spec.ts -g "captures five truthful release states"`.';

interface ScreenshotProvenance {
  capturedAt: string;
  distSha256: string;
  version: string;
}

interface CaptureGeometry {
  deviceScaleFactor: number;
  viewport: { height: number; width: number };
}

const POPUP_CAPTURE: CaptureGeometry = {
  deviceScaleFactor: 4 / 3,
  viewport: {
    height: 600,
    width: 960,
  },
};
const PAGE_CAPTURE: CaptureGeometry = {
  deviceScaleFactor: 1.6,
  viewport: {
    height: 500,
    width: 800,
  },
};
const DETAIL_CAPTURE: CaptureGeometry = {
  deviceScaleFactor: 1,
  viewport: {
    height: 800,
    width: 1280,
  },
};
const TALL_CAPTURE: CaptureGeometry = {
  deviceScaleFactor: 20 / 17,
  viewport: {
    height: 680,
    width: 1088,
  },
};
const STATS_CAPTURE: CaptureGeometry = {
  deviceScaleFactor: 20 / 23,
  viewport: {
    height: 920,
    width: 1472,
  },
};
const STORE_IMAGE_SIZE: Readonly<{ height: number; width: number }> = {
  height: 800,
  width: 1280,
};
const STORE_INTENTION: string = 'Finish the release notes';
const STORE_TIMEZONE: string = 'Europe/Amsterdam';
const HOSTILE_TIMEZONE: string = 'Pacific/Pago_Pago';
const EXPECTED_HOST_TIMEZONE_ENV: string = 'STORE_SCREENSHOT_EXPECT_HOST_TIMEZONE';
/**
 * The instant every clock in this capture is frozen at.
 *
 * It is a morning in the store timezone, which is what makes the hostile Pago Pago run land on a
 * different calendar day whatever the offset Amsterdam is currently on, and it is always ahead of
 * the real clock, because `chrome.alarms` schedules on the real one: a session started on a frozen
 * clock that sits in the past asks the browser for an alarm that has already passed, and the read
 * back answers `alarm-failed`. It was a fixed timestamp, which meant this whole capture only ran on
 * the day it was written.
 */
const CAPTURE_HOUR: number = 9;
const CAPTURE_MINUTE: number = 45;
const CAPTURE_MARGIN_MS: number = 5 * 60_000;
// Set UPDATE_STORE_SCREENSHOTS=1 to replace tracked PNGs after every capture validates. Unset compares only.
const UPDATE_SCREENSHOTS_ENV: string = 'UPDATE_STORE_SCREENSHOTS';

// Every image here is compared byte for byte, so the browser paints without the GPU: on the
// compositor's path the same build differed from itself between runs, a few edge pixels at a time.
test.use({ extensionTimezone: STORE_TIMEZONE, extensionDeterministicPaint: true });

function parseScreenshotUpdateMode(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${UPDATE_SCREENSHOTS_ENV} must be unset or exactly 1`);
}

interface ScreenshotFileOperations {
  readdir(directory: string): Promise<string[]>;
  readFile(file: string): Promise<Buffer>;
  rename(source: string, target: string): Promise<void>;
  rm(file: string, options: { force: boolean }): Promise<void>;
  writeFile(file: string, payload: Buffer, options: { flag: 'wx' }): Promise<void>;
}

const SCREENSHOT_FILE_OPERATIONS: ScreenshotFileOperations = {
  readdir: async (directory: string): Promise<string[]> => await readdir(directory),
  readFile: async (file: string): Promise<Buffer> => await readFile(file),
  rename: async (source: string, target: string): Promise<void> => await rename(source, target),
  rm: async (file: string, options: { force: boolean }): Promise<void> => await rm(file, options),
  writeFile: async (file: string, payload: Buffer, options: { flag: 'wx' }): Promise<void> =>
    await writeFile(file, payload, options),
};

function requireExactScreenshotFilenames(entries: readonly string[], location: string): void {
  const actual: string[] = [...entries].sort();
  const expected: string[] = [...SCREENSHOT_FILES];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${location} screenshot inventory is not exact: ${JSON.stringify(actual)}`);
  }
}

/**
 * One digest over every file in the built extension, which is what identifies a build here.
 *
 * The whole tree counts, not the pages alone: what a captured page shows is decided by the worker
 * that answers it as much as by the markup that renders it. Two builds of unchanged sources digest
 * identically, so this is stable evidence rather than a timestamp.
 */
async function buildDigest(): Promise<string> {
  const files: string[] = await distFiles(DIST_DIRECTORY);
  const hash = createHash('sha256');
  for (const relative of files) {
    hash.update(relative);
    hash.update('\0');
    hash.update(await readFile(path.join(DIST_DIRECTORY, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function distFiles(directory: string, base: string = directory): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full: string = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await distFiles(full, base)));
    else found.push(path.relative(base, full));
  }
  return found.sort();
}

async function writeScreenshotProvenance(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(DIST_DIRECTORY, 'manifest.json'), 'utf8'),
  ) as { version?: unknown };
  const provenance: ScreenshotProvenance = {
    capturedAt: new Date().toISOString(),
    distSha256: await buildDigest(),
    version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
  };
  await writeFile(SCREENSHOT_PROVENANCE_PATH, `${JSON.stringify(provenance, null, 2)}\n`);
}

/**
 * Proves the tracked images came from the build that is present now.
 *
 * The inventory below proves the five files are well-formed images of the right size, which it can
 * do just as happily for images that predate the interface they claim to show. That is how this set
 * drifted behind a slice of surfaces work with nothing complaining. This is the half that can tell.
 */
async function assertScreenshotsMatchThisBuild(): Promise<void> {
  let recorded: ScreenshotProvenance;
  try {
    recorded = JSON.parse(
      await readFile(SCREENSHOT_PROVENANCE_PATH, 'utf8'),
    ) as ScreenshotProvenance;
  } catch (error: unknown) {
    throw new Error(
      `The store screenshots record no build, so nothing can say whether they show this one. ${RECAPTURE_HINT} Cause: ${String(error)}`,
    );
  }
  let current: string;
  try {
    current = await buildDigest();
  } catch (error: unknown) {
    throw new Error(
      `dist/ is unreadable, so the build the store screenshots claim cannot be checked. Run \`npm run build\` first. Cause: ${String(error)}`,
    );
  }
  if (recorded.distSha256 === current) return;
  throw new Error(
    `The store screenshots were captured from a different build than the one in dist/. They record ${recorded.distSha256.slice(0, 12)} taken at ${recorded.capturedAt}, and this build is ${current.slice(0, 12)}. A listing image of an interface the product no longer has is a false claim about the product. ${RECAPTURE_HINT}`,
  );
}

async function assertScreenshotInventory(directory: string): Promise<void> {
  const entries: string[] = (await readdir(directory)).sort();
  expect(entries).toEqual([...SCREENSHOT_FILES]);

  for (const file of SCREENSHOT_FILES) {
    const payload: Buffer = await readFile(path.join(directory, file));
    expect(payload.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const image: PNG = PNG.sync.read(payload);
    expect({ height: image.height, width: image.width }, file).toEqual({
      height: 800,
      width: 1280,
    });
    for (let alphaOffset: number = 3; alphaOffset < image.data.length; alphaOffset += 4) {
      if (image.data[alphaOffset] !== 255) {
        const pixelIndex: number = (alphaOffset - 3) / 4;
        throw new Error(
          `${file} must be fully opaque at every decoded pixel; pixel ${String(pixelIndex)} has alpha ${String(image.data[alphaOffset])}`,
        );
      }
    }
    const cornerPixelOffsets: readonly number[] = [
      3,
      (image.width - 1) * 4 + 3,
      (image.height - 1) * image.width * 4 + 3,
      (image.height * image.width - 1) * 4 + 3,
    ];
    expect(
      cornerPixelOffsets.map((offset: number): number => image.data[offset] ?? 0),
      `${file} must reach every square image corner without transparent padding`,
    ).toEqual([255, 255, 255, 255]);
  }
}

async function captureStoreScreenshot(
  page: Page,
  directory: string,
  file: string,
  geometry: CaptureGeometry,
): Promise<void> {
  const session: CDPSession = await page.context().newCDPSession(page);
  try {
    await session.send('Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: geometry.deviceScaleFactor,
      height: geometry.viewport.height,
      mobile: false,
      screenHeight: geometry.viewport.height,
      screenWidth: geometry.viewport.width,
      width: geometry.viewport.width,
    });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    // The last unpinned thing about this capture, and it moved 24,955 pixels between two runs of
    // the same build. macOS decides scrollbar width from the pointing device: a trackpad draws
    // overlay scrollbars that take no layout space, a mouse draws a gutter about 20 pixels wide,
    // and `AppleShowScrollBars` is unset here so the machine switches between them on its own. The
    // gutter narrows every panel and re-wraps every line beneath it, which reads as a redesign
    // rather than as a scrollbar. Everything else about this capture is declared, the device scale
    // factor, the viewport, the colour scheme, motion and fonts, so this is declared too. It
    // reproduces the tracked bytes rather than replacing them, which is how we know the images
    // were always right and only the host had moved.
    await page.addStyleTag({
      content: '::-webkit-scrollbar { width: 0 !important; height: 0 !important; }',
    });
    // Layout changes can move a radio beneath the last click's pointer and change native paint.
    await page.mouse.move(1, 1);
    await page.evaluate((): void => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const interactiveRadios: Locator = page.locator('input[type="radio"]:is(:hover, :focus)');
    const interactiveLabels: Locator = page.locator('label:is(:hover, :focus, :focus-within)');
    await expect(interactiveRadios).toHaveCount(0);
    await expect(interactiveLabels).toHaveCount(0);
    await page.evaluate(async (): Promise<void> => {
      await document.fonts.ready;
      await new Promise<void>((resolve: () => void): void => {
        requestAnimationFrame((): number => requestAnimationFrame(resolve));
      });
    });
    const viewport: { deviceScaleFactor: number; height: number; width: number } =
      await storeViewportMetadata(page);
    expect({ height: viewport.height, width: viewport.width }).toEqual(geometry.viewport);
    expect(viewport.deviceScaleFactor).toBeCloseTo(geometry.deviceScaleFactor, 5);
    test.info().annotations.push({
      type: 'store-capture-interaction',
      description: JSON.stringify({
        file,
        pointer: { x: 1, y: 1 },
        interactiveRadios: await interactiveRadios.count(),
        interactiveLabels: await interactiveLabels.count(),
      }),
    });
    await expect(interactiveRadios).toHaveCount(0);
    await expect(interactiveLabels).toHaveCount(0);
    const screenshot = await session.send('Page.captureScreenshot', {
      captureBeyondViewport: true,
      clip: {
        height: geometry.viewport.height,
        scale: 1,
        width: geometry.viewport.width,
        x: 0,
        y: 0,
      },
      format: 'png',
      fromSurface: true,
    });
    const payload: Buffer = Buffer.from(screenshot.data, 'base64');
    await writeFile(path.join(directory, file), payload);
    const image: PNG = PNG.sync.read(payload);
    expect({ height: image.height, width: image.width }, file).toEqual(STORE_IMAGE_SIZE);
  } finally {
    await session.detach();
  }
}

async function setCaptureTimezone(page: Page): Promise<CDPSession> {
  const session: CDPSession = await page.context().newCDPSession(page);
  await session.send('Emulation.setTimezoneOverride', { timezoneId: STORE_TIMEZONE });
  const timezone: string = await page.evaluate(
    (): string => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  expect(timezone).toBe(STORE_TIMEZONE);
  return session;
}

async function assertWorkerTimezone(worker: Worker): Promise<void> {
  expect(
    await worker.evaluate((): string => Intl.DateTimeFormat().resolvedOptions().timeZone),
  ).toBe(STORE_TIMEZONE);
}

interface ScreenshotCapturePayload {
  file: string;
  original: Buffer;
  payload: Buffer;
}

interface StagedScreenshot {
  rollback: string;
  target: string;
  temporary: string;
}

async function loadScreenshotPublication(
  captureDirectory: string,
  canonicalDirectory: string,
  operations: ScreenshotFileOperations,
): Promise<readonly ScreenshotCapturePayload[]> {
  const [captureEntries, canonicalEntries]: [string[], string[]] = await Promise.all([
    operations.readdir(captureDirectory),
    operations.readdir(canonicalDirectory),
  ]);
  requireExactScreenshotFilenames(captureEntries, 'captured');
  requireExactScreenshotFilenames(canonicalEntries, 'canonical');
  return await Promise.all(
    SCREENSHOT_FILES.map(
      async (file: string): Promise<ScreenshotCapturePayload> => ({
        file,
        original: await operations.readFile(path.join(canonicalDirectory, file)),
        payload: await operations.readFile(path.join(captureDirectory, file)),
      }),
    ),
  );
}

function screenshotStagingPaths(
  captures: readonly ScreenshotCapturePayload[],
  canonicalDirectory: string,
): readonly StagedScreenshot[] {
  return captures.map(
    ({ file }): StagedScreenshot => ({
      rollback: path.join(canonicalDirectory, `.${file}.${randomUUID()}.rollback`),
      target: path.join(canonicalDirectory, file),
      temporary: path.join(canonicalDirectory, `.${file}.${randomUUID()}.tmp`),
    }),
  );
}

async function removeScreenshotStaging(
  staged: readonly StagedScreenshot[],
  operations: ScreenshotFileOperations,
): Promise<void> {
  await Promise.all(
    staged.flatMap(({ rollback, temporary }): Promise<void>[] => [
      operations.rm(temporary, { force: true }),
      operations.rm(rollback, { force: true }),
    ]),
  );
}

async function stageAndValidateScreenshots(
  captures: readonly ScreenshotCapturePayload[],
  staged: readonly StagedScreenshot[],
  operations: ScreenshotFileOperations,
): Promise<void> {
  for (let index: number = 0; index < staged.length; index += 1) {
    const capture = captures[index];
    const stage = staged[index];
    if (capture === undefined || stage === undefined) {
      throw new Error('store screenshot staging indexes diverged');
    }
    await operations.writeFile(stage.temporary, capture.payload, { flag: 'wx' });
    await operations.writeFile(stage.rollback, capture.original, { flag: 'wx' });
  }
  for (let index: number = 0; index < staged.length; index += 1) {
    const capture = captures[index];
    const stage = staged[index];
    if (capture === undefined || stage === undefined) {
      throw new Error('store screenshot validation indexes diverged');
    }
    const [stagedPayload, stagedOriginal]: [Buffer, Buffer] = await Promise.all([
      operations.readFile(stage.temporary),
      operations.readFile(stage.rollback),
    ]);
    if (!stagedPayload.equals(capture.payload) || !stagedOriginal.equals(capture.original)) {
      throw new Error(`${capture.file} staging byte validation failed`);
    }
  }
}

async function restoreScreenshotPublication(
  staged: readonly StagedScreenshot[],
  operations: ScreenshotFileOperations,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const { rollback, target } of staged) {
    try {
      await operations.rename(rollback, target);
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  return errors;
}

// Handled filesystem errors trigger full-set rollback. Five renames cannot be process-kill atomic.
async function publishCapturedScreenshots(
  captureDirectory: string,
  canonicalDirectory: string,
  updateCanonical: boolean,
  operations: ScreenshotFileOperations = SCREENSHOT_FILE_OPERATIONS,
): Promise<void> {
  if (!updateCanonical) {
    for (const file of SCREENSHOT_FILES) {
      const [capture, canonical]: [Buffer, Buffer] = await Promise.all([
        operations.readFile(path.join(captureDirectory, file)),
        operations.readFile(path.join(canonicalDirectory, file)),
      ]);
      if (!capture.equals(canonical)) {
        throw new Error(`${file} differs from the tracked canonical PNG`);
      }
    }
    return;
  }

  const captures: readonly ScreenshotCapturePayload[] = await loadScreenshotPublication(
    captureDirectory,
    canonicalDirectory,
    operations,
  );
  const staged: readonly StagedScreenshot[] = screenshotStagingPaths(captures, canonicalDirectory);
  try {
    await stageAndValidateScreenshots(captures, staged, operations);
  } catch (stagingError: unknown) {
    await removeScreenshotStaging(staged, operations);
    throw stagingError;
  }
  try {
    for (const { target, temporary } of staged) await operations.rename(temporary, target);
  } catch (publicationError: unknown) {
    const rollbackErrors: unknown[] = await restoreScreenshotPublication(staged, operations);
    if (rollbackErrors.length === 0) {
      await removeScreenshotStaging(staged, operations);
      throw publicationError;
    }
    throw new AggregateError(
      [publicationError, ...rollbackErrors],
      'store screenshot publication failed and runtime rollback was incomplete',
    );
  }
  await removeScreenshotStaging(staged, operations);
}

async function runHostileTimezoneCapture(outputDirectory: string): Promise<string> {
  const executable: string = path.join(REPOSITORY_ROOT, 'node_modules/.bin/playwright');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    [EXPECTED_HOST_TIMEZONE_ENV]: HOSTILE_TIMEZONE,
    TZ: HOSTILE_TIMEZONE,
  };
  delete environment[UPDATE_SCREENSHOTS_ENV];
  const args: readonly string[] = [
    'test',
    `--config=${path.join(REPOSITORY_ROOT, 'playwright.config.ts')}`,
    STORE_SCREENSHOT_SPEC,
    '--grep=captures five truthful release states',
    `--output=${outputDirectory}`,
    '--reporter=line',
    '--workers=1',
  ];
  return await new Promise<string>((resolve, reject): void => {
    const child: ChildProcessWithoutNullStreams = spawn(executable, args, {
      cwd: REPOSITORY_ROOT,
      env: environment,
    });
    let output: string = '';
    child.stdout.on('data', (chunk: Buffer): void => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer): void => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code: number | null): void => {
      if (code === 0) resolve(output);
      else reject(new Error(`${HOSTILE_TIMEZONE} capture exited ${String(code)}\n${output}`));
    });
  });
}

async function freezeIsolatedPageWorlds(
  session: CDPSession,
  isolatedContextIds: ReadonlySet<number>,
): Promise<void> {
  await Promise.all(
    [...isolatedContextIds].map(async (contextId: number): Promise<void> => {
      await session.send('Runtime.evaluate', {
        contextId,
        expression: `Date.now = () => ${String(captureInstant())}`,
      });
    }),
  );
}

async function blurIsolatedPageWorlds(
  session: CDPSession,
  isolatedContextIds: ReadonlySet<number>,
): Promise<void> {
  await Promise.all(
    [...isolatedContextIds].map(async (contextId: number): Promise<void> => {
      await session.send('Runtime.evaluate', {
        contextId,
        expression: 'document.activeElement?.blur()',
      });
    }),
  );
}

async function storeViewportMetadata(page: Page): Promise<{
  deviceScaleFactor: number;
  height: number;
  width: number;
}> {
  return await page.evaluate((): { deviceScaleFactor: number; height: number; width: number } => ({
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio,
    width: window.innerWidth,
  }));
}

function storeLists(): ListsConfig {
  return {
    ...structuredClone(DEFAULT_LISTS),
    categories: {
      ...DEFAULT_LISTS.categories,
      social: true,
    },
    custom: [
      { kind: 'host', pattern: 'blocked.example' },
      { kind: 'regex', pattern: '(^|\\.)research\\.example\\.org$' },
    ],
  };
}

function storeSettings(): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    cyclingOnByDefault: false,
    defaultMode: 'blacklist',
    defaultStrictness: 'friction',
    theme: 'light',
  };
}

async function requireAck(ack: Ack, operation: string): Promise<void> {
  if (!ack.ok) throw new Error(`${operation}: ${ack.error}`);
}

async function freezeWorkerClock(worker: Worker): Promise<void> {
  const frozenAt: number = captureInstant();
  const clock = await worker.evaluate((at: number): { beforeFreeze: number; now: number } => {
    const beforeFreeze: number = Date.now();
    Date.now = (): number => at;
    return { beforeFreeze, now: Date.now() };
  }, frozenAt);
  expect(clock).toEqual({ beforeFreeze: expect.any(Number), now: frozenAt });
}

async function installPageClock(page: Page): Promise<void> {
  await page.addInitScript((at: number): void => {
    Date.now = (): number => at;
  }, captureInstant());
}

async function settleSync(controlPage: Page): Promise<void> {
  await expect
    .poll(async (): Promise<string> => {
      const setup = await sendExtensionRequest(controlPage, { type: 'getSetupState' });
      if (setup.syncWriteStatus !== 'pending') return setup.syncWriteStatus;
      const retried = await sendExtensionRequest(controlPage, { type: 'retrySync' });
      if (!retried.ok) throw new Error(`could not settle Chrome Sync: ${retried.error}`);
      return (await sendExtensionRequest(controlPage, { type: 'getSetupState' })).syncWriteStatus;
    })
    .toBe('idle');
}

interface ZonedDateTimeParts {
  day: number;
  hour: number;
  minute: number;
  month: number;
  year: number;
}

function zonedDateTimeParts(at: number, timezone: string): ZonedDateTimeParts {
  const values: Partial<ZonedDateTimeParts> = {};
  const formatter: Intl.DateTimeFormat = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  });
  for (const part of formatter.formatToParts(at)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      values[part.type] = Number(part.value);
    }
    if (part.type === 'hour' || part.type === 'minute') values[part.type] = Number(part.value);
  }
  if (
    values.year === undefined ||
    values.month === undefined ||
    values.day === undefined ||
    values.hour === undefined ||
    values.minute === undefined
  ) {
    throw new Error(`could not derive date parts in ${timezone}`);
  }
  return values as ZonedDateTimeParts;
}

function zonedDateKey(at: number, timezone: string): string {
  const parts: ZonedDateTimeParts = zonedDateTimeParts(at, timezone);
  return `${String(parts.year)}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function zonedTimestamp(dateKey: string, hour: number, minute: number, timezone: string): number {
  const [yearText, monthText, dayText]: string[] = dateKey.split('-');
  const year: number = Number(yearText);
  const month: number = Number(monthText);
  const day: number = Number(dayText);
  const expected: ZonedDateTimeParts = { day, hour, minute, month, year };
  const expectedAsUtc: number = Date.UTC(year, month - 1, day, hour, minute);
  let candidate: number = expectedAsUtc;
  for (let attempt: number = 0; attempt < 4; attempt += 1) {
    const actual: ZonedDateTimeParts = zonedDateTimeParts(candidate, timezone);
    const actualAsUtc: number = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    candidate += expectedAsUtc - actualAsUtc;
  }
  expect(zonedDateTimeParts(candidate, timezone)).toEqual(expected);
  return candidate;
}

/** The wall clock the overlay prints for an instant, in the timezone every capture runs in. */
function zonedClockLabel(at: number, timezone: string): string {
  const parts: ZonedDateTimeParts = zonedDateTimeParts(at, timezone);
  return `${String(parts.hour)}:${String(parts.minute).padStart(2, '0')}`;
}

let frozenCaptureAt: number | null = null;

/** The frozen instant, computed once per process and shared by the worker, the pages and the seed. */
function captureInstant(): number {
  frozenCaptureAt ??= nextCaptureInstant(Date.now());
  return frozenCaptureAt;
}

/** The next store-timezone morning that is still ahead of the real clock. */
function nextCaptureInstant(realNow: number): number {
  const todayKey: string = zonedDateKey(realNow, STORE_TIMEZONE);
  const today: number = zonedTimestamp(todayKey, CAPTURE_HOUR, CAPTURE_MINUTE, STORE_TIMEZONE);
  if (today >= realNow + CAPTURE_MARGIN_MS) return today;
  const tomorrowKey: string = zonedDateKey(today + 36 * 3_600_000, STORE_TIMEZONE);
  return zonedTimestamp(tomorrowKey, CAPTURE_HOUR, CAPTURE_MINUTE, STORE_TIMEZONE);
}

async function seedStoreStats(controlPage: Page, worker: Worker): Promise<void> {
  // A completed sync setup reports `pending` while the boot republishes it, measured at about ten
  // seconds, so reading the status once is a check racing the thing it checks. It wins that race
  // when this spec runs alone and loses it behind a full suite. This file already owns the wait.
  await settleSync(controlPage);
  const setup = await sendExtensionRequest(controlPage, { type: 'getSetupState' });
  expect(setup).toMatchObject({
    completed: true,
    storageMode: 'sync',
    syncWriteStatus: 'idle',
  });
  const seed: StatsVisualSeed = buildStatsVisualSeed('one-active-hour-sync', captureInstant());
  const currentDateKey: string = zonedDateKey(captureInstant(), STORE_TIMEZONE);
  const seededDay = seed.bundle.days[0];
  if (seededDay === undefined) throw new Error('store Stats seed is missing its active day');
  seededDay.date = currentDateKey;
  seededDay.focusMs = 20 * 60_000;
  seededDay.pauseMsEarned = 3 * 60_000;
  seed.bundle.streak = {
    ...seed.bundle.streak,
    activeDays: [],
    activeMonth: currentDateKey.slice(0, 7),
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
  };
  for (const event of seed.events) {
    if (event.t === 'sessionStarted') {
      event.at = zonedTimestamp(currentDateKey, 8, 30, STORE_TIMEZONE);
      if ('durationMin' in event) event.durationMin = 20;
    }
    if (event.t === 'attempt') {
      event.at = zonedTimestamp(currentDateKey, 9, 10, STORE_TIMEZONE);
    }
    if (event.t === 'sessionCompleted') {
      event.at = zonedTimestamp(currentDateKey, 9, 30, STORE_TIMEZONE);
      event.focusedMs = 20 * 60_000;
    }
  }
  seed.bundle.recentSessions = [...seed.events].reverse();
  seed.bundle.totals = {
    attemptsToday: 1,
    focusMsLast7Days: seededDay.focusMs,
    focusMsToday: seededDay.focusMs,
    resistedToday: seededDay.resisted,
  };
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
      payload.bundle.days.map((day): [string, unknown] => [`agg:store-task4:${day.date}`, day]),
    );
    aggregates.streak = payload.bundle.streak;
    await chrome.storage.sync.set(aggregates);
  }, seed);
}

/**
 * The seeded day is the frozen instant's day, so it is only "today" once the worker's clock is
 * frozen there. Read against the live clock this passed on the day the seed was written and has
 * been reading zero for today's totals ever since, while the seven-day total, which does not care
 * which day it is, kept matching.
 */
async function expectStoreStatsSeeded(controlPage: Page): Promise<void> {
  const stats = await sendExtensionRequest(controlPage, { type: 'getStats', days: 14 });
  expect(stats).toMatchObject({
    totals: {
      attemptsToday: 1,
      focusMsLast7Days: 20 * 60_000,
      focusMsToday: 20 * 60_000,
    },
  });
}

test('default screenshot publication compares complete bytes without changing canonical files', async ({
  browserName: _browserName,
}, testInfo: TestInfo): Promise<void> => {
  const captureDirectory: string = testInfo.outputPath('captured');
  const canonicalDirectory: string = testInfo.outputPath('canonical');
  await Promise.all([mkdir(captureDirectory, { recursive: true }), mkdir(canonicalDirectory)]);
  await Promise.all(
    SCREENSHOT_FILES.flatMap((file: string): Promise<void>[] => {
      const payload: Buffer = Buffer.from(`canonical:${file}`);
      return [
        writeFile(path.join(captureDirectory, file), payload),
        writeFile(path.join(canonicalDirectory, file), payload),
      ];
    }),
  );
  const before: Buffer[] = await Promise.all(
    SCREENSHOT_FILES.map(
      (file: string): Promise<Buffer> => readFile(path.join(canonicalDirectory, file)),
    ),
  );

  await publishCapturedScreenshots(captureDirectory, canonicalDirectory, false);

  const after: Buffer[] = await Promise.all(
    SCREENSHOT_FILES.map(
      (file: string): Promise<Buffer> => readFile(path.join(canonicalDirectory, file)),
    ),
  );
  expect(after).toEqual(before);
  await writeFile(path.join(captureDirectory, SCREENSHOT_FILES[0] as string), 'drift');
  await expect(
    publishCapturedScreenshots(captureDirectory, canonicalDirectory, false),
  ).rejects.toThrow('differs from the tracked canonical PNG');
  expect(await readFile(path.join(canonicalDirectory, SCREENSHOT_FILES[0] as string))).toEqual(
    before[0],
  );
});

test('explicit update publication replaces a safe canonical fixture after staging', async ({
  browserName: _browserName,
}, testInfo: TestInfo): Promise<void> => {
  const captureDirectory: string = testInfo.outputPath('captured');
  const canonicalDirectory: string = testInfo.outputPath('canonical');
  await Promise.all([
    mkdir(captureDirectory, { recursive: true }),
    mkdir(canonicalDirectory, { recursive: true }),
  ]);
  await Promise.all(
    SCREENSHOT_FILES.flatMap((file: string): Promise<void>[] => [
      writeFile(path.join(captureDirectory, file), `updated:${file}`),
      writeFile(path.join(canonicalDirectory, file), `old:${file}`),
    ]),
  );

  await publishCapturedScreenshots(captureDirectory, canonicalDirectory, true);

  expect((await readdir(canonicalDirectory)).sort()).toEqual([...SCREENSHOT_FILES]);
  await Promise.all(
    SCREENSHOT_FILES.map(async (file: string): Promise<void> => {
      expect(await readFile(path.join(canonicalDirectory, file), 'utf8')).toBe(`updated:${file}`);
    }),
  );
});

test('update publication restores the complete canonical set after a later replacement fails', async ({
  browserName: _browserName,
}, testInfo: TestInfo): Promise<void> => {
  const captureDirectory: string = testInfo.outputPath('captured');
  const canonicalDirectory: string = testInfo.outputPath('canonical');
  await Promise.all([
    mkdir(captureDirectory, { recursive: true }),
    mkdir(canonicalDirectory, { recursive: true }),
  ]);
  await Promise.all(
    SCREENSHOT_FILES.flatMap((file: string): Promise<void>[] => [
      writeFile(path.join(captureDirectory, file), `updated:${file}`),
      writeFile(path.join(canonicalDirectory, file), `old:${file}`),
    ]),
  );
  let replacementCount: number = 0;
  const failingOperations: ScreenshotFileOperations = {
    ...SCREENSHOT_FILE_OPERATIONS,
    rename: async (source: string, target: string): Promise<void> => {
      if (source.endsWith('.tmp') && SCREENSHOT_FILES.includes(path.basename(target))) {
        replacementCount += 1;
        if (replacementCount === 4) throw new Error('deliberate fourth replacement failure');
      }
      await rename(source, target);
    },
  };

  await expect(
    publishCapturedScreenshots(captureDirectory, canonicalDirectory, true, failingOperations),
  ).rejects.toThrow('deliberate fourth replacement failure');

  expect((await readdir(canonicalDirectory)).sort()).toEqual([...SCREENSHOT_FILES]);
  await Promise.all(
    SCREENSHOT_FILES.map(async (file: string): Promise<void> => {
      expect(await readFile(path.join(canonicalDirectory, file), 'utf8')).toBe(`old:${file}`);
    }),
  );
});

test('update staging leaves the canonical set untouched after a later write fails', async ({
  browserName: _browserName,
}, testInfo: TestInfo): Promise<void> => {
  const captureDirectory: string = testInfo.outputPath('captured');
  const canonicalDirectory: string = testInfo.outputPath('canonical');
  await Promise.all([
    mkdir(captureDirectory, { recursive: true }),
    mkdir(canonicalDirectory, { recursive: true }),
  ]);
  await Promise.all(
    SCREENSHOT_FILES.flatMap((file: string): Promise<void>[] => [
      writeFile(path.join(captureDirectory, file), `updated:${file}`),
      writeFile(path.join(canonicalDirectory, file), `old:${file}`),
    ]),
  );
  let stagingWriteCount: number = 0;
  const failingOperations: ScreenshotFileOperations = {
    ...SCREENSHOT_FILE_OPERATIONS,
    writeFile: async (file: string, payload: Buffer, options: { flag: 'wx' }): Promise<void> => {
      stagingWriteCount += 1;
      if (stagingWriteCount === 7) throw new Error('deliberate seventh staging write failure');
      await SCREENSHOT_FILE_OPERATIONS.writeFile(file, payload, options);
    },
  };

  await expect(
    publishCapturedScreenshots(captureDirectory, canonicalDirectory, true, failingOperations),
  ).rejects.toThrow('deliberate seventh staging write failure');

  expect((await readdir(canonicalDirectory)).sort()).toEqual([...SCREENSHOT_FILES]);
  await Promise.all(
    SCREENSHOT_FILES.map(async (file: string): Promise<void> => {
      expect(await readFile(path.join(canonicalDirectory, file), 'utf8')).toBe(`old:${file}`);
    }),
  );
});

test('screenshot update mode rejects every value except the documented 1', (): void => {
  expect(parseScreenshotUpdateMode(undefined)).toBe(false);
  expect(parseScreenshotUpdateMode('1')).toBe(true);
  for (const invalid of ['', '0', 'true', 'yes']) {
    expect((): boolean => parseScreenshotUpdateMode(invalid)).toThrow(
      `${UPDATE_SCREENSHOTS_ENV} must be unset or exactly 1`,
    );
  }
});

test('screenshot integrity rejects a transparent interior pixel', async ({
  browserName: _browserName,
}, testInfo: TestInfo): Promise<void> => {
  const fixtureDirectory: string = testInfo.outputPath('transparent-fixture');
  await mkdir(fixtureDirectory, { recursive: true });
  await Promise.all(
    SCREENSHOT_FILES.map(async (file: string): Promise<void> => {
      await writeFile(
        path.join(fixtureDirectory, file),
        await readFile(path.join(SCREENSHOT_DIRECTORY, file)),
      );
    }),
  );
  const target: string = path.join(fixtureDirectory, SCREENSHOT_FILES[0] as string);
  const image: PNG = PNG.sync.read(await readFile(target));
  const centerAlphaOffset: number =
    (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4 + 3;
  image.data[centerAlphaOffset] = 0;
  await writeFile(target, PNG.sync.write(image));

  await expect(assertScreenshotInventory(fixtureDirectory)).rejects.toThrow(
    'must be fully opaque at every decoded pixel',
  );
});

test('hostile Pago Pago host timezone reproduces every Amsterdam canonical byte', async ({
  browserName: _browserName,
}, testInfo: TestInfo): Promise<void> => {
  expect(zonedDateKey(captureInstant(), HOSTILE_TIMEZONE)).not.toBe(
    zonedDateKey(captureInstant(), STORE_TIMEZONE),
  );
  const before: Buffer[] = await Promise.all(
    SCREENSHOT_FILES.map(
      (file: string): Promise<Buffer> => readFile(path.join(SCREENSHOT_DIRECTORY, file)),
    ),
  );

  const output: string = await runHostileTimezoneCapture(testInfo.outputPath('pago-pago-child'));

  expect(output).toContain('1 passed');
  const after: Buffer[] = await Promise.all(
    SCREENSHOT_FILES.map(
      (file: string): Promise<Buffer> => readFile(path.join(SCREENSHOT_DIRECTORY, file)),
    ),
  );
  expect(after).toEqual(before);
});

test('store screenshot inventory is exact, intact, opaque, 1280 by 800, and from this build', async (): Promise<void> => {
  await assertScreenshotInventory(SCREENSHOT_DIRECTORY);
  await assertScreenshotsMatchThisBuild();
});

test('captures five truthful release states with category membership in the popup and permission copy in onboarding', async ({
  context,
  extPage,
  extensionId,
  freshInstallExtension,
  restartableExtension,
  siteUrl,
  worker,
}): Promise<void> => {
  const expectedHostTimezone: string | undefined = process.env[EXPECTED_HOST_TIMEZONE_ENV];
  if (expectedHostTimezone !== undefined) {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(expectedHostTimezone);
  }
  await assertWorkerTimezone(worker);
  const updateCanonical: boolean = parseScreenshotUpdateMode(process.env[UPDATE_SCREENSHOTS_ENV]);
  const captureDirectory: string = test.info().outputPath('captured-store-screenshots');
  test.info().annotations.push({
    type: 'capture-geometry',
    description:
      'Popup uses 960x600 CSS at DPR 4/3. Block uses 1280x800 CSS at DPR 1. Onboarding uses 800x500 CSS at DPR 1.6. Privacy uses 1088x680 CSS at DPR 20/17. Stats uses 1472x920 CSS at DPR 20/23. Every PNG is 1280x800.',
  });
  await mkdir(captureDirectory, { recursive: true });
  await assertScreenshotInventory(SCREENSHOT_DIRECTORY);
  await settleSync(extPage);
  const lists: ListsConfig = storeLists();
  const settings: Settings = storeSettings();
  await requireAck(
    await sendExtensionRequest(extPage, { type: 'updateSettings', settings }),
    'could not seed store screenshot settings',
  );
  await requireAck(
    await sendExtensionRequest(extPage, { type: 'updateLists', lists }),
    'could not seed store screenshot lists',
  );
  await settleSync(extPage);
  await seedStoreStats(extPage, worker);
  await settleSync(extPage);
  await freezeWorkerClock(worker);
  await expectStoreStatsSeeded(extPage);

  await test.step('01 uses the 25-minute Friction draft to show effective category membership', async (): Promise<void> => {
    const timezoneSession: CDPSession = await setCaptureTimezone(extPage);
    await extPage.setViewportSize(POPUP_CAPTURE.viewport);
    await installPageClock(extPage);
    await extPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await extPage.getByLabel('Intention').fill(STORE_INTENTION);
    await openPopupSection(extPage, 'Session settings');
    await expect(extPage.getByRole('button', { name: 'Friction' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(extPage.getByRole('button', { name: 'Start 25 min focus' })).toBeVisible();
    await expect(extPage.getByText('1 of 7 categories selected')).toBeVisible();
    await expect(extPage.getByText('2 extra blocked rules')).toBeVisible();
    await expect(extPage.getByRole('button', { name: 'Social media' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(extPage.getByRole('list', { name: 'Social media sites' })).toContainText(
      'instagram.com',
    );
    const frictionButton = extPage.getByRole('button', { name: 'Friction' });
    await frictionButton.click();
    await expect(
      extPage.locator('.help-popover__body', {
        hasText: 'Ending early requires a 10-second wait. No typing is required.',
      }),
    ).toBeVisible();
    await frictionButton.press('Escape');
    const popupGeometry = await extPage.evaluate(
      (): {
        clientHeight: number;
        frictionOffsetTop: number;
        ruleSummaryOffsetTop: number;
        scrollTop: number;
        scrollHeight: number;
      } => {
        const scroll: HTMLElement | null = document.querySelector('.start-form__scroll');
        const summary: HTMLElement | null = document.querySelector('.rule-summary');
        const friction: HTMLElement | null = document.querySelector('.session-type-control');
        const mode: HTMLElement | null = document.querySelector('.mode-control');
        if (scroll === null || summary === null || friction === null || mode === null) {
          throw new Error('popup store geometry is unavailable');
        }
        scroll.scrollTop +=
          mode.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
        const rules: HTMLElement | null = document.querySelector('.rule-summary__scroll');
        if (rules !== null) rules.scrollTop = 30;
        return {
          clientHeight: scroll.clientHeight,
          frictionOffsetTop: friction.offsetTop,
          ruleSummaryOffsetTop: summary.offsetTop,
          scrollTop: scroll.scrollTop,
          scrollHeight: scroll.scrollHeight,
        };
      },
    );
    expect(popupGeometry.scrollHeight).toBeGreaterThan(popupGeometry.clientHeight);
    await test.info().attach('01-popup-geometry.json', {
      body: Buffer.from(JSON.stringify(popupGeometry, null, 2)),
      contentType: 'application/json',
    });
    await captureStoreScreenshot(
      extPage,
      captureDirectory,
      SCREENSHOT_FILES[0] as string,
      POPUP_CAPTURE,
    );
    await timezoneSession.detach();
  });

  await test.step('02 starts the seeded draft and captures a real existing-page block verdict', async (): Promise<void> => {
    const blockedLaunch = await restartableExtension.launch();
    await assertWorkerTimezone(blockedLaunch.worker);
    await freezeWorkerClock(blockedLaunch.worker);
    await requireAck(
      await sendExtensionRequest(blockedLaunch.extPage, { type: 'updateSettings', settings }),
      'could not seed blocked-page settings',
    );
    await requireAck(
      await sendExtensionRequest(blockedLaunch.extPage, { type: 'updateLists', lists }),
      'could not seed blocked-page lists',
    );
    const config: SessionConfig = {
      cycling: null,
      duration: { kind: 'timed', minutes: 25 },
      intention: STORE_INTENTION,
      mode: 'blacklist',
      rules: rulesFromLists(lists),
      scheduleOccurrence: null,
      source: 'manual',
      strictness: 'friction',
    };
    const blockedPage: Page = await blockedLaunch.context.newPage();
    const blockedTimezoneSession: CDPSession = await setCaptureTimezone(blockedPage);
    await blockedPage.setViewportSize(DETAIL_CAPTURE.viewport);
    const accessibilitySession = await blockedLaunch.context.newCDPSession(blockedPage);
    const isolatedContextIds: Set<number> = new Set<number>();
    accessibilitySession.on('Runtime.executionContextCreated', (payload): void => {
      if (payload.context.auxData?.type === 'isolated') {
        isolatedContextIds.add(payload.context.id);
      }
    });
    accessibilitySession.on('Runtime.executionContextDestroyed', (payload): void => {
      isolatedContextIds.delete(payload.executionContextId);
    });
    accessibilitySession.on('Runtime.executionContextsCleared', (): void => {
      isolatedContextIds.clear();
    });
    await accessibilitySession.send('Runtime.enable');
    await installPageClock(blockedPage);
    await blockedPage.goto(siteUrl('/plain.html'));
    await freezeIsolatedPageWorlds(accessibilitySession, isolatedContextIds);
    await requireAck(
      await sendExtensionRequest(blockedLaunch.extPage, { type: 'startSession', config }),
      'could not start the store screenshot session',
    );
    const snapshot = await sendExtensionRequest(blockedLaunch.extPage, { type: 'getSnapshot' });
    expect(snapshot).toMatchObject({
      config: {
        duration: { kind: 'timed', minutes: 25 },
        intention: STORE_INTENTION,
        mode: 'blacklist',
        strictness: 'friction',
      },
      phase: 'focus',
      phaseEndsAt: captureInstant() + 25 * 60_000,
      sessionEndsAt: captureInstant() + 25 * 60_000,
      startedAt: captureInstant(),
    });
    await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
    // The verdict is read from the command the worker froze for that document rather than by
    // asking for another page's block state: the worker derives the target from the sender now, so
    // a pull from the extension page is answered with nothing at all, by design.
    const blockedRuntime: RuntimeStateV2 = await readRuntimeV2(blockedLaunch.worker);
    const applied: FrozenDocumentCommand | undefined = Object.values(
      blockedRuntime.documentCommands,
    ).find(
      (command: FrozenDocumentCommand): boolean => command.expectedUrl === siteUrl('/plain.html'),
    );
    expect(applied?.verdict).toEqual({
      blocked: true,
      categoryId: null,
      matchedPattern: 'blocked.example',
      reason: 'custom',
    });
    expect(applied?.presentation).toBe('active');
    try {
      await accessibilitySession.send('Accessibility.enable');
      await expect
        .poll(async (): Promise<string[]> => {
          const tree = await accessibilitySession.send('Accessibility.getFullAXTree');
          return tree.nodes
            .map((node): string => String(node.name?.value ?? ''))
            .filter((name: string): boolean => name !== '');
        })
        .toEqual(
          expect.arrayContaining([
            `Locked until ${zonedClockLabel(captureInstant() + 25 * 60_000, STORE_TIMEZONE)}`,
            '25 min left in this session',
            'Your next step',
            STORE_INTENTION,
            'Blocked by your block list: blocked.example',
          ]),
        );
      await blurIsolatedPageWorlds(accessibilitySession, isolatedContextIds);
    } finally {
      await accessibilitySession.detach();
    }
    await captureStoreScreenshot(
      blockedPage,
      captureDirectory,
      SCREENSHOT_FILES[1] as string,
      DETAIL_CAPTURE,
    );
    await blockedTimezoneSession.detach();
    await blockedPage.close();
    await restartableExtension.close();
  });

  await test.step('03 captures the real onboarding permission step while retaining the seeded category choice', async (): Promise<void> => {
    const launch = await freshInstallExtension.launch();
    await assertWorkerTimezone(launch.worker);
    const onboardingTimezoneSession: CDPSession = await setCaptureTimezone(launch.onboardingPage);
    await launch.onboardingPage.setViewportSize(PAGE_CAPTURE.viewport);
    await installPageClock(launch.onboardingPage);
    const loaded = await sendExtensionRequest(launch.extPage, { type: 'getOnboardingDraft' });
    if (!loaded.ok || loaded.draft === null) {
      throw new Error(`could not load onboarding draft: ${JSON.stringify(loaded)}`);
    }
    const draft: OnboardingDraft = {
      ...loaded.draft,
      step: 2,
      lists: {
        ...loaded.draft.lists,
        categories: { ...loaded.draft.lists.categories, social: true },
      },
      websiteAccessChoice: 'pending',
    };
    const saved = await sendExtensionRequest(launch.extPage, {
      type: 'saveOnboardingDraft',
      draft,
    });
    if (!saved.ok) throw new Error(`could not seed onboarding draft: ${saved.error}`);
    expect(saved.draft).toMatchObject({
      step: 2,
      lists: { categories: { social: true } },
      websiteAccessChoice: 'pending',
    });
    await launch.onboardingPage.reload();
    await expect(
      launch.onboardingPage.getByRole('heading', { name: 'Enable website blocking' }),
    ).toBeVisible();
    await expect(
      launch.onboardingPage.getByText(
        'Focus Lock checks page addresses locally so it can match your selected categories and sites.',
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      launch.onboardingPage.getByText('Read and change all your data on all websites'),
    ).toBeVisible();
    await captureStoreScreenshot(
      launch.onboardingPage,
      captureDirectory,
      SCREENSHOT_FILES[2] as string,
      PAGE_CAPTURE,
    );
    await onboardingTimezoneSession.detach();
  });

  await test.step('04 captures representative synchronized totals with explicit machine-only panels', async (): Promise<void> => {
    const statsPage: Page = await context.newPage();
    const statsTimezoneSession: CDPSession = await setCaptureTimezone(statsPage);
    await installPageClock(statsPage);
    await statsPage.setViewportSize(STATS_CAPTURE.viewport);
    await statsPage.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);
    await expect(
      statsPage.getByRole('heading', { level: 1, name: 'Your focus record' }),
    ).toBeVisible();
    await expect(
      statsPage.getByText('Synced totals from this Chrome account. Local-only panels are labeled.'),
    ).toBeVisible();
    await expect(
      statsPage.locator('.tile', { hasText: 'Focus today' }).locator('.tile-value'),
    ).toHaveText('20 m');
    await expect(
      statsPage.getByRole('heading', { name: 'Attempts by hour, this machine only' }),
    ).toHaveCount(1);
    await expect(
      statsPage.getByRole('heading', { name: 'Recent sessions on this machine' }),
    ).toHaveCount(1);
    await expect(statsPage.getByText('Prepare the release summary')).toHaveCount(2);
    await statsPage.evaluate((): void => window.scrollTo(0, 24));
    await captureStoreScreenshot(
      statsPage,
      captureDirectory,
      SCREENSHOT_FILES[3] as string,
      STATS_CAPTURE,
    );
    await statsTimezoneSession.detach();
    await statsPage.close();
  });

  await test.step('05 captures Privacy and data with Sync enabled and exact data scopes', async (): Promise<void> => {
    await expect
      .poll(
        async (): Promise<string> =>
          (await sendExtensionRequest(extPage, { type: 'getSetupState' })).syncWriteStatus,
      )
      .toBe('idle');
    const optionsPage: Page = await context.newPage();
    const optionsTimezoneSession: CDPSession = await setCaptureTimezone(optionsPage);
    await optionsPage.setViewportSize(TALL_CAPTURE.viewport);
    await installPageClock(optionsPage);
    await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html#privacy`);
    await expect(
      optionsPage.getByRole('heading', { level: 2, name: 'Privacy and data' }),
    ).toBeVisible();
    await expect(
      optionsPage.getByRole('switch', { name: 'Sync Focus Lock data across Chrome devices' }),
    ).toBeChecked();
    await expect(optionsPage.getByText('Chrome Sync is on.')).toBeVisible();
    await expect(optionsPage.getByRole('heading', { name: 'Synced' })).toBeVisible();
    await expect(optionsPage.getByRole('heading', { name: 'Local only' })).toBeVisible();
    const syncedScope = optionsPage.locator('.privacy-data-scope', {
      has: optionsPage.getByRole('heading', { name: 'Synced' }),
    });
    await expect(syncedScope.getByRole('listitem')).toHaveText([
      'Settings',
      'Block and allow lists',
      'Site access credit',
      'Streaks',
      'Domain-level blocked-attempt aggregates',
    ]);
    const localOnlyScope = optionsPage.locator('.privacy-data-scope', {
      has: optionsPage.getByRole('heading', { name: 'Local only' }),
    });
    await expect(localOnlyScope.getByRole('listitem')).toHaveText([
      'Full URLs',
      'Focus intentions',
      'Detailed session events',
      'Active runtime session',
    ]);
    await expect(
      optionsPage.getByText('Nothing is sent to the Focus Lock developer.'),
    ).toBeVisible();
    await optionsPage.evaluate((): void => {
      const privacyHeading: HTMLHeadingElement | undefined = [
        ...document.querySelectorAll('h2'),
      ].find(
        (heading: HTMLHeadingElement): boolean =>
          heading.textContent?.trim() === 'Privacy and data',
      );
      if (privacyHeading === undefined) throw new Error('Privacy and data heading is unavailable');
      window.scrollTo(0, Math.max(0, privacyHeading.offsetTop - 56));
    });
    await captureStoreScreenshot(
      optionsPage,
      captureDirectory,
      SCREENSHOT_FILES[4] as string,
      TALL_CAPTURE,
    );
    await optionsTimezoneSession.detach();
    await optionsPage.close();
  });

  await assertScreenshotInventory(captureDirectory);
  assertNoUnexpectedBrowserDiagnostics(browserDiagnosticsFor(context));
  assertNoUnexpectedBrowserDiagnostics(freshInstallExtension.diagnostics);
  assertNoUnexpectedBrowserDiagnostics(restartableExtension.diagnostics);
  await publishCapturedScreenshots(captureDirectory, SCREENSHOT_DIRECTORY, updateCanonical);
  // The provenance is written by the run that published the images, from the build those images
  // were captured against. Written anywhere else it would record a build they did not come from.
  if (updateCanonical) await writeScreenshotProvenance();
  await assertScreenshotInventory(SCREENSHOT_DIRECTORY);
  await assertScreenshotsMatchThisBuild();
});
