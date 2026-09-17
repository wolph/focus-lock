import type { Locator, Page } from '@playwright/test';
import type { Settings } from '../../src/shared/types';
import { expect, sendExtensionRequest, startTestSession, test } from './fixtures';

test('popup shows an unlock confirmation and a red End session control', async ({
  context,
  extPage,
  siteUrl,
}, testInfo): Promise<void> => {
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  await sendExtensionRequest(extPage, {
    type: 'updateSettings',
    settings: {
      ...settings,
      pause: { earnRatio: 10, capMs: 600_000, pauseMs: 300_000, unlockMs: 300_000 },
      gate: { delayMs: 1_000, requireTypedPhrase: false, allowForceEnd: false },
    },
  });
  const site: Page = await context.newPage();
  await site.goto(siteUrl('/plain.html'));
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 5 } });
  await expect(site.locator('focus-lock-overlay')).toBeAttached();
  // End session is on screen from the moment the popup opens, by product rule.
  // See docs/superpowers/specs/2026-09-17-popup-visibility-rules.md.
  await expect(extPage.getByRole('button', { name: 'End session', exact: true })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await extPage.evaluate((value: string): void => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [480, 375, 768]) {
      await extPage.setViewportSize({ width, height: 600 });
      const end: Locator = extPage.getByRole('button', { name: 'End session', exact: true });
      // The active view scrolls inside the fixed popup height, so the End control is brought
      // into view the way a person would reach it.
      await end.scrollIntoViewIfNeeded();
      // The scrolled view can leave a sub-pixel of the control outside the box, so the check
      // asks for the whole control within rounding rather than an exact 1.
      await expect(end).toBeInViewport({ ratio: 0.98 });
      const actionStyles: Record<string, string | number>[] = await extPage
        .locator('.actions > button')
        .evaluateAll((buttons: Element[]): Record<string, string | number>[] =>
          buttons.map((button: Element): Record<string, string | number> => {
            const style: CSSStyleDeclaration = getComputedStyle(button);
            return {
              height: button.getBoundingClientRect().height,
              width: button.getBoundingClientRect().width,
              padding: style.padding,
              radius: style.borderRadius,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
            };
          }),
        );
      expect(actionStyles).toHaveLength(3);
      expect(actionStyles[2]).toEqual(actionStyles[0]);
      expect(actionStyles[2]).toEqual(actionStyles[1]);
      await extPage.screenshot({
        path: testInfo.outputPath(`end-${theme}-${width}-full.png`),
        fullPage: true,
      });
      await end.screenshot({ path: testInfo.outputPath(`end-${theme}-${width}-detail.png`) });
      await end.hover();
      await end.screenshot({ path: testInfo.outputPath(`end-${theme}-${width}-hover.png`) });
      await end.focus();
      await extPage
        .locator('.actions')
        .screenshot({ path: testInfo.outputPath(`end-${theme}-${width}-focus.png`) });
      await end.evaluate((element: HTMLButtonElement): void => element.blur());
      // The hover above leaves the pointer on the button, and the next width's resting shots
      // would show the hover fill. Park the pointer so every full and detail image is at rest.
      await extPage.mouse.move(0, 0);
    }
  }
  await expect
    .poll(
      async (): Promise<number> =>
        (await sendExtensionRequest(extPage, { type: 'getSnapshot' })).bankMs,
      { timeout: 40_000 },
    )
    .toBeGreaterThanOrEqual(300_000);
  await site.bringToFront();
  await extPage.evaluate(async (): Promise<void> => {
    await chrome.action.openPopup();
  });
  await expect
    .poll(
      async (): Promise<string | null> =>
        extPage.evaluate((): string | null => {
          const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
          const details: HTMLDetailsElement | null | undefined =
            popup?.document.querySelector('.active-view details');
          if (details && !details.open) details.querySelector('summary')?.click();
          const button: HTMLButtonElement | undefined = Array.from(
            popup?.document.querySelectorAll('button') ?? [],
          ).find(
            (element: HTMLButtonElement): boolean =>
              element.textContent?.includes('Unlock this site') === true,
          );
          if (button === undefined || button.disabled) return null;
          return button.textContent;
        }),
    )
    .toContain('blocked.example');
  await extPage.evaluate((): void => {
    const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
    const button: HTMLButtonElement | undefined = Array.from(
      popup?.document.querySelectorAll('button') ?? [],
    ).find(
      (element: HTMLButtonElement): boolean =>
        element.textContent?.includes('Unlock this site') === true,
    );
    if (button === undefined) throw new Error('Missing native popup unlock button');
    button.click();
  });
  await expect
    .poll(
      async (): Promise<string> =>
        extPage.evaluate(
          (): string =>
            chrome.extension.getViews({ type: 'popup' })[0]?.document.body.textContent ?? '',
        ),
    )
    .toContain('Keep focusing');
  expect((await sendExtensionRequest(extPage, { type: 'getSnapshot' })).gate?.host).toBe(
    'blocked.example',
  );
  await expect
    .poll(
      async (): Promise<boolean> =>
        extPage.evaluate((): boolean => {
          const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
          const confirm: HTMLButtonElement | null | undefined =
            popup?.document.querySelector<HTMLButtonElement>('.gate-confirm');
          return confirm !== undefined && confirm !== null && !confirm.disabled;
        }),
    )
    .toBe(true);
  await extPage.evaluate((): void => {
    const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
    popup?.document.querySelector<HTMLButtonElement>('.gate-confirm')?.click();
  });
  await expect(site.locator('focus-lock-overlay')).toHaveCount(0);
  expect(
    (await sendExtensionRequest(extPage, { type: 'getSnapshot' })).activeUnlocks.map(
      (unlock): string => unlock.host,
    ),
  ).toEqual(['blocked.example']);
});
