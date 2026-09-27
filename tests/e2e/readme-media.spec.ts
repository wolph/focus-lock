import { execFileSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  type Browser,
  type CDPSession,
  type ConsoleMessage,
  chromium,
  type FrameLocator,
  type Locator,
  type Page,
  type Route,
  type Worker,
} from '@playwright/test';
import { PNG } from 'pngjs';
import type { DailyAgg, ListsConfig, Settings, SetupState } from '../../src/shared/types';
import { assertNoUnexpectedBrowserDiagnostics } from './browser-diagnostics';
import {
  type AccessibilityNode,
  type AccessibilityProperty,
  type AccessibilityTree,
  type FrameTree,
  findFrameId,
} from './cdp-accessibility';
import {
  browserDiagnosticsFor,
  expect,
  sendExtensionRequest,
  test,
  waitForActiveSession,
} from './fixtures';
import { type PagesServer, startPagesServer } from './pages-server';
import { buildStatsVisualSeed, type StatsVisualSeed } from './stats-visual-seeds';

const ROOT: string = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT: string = path.join(ROOT, 'docs/images/focus-lock/readme');
const INTENTION: string = 'Finish the proposal';
const FILES: readonly string[] = [
  'focus-session.png',
  'blocked-page.png',
  'progress.png',
  'demo-poster.png',
  'demo.gif',
];
const PAGE_SIZE: { width: number; height: number } = { width: 960, height: 640 };
// biome-ignore lint/suspicious/noTemplateCurlyInString: Shell expansion is reproduced verbatim.
const CLEAN_ENVIRONMENT: string = 'env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}"';

interface MediaProvenance {
  capturedAt: string;
  sourceCommit: string;
  distSha256: string;
  packageLockSha256: string;
  captureScriptSha256: string;
  version: string;
  toolchain: { node: string; chromium: string; ffmpeg: string };
  files: Record<string, { bytes: number; sha256: string }>;
  demonstration: string[];
  reproductionInstructions: string[];
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ['PATH', 'TMPDIR'].flatMap((key: string): [string, string][] => {
      const value: string | undefined = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function command(executable: string, args: string[]): string {
  // The subprocess sees no inherited credentials, and failures report no environment values.
  try {
    return execFileSync(executable, args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: cleanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`${executable} failed while generating README media`);
  }
}

async function buildDigest(directory: string = path.join(ROOT, 'dist')): Promise<string> {
  const files: string[] = await readdir(directory, { recursive: true });
  const hash: Hash = createHash('sha256');
  for (const relative of files.sort()) {
    const filename: string = path.join(directory, relative);
    if (!(await stat(filename)).isFile()) continue;
    hash
      .update(relative)
      .update('\0')
      .update(await readFile(filename))
      .update('\0');
  }
  return hash.digest('hex');
}

async function preparePage(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

async function capture(page: Page, directory: string, name: string): Promise<void> {
  await page.evaluate(async (): Promise<void> => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.screenshot({ path: path.join(directory, name), animations: 'disabled' });
}

async function seedProgress(extPage: Page, worker: Worker): Promise<void> {
  await expect
    .poll(
      async (): Promise<string> => {
        const setup: SetupState = await sendExtensionRequest(extPage, { type: 'getSetupState' });
        return setup.syncWriteStatus;
      },
      { timeout: 30_000 },
    )
    .toBe('idle');
  const seed: StatsVisualSeed = buildStatsVisualSeed('one-active-hour-sync', Date.now());
  for (const event of seed.events) {
    if (event.t === 'sessionStarted') event.intention = INTENTION;
    if (event.t === 'attempt') {
      event.host = 'blocked.example';
      event.url = 'https://blocked.example/feed';
    }
  }
  const day: DailyAgg | undefined = seed.bundle.days[0];
  if (day === undefined) throw new Error('The demonstration day is missing');
  day.attempts = { 'blocked.example': 1 };
  await worker.evaluate(async (payload: StatsVisualSeed): Promise<void> => {
    await chrome.storage.local.set({ events: payload.events });
    await chrome.storage.sync.set({
      ...Object.fromEntries(
        payload.bundle.days.map((value: DailyAgg): [string, unknown] => [
          `agg:readme-demo:${value.date}`,
          value,
        ]),
      ),
      streak: payload.bundle.streak,
    });
  }, seed);
}

async function waitForWorkTarget(page: Page): Promise<void> {
  const session: CDPSession = await page.context().newCDPSession(page);
  try {
    await expect
      .poll(async (): Promise<boolean> => {
        const tree: AccessibilityTree = await session.send('Accessibility.getFullAXTree');
        return tree.nodes.some(
          (node: AccessibilityNode): boolean =>
            node.role?.value === 'button' &&
            String(node.name?.value).startsWith(`Back to work: ${INTENTION}`),
        );
      })
      .toBe(true);
  } finally {
    await session.detach();
  }
}

/**
 * Polls the demo tab iframe's own accessibility tree for an enabled button with the given name,
 * without clicking it. The lockscreen's Back to work button starts disabled until the demo engine
 * records a work target for the session, so the poster capture waits on this before the screenshot,
 * the same readiness gate tests/e2e/site-demo.spec.ts polls for immediately before its own click.
 */
async function waitForDemoLockTarget(page: Page, tabId: number, name: string): Promise<void> {
  // A mouse click lands in viewport coordinates, so the iframe must be on screen first.
  await page.locator(`iframe[data-tab-id="${String(tabId)}"]`).scrollIntoViewIfNeeded();
  const session: CDPSession = await page.context().newCDPSession(page);
  try {
    await session.send('Page.enable');
    const frameTree: FrameTree = await session.send('Page.getFrameTree');
    const frameId: string | undefined = findFrameId(frameTree.frameTree, `tab=${String(tabId)}`);
    if (frameId === undefined) throw new Error(`demo tab iframe not found: ${String(tabId)}`);
    await expect
      .poll(
        async (): Promise<boolean> => {
          const tree: AccessibilityTree = await session.send('Accessibility.getFullAXTree', {
            frameId,
          });
          const node: AccessibilityNode | undefined = tree.nodes.find(
            (candidate: AccessibilityNode): boolean =>
              candidate.role?.value === 'button' && String(candidate.name?.value).startsWith(name),
          );
          if (node === undefined) return false;
          const disabled: boolean =
            node.properties?.some(
              (property: AccessibilityProperty): boolean =>
                property.name === 'disabled' && property.value?.value === true,
            ) ?? false;
          return !disabled;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    await session.detach();
  }
}

/**
 * Clicks a button inside the demo tab iframe's lockscreen, which mounts in a closed shadow root
 * (src/content/overlay-host.ts). A closed shadow root refuses .shadowRoot to every piece of page
 * JavaScript, Playwright locators included, so no CSS or role locator can reach in. The CDP
 * Accessibility domain, scoped to the iframe's own frame, still reports the button and its
 * on-screen box, matching clickLockscreenButton in tests/e2e/site-demo.spec.ts.
 */
async function clickDemoLockscreenButton(page: Page, tabId: number, name: string): Promise<void> {
  const session: CDPSession = await page.context().newCDPSession(page);
  try {
    await session.send('Page.enable');
    const frameTree: FrameTree = await session.send('Page.getFrameTree');
    const frameId: string | undefined = findFrameId(frameTree.frameTree, `tab=${String(tabId)}`);
    if (frameId === undefined) throw new Error(`demo tab iframe not found: ${String(tabId)}`);
    const tree: AccessibilityTree = await session.send('Accessibility.getFullAXTree', { frameId });
    const button: AccessibilityNode | undefined = tree.nodes.find(
      (node: AccessibilityNode): boolean =>
        node.role?.value === 'button' && String(node.name?.value).startsWith(name),
    );
    if (button?.backendDOMNodeId === undefined) throw new Error(`demo button unavailable: ${name}`);
    const box: { model: { content: number[] } } = await session.send('DOM.getBoxModel', {
      backendNodeId: button.backendDOMNodeId,
    });
    const [left, top, right, , , bottom] = box.model.content;
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
      throw new Error(`demo button has no clickable bounds: ${name}`);
    }
    await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  } finally {
    await session.detach();
  }
}

/**
 * Records demo.gif and demo-poster.png from the interactive demo page rather than the extension,
 * so the README hero shows the same three beats a site visitor clicks through: the popup open with
 * the intention typed, the Headlines lockscreen, and the draft tab after Back to work. The frame
 * timing (80 screenshots at 8 fps, switching state at frame 16 and frame 48) and the ffmpeg
 * encoding downstream of this function are unchanged from the extension-driven recording.
 */
async function recordSiteDemo(directory: string, frames: string): Promise<void> {
  const server: PagesServer = await startPagesServer();
  try {
    const browser: Browser = await chromium.launch();
    try {
      const page: Page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error: Error): void => {
        errors.push(error.message);
      });
      page.on('console', (message: ConsoleMessage): void => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await preparePage(page, PAGE_SIZE);
      await page.goto(server.url);

      // The demo opens idle on the Headlines tab. The popup is opened on the draft with the
      // intention typed before the loop, so the draft is the work tab. Start locks Headlines,
      // which the visitor then opens, and Back to work returns to the draft.
      const draft: FrameLocator = page.frameLocator('iframe[data-tab-id="11"]');
      const headlines: FrameLocator = page.frameLocator('iframe[data-tab-id="12"]');
      await expect(headlines.locator('focus-lock-overlay')).not.toBeAttached();
      await page.getByRole('button', { name: 'Proposal draft', exact: true }).click();
      await page.getByRole('button', { name: 'Open Focus Lock' }).click();
      const popup: Locator = page.locator('#popup');
      await popup.getByLabel('Intention').fill(INTENTION);
      await expect(popup.locator('.work-target')).toHaveText(/Proposal draft/);

      await page.locator('#browser').scrollIntoViewIfNeeded();

      await mkdir(frames, { recursive: true });
      const started: number = performance.now();
      for (let frame: number = 0; frame < 80; frame += 1) {
        if (frame === 16) {
          await popup.getByRole('button', { name: /^Start/ }).click();
          await expect(headlines.locator('focus-lock-overlay')).toBeAttached();
          await expect(page.locator('[data-beat="start"]')).toHaveClass(/guide-done/);
          // Close the popup panel so the lockscreen underneath is what the frames show.
          await page.getByRole('button', { name: 'Open Focus Lock' }).click();
          await expect(page.locator('#popup-panel')).toBeHidden();
          await page.getByRole('button', { name: 'Headlines', exact: true }).click();
          await waitForDemoLockTarget(page, 12, 'Back to work');
        }
        if (frame === 28) await capture(page, directory, 'demo-poster.png');
        if (frame === 48) {
          await clickDemoLockscreenButton(page, 12, 'Back to work');
          await expect(page.locator('button.tab-active')).toHaveText('Proposal draft');
          await expect(page.locator('[data-beat="back"]')).toHaveClass(/guide-done/);
          await draft.locator('#draft').fill('Section one: why this matters.');
        }
        await page.screenshot({ path: path.join(frames, `${String(frame).padStart(3, '0')}.png`) });
        await delay(Math.max(0, started + ((frame + 1) * 1_000) / 8 - performance.now()));
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

const WORK_PAGE: string = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Finish the proposal</title><style>
* { box-sizing: border-box; } body { margin: 0; background: #f4f6fa; color: #243047;
font: 18px/1.6 system-ui, sans-serif; } header { background: #fff; padding: 18px 44px;
border-bottom: 1px solid #dce2ea; display: flex; justify-content: space-between; font-size: 14px; }
header span { color: #65748c; } main { max-width: 790px; margin: 36px auto; padding: 36px 48px;
background: #fff; border: 1px solid #dce2ea; border-radius: 10px; }
h1 { margin: 8px 0 20px; font-size: 36px; line-height: 1.2; } h2 { font-size: 19px; }
p { margin: 12px 0; } .label { color: #557098; font-size: 13px; letter-spacing: 1px; }
.next { border-left: 3px solid #506ddc; background: #f1f4ff; padding: 10px 18px; }
</style></head><body><header><strong>Project notes</strong><span>Demonstration document</span></header>
<main><div class="label">DRAFT PROPOSAL</div><h1>Finish the proposal</h1>
<p>A clearer support experience for customers.</p><h2>What we will deliver</h2>
<p>A shorter contact form, clearer response times and a guide to the most common questions.</p>
<h2>Next step</h2><p class="next">Write the timeline and send the proposal for review.</p>
</main></body></html>`;

const READING_PAGE: string = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Reading list</title>
<style>body { margin: 0; padding: 32px 48px; background: #fff; color: #273449;
font: 18px/1.6 system-ui, sans-serif; } h1 { font-size: 32px; } p { max-width: 680px; }
small { color: #61708a; }</style></head><body><small>Demonstration page</small>
<h1>Reading list</h1><p>Interesting stories to read when the work is finished.</p>
<h2>A new idea for the weekend</h2><p>There is always another article to open.</p>
</body></html>`;

test.use({ extensionTimezone: 'Europe/Amsterdam', extensionDeterministicPaint: true });

test.describe('README capture', (): void => {
  test.skip(process.env.UPDATE_README_MEDIA !== '1', 'Set UPDATE_README_MEDIA=1 to recapture');

  test.beforeAll((): void => {
    if (process.env.UPDATE_README_MEDIA === '1' && process.env.FOCUS_LOCK_E2E_DIST !== undefined) {
      throw new Error(
        'README captures require the repository dist build. Unset FOCUS_LOCK_E2E_DIST.',
      );
    }
  });

  test('captures the README product tour', async ({
    context,
    extPage,
    extensionId,
    siteUrl,
    worker,
  }): Promise<void> => {
    test.setTimeout(120_000);
    const directory: string = test.info().outputPath('readme-media');
    await mkdir(directory, { recursive: true });
    const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
    expect(
      await sendExtensionRequest(extPage, {
        type: 'updateSettings',
        settings: { ...settings, theme: 'light' },
      }),
    ).toMatchObject({ ok: true });
    const lists: ListsConfig = await sendExtensionRequest(extPage, { type: 'getLists' });
    expect(
      await sendExtensionRequest(extPage, {
        type: 'updateLists',
        lists: { ...lists, custom: [{ kind: 'host', pattern: 'blocked.example' }] },
      }),
    ).toMatchObject({ ok: true });
    await seedProgress(extPage, worker);
    const workUrl: string = siteUrl('/proposal.html').replace('blocked.example', 'other.example');
    await context.route(workUrl, async (route: Route): Promise<void> => {
      await route.fulfill({ contentType: 'text/html', body: WORK_PAGE });
    });
    const work: Page = await context.newPage();
    await preparePage(work, PAGE_SIZE);
    await work.goto(workUrl);
    await expect(work.getByRole('heading', { name: INTENTION })).toBeVisible();
    await work.bringToFront();
    await preparePage(extPage, { width: 600, height: 600 });
    await extPage.reload();
    await extPage.getByLabel('Intention').fill(INTENTION);
    await expect(extPage.locator('.work-target')).toContainText(INTENTION);
    await expect(extPage.getByRole('button', { name: 'Start 25 min focus' })).toBeVisible();
    await capture(extPage, directory, 'focus-session.png');
    const blocked: Page = await context.newPage();
    const blockedUrl: string = siteUrl('/reading.html');
    await context.route(blockedUrl, async (route: Route): Promise<void> => {
      await route.fulfill({ contentType: 'text/html', body: READING_PAGE });
    });
    await preparePage(blocked, PAGE_SIZE);
    await blocked.goto(blockedUrl);
    await extPage.getByRole('button', { name: 'Start 25 min focus' }).click();
    await waitForActiveSession(extPage);
    await expect(blocked.locator('focus-lock-overlay')).toBeAttached();
    await expect(extPage.getByRole('button', { name: /^Back to work:/ })).toBeEnabled();
    await waitForWorkTarget(blocked);
    await capture(blocked, directory, 'blocked-page.png');
    await recordSiteDemo(directory, path.join(directory, 'frames'));
    command('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      '8',
      '-i',
      path.join(directory, 'frames/%03d.png'),
      '-filter_complex',
      '[0:v]split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop',
      '0',
      path.join(directory, 'demo.gif'),
    ]);
    const statsPage: Page = await context.newPage();
    await preparePage(statsPage, { width: 1280, height: 1000 });
    await statsPage.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);
    await expect(statsPage.getByRole('heading', { name: 'Your focus record' })).toBeVisible();
    await expect(
      statsPage.locator('.tile', { hasText: 'Focus in the last 7 days' }).locator('.tile-value'),
    ).toHaveText('1 h 00 m');
    const focusChart: { x: number; y: number; width: number; height: number } | null =
      await statsPage.locator('.charts .card').first().boundingBox();
    if (focusChart === null) throw new Error('The focus chart is missing');
    const statsHeight: number = Math.ceil(focusChart.y + focusChart.height) + 12;
    await statsPage.setViewportSize({ width: 1280, height: statsHeight });
    await capture(statsPage, directory, 'progress.png');
    const manifest: { version: string } = JSON.parse(
      await readFile(path.join(ROOT, 'dist/manifest.json'), 'utf8'),
    );
    const provenance: MediaProvenance = {
      capturedAt: new Date().toISOString(),
      sourceCommit: command('git', ['rev-parse', 'HEAD']),
      distSha256: await buildDigest(),
      packageLockSha256: createHash('sha256')
        .update(await readFile(path.join(ROOT, 'package-lock.json')))
        .digest('hex'),
      captureScriptSha256: createHash('sha256')
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest('hex'),
      version: manifest.version,
      toolchain: {
        node: process.versions.node,
        chromium: context.browser()?.version() ?? 'unknown',
        ffmpeg: command('ffmpeg', ['-version']).split('\n')[0] ?? 'unknown',
      },
      files: {},
      demonstration: [
        'Fresh isolated Playwright Chromium extension profile with website permission fixture. No personal browser data.',
        'focus-session.png, blocked-page.png and progress.png: the real extension UI and controls, light theme, in a real Chrome tab. No UI text, CSS or screenshots are replaced.',
        'Session: 25 minutes, Finish the proposal. A local demonstration document is the actual selected work tab.',
        'Progress: seeded one-hour completed session and one blocked attempt yesterday. The current session is real.',
        "demo-poster.png and demo.gif are recorded from the interactive demo page at https://wolph.github.io/focus-lock/, which renders that same popup directly on the page and mounts that same lockscreen inside each fake browser tab's own iframe, none of them real Chrome tabs.",
        'GIF: 80 screenshots at 8 fps, 10 seconds. The popup open on the idle Headlines tab for 2 seconds, Start locking that tab and the lockscreen for 4, the returned work document for 4.',
        `Native Chrome browser chrome is outside every capture. The demo captures do include the fake tab strip and toolbar drawn by the demo page itself, since that is ordinary page content, not real browser chrome. Popup viewport 480x600. Block and demo 960x640. Stats overview 1280x${statsHeight}.`,
        "In blocked-page.png the blocking overlay applies to an already loaded local blocked.example page, and pressing Back to work there activates that page's original Chrome tab. In demo.gif, pressing Back to work switches the fake tab strip on the demo page to the work tab, a state change inside one Chrome tab rather than a switch between Chrome tabs.",
      ],
      reproductionInstructions: [
        `${CLEAN_ENVIRONMENT} node scripts/gen-icons.mjs`,
        `${CLEAN_ENVIRONMENT} node node_modules/vite/bin/vite.js build`,
        `${CLEAN_ENVIRONMENT} node node_modules/vite/bin/vite.js build --config vite.pages.config.ts`,
        `${CLEAN_ENVIRONMENT} node scripts/build-pages.mjs`,
        `${CLEAN_ENVIRONMENT} TZ=Europe/Amsterdam UPDATE_README_MEDIA=1 node node_modules/@playwright/test/cli.js test tests/e2e/readme-media.spec.ts -g 'captures the README product tour'`,
        `${CLEAN_ENVIRONMENT} node node_modules/@playwright/test/cli.js test tests/e2e/readme-media.spec.ts -g 'validates the README media inventory'`,
      ],
    };
    for (const filename of FILES) {
      const payload: Buffer = await readFile(path.join(directory, filename));
      expect(payload.length).toBeLessThan(5_000_000);
      provenance.files[filename] = {
        bytes: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex'),
      };
    }
    assertNoUnexpectedBrowserDiagnostics(browserDiagnosticsFor(context));
    await mkdir(OUTPUT, { recursive: true });
    for (const filename of FILES)
      await writeFile(path.join(OUTPUT, filename), await readFile(path.join(directory, filename)));
    await writeFile(
      path.join(OUTPUT, 'provenance.json'),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
  });
});

test('validates the README media inventory', async (): Promise<void> => {
  const provenance: MediaProvenance = JSON.parse(
    await readFile(path.join(OUTPUT, 'provenance.json'), 'utf8'),
  );
  expect(Number.isFinite(Date.parse(provenance.capturedAt))).toBe(true);
  expect(provenance.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(provenance.distSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(provenance.packageLockSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(provenance.captureScriptSha256).toBe(
    createHash('sha256')
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest('hex'),
  );
  for (const filename of FILES) {
    const payload: Buffer = await readFile(path.join(OUTPUT, filename));
    expect(payload.length).toBeLessThan(5_000_000);
    expect(provenance.files[filename]).toEqual({
      bytes: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    });
    if (filename.endsWith('.png')) {
      const png: PNG = PNG.sync.read(payload);
      expect(png.width).toBeGreaterThanOrEqual(380);
      expect(png.height).toBeGreaterThanOrEqual(600);
    } else {
      expect(payload.subarray(0, 6).toString()).toMatch(/^GIF8[79]a$/);
    }
  }
});
