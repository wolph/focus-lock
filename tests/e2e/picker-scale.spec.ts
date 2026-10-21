/**
 * The chooser at scale, ported from the retired renderer's suite against the v2 start request.
 * The overlay lives in a closed shadow root, so every control is reached through the
 * accessibility tree and one resolved node inside the picker.
 */
import type { CDPSession, Page, Worker } from '@playwright/test';
import type { WorkTab } from '../../src/shared/work-target';
import { expect, sendExtensionRequest, startTestSession, test } from './fixtures';

interface AXNode {
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
}

async function node(cdp: CDPSession, name: string, role: string = 'button'): Promise<number> {
  let found: AXNode | undefined;
  await expect
    .poll(async (): Promise<boolean> => {
      const tree: { nodes: AXNode[] } = await cdp.send('Accessibility.getFullAXTree');
      found = tree.nodes.find(
        (entry: AXNode): boolean =>
          entry.role?.value === role && String(entry.name?.value).startsWith(name),
      );
      return found?.backendDOMNodeId !== undefined;
    })
    .toBe(true);
  return found?.backendDOMNodeId as number;
}

async function isPickerOpen(cdp: CDPSession): Promise<boolean> {
  const tree: { nodes: AXNode[] } = await cdp.send('Accessibility.getFullAXTree');
  return tree.nodes.some(
    (entry: AXNode): boolean =>
      entry.role?.value === 'searchbox' && entry.name?.value === 'Search work tabs',
  );
}

async function click(cdp: CDPSession, page: Page, name: string): Promise<void> {
  // A live-view repaint can replace the control between lookup and measurement. CDP may report
  // a detached node or an unavailable box model, so retry the lookup against the fresh tree.
  for (let attempt: number = 0; attempt < 5; attempt += 1) {
    const id: number = await node(cdp, name);
    try {
      await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: id });
      const box: { model: { content: number[] } } = await cdp.send('DOM.getBoxModel', {
        backendNodeId: id,
      });
      await page.mouse.click(
        ((box.model.content[0] ?? 0) + (box.model.content[2] ?? 0)) / 2,
        ((box.model.content[1] ?? 0) + (box.model.content[5] ?? 0)) / 2,
      );
      return;
    } catch (error: unknown) {
      const unavailable: boolean =
        error instanceof Error &&
        /detached from document|No node with given id|Could not compute box model/u.test(
          error.message,
        );
      if (!unavailable || attempt >= 4) throw error;
    }
    await page.waitForTimeout(100);
  }
}

async function openPicker(cdp: CDPSession, page: Page): Promise<void> {
  // A repaint can move the control after measurement. Confirm the chooser opened before
  // continuing, including when a mouse click lands on the old coordinates.
  for (let attempt: number = 0; attempt < 5; attempt += 1) {
    if (await isPickerOpen(cdp)) return;
    await click(cdp, page, 'Choose a work tab');
    await page.waitForTimeout(100);
  }
  await node(cdp, 'Search work tabs', 'searchbox');
}

async function pickerValue<T>(cdp: CDPSession, expression: string): Promise<T> {
  const remote: { object: { objectId?: string } } = await cdp.send('DOM.resolveNode', {
    backendNodeId: await node(cdp, 'Search work tabs', 'searchbox'),
  });
  const result: { result: { value?: unknown } } = await cdp.send('Runtime.callFunctionOn', {
    objectId: remote.object.objectId,
    functionDeclaration: `function() { const picker = this.closest('.work-picker'); return (${expression}); }`,
    returnByValue: true,
  });
  return result.result.value as T;
}

async function query(cdp: CDPSession, page: Page, value: string): Promise<void> {
  await page.bringToFront();
  await cdp.send('DOM.focus', { backendNodeId: await node(cdp, 'Search work tabs', 'searchbox') });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  if (value !== '') await page.keyboard.insertText(value);
}

async function tabId(worker: Worker, page: Page): Promise<number> {
  return worker.evaluate(async (url: string): Promise<number> => {
    const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({ url });
    const id: number | undefined = tabs[0]?.id;
    if (id === undefined) throw new Error('Owned tab is missing');
    return id;
  }, page.url());
}

test('ten thousand tab records keep DOM bounded and support search and offscreen keyboard navigation', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 5 } });
  await worker.evaluate((): void => {
    const tabs: WorkTab[] = Array.from(
      { length: 10_000 },
      (_: unknown, index: number): WorkTab => ({
        tabId: 100_000 + index,
        title: `Reference ${String(index + 1).padStart(5, '0')}`,
        hostname: `domain${index % 25}.example`,
        lastAccessed: 20_000 - index,
      }),
    );
    chrome.runtime.onMessage.addListener(
      (
        request: unknown,
        sender: chrome.runtime.MessageSender,
        reply: (value: unknown) => void,
      ): void => {
        if (
          !sender.url?.startsWith('http://blocked.example:') ||
          typeof request !== 'object' ||
          request === null ||
          !('type' in request)
        )
          return;
        if (request.type === 'getWorkTabs') reply({ ok: true, tabs });
        if (request.type === 'getWorkTabIcon') reply({ ok: true, icon: null });
      },
    );
  });
  const blocked: Page = await context.newPage();
  await blocked.setViewportSize({ width: 1280, height: 1000 });
  await blocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blocked.locator('focus-lock-overlay')).toBeAttached();
  const cdp: CDPSession = await context.newCDPSession(blocked);
  try {
    await openPicker(cdp, blocked);
    await node(cdp, 'Reference 00001');
    const rendered: () => Promise<number> = (): Promise<number> =>
      pickerValue(cdp, 'picker.querySelectorAll(".work-tab-option").length');
    expect(await rendered()).toBeLessThan(24);
    expect(await pickerValue<number>(cdp, 'picker.getBoundingClientRect().width')).toBeGreaterThan(
      1200,
    );
    expect(await pickerValue<number>(cdp, 'picker.getBoundingClientRect().height')).toBeGreaterThan(
      920,
    );
    await query(cdp, blocked, '');
    await blocked.keyboard.press('ArrowDown');
    await blocked.keyboard.press('End');
    await node(cdp, 'Reference 10000');
    expect(
      await pickerValue<string>(
        cdp,
        'this.getRootNode().activeElement?.getAttribute("aria-label")',
      ),
    ).toContain('Reference 10000');
    expect(await rendered()).toBeLessThan(24);
    await blocked.keyboard.press('Home');
    expect(
      await pickerValue<string>(
        cdp,
        'this.getRootNode().activeElement?.getAttribute("aria-label")',
      ),
    ).toContain('Reference 00001');
    await blocked.keyboard.press('ArrowDown');
    await pickerValue(cdp, '(picker.querySelector(".work-picker-list").scrollTop = 20)');
    await expect
      .poll(
        (): Promise<string> =>
          pickerValue(cdp, 'this.getRootNode().activeElement?.getAttribute("aria-label")'),
      )
      .toContain('Reference 00002');
    await query(cdp, blocked, 'unmatched');
    await query(cdp, blocked, '10000 DOMAIN24');
    await expect.poll(rendered).toBe(1);
    await node(cdp, 'Reference 10000');
    await query(cdp, blocked, '');
    await expect.poll(rendered).toBeGreaterThan(1);
    expect(await rendered()).toBeLessThan(24);
    await blocked.setViewportSize({ width: 375, height: 500 });
    await expect.poll(rendered).toBeLessThan(14);
    expect(
      await pickerValue<number>(cdp, 'picker.getBoundingClientRect().right'),
    ).toBeLessThanOrEqual(375);
    await blocked.keyboard.press('Escape');
    await node(cdp, 'Choose a work tab');
  } finally {
    await cdp.detach();
  }
});

test('the picker shows cached favicons, recent tabs and labelled return destinations', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const older: Page = await context.newPage();
  await older.goto(siteUrl('/icon.html').replace('blocked.example', 'other.example'));
  const olderId: number = await tabId(worker, older);
  await expect
    .poll(
      (): Promise<string | undefined> =>
        worker.evaluate(
          async (id: number): Promise<string | undefined> => (await chrome.tabs.get(id)).favIconUrl,
          olderId,
        ),
    )
    .toContain('/icon.png');
  const recent: Page = await context.newPage();
  await recent.goto(siteUrl('/plain.html').replace('blocked.example', '127.0.0.1'));
  await recent.evaluate((): void => {
    document.title = 'Most recent reference';
  });
  const recentId: number = await tabId(worker, recent);
  await worker.evaluate(async (id: number): Promise<void> => {
    await chrome.tabs.update(id, { active: true });
  }, recentId);
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 5 } });
  const blocked: Page = await context.newPage();
  await blocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blocked.locator('focus-lock-overlay')).toBeAttached();
  const cdp: CDPSession = await context.newCDPSession(blocked);
  try {
    await openPicker(cdp, blocked);
    await node(cdp, 'Most recent reference');
    expect(
      await pickerValue<string[]>(
        cdp,
        'Array.from(picker.querySelectorAll(".work-tab-title"), element => element.textContent)',
      ),
    ).toEqual(['Most recent reference', 'Reference with a cached icon']);
    await expect
      .poll(
        (): Promise<number> =>
          pickerValue(
            cdp,
            'Array.from(picker.querySelectorAll(".work-tab-option img")).filter(image => image.complete && image.naturalWidth > 0).length',
          ),
      )
      .toBeGreaterThan(0);
    expect(
      await pickerValue<boolean>(
        cdp,
        'Array.from(picker.querySelectorAll(".work-tab-option img")).every(image => image.src.startsWith("data:image/png;base64,"))',
      ),
    ).toBe(true);
    const colours: string[] = await pickerValue(
      cdp,
      'Array.from(picker.querySelectorAll(".work-tab-option"), element => element.style.getPropertyValue("--tab-colour"))',
    );
    expect(colours[0]).toBeTruthy();
    expect(colours[0]).not.toBe(colours[1]);
    await click(cdp, blocked, 'Cancel');
    const windowId: number = await worker.evaluate(
      async (id: number): Promise<number> => (await chrome.tabs.get(id)).windowId,
      recentId,
    );
    const current = await sendExtensionRequest(extPage, { type: 'getWorkTarget', windowId });
    if (!current.ok || current.sessionId === null) throw new Error('Test session is missing');
    expect(
      await sendExtensionRequest(extPage, {
        type: 'setWorkTarget',
        sessionId: current.sessionId,
        tabId: recentId,
        windowId,
      }),
    ).toEqual({ ok: true });
    // The worker's workTargetChanged push re-reads the target, so the lock screen names the
    // destination on its own button without a reload. The popup's own button is the popup
    // task's scenario.
    const label: string = 'Back to work: Most recent reference (127.0.0.1)';
    await node(cdp, label);
    await click(cdp, blocked, label);
    await expect
      .poll(
        (): Promise<boolean> =>
          worker.evaluate(
            async (id: number): Promise<boolean> => (await chrome.tabs.get(id)).active,
            recentId,
          ),
      )
      .toBe(true);
  } finally {
    await cdp.detach();
  }
});
