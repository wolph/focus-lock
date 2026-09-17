import type { Page } from '@playwright/test';
import { expect, startTestSession, test, waitForActiveSession } from './fixtures';
import {
  describeOverflow,
  type OverflowFinding,
  overflowFindings,
  overlayDirection,
  overlayOverflowFindings,
} from './overflow-probe';

/**
 * The locales a translation is most likely to break the layout in: German and Finnish compound
 * without a space, Russian runs long in Cyrillic, Japanese and Chinese set no word breaks, Hindi
 * stacks diacritics above and below the line, and Arabic and Hebrew reverse the writing direction.
 * Every locale ships, so this set is a tripwire rather than a promise about the other forty-five.
 */
const STRESS_LOCALES: readonly string[] = ['de', 'fi', 'ru', 'ja', 'zh-CN', 'hi', 'ar', 'he'];
const RTL_LOCALES: ReadonlySet<string> = new Set<string>(['ar', 'he', 'fa']);

const SETTINGS_SECTIONS: readonly string[] = [
  'blocking',
  'schedule',
  'behavior',
  'budget',
  'notifications',
  'privacy',
];

/** The popup is the narrowest surface, so it is probed at its own width rather than the default. */
const POPUP_VIEWPORT: { width: number; height: number } = { width: 400, height: 600 };

async function expectFits(page: Page, locale: string, surface: string): Promise<void> {
  const findings: OverflowFinding[] = await overflowFindings(page);
  expect(findings, describeOverflow(locale, surface, findings)).toEqual([]);
}

/**
 * Chrome picks the catalogue for an extension from its own UI locale, which follows `--lang` on
 * Linux and Windows and the operating system on macOS, where the flag, the `intl.app_locale`
 * preference and the LANGUAGE environment variable are all ignored. A run that cannot switch the
 * language would otherwise test English eight times over and report eight passes, so each
 * scenario asks the extension which locale its messages came from and skips itself, with the
 * reason, when the request did not take.
 */
async function requireUiLanguage(page: Page, locale: string): Promise<void> {
  // `@@ui_locale` is the browser's interface locale, which is what Chrome picks the catalogue by.
  // `getUILanguage` reports the language preference instead and can say fr while every message
  // still comes from en, so it is the wrong thing to gate on.
  const actual: string = await page.evaluate((): string => chrome.i18n.getMessage('@@ui_locale'));
  const wanted: string = locale.split('-')[0] ?? locale;
  test.skip(
    !actual.toLowerCase().replace('_', '-').startsWith(wanted.toLowerCase()),
    `the extension resolved its messages from ${actual}, not ${locale}: this platform ignores the UI language flag`,
  );
}

async function expectDirection(page: Page, locale: string): Promise<void> {
  const direction: string = await page.evaluate(
    (): string => document.documentElement.dir || 'ltr',
  );
  expect(direction, `${locale} document direction`).toBe(RTL_LOCALES.has(locale) ? 'rtl' : 'ltr');
  const language: string = await page.evaluate((): string => document.documentElement.lang);
  expect(language.toLowerCase(), `${locale} document language`).toContain(
    locale.split('-')[0]?.toLowerCase() ?? locale,
  );
}

/** The overlay's shadow root is closed, so the host element is what carries its direction. */
async function expectOverlayDirection(page: Page, locale: string): Promise<void> {
  const direction: string = await overlayDirection(page);
  expect(direction, `${locale} overlay direction`).toBe(RTL_LOCALES.has(locale) ? 'rtl' : 'ltr');
}

for (const locale of STRESS_LOCALES) {
  test.describe(`layout in ${locale}`, () => {
    test.use({ extensionUiLanguage: locale });

    test('the popup, settings and stats fit their boxes', async ({ context, extensionId }) => {
      const popup: Page = await context.newPage();
      await popup.setViewportSize(POPUP_VIEWPORT);
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await expect(popup.locator('.start-form')).toBeVisible();
      await requireUiLanguage(popup, locale);
      await expectDirection(popup, locale);
      await expectFits(popup, locale, 'popup idle');

      const options: Page = await context.newPage();
      for (const section of SETTINGS_SECTIONS) {
        await options.goto(`chrome-extension://${extensionId}/src/options/options.html#${section}`);
        await expect(options.locator('.settings-nav')).toBeVisible();
        await expectDirection(options, locale);
        await expectFits(options, locale, `options ${section}`);
      }

      const stats: Page = await context.newPage();
      await stats.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);
      await expect(stats.locator('.settings-nav')).toBeVisible();
      await expectFits(stats, locale, 'stats');

      const onboarding: Page = await context.newPage();
      await onboarding.goto(`chrome-extension://${extensionId}/src/onboarding/onboarding.html`);
      await expectFits(onboarding, locale, 'onboarding');
    });

    test('the running popup and the block overlay fit their boxes', async ({
      context,
      extPage,
      extensionId,
      siteUrl,
    }) => {
      await startTestSession(extPage, { intention: 'Ship the release' });
      await waitForActiveSession(extPage);

      const popup: Page = await context.newPage();
      await popup.setViewportSize(POPUP_VIEWPORT);
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await expect(popup.locator('.active-view')).toBeVisible();
      await requireUiLanguage(popup, locale);
      await expectFits(popup, locale, 'popup active');

      const blocked: Page = await context.newPage();
      await blocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
      await expect(blocked.locator('focus-lock-overlay')).toBeAttached({ timeout: 20_000 });
      await expectOverlayDirection(blocked, locale);
      const overlayFindings: OverflowFinding[] = await overlayOverflowFindings(blocked, context);
      expect(overlayFindings, describeOverflow(locale, 'block overlay', overlayFindings)).toEqual(
        [],
      );
    });
  });
}
