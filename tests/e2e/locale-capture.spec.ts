import type { Page } from '@playwright/test';
import { expect, startTestSession, test, waitForActiveSession } from './fixtures';

/**
 * Screenshot capture for manual review of a translated build. Skipped unless LOCALE_SHOTS names a
 * directory, so the suite does not write evidence on an ordinary run.
 */
const OUTPUT: string | undefined = process.env.LOCALE_SHOTS;
const LOCALE: string = process.env.LOCALE_SHOTS_LANG ?? 'fr';
const WIDTHS: ReadonlyArray<{ name: string; width: number; height: number }> = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'tablet', width: 768, height: 1000 },
  { name: 'mobile', width: 375, height: 800 },
];

test.skip(OUTPUT === undefined, 'LOCALE_SHOTS is not set');
test.use({ extensionUiLanguage: LOCALE });

test('capture every surface for review', async ({ context, extPage, extensionId, siteUrl }) => {
  const shot = async (page: Page, name: string, fullPage: boolean = true): Promise<void> => {
    await page.screenshot({ path: `${OUTPUT}/${LOCALE}-${name}.png`, fullPage });
  };

  const popup: Page = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await expect(popup.locator('.start-form')).toBeVisible();
  await shot(popup, 'popup-idle');

  const options: Page = await context.newPage();
  for (const viewport of WIDTHS) {
    await options.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const section of ['blocking', 'behavior', 'privacy']) {
      await options.goto(`chrome-extension://${extensionId}/src/options/options.html#${section}`);
      await expect(options.locator('.settings-nav')).toBeVisible();
      await shot(options, `options-${section}-${viewport.name}`);
    }
  }

  const stats: Page = await context.newPage();
  for (const viewport of WIDTHS) {
    await stats.setViewportSize({ width: viewport.width, height: viewport.height });
    await stats.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);
    await expect(stats.locator('.settings-nav')).toBeVisible();
    await shot(stats, `stats-${viewport.name}`);
  }

  const onboarding: Page = await context.newPage();
  await onboarding.setViewportSize({ width: 1280, height: 900 });
  await onboarding.goto(`chrome-extension://${extensionId}/src/onboarding/onboarding.html`);
  await shot(onboarding, 'onboarding');

  await startTestSession(extPage, { intention: 'Terminer le rapport' });
  await waitForActiveSession(extPage);
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await expect(popup.locator('.active-view')).toBeVisible();
  await shot(popup, 'popup-active');

  const blocked: Page = await context.newPage();
  await blocked.setViewportSize({ width: 1280, height: 900 });
  await blocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blocked.locator('focus-lock-overlay')).toBeAttached({ timeout: 20_000 });
  await blocked.waitForTimeout(1000);
  // The overlay is fixed to the viewport, which a full-page capture renders only once at the top.
  await shot(blocked, 'overlay', false);
});
