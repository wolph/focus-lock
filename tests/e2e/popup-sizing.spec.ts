import { expect, startTestSession, test } from './fixtures';

/**
 * Chrome measures the toolbar popup before its first layout, so a maximum width in viewport units
 * reads a viewport that does not exist yet and clamps the popup to a fraction of its width. These
 * scenarios read the real popup window through `chrome.extension.getViews`, without emulating a
 * viewport, so the regression is measured where it happens.
 */
const POPUP_WIDTH: number = 480;
const POPUP_HEIGHT: number = 600;

test('the toolbar popup opens at its intended size without viewport emulation', async ({
  extPage,
}) => {
  await extPage.evaluate(async (): Promise<void> => {
    await chrome.action.openPopup();
  });

  await expect
    .poll(async (): Promise<number | null> => {
      return await extPage.evaluate((): number | null => {
        const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
        return popup === undefined ? null : popup.innerWidth;
      });
    })
    .toBe(POPUP_WIDTH);

  // The idle form loads its settings after the popup opens, so the layout is measured once the
  // start button exists.
  await expect
    .poll(async (): Promise<boolean> => {
      return await extPage.evaluate((): boolean => {
        const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
        return popup !== undefined && popup.document.querySelector('.start-button') !== null;
      });
    })
    .toBe(true);

  // The body keeps its intrinsic 600 px so Chrome asks for that height. A screen too short for
  // it gets a shorter popup window, and the app column shrinks to that window instead of being
  // clipped, which keeps the sticky start button in view.
  const measured: { width: number; height: number; app: number; viewport: number; start: number } =
    await extPage.evaluate(
      (): { width: number; height: number; app: number; viewport: number; start: number } => {
        const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
        if (popup === undefined) throw new Error('the toolbar popup is not open');
        const body: DOMRect = popup.document.body.getBoundingClientRect();
        const app: number =
          popup.document.querySelector('.app')?.getBoundingClientRect().height ?? 0;
        const start: number =
          popup.document.querySelector('.start-button')?.getBoundingClientRect().bottom ?? 0;
        return { width: body.width, height: body.height, app, viewport: popup.innerHeight, start };
      },
    );
  expect(measured.width).toBe(POPUP_WIDTH);
  expect(measured.height).toBe(POPUP_HEIGHT);
  expect(measured.app).toBe(Math.min(POPUP_HEIGHT, measured.viewport));
  expect(measured.start).toBeGreaterThan(0);
  expect(measured.start).toBeLessThanOrEqual(measured.viewport);
});

test('the popup page still fits a narrow tab viewport', async ({ extPage }) => {
  for (const width of [375, 768]) {
    await extPage.setViewportSize({ width, height: 1000 });
    expect(await extPage.evaluate((): number => document.body.getBoundingClientRect().width)).toBe(
      Math.min(width, POPUP_WIDTH),
    );
    expect(
      await extPage.evaluate((): number => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

test('the active view fits the real toolbar popup without scrolling', async ({ extPage }) => {
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 50 } });
  await extPage.evaluate(async (): Promise<void> => {
    await chrome.action.openPopup();
  });
  await expect
    .poll(async (): Promise<boolean> => {
      return await extPage.evaluate((): boolean => {
        const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
        return popup !== undefined && popup.document.querySelector('.end-session-button') !== null;
      });
    })
    .toBe(true);

  // This scenario used to prove the End control could be *scrolled* into view. The popup no longer
  // scrolls at all, so it now proves the control is already in view without anyone touching it.
  // See docs/superpowers/specs/2026-09-17-popup-visibility-rules.md.
  const measured: { viewport: number; scrollable: boolean; endBottom: number } =
    await extPage.evaluate((): { viewport: number; scrollable: boolean; endBottom: number } => {
      const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
      if (popup === undefined) throw new Error('the toolbar popup is not open');
      const view: HTMLElement | null = popup.document.querySelector('.active-view');
      const end: HTMLElement | null = popup.document.querySelector('.end-session-button');
      if (view === null || end === null) throw new Error('the active view did not render');
      return {
        viewport: popup.innerHeight,
        scrollable: view.scrollHeight > view.clientHeight + 1,
        endBottom: end.getBoundingClientRect().bottom,
      };
    });
  expect(measured.scrollable).toBe(false);
  expect(measured.endBottom).toBeGreaterThan(0);
  expect(measured.endBottom).toBeLessThanOrEqual(measured.viewport);
});
