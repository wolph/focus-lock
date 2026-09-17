/**
 * The three beats a visitor clicks through on the landing page, in a real Chromium against the
 * built site. The popup and the lockscreen here are the product's own components, so a product
 * change that breaks them breaks this before it reaches the site.
 */
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  expect,
  type FrameLocator,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import {
  type AccessibilityNode,
  type AccessibilityProperty,
  type AccessibilityTree,
  type FrameTree,
  findFrameId,
} from './cdp-accessibility';
import { type PagesServer, startPagesServer } from './pages-server';

let server: PagesServer;
let browser: Browser;

test.beforeAll(async (): Promise<void> => {
  server = await startPagesServer();
  browser = await chromium.launch();
});

test.afterAll(async (): Promise<void> => {
  await browser.close();
  await server.close();
});

/**
 * Clicks a button inside a tab iframe's lockscreen, which mounts in a closed shadow root
 * (src/content/overlay-host.ts). A closed shadow root refuses `.shadowRoot` to every piece of
 * page JavaScript, Playwright's own locators included, so no CSS or role locator can reach in.
 * The CDP Accessibility domain, scoped to the iframe's own frame, still reports the button and
 * its on-screen box: the accessibility tree is built from the flattened render tree, not from
 * the script-visible shadow root reference that `closed` withholds. The technique matches
 * `clickClosedShadowButton` in gates.spec.ts, extended with a frame lookup because that helper's
 * target sits on the top-level page and this one sits inside a tab iframe.
 */
async function clickLockscreenButton(
  context: BrowserContext,
  page: Page,
  tabId: number,
  accessibleName: string,
): Promise<void> {
  // A mouse click lands in viewport coordinates, so the iframe must be on screen first.
  await page.locator(`iframe[data-tab-id="${String(tabId)}"]`).scrollIntoViewIfNeeded();
  const session: CDPSession = await context.newCDPSession(page);
  try {
    await session.send('Page.enable');
    const frameTree: FrameTree = await session.send('Page.getFrameTree');
    const frameId: string | undefined = findFrameId(frameTree.frameTree, `tab=${String(tabId)}`);
    if (frameId === undefined) throw new Error(`tab iframe not found: ${String(tabId)}`);
    let backendNodeId: number | undefined;
    // The button starts disabled until the engine records a work target for the session, so this
    // polls rather than reading the tree once.
    await expect
      .poll(
        async (): Promise<boolean> => {
          const tree: AccessibilityTree = await session.send('Accessibility.getFullAXTree', {
            frameId,
          });
          const node: AccessibilityNode | undefined = tree.nodes.find(
            (candidate: AccessibilityNode): boolean =>
              candidate.role?.value === 'button' &&
              String(candidate.name?.value).startsWith(accessibleName),
          );
          if (node === undefined) return false;
          const disabled: boolean =
            node.properties?.some(
              (property: AccessibilityProperty): boolean =>
                property.name === 'disabled' && property.value?.value === true,
            ) ?? false;
          if (disabled) return false;
          backendNodeId = node.backendDOMNodeId;
          return true;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    if (backendNodeId === undefined) throw new Error(`button not found: ${accessibleName}`);
    const box: { model: { content: number[] } } = await session.send('DOM.getBoxModel', {
      backendNodeId,
    });
    const [left, top, right, , , bottom] = box.model.content;
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
      throw new Error(`button has no content box: ${accessibleName}`);
    }
    await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  } finally {
    await session.detach();
  }
}

test('a visitor locks the site they are on, returns to the draft, and ends the session', async (): Promise<void> => {
  const page: Page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error): void => {
    errors.push(error.message);
  });
  page.on('console', (message): void => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(server.url);

  // The demo opens idle on the Headlines tab: nothing is locked until the visitor locks it.
  const icon: Locator = page.getByRole('button', { name: 'Open Focus Lock' });
  await expect(icon).toHaveAttribute('data-locked', 'false');
  await expect(page.locator('button.tab-active')).toHaveText('Headlines');
  const headlines: FrameLocator = page.frameLocator('iframe[data-tab-id="12"]');
  await expect(headlines.locator('focus-lock-overlay')).not.toBeAttached();
  await expect(page.locator('[data-beat="start"]')).toHaveClass(/guide-current/);

  // Beat 1: start from the real popup. The site the visitor is on locks at once.
  await icon.click();
  const popup: Locator = page.locator('#popup');
  await popup.getByLabel('Intention').fill('Finish the proposal');
  // Headlines is not an eligible work tab, so nothing is preselected: pick the draft.
  await popup.getByRole('button', { name: 'Change' }).click();
  await popup.getByLabel('Work tab').selectOption('11');
  await expect(popup.locator('.work-target')).toHaveText(/Proposal draft/);
  await popup.getByRole('button', { name: /^Start/ }).click();
  await expect(icon).toHaveAttribute('data-locked', 'true');
  await expect(headlines.locator('focus-lock-overlay')).toBeAttached();
  await expect(page.locator('[data-beat="start"]')).toHaveClass(/guide-done/);

  // Beat 2: the lockscreen's own Back to work returns to the draft.
  await clickLockscreenButton(page.context(), page, 12, 'Back to work');
  await expect(page.locator('button.tab-active')).toHaveText('Proposal draft');
  await expect(page.locator('[data-beat="back"]')).toHaveClass(/guide-done/);
  const work: FrameLocator = page.frameLocator('iframe[data-tab-id="11"]');
  await work.locator('#draft').fill('Section one: why this matters.');

  // Beat 3: end the session through the popup's Friction gate.
  await icon.click();
  // The session actions are on screen as soon as the popup opens, with nothing to unfold first.
  // See docs/superpowers/specs/2026-09-17-popup-visibility-rules.md.
  await popup.getByRole('button', { name: 'End session' }).click();
  const confirm: Locator = popup.getByRole('button', { name: 'End the session' });
  await expect(confirm).toBeEnabled({ timeout: 10_000 });
  await confirm.click();
  await expect(icon).toHaveAttribute('data-locked', 'false');
  await expect(page.locator('[data-beat="end"]')).toHaveClass(/guide-done/);
  await expect(headlines.locator('focus-lock-overlay')).not.toBeAttached();
  await expect(work.locator('#draft')).toHaveValue('Section one: why this matters.');

  expect(errors).toEqual([]);
});
