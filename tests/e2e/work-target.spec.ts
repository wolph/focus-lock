/**
 * The lock screen's return-to-work scenarios, ported from the retired renderer's suite against the
 * v2 start request and this branch's fixtures. The overlay lives in a closed shadow root, so every
 * control is reached through the accessibility tree.
 */
import type { BrowserContext, CDPSession, Page, Worker } from '@playwright/test';
import type { SessionSnapshot } from '../../src/shared/types';
import type { WorkTargetResult } from '../../src/shared/work-target';
import { expect, sendExtensionRequest, startTestSession, test } from './fixtures';

interface AccessibilityProperty {
  name: string;
  value: { value?: unknown };
}

interface AccessibilityNode {
  backendDOMNodeId?: number;
  value?: { value?: unknown };
  role?: { value?: unknown };
  name?: { value?: unknown };
  properties?: AccessibilityProperty[];
}

interface AccessibilityTree {
  nodes: AccessibilityNode[];
}

interface TabIdentity {
  tabId: number;
  windowId: number;
}

test('a stopped page can retry a failed work-tab lookup and choose its target', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const work: Page = await context.newPage();
  await work.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await work.evaluate((): void => {
    document.title = 'Continue this task';
  });
  const chosen: TabIdentity = await identity(worker, work);
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 2 } });
  await worker.evaluate((): void => {
    (globalThis as unknown as { rejectWorkLookup: boolean }).rejectWorkLookup = true;
    chrome.runtime.onMessage.addListener(
      (
        message: unknown,
        sender: chrome.runtime.MessageSender,
        reply: (value: unknown) => void,
      ): void => {
        if (
          (globalThis as unknown as { rejectWorkLookup: boolean }).rejectWorkLookup &&
          sender.url?.startsWith('http://blocked.example:') &&
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'getWorkTarget'
        ) {
          reply({ ok: false, error: 'Temporary lookup failure' });
        }
      },
    );
  });
  const blocked: Page = await context.newPage();
  await blocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blocked.locator('focus-lock-overlay')).toBeAttached();
  const cdp: CDPSession = await context.newCDPSession(blocked);
  try {
    await expect
      .poll(async (): Promise<boolean> => {
        const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
        return tree.nodes.some(
          (node: AccessibilityNode): boolean =>
            node.name?.value === 'Could not load your work tab. Try again, or reload this page.',
        );
      })
      .toBe(true);
    const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
    const button: AccessibilityNode | undefined = tree.nodes.find(
      (node: AccessibilityNode): boolean =>
        node.role?.value === 'button' && node.name?.value === 'Choose a work tab',
    );
    expect(
      button?.properties?.some(
        (property: AccessibilityProperty): boolean =>
          property.name === 'disabled' && property.value.value === true,
      ),
    ).toBe(false);
  } finally {
    await cdp.detach();
  }
  await worker.evaluate((): void => {
    (globalThis as unknown as { rejectWorkLookup: boolean }).rejectWorkLookup = false;
  });
  await clickOverlay(context, blocked, 'Choose a work tab');
  await clickOverlay(context, blocked, 'Continue this task');
  await expect
    .poll(
      async (): Promise<boolean> =>
        worker.evaluate(
          async (tabId: number): Promise<boolean> => (await chrome.tabs.get(tabId)).active,
          chosen.tabId,
        ),
    )
    .toBe(true);
});

async function identity(worker: Worker, page: Page): Promise<TabIdentity> {
  return worker.evaluate(async (url: string): Promise<TabIdentity> => {
    const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({ url });
    const tab: chrome.tabs.Tab | undefined = tabs[0];
    if (tab?.id === undefined) throw new Error('Test tab is missing');
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());
}

async function target(extPage: Page, windowId: number): Promise<WorkTargetResult> {
  return sendExtensionRequest(extPage, { type: 'getWorkTarget', windowId });
}

async function selectTarget(extPage: Page, work: TabIdentity): Promise<string> {
  const current: WorkTargetResult = await target(extPage, work.windowId);
  if (!current.ok || current.sessionId === null) throw new Error('No active test session');
  expect(
    await sendExtensionRequest(extPage, {
      type: 'setWorkTarget',
      sessionId: current.sessionId,
      tabId: work.tabId,
      windowId: work.windowId,
    }),
  ).toEqual({ ok: true });
  return current.sessionId;
}

/** How long the overlay gets to carry the control, which is longer than a loaded CI runner needs. */
const OVERLAY_CONTROL_TIMEOUT_MS: number = 20_000;

/**
 * Clicks one control inside the overlay's shadow root, through the accessibility tree because the
 * control has no page-level selector.
 *
 * The node is looked up and clicked in one attempt, and the attempt is repeated while the overlay
 * refreezes underneath it. A frozen view arrives whenever the worker republishes, which a session
 * start and a work-tab status update both do, and the node the previous tree named is detached by
 * the time it is scrolled to. Reading the tree once and trusting the id afterwards is what made
 * this fail on CI in two different ways: a detached node, and a control that had not arrived yet.
 */
async function clickOverlay(
  context: BrowserContext,
  page: Page,
  name: string,
  role: string = 'button',
): Promise<void> {
  const session: CDPSession = await context.newCDPSession(page);
  const deadline: number = Date.now() + OVERLAY_CONTROL_TIMEOUT_MS;
  let lastFailure: string = `never found ${role} ${name}`;
  try {
    while (Date.now() < deadline) {
      try {
        const tree = await session.send('Accessibility.getFullAXTree');
        const node = tree.nodes.find(
          (entry): boolean =>
            entry.role?.value === role && String(entry.name?.value).startsWith(name),
        );
        if (node?.backendDOMNodeId === undefined) {
          lastFailure = `no ${role} named ${name} in the tree`;
          await page.waitForTimeout(100);
          continue;
        }
        await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendDOMNodeId });
        const box = await session.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
        const [left, top, right, , , bottom] = box.model.content;
        if (
          left === undefined ||
          top === undefined ||
          right === undefined ||
          bottom === undefined
        ) {
          throw new Error('Missing button coordinates');
        }
        await page.mouse.click((left + right) / 2, (top + bottom) / 2);
        return;
      } catch (error: unknown) {
        // A node the overlay replaced between the read and the click is the ordinary race here,
        // and the answer to it is a fresh tree rather than a failed scenario. Anything else is
        // reported once the budget is spent.
        lastFailure = error instanceof Error ? error.message : String(error);
        await page.waitForTimeout(100);
      }
    }
    throw new Error(`Could not click ${role} ${name}: ${lastFailure}`);
  } finally {
    await session.detach();
  }
}

test('the lockscreen returns to the chosen work tab without changing either loaded page', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const workPage: Page = await context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await workPage.evaluate((): void => {
    document.body.innerHTML =
      '<label>Draft<input id="draft"></label><div style="height:3000px"></div>';
  });
  await workPage.locator('#draft').fill('Keep this draft');
  await workPage.evaluate((): void => window.scrollTo(0, 300));
  const work: TabIdentity = await identity(worker, workPage);
  const blockedPage: Page = await context.newPage();
  await blockedPage.goto(siteUrl('/plain.html'));
  await blockedPage.evaluate((): void => {
    (window as unknown as { preserved: string }).preserved = 'existing page';
  });
  await startTestSession(extPage, {
    duration: { kind: 'timed', minutes: 2 },
    intention: 'Write the next example',
  });
  await selectTarget(extPage, work);
  await worker.evaluate(async (tabId: number): Promise<void> => {
    await chrome.windows.create({ tabId, focused: false });
  }, work.tabId);
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
  await blockedPage.bringToFront();
  await clickOverlay(context, blockedPage, 'Back to work');
  await expect
    .poll(
      async (): Promise<boolean> =>
        worker.evaluate(async (id: number): Promise<boolean> => {
          const tab: chrome.tabs.Tab = await chrome.tabs.get(id);
          const win: chrome.windows.Window = await chrome.windows.get(tab.windowId);
          return tab.active && win.focused;
        }, work.tabId),
    )
    .toBe(true);
  await expect(workPage.locator('#draft')).toHaveValue('Keep this draft');
  expect(await workPage.evaluate((): number => window.scrollY)).toBe(300);
  expect(
    await blockedPage.evaluate(
      (): string => (window as unknown as { preserved: string }).preserved,
    ),
  ).toBe('existing page');
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
});

test('returning abandons an open gate without spending access credit', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const workPage: Page = await context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 2 } });
  const work: TabIdentity = await identity(worker, workPage);
  await selectTarget(extPage, work);
  const blockedPage: Page = await context.newPage();
  await blockedPage.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
  const readiness: CDPSession = await context.newCDPSession(blockedPage);
  try {
    // Both async updates move the disclosure while the centred panel settles.
    await expect
      .poll(async (): Promise<boolean> => {
        const tree: AccessibilityTree = await readiness.send('Accessibility.getFullAXTree');
        const hasTarget: boolean = tree.nodes.some(
          (node: AccessibilityNode): boolean =>
            node.role?.value === 'button' && String(node.name?.value).startsWith('Back to work'),
        );
        const hasStoppedNotice: boolean = tree.nodes.some((node: AccessibilityNode): boolean =>
          String(node.name?.value).startsWith('This page did not load.'),
        );
        return hasTarget && hasStoppedNotice;
      })
      .toBe(true);
  } finally {
    await readiness.detach();
  }
  await clickOverlay(context, blockedPage, 'Need a break or site access?', 'DisclosureTriangle');
  await clickOverlay(context, blockedPage, 'End session');
  const beforeReturn: CDPSession = await context.newCDPSession(blockedPage);
  try {
    await expect
      .poll(async (): Promise<boolean> => {
        const tree = await beforeReturn.send('Accessibility.getFullAXTree');
        return tree.nodes.some((node): boolean => node.name?.value === 'End this session');
      })
      .toBe(true);
  } finally {
    await beforeReturn.detach();
  }
  await clickOverlay(context, blockedPage, 'Back to work');
  await expect
    .poll(async (): Promise<boolean> => {
      const current: SessionSnapshot = await sendExtensionRequest(extPage, {
        type: 'getSnapshot',
      });
      return current.gate === null;
    })
    .toBe(true);
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(snapshot.gate).toBeNull();
  expect(snapshot.phase).toBe('focus');
  const events = await sendExtensionRequest(extPage, { type: 'exportEvents' });
  expect(events.json).toContain('gateResisted');
  expect(events.json).not.toContain('pauseTaken');
  expect(events.json).not.toContain('unlockTaken');
  const cdp: CDPSession = await context.newCDPSession(blockedPage);
  try {
    await expect
      .poll(async (): Promise<boolean> => {
        const tree = await cdp.send('Accessibility.getFullAXTree');
        return tree.nodes.some(
          (node): boolean => node.role?.value === 'button' && node.name?.value === 'End session',
        );
      })
      .toBe(true);
  } finally {
    await cdp.detach();
  }
});

test('long next steps scroll with a trackpad and touch while the blocked page stays still', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const page: Page = await context.newPage();
  await page.setViewportSize({ width: 375, height: 500 });
  await page.goto(siteUrl('/plain.html'));
  await page.evaluate((): void => window.scrollTo(0, 300));
  await startTestSession(extPage, {
    duration: { kind: 'timed', minutes: 2 },
    intention: 'Write one small example, then check the result. '.repeat(30),
  });
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  const cdp: CDPSession = await context.newCDPSession(page);
  try {
    const tree = await cdp.send('Accessibility.getFullAXTree');
    const dialog = tree.nodes.find((node): boolean => node.role?.value === 'dialog');
    if (dialog?.backendDOMNodeId === undefined) throw new Error('Overlay dialog missing');
    const remote: { object: { objectId?: string } } = await cdp.send('DOM.resolveNode', {
      backendNodeId: dialog.backendDOMNodeId,
    });
    const scrollTop: () => Promise<number> = async (): Promise<number> => {
      const result = await cdp.send('Runtime.callFunctionOn', {
        objectId: remote.object.objectId,
        functionDeclaration: 'function() { return this.scrollTop; }',
        returnByValue: true,
      });
      return Number(result.result.value);
    };
    await page.mouse.move(180, 250);
    await page.mouse.wheel(0, 400);
    await expect.poll(scrollTop).toBeGreaterThan(0);
    expect(await page.evaluate((): number => window.scrollY)).toBe(300);

    await cdp.send('DOM.focus', { backendNodeId: dialog.backendDOMNodeId });
    await page.keyboard.press('Home');
    await expect.poll(scrollTop).toBe(0);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    // A finger drag made of touch events. Input.synthesizeScrollGesture scrolls on macOS, but
    // headless Chromium on Linux delivers its touchstart and never a touchmove.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 180, y: 400 }],
    });
    for (let step: number = 1; step <= 10; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 180, y: 400 - step * 30 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(scrollTop).toBeGreaterThan(0);
    expect(await page.evaluate((): number => window.scrollY)).toBe(300);
  } finally {
    await cdp.detach();
  }
});

test('a closed work tab can be replaced and stale session actions are rejected', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const workPage: Page = await context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 2 } });
  const work: TabIdentity = await identity(worker, workPage);
  const sessionId: string = await selectTarget(extPage, work);
  await workPage.close();
  await expect
    .poll(async (): Promise<string> => {
      const result: WorkTargetResult = await target(extPage, work.windowId);
      return result.ok ? result.state : result.error;
    })
    .toBe('unavailable');
  const failed = await sendExtensionRequest(extPage, {
    type: 'returnToWork',
    sessionId,
    windowId: work.windowId,
  });
  expect(failed.ok).toBe(false);
  const replacement: Page = await context.newPage();
  await replacement.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await selectTarget(extPage, await identity(worker, replacement));
  const stale = await sendExtensionRequest(extPage, {
    type: 'returnToWork',
    sessionId: 'previous-session',
    windowId: work.windowId,
  });
  expect(stale.ok).toBe(false);
  const current: WorkTargetResult = await target(extPage, work.windowId);
  expect(current.ok && current.state).toBe('ready');
  // A session is judged by the lists as they stand, so blocking the work tab's own site takes the
  // destination away: returning to work must not land on a page the session is now covering.
  const lists = await sendExtensionRequest(extPage, { type: 'getLists' });
  expect(
    await sendExtensionRequest(extPage, {
      type: 'updateLists',
      lists: { ...lists, custom: [...lists.custom, { kind: 'host', pattern: 'other.example' }] },
    }),
  ).toEqual({ ok: true });
  await expect
    .poll(async (): Promise<string> => {
      const result: WorkTargetResult = await target(extPage, work.windowId);
      return result.ok ? result.state : result.error;
    })
    .toBe('unavailable');
  expect(
    await sendExtensionRequest(extPage, {
      type: 'returnToWork',
      sessionId,
      windowId: work.windowId,
    }),
  ).toMatchObject({ ok: false });

  // Unblocking it again gives the destination back, without choosing the tab a second time.
  expect(await sendExtensionRequest(extPage, { type: 'updateLists', lists })).toEqual({ ok: true });
  await expect
    .poll(async (): Promise<string> => {
      const result: WorkTargetResult = await target(extPage, work.windowId);
      return result.ok ? result.state : result.error;
    })
    .toBe('ready');
  expect(
    await sendExtensionRequest(extPage, {
      type: 'returnToWork',
      sessionId,
      windowId: work.windowId,
    }),
  ).toEqual({ ok: true });
});

test('browser restart restores the focus session but clears its work-tab reference', async ({
  restartableExtension,
  siteUrl,
}) => {
  const original = await restartableExtension.launch();
  const workPage: Page = await original.context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await startTestSession(original.extPage, { duration: { kind: 'timed', minutes: 5 } });
  const sessionId: string = await selectTarget(
    original.extPage,
    await identity(original.worker, workPage),
  );
  await restartableExtension.close();
  const restored = await restartableExtension.launch();
  const popup: TabIdentity = await identity(restored.worker, restored.extPage);
  const current: WorkTargetResult = await target(restored.extPage, popup.windowId);
  expect(current.ok && current.sessionId).toBe(sessionId);
  expect(current.ok && current.state).toBe('missing');
  const snapshot: SessionSnapshot = await sendExtensionRequest(restored.extPage, {
    type: 'getSnapshot',
  });
  expect(snapshot.phase).toBe('focus');
});

// The popup's Use this tab flow and its Back to work button belong to the popup task and are
// covered there, so the popup scenario from the retired suite is not ported here.

test('the inline picker offers allowed tabs and returns without losing page input', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const workPage: Page = await context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await workPage.evaluate((): void => {
    document.title = 'Write the next example';
    document.body.innerHTML = '<label>Draft<input id="draft"></label>';
  });
  await workPage.locator('#draft').fill('Keep my draft');
  const work: TabIdentity = await identity(worker, workPage);
  const blockedPage: Page = await context.newPage();
  await blockedPage.goto(siteUrl('/plain.html'));
  await blockedPage.evaluate((): void => {
    document.title = 'Distracting page';
    (window as unknown as { preserved: string }).preserved = 'existing content';
  });
  await startTestSession(extPage, {
    duration: { kind: 'timed', minutes: 2 },
    intention: 'Write one example',
  });
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
  await clickOverlay(context, blockedPage, 'Choose a work tab');
  const cdp: CDPSession = await context.newCDPSession(blockedPage);
  try {
    await expect
      .poll(async (): Promise<boolean> => {
        const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
        return tree.nodes.some(
          (node: AccessibilityNode): boolean =>
            node.role?.value === 'button' &&
            String(node.name?.value).startsWith('Write the next example'),
        );
      })
      .toBe(true);
    const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
    expect(
      tree.nodes.some(
        (node: AccessibilityNode): boolean =>
          node.role?.value === 'button' && String(node.name?.value).includes('Distracting page'),
      ),
    ).toBe(false);
  } finally {
    await cdp.detach();
  }
  await clickOverlay(context, blockedPage, 'Write the next example');
  await expect
    .poll(
      async (): Promise<boolean> =>
        worker.evaluate(async (tabId: number): Promise<boolean> => {
          const tab: chrome.tabs.Tab = await chrome.tabs.get(tabId);
          return tab.active;
        }, work.tabId),
    )
    .toBe(true);
  expect(await target(extPage, work.windowId)).toMatchObject({
    ok: true,
    state: 'ready',
    title: 'Write the next example',
  });
  await expect(workPage.locator('#draft')).toHaveValue('Keep my draft');
  expect(
    await blockedPage.evaluate(
      (): string => (window as unknown as { preserved: string }).preserved,
    ),
  ).toBe('existing content');
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
});

test('the larger picker searches titles and domains before keyboard selection', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const work: Page = await context.newPage();
  await work.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await work.evaluate((): void => {
    document.title = 'Write the generator example';
  });
  const chosen: TabIdentity = await identity(worker, work);
  const notes: Page = await context.newPage();
  await notes.goto(siteUrl('/plain.html').replace('blocked.example', '127.0.0.1'));
  await notes.evaluate((): void => {
    document.title = 'Meeting notes';
  });
  const notesTab: TabIdentity = await identity(worker, notes);
  await expect
    .poll(
      async (): Promise<string | undefined> =>
        worker.evaluate(
          async (tabId: number): Promise<string | undefined> =>
            (await chrome.tabs.get(tabId)).title,
          notesTab.tabId,
        ),
    )
    .toBe('Meeting notes');
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 2 } });
  const blocked: Page = await context.newPage();
  await blocked.setViewportSize({ width: 1280, height: 1000 });
  await blocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blocked.locator('focus-lock-overlay')).toBeAttached();
  await clickOverlay(context, blocked, 'Choose a work tab');
  const cdp: CDPSession = await context.newCDPSession(blocked);
  const hasRow: (title: string) => Promise<boolean> = async (title: string): Promise<boolean> => {
    const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
    return tree.nodes.some(
      (node: AccessibilityNode): boolean =>
        node.role?.value === 'button' && String(node.name?.value).startsWith(title),
    );
  };
  const search: (query: string) => Promise<void> = async (query: string): Promise<void> => {
    await blocked.bringToFront();
    const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
    const field: AccessibilityNode | undefined = tree.nodes.find(
      (node: AccessibilityNode): boolean => node.role?.value === 'searchbox',
    );
    if (field?.backendDOMNodeId === undefined) throw new Error('Search field is missing');
    await cdp.send('DOM.focus', { backendNodeId: field.backendDOMNodeId });
    await blocked.keyboard.press('ControlOrMeta+A');
    await blocked.keyboard.press('Backspace');
    if (query.length > 0) await blocked.keyboard.insertText(query);
    await expect
      .poll(async (): Promise<unknown> => {
        const updated: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
        return (
          updated.nodes.find((node: AccessibilityNode): boolean => node.role?.value === 'searchbox')
            ?.value?.value ?? ''
        );
      })
      .toBe(query);
  };
  try {
    await expect
      .poll(async (): Promise<boolean> => {
        const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
        return tree.nodes.some(
          (node: AccessibilityNode): boolean =>
            node.role?.value === 'searchbox' &&
            node.name?.value === 'Search work tabs' &&
            node.properties?.some(
              (property: AccessibilityProperty): boolean =>
                property.name === 'focused' && property.value.value === true,
            ) === true,
        );
      })
      .toBe(true);
    const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
    const field: AccessibilityNode | undefined = tree.nodes.find(
      (node: AccessibilityNode): boolean => node.role?.value === 'searchbox',
    );
    if (field?.backendDOMNodeId === undefined) throw new Error('Search field is missing');
    const remote: { object: { objectId?: string } } = await cdp.send('DOM.resolveNode', {
      backendNodeId: field.backendDOMNodeId,
    });
    const size: { result: { value?: unknown } } = await cdp.send('Runtime.callFunctionOn', {
      objectId: remote.object.objectId,
      functionDeclaration:
        'function() { return this.closest(".work-picker").getBoundingClientRect().width; }',
      returnByValue: true,
    });
    expect(size.result.value).toBeGreaterThan(650);
    await expect.poll((): Promise<boolean> => hasRow('Meeting notes')).toBe(true);
    const pickerHeight: () => Promise<number> = async (): Promise<number> => {
      const result: { result: { value?: unknown } } = await cdp.send('Runtime.callFunctionOn', {
        objectId: remote.object.objectId,
        functionDeclaration:
          'function() { return this.closest(".work-picker").getBoundingClientRect().height; }',
        returnByValue: true,
      });
      if (typeof result.result.value !== 'number') throw new Error('Picker height is missing');
      return result.result.value;
    };
    const beforeSearch: number = await pickerHeight();
    await search('  GeNeRaToR  example ');
    await expect.poll((): Promise<boolean> => hasRow('Write the generator example')).toBe(true);
    await expect.poll((): Promise<boolean> => hasRow('Meeting notes')).toBe(false);
    await search('127.0.0.1');
    await expect.poll((): Promise<boolean> => hasRow('Meeting notes')).toBe(true);
    await expect.poll((): Promise<boolean> => hasRow('Write the generator example')).toBe(false);
    await search('no matching work tab');
    await expect.poll((): Promise<boolean> => hasRow('Meeting notes')).toBe(false);
    await expect.poll((): Promise<boolean> => hasRow('Write the generator example')).toBe(false);
    expect(await pickerHeight()).toBeCloseTo(beforeSearch, 0);
    await search('');
    await expect.poll((): Promise<boolean> => hasRow('Meeting notes')).toBe(true);
    await search('other.example');
    await expect.poll((): Promise<boolean> => hasRow('Write the generator example')).toBe(true);
    await blocked.keyboard.press('ArrowDown');
    await blocked.keyboard.press('Enter');
    await expect
      .poll(
        async (): Promise<boolean> =>
          worker.evaluate(
            async (tabId: number): Promise<boolean> => (await chrome.tabs.get(tabId)).active,
            chosen.tabId,
          ),
      )
      .toBe(true);
    expect(await target(extPage, chosen.windowId)).toMatchObject({
      ok: true,
      state: 'ready',
      title: 'Write the generator example',
    });
  } finally {
    await cdp.detach();
  }
});

test('refreshing an empty picker keeps keyboard focus inside the lockscreen', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'));
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 2 } });
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await clickOverlay(context, page, 'Choose a work tab');
  await clickOverlay(context, page, 'Refresh tabs');
  const cdp: CDPSession = await context.newCDPSession(page);
  const focused: (name: string) => Promise<boolean> = async (name: string): Promise<boolean> => {
    const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
    return tree.nodes.some(
      (node: AccessibilityNode): boolean =>
        node.role?.value === 'button' &&
        node.name?.value === name &&
        node.properties?.some(
          (property: AccessibilityProperty): boolean =>
            property.name === 'focused' && property.value.value === true,
        ) === true,
    );
  };
  try {
    await expect.poll((): Promise<boolean> => focused('Cancel')).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll((): Promise<boolean> => focused('Choose a work tab')).toBe(true);
  } finally {
    await cdp.detach();
  }
});

test('a pending work tab save can be cancelled with Escape without activating that tab', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const work: Page = await context.newPage();
  await work.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await work.evaluate((): void => {
    document.title = 'Continue the draft';
  });
  const workTab: TabIdentity = await identity(worker, work);
  const blocked: Page = await context.newPage();
  await blocked.goto(siteUrl('/plain.html'));
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 2 } });
  await clickOverlay(context, blocked, 'Choose a work tab');
  await worker.evaluate((): void => {
    const original: typeof chrome.storage.session.set = chrome.storage.session.set.bind(
      chrome.storage.session,
    );
    const state: { release?: () => void } = {};
    (globalThis as unknown as { releaseWorkSave: () => void }).releaseWorkSave = (): void => {
      state.release?.();
    };
    Object.defineProperty(chrome.storage.session, 'set', {
      configurable: true,
      value: async (items: Record<string, unknown>): Promise<void> => {
        if ('workTarget' in items)
          await new Promise<void>((resolve: () => void): void => {
            state.release = resolve;
            (globalThis as unknown as { workSavePending: boolean }).workSavePending = true;
          });
        await original(items);
      },
    });
  });
  await blocked.bringToFront();
  await clickOverlay(context, blocked, 'Continue the draft');
  await expect
    .poll(
      async (): Promise<boolean> =>
        worker.evaluate(
          (): boolean =>
            (globalThis as unknown as { workSavePending?: boolean }).workSavePending === true,
        ),
    )
    .toBe(true);
  const cdp: CDPSession = await context.newCDPSession(blocked);
  try {
    await expect
      .poll(async (): Promise<boolean> => {
        const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
        return tree.nodes.some(
          (node: AccessibilityNode): boolean =>
            node.role?.value === 'button' &&
            node.name?.value === 'Cancel' &&
            node.properties?.some(
              (property: AccessibilityProperty): boolean =>
                property.name === 'focused' && property.value.value === true,
            ) === true,
        );
      })
      .toBe(true);
    await blocked.keyboard.press('Escape');
    await expect
      .poll(async (): Promise<boolean> => {
        const tree: AccessibilityTree = await cdp.send('Accessibility.getFullAXTree');
        return tree.nodes.some(
          (node: AccessibilityNode): boolean => node.name?.value === 'Available work tabs',
        );
      })
      .toBe(false);
  } finally {
    await worker.evaluate((): void =>
      (globalThis as unknown as { releaseWorkSave: () => void }).releaseWorkSave(),
    );
    await cdp.detach();
  }
  await expect
    .poll(async (): Promise<string | null> => {
      const current: WorkTargetResult = await target(extPage, workTab.windowId);
      return current.ok ? current.title : null;
    })
    .toBe('Continue the draft');
  expect(
    await worker.evaluate(
      async (id: number): Promise<boolean> => (await chrome.tabs.get(id)).active,
      workTab.tabId,
    ),
  ).toBe(false);
});

test('typed gate confirmation survives theme and work-tab status updates', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  const settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  expect(
    await sendExtensionRequest(extPage, {
      type: 'updateSettings',
      settings: { ...settings, gate: { ...settings.gate, requireTypedPhrase: true } },
    }),
  ).toEqual({ ok: true });
  const workPage: Page = await context.newPage();
  await workPage.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 2 } });
  await selectTarget(extPage, await identity(worker, workPage));
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await clickOverlay(context, page, 'Need a break or site access?', 'DisclosureTriangle');
  await clickOverlay(context, page, 'End session');
  const cdp: CDPSession = await context.newCDPSession(page);
  try {
    await expect
      .poll(async (): Promise<boolean> => {
        const tree = await cdp.send('Accessibility.getFullAXTree');
        return tree.nodes.some(
          (entry): boolean =>
            entry.role?.value === 'textbox' && entry.name?.value === 'Type this to confirm:',
        );
      })
      .toBe(true);
    const tree = await cdp.send('Accessibility.getFullAXTree');
    const input = tree.nodes.find(
      (entry): boolean =>
        entry.role?.value === 'textbox' && entry.name?.value === 'Type this to confirm:',
    );
    if (input?.backendDOMNodeId === undefined) throw new Error('Gate input missing');
    await cdp.send('DOM.focus', { backendNodeId: input.backendDOMNodeId });
    await page.keyboard.type('Keep this partial phrase');
    expect(await sendExtensionRequest(extPage, { type: 'updateTheme', theme: 'dark' })).toEqual({
      ok: true,
    });
    await workPage.evaluate((): void => {
      document.title = 'Updated work title';
    });
    await expect
      .poll(async (): Promise<string> => {
        const latest = await cdp.send('Accessibility.getFullAXTree');
        const field = latest.nodes.find(
          (entry): boolean => entry.name?.value === 'Type this to confirm:',
        );
        return String(field?.value?.value ?? '');
      })
      .toBe('Keep this partial phrase');
    await page.keyboard.type(' still focused');
    await expect
      .poll(async (): Promise<string> => {
        const latest = await cdp.send('Accessibility.getFullAXTree');
        const field = latest.nodes.find(
          (entry): boolean => entry.name?.value === 'Type this to confirm:',
        );
        return String(field?.value?.value ?? '');
      })
      .toBe('Keep this partial phrase still focused');
  } finally {
    await cdp.detach();
  }
});
