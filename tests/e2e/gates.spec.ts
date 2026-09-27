import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import { cancelPhrase } from '../../src/shared/constants';
import type { GateState, SessionSnapshot, Settings } from '../../src/shared/types';
import { expect, sendExtensionRequest, startTestSession, test } from './fixtures';
import { revealSessionActions } from './popup-disclosures';

async function captureGate(extPage: Page): Promise<GateState> {
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  if (snapshot.gate === null) throw new Error('Expected an open gate');
  return snapshot.gate;
}

interface FastEconomyOptions {
  pauseMs?: number;
  unlockMs?: number;
  gateDelayMs?: number;
  requireTypedPhrase?: boolean;
}

async function configureFastEconomy(
  extPage: Page,
  options: FastEconomyOptions = {},
): Promise<void> {
  const pauseMs: number = options.pauseMs ?? 1_000;
  const unlockMs: number = options.unlockMs ?? 1_000;
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateSettings',
    settings: {
      ...settings,
      pause: {
        earnRatio: 10,
        capMs: Math.max(60_000, pauseMs, unlockMs),
        pauseMs,
        unlockMs,
      },
      gate: {
        delayMs: options.gateDelayMs ?? 500,
        requireTypedPhrase: options.requireTypedPhrase ?? false,
        allowForceEnd: false,
      },
    },
  });
  if (!ack.ok) throw new Error(ack.error);
}

async function waitForBank(
  extPage: Page,
  amountMs: number,
  timeoutMs: number = 5_000,
): Promise<void> {
  await expect
    .poll(
      async (): Promise<number> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return snapshot.bankMs;
      },
      { timeout: timeoutMs },
    )
    .toBeGreaterThanOrEqual(amountMs);
}

async function clickClosedShadowButton(
  context: BrowserContext,
  page: Page,
  accessibleName: string,
): Promise<void> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    const tree = await session.send('Accessibility.getFullAXTree');
    let backendNodeId: number | undefined;
    for (const node of tree.nodes) {
      if (node.role?.value === 'button' && node.name?.value?.startsWith(accessibleName)) {
        if (
          node.properties?.some(
            (property): boolean => property.name === 'disabled' && property.value.value === true,
          )
        )
          return;
        backendNodeId = node.backendDOMNodeId;
        break;
      }
    }
    if (backendNodeId === undefined) throw new Error(`button not found: ${accessibleName}`);
    const box = await session.send('DOM.getBoxModel', { backendNodeId });
    const [left, top, right, , , bottom] = box.model.content;
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
      throw new Error(`button has no content box: ${accessibleName}`);
    }
    await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  } finally {
    await session.detach();
  }
}

async function openAccessDrawer(context: BrowserContext, page: Page): Promise<void> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    const tree = await session.send('Accessibility.getFullAXTree');
    const summary = tree.nodes.find(
      (node): boolean =>
        node.role?.value === 'DisclosureTriangle' &&
        String(node.name?.value).startsWith('Need a break or site access?'),
    );
    if (summary?.backendDOMNodeId === undefined) return;
    const expanded: boolean =
      summary.properties?.some(
        (property): boolean => property.name === 'expanded' && property.value.value === true,
      ) ?? false;
    if (expanded) return;
    const box = await session.send('DOM.getBoxModel', { backendNodeId: summary.backendDOMNodeId });
    const [left, top, right, , , bottom] = box.model.content;
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
      throw new Error('access drawer summary has no content box');
    }
    await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  } finally {
    await session.detach();
  }
}

async function closedShadowButtonNames(context: BrowserContext, page: Page): Promise<string[]> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    const tree = await session.send('Accessibility.getFullAXTree');
    return tree.nodes
      .filter((node): boolean => node.role?.value === 'button')
      .map((node): string => String(node.name?.value ?? ''));
  } finally {
    await session.detach();
  }
}

async function openOverlayUnlock(
  context: BrowserContext,
  page: Page,
  extPage: Page,
  host: string,
): Promise<void> {
  await expect
    .poll(async (): Promise<string | null> => {
      const current: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
      if (current.gate?.host === host) return host;
      await openAccessDrawer(context, page);
      const names: string[] = await closedShadowButtonNames(context, page);
      if (names.some((name: string): boolean => name.startsWith('Unlock this site '))) {
        await clickClosedShadowButton(context, page, 'Unlock this site ');
      }
      return (await sendExtensionRequest(extPage, { type: 'getSnapshot' })).gate?.host ?? null;
    })
    .toBe(host);
}

test('a pause gate costs credit and confirms without a wait', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const pauseMs: number = 10_000;
  await configureFastEconomy(extPage, { pauseMs });
  const page = await context.newPage();
  await page.goto(siteUrl('/plain.html'));
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.3 } });
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await waitForBank(extPage, pauseMs);
  await openAccessDrawer(context, page);
  await expect
    .poll(async (): Promise<string> => {
      const names: string[] = await closedShadowButtonNames(context, page);
      return names.find((name: string): boolean => name.startsWith('Unlock this site')) ?? '';
    })
    .toBe('Unlock this site 0:01 - costs 0:01 credit');

  expect(
    await sendExtensionRequest(extPage, { type: 'openGate', gate: 'pause', host: null }),
  ).toEqual({ ok: true, code: 'ok' });
  // The credit is the price, so the gate is ready as it opens (docs/product-rules.md, rule 8).
  const opened: GateState = await captureGate(extPage);
  expect(opened.readyAt).toBe(opened.openedAt);

  await expect
    .poll(async (): Promise<boolean> => {
      const ack = await sendExtensionRequest(extPage, {
        type: 'confirmGate',
        expectedGate: await captureGate(extPage),
        typedPhrase: null,
      });
      return ack.ok;
    })
    .toBe(true);
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
    type: 'getSnapshot',
  });
  expect(snapshot.phase).toBe('paused');
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);
});

test('pause gate supports keep focusing, taking a pause, and resuming now', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const pauseMs: number = 10_000;
  await configureFastEconomy(extPage, { pauseMs });
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'));
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 2 } });
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await waitForBank(extPage, pauseMs);

  await revealSessionActions(extPage);
  const pauseButton = extPage.getByRole('button', {
    name: /^Unlock all sites .*access, .*credit/,
  });
  await expect(pauseButton).toBeEnabled();
  await pauseButton.click();
  await extPage.getByRole('button', { name: 'Keep focusing' }).click();
  await revealSessionActions(extPage);
  await expect(pauseButton).toBeEnabled();

  await pauseButton.click();
  const takePause = extPage.getByRole('button', { name: 'Unlock all sites', exact: true });
  await expect(takePause).toBeEnabled();
  await takePause.click();
  await expect(extPage.getByRole('button', { name: 'Resume now' })).toBeVisible();
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);
  const beforeResume: SessionSnapshot = await sendExtensionRequest(extPage, {
    type: 'getSnapshot',
  });
  expect(beforeResume.phase).toBe('paused');
  expect((beforeResume.sessionEndsAt ?? 0) - beforeResume.at).toBeGreaterThan(60_000);

  await extPage.getByRole('button', { name: 'Resume now' }).click();
  await expect
    .poll(async (): Promise<SessionSnapshot['phase']> => {
      const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
        type: 'getSnapshot',
      });
      return snapshot.phase;
    })
    .toBe('focus');
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
});

test('paused UI leaves when the session wall clock ends', async ({ extPage }) => {
  const pauseMs: number = 10_000;
  await configureFastEconomy(extPage, { pauseMs });
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.08 } });
  await waitForBank(extPage, pauseMs);

  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: /^Unlock all sites .*access, .*credit/ }).click();
  await extPage.getByRole('button', { name: 'Unlock all sites', exact: true }).click();
  // The worker answers getSnapshot off its mutation queue on purpose, because serializing the read
  // made it reject for the whole of any storage transition. So a read taken the instant a command
  // is acknowledged can still describe the state before the commit, and the pause is waited for
  // rather than assumed.
  await expect
    .poll(
      async (): Promise<string> =>
        (await sendExtensionRequest(extPage, { type: 'getSnapshot' })).phase,
    )
    .toBe('paused');
  const paused: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  const sessionEndsAt: number | null = paused.sessionEndsAt;
  if (sessionEndsAt === null) throw new Error('paused session has no end');

  await expect.poll((): boolean => Date.now() >= sessionEndsAt + 50, { timeout: 5_000 }).toBe(true);
  await expect(extPage.getByRole('button', { name: 'Resume now' })).toHaveCount(0, {
    timeout: 5_000,
  });
  const ended: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(ended.phase).toBe('idle');
});

test('abandoning a gate records a resisted temptation', async ({ extPage }) => {
  await configureFastEconomy(extPage);
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.3 } });
  await waitForBank(extPage, 1_000);
  expect(
    await sendExtensionRequest(extPage, { type: 'openGate', gate: 'pause', host: null }),
  ).toEqual({ ok: true, code: 'ok' });
  expect(
    await sendExtensionRequest(extPage, {
      type: 'abandonGate',
      expectedGate: await captureGate(extPage),
    }),
  ).toEqual({
    ok: true,
    code: 'ok',
  });

  await expect
    .poll(async (): Promise<number> => {
      const stats = await sendExtensionRequest(extPage, { type: 'getStats', days: 14 });
      return stats.totals.resistedToday;
    })
    .toBe(1);
});

test('hard sessions reject weakening list changes', async ({ extPage }) => {
  await startTestSession(extPage, {
    strictness: 'hard',
    duration: { kind: 'timed', minutes: 0.2 },
  });
  const lists = await sendExtensionRequest(extPage, { type: 'getLists' });
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateLists',
    lists: { ...lists, custom: [] },
  });

  expect(ack.ok).toBe(false);
  if (!ack.ok) expect(ack.error).toMatch(/hard/i);
});

test('friction cancellation without typing uses the configured delay', async ({ extPage }) => {
  const gateDelayMs: number = 3_000;
  await configureFastEconomy(extPage, { gateDelayMs, requireTypedPhrase: false });
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.3 } });
  // A Friction End opens the gate. Only a Flexible session ends on the request itself.
  expect(await sendExtensionRequest(extPage, { type: 'openEndGate' })).toEqual({
    ok: true,
    code: 'ok',
  });

  const early = await sendExtensionRequest(extPage, {
    type: 'confirmGate',
    expectedGate: await captureGate(extPage),
    typedPhrase: null,
  });
  expect(early.ok).toBe(false);

  const opened: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(opened.gate?.readyAt).toBe((opened.gate?.openedAt ?? 0) + gateDelayMs);
  expect(opened.gate?.requiredPhrase).toBeNull();

  await expect
    .poll(
      async (): Promise<boolean> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return snapshot.gate !== null && snapshot.at >= snapshot.gate.readyAt;
      },
      { timeout: 6_000, intervals: [100] },
    )
    .toBe(true);

  expect(
    await sendExtensionRequest(extPage, {
      type: 'confirmGate',
      expectedGate: await captureGate(extPage),
      typedPhrase: null,
    }),
  ).toEqual({ ok: true, code: 'ok' });
  const ended: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(ended.phase).toBe('idle');
});

test('Flexible session ending immediately removes an active block', async ({
  context,
  extPage,
  siteUrl,
}) => {
  await configureFastEconomy(extPage, { gateDelayMs: 30_000, requireTypedPhrase: true });
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'));
  await startTestSession(extPage, {
    duration: { kind: 'timed', minutes: 0.3 },
    strictness: 'flexible',
  });
  await expect(page.locator('focus-lock-overlay')).toBeAttached();

  expect(await sendExtensionRequest(extPage, { type: 'requestSessionEnd' })).toEqual({
    ok: true,
    code: 'ok',
  });
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);
  const ended: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(ended).toMatchObject({ phase: 'idle', gate: null, activeUnlocks: [] });
});

test('zero delay removes the wait but still honors the typing setting', async ({ extPage }) => {
  const requiredPhrase: string = cancelPhrase('e2e test run');
  await configureFastEconomy(extPage, { gateDelayMs: 0, requireTypedPhrase: true });
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.3 } });
  expect(await sendExtensionRequest(extPage, { type: 'openEndGate' })).toEqual({
    ok: true,
    code: 'ok',
  });

  const opened: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(opened.gate?.readyAt).toBe(opened.gate?.openedAt);
  expect(
    await sendExtensionRequest(extPage, {
      type: 'confirmGate',
      expectedGate: await captureGate(extPage),
      typedPhrase: null,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await sendExtensionRequest(extPage, {
      type: 'confirmGate',
      expectedGate: await captureGate(extPage),
      typedPhrase: requiredPhrase,
    }),
  ).toEqual({ ok: true, code: 'ok' });
});

test('friction cancellation with typing requires the configured phrase after its delay', async ({
  extPage,
}) => {
  const gateDelayMs: number = 3_000;
  const requiredPhrase: string = cancelPhrase('e2e test run');
  await configureFastEconomy(extPage, { gateDelayMs, requireTypedPhrase: true });
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.3 } });
  expect(await sendExtensionRequest(extPage, { type: 'openEndGate' })).toEqual({
    ok: true,
    code: 'ok',
  });

  const early = await sendExtensionRequest(extPage, {
    type: 'confirmGate',
    expectedGate: await captureGate(extPage),
    typedPhrase: requiredPhrase,
  });
  expect(early.ok).toBe(false);

  const opened: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(opened.gate?.readyAt).toBe((opened.gate?.openedAt ?? 0) + gateDelayMs);
  expect(opened.gate?.requiredPhrase).toBe(requiredPhrase);

  await expect
    .poll(
      async (): Promise<number> => {
        const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return snapshot.at;
      },
      { timeout: 6_000, intervals: [100] },
    )
    .toBeGreaterThanOrEqual(opened.gate?.readyAt ?? Number.POSITIVE_INFINITY);

  const missing = await sendExtensionRequest(extPage, {
    type: 'confirmGate',
    expectedGate: await captureGate(extPage),
    typedPhrase: null,
  });
  expect(missing.ok).toBe(false);
  const wrong = await sendExtensionRequest(extPage, {
    type: 'confirmGate',
    expectedGate: await captureGate(extPage),
    typedPhrase: 'let me out',
  });
  expect(wrong.ok).toBe(false);
  expect(
    await sendExtensionRequest(extPage, {
      type: 'confirmGate',
      expectedGate: await captureGate(extPage),
      typedPhrase: requiredPhrase,
    }),
  ).toEqual({ ok: true, code: 'ok' });

  const ended: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(ended.phase).toBe('idle');
});

test('hard sessions reject cancellation gates', async ({ extPage }) => {
  await startTestSession(extPage, {
    duration: { kind: 'timed', minutes: 0.3 },
    strictness: 'hard',
  });

  const ack = await sendExtensionRequest(extPage, { type: 'requestSessionEnd' });
  const gateAck = await sendExtensionRequest(extPage, { type: 'openEndGate' });

  expect(ack).toEqual({ ok: false, code: 'end-not-allowed', error: 'end-not-allowed' });
  expect(gateAck).toEqual({ ok: false, code: 'end-not-allowed', error: 'end-not-allowed' });
  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(snapshot.phase).toBe('focus');
  expect(snapshot.gate).toBeNull();
});

test('a newly blocked domain replaces an unlock gate and rejects the old confirmation', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const unlockMs: number = 30_000;
  const gateDelayMs: number = 1_500;
  await configureFastEconomy(extPage, { unlockMs, gateDelayMs });
  const first: Page = await context.newPage();
  await first.goto(siteUrl('/plain.html'));
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 2 } }, [
    { kind: 'host', pattern: 'blocked.example' },
    { kind: 'host', pattern: 'other.example' },
  ]);
  await expect(first.locator('focus-lock-overlay')).toBeAttached();
  await waitForBank(extPage, unlockMs, 10_000);
  await openOverlayUnlock(context, first, extPage, 'blocked.example');
  const original: GateState = await captureGate(extPage);

  const second: Page = await context.newPage();
  await second.goto(siteUrl('/plain.html').replace('blocked.example', 'other.example'));
  await expect(second.locator('focus-lock-overlay')).toBeAttached();
  await openAccessDrawer(context, second);
  const names: string[] = await closedShadowButtonNames(context, second);
  expect(names).not.toContain('Keep focusing');
  expect(names).toContain('Unlock this site 0:30 - costs 0:30 credit');
  await openOverlayUnlock(context, second, extPage, 'other.example');
  const replacement: GateState = await captureGate(extPage);
  expect(replacement.openedAt).toBeGreaterThan(original.openedAt);
  // A spend waits for nothing (docs/product-rules.md, rule 8): the gate is ready as it opens.
  expect(replacement.readyAt).toBe(replacement.openedAt);
  expect((await sendExtensionRequest(extPage, { type: 'getSnapshot' })).activeUnlocks).toEqual([]);
  await expect
    .poll(
      async (): Promise<boolean> =>
        (await closedShadowButtonNames(context, first)).includes('Keep focusing'),
    )
    .toBe(false);
  await expect.poll((): boolean => Date.now() >= replacement.readyAt).toBe(true);
  expect(
    await sendExtensionRequest(extPage, {
      type: 'confirmGate',
      typedPhrase: null,
      expectedGate: original,
    }),
  ).toMatchObject({ ok: false, code: 'no-active-gate' });
  expect(
    await sendExtensionRequest(extPage, { type: 'abandonGate', expectedGate: original }),
  ).toMatchObject({ ok: false, code: 'no-active-gate' });
  expect(await captureGate(extPage)).toEqual(replacement);
  await expect
    .poll(
      async (): Promise<boolean> =>
        (await closedShadowButtonNames(context, second)).includes('Unlock this site'),
    )
    .toBe(true);
  await clickClosedShadowButton(context, second, 'Unlock this site');
  await expect(second.locator('focus-lock-overlay')).toHaveCount(0);
  // Clearing the overlay precedes the stopped document's reload. Keep the test server alive
  // until the restored page has loaded, so fixture teardown cannot refuse that request.
  await expect(second.locator('#marker')).toHaveText('plain page');
  await second.waitForLoadState('load');
  await expect(first.locator('focus-lock-overlay')).toBeAttached();
  const after: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(after.activeUnlocks.map((unlock): string => unlock.host)).toEqual(['other.example']);
});

test('overlay unlock isolates another site and reblocks after expiry', async ({
  context,
  extPage,
  siteUrl,
  worker,
}) => {
  const unlockMs: number = 35_000;
  await configureFastEconomy(extPage, { pauseMs: 1_000, unlockMs });
  const page = await context.newPage();
  const otherPage = await context.newPage();
  const subdomainUrl: string = siteUrl('/plain.html').replace(
    'blocked.example',
    'm.blocked.example',
  );
  const otherUrl: string = siteUrl('/plain.html').replace('blocked.example', 'other.example');
  await page.goto(subdomainUrl);
  await otherPage.goto(otherUrl);
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 1.5 } }, [
    { kind: 'host', pattern: 'blocked.example' },
    { kind: 'host', pattern: 'other.example' },
  ]);
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(otherPage.locator('focus-lock-overlay')).toBeAttached();
  await waitForBank(extPage, unlockMs, 15_000);

  // The click and the durable gate are one round trip apart, so a poll that clicks unconditionally
  // asks for a button the click it already landed has just replaced with the gate panel, and can
  // never recover. It clicks only while the button is still offered, and settles on the gate.
  await expect
    .poll(async (): Promise<string | null> => {
      await openAccessDrawer(context, page);
      // The spend names its clock, the gate's confirm does not, and the confirm is on screen as
      // soon as the gate opens: the trailing space keeps this click on the spend.
      const names: string[] = await closedShadowButtonNames(context, page);
      if (names.some((name: string): boolean => name.startsWith('Unlock this site '))) {
        await clickClosedShadowButton(context, page, 'Unlock this site ');
      }
      const opened: SessionSnapshot = await sendExtensionRequest(extPage, {
        type: 'getSnapshot',
      });
      return opened.gate?.kind ?? null;
    })
    .toBe('unlockSite');
  await expect
    .poll(async (): Promise<boolean> => {
      const ack = await sendExtensionRequest(extPage, {
        type: 'confirmGate',
        expectedGate: await captureGate(extPage),
        typedPhrase: null,
      });
      return ack.ok;
    })
    .toBe(true);

  const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
    type: 'getSnapshot',
  });
  expect(snapshot.activeUnlocks[0]?.host).toBe('blocked.example');
  // The `phase` alarm belongs to the session and holds its next boundary alone. An unlock expiry
  // is not a boundary, so it never lands there: the verdict drops the unlock by instant and the
  // minute tick sweeps the tab back behind the overlay.
  const phaseAlarm: chrome.alarms.Alarm | undefined = await worker.evaluate(
    async (): Promise<chrome.alarms.Alarm | undefined> => await chrome.alarms.get('phase'),
  );
  expect(phaseAlarm?.scheduledTime).toBe(
    Math.min(
      snapshot.phaseEndsAt ?? Number.POSITIVE_INFINITY,
      snapshot.sessionEndsAt ?? Number.POSITIVE_INFINITY,
    ),
  );
  expect(phaseAlarm?.scheduledTime).not.toBe(snapshot.activeUnlocks[0]?.until);
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);
  await expect(page.locator('#marker')).toHaveText('plain page');
  await expect(otherPage.locator('focus-lock-overlay')).toBeAttached();

  await expect
    .poll(
      async (): Promise<number> => {
        const current: SessionSnapshot = await sendExtensionRequest(extPage, {
          type: 'getSnapshot',
        });
        return current.activeUnlocks.length;
      },
      { timeout: 50_000 },
    )
    .toBe(0);
  // The unlock is over by instant, so the page it paid for blocks again on its next visit. The
  // sweep that reblocks a page nobody navigates rides the minute tick, which is too slow for a
  // 60-second test budget and is covered in tests/unit/background/engine-v2-integration.test.ts.
  await page.reload();
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(otherPage.locator('focus-lock-overlay')).toBeAttached();
});

/** Whether the first button whose name starts with `accessibleName` is disabled, or null if absent. */
async function closedShadowButtonDisabled(
  context: BrowserContext,
  page: Page,
  accessibleName: string,
): Promise<boolean | null> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    const tree = await session.send('Accessibility.getFullAXTree');
    const node = tree.nodes.find(
      (candidate): boolean =>
        candidate.role?.value === 'button' &&
        String(candidate.name?.value ?? '').startsWith(accessibleName),
    );
    if (node === undefined) return null;
    return (
      node.properties?.some(
        (property): boolean => property.name === 'disabled' && property.value.value === true,
      ) ?? false
    );
  } finally {
    await session.detach();
  }
}

test('Exclude this site stops blocking the site for good from the blocked page', async ({
  context,
  extPage,
  siteUrl,
}) => {
  // Rule 7 in docs/product-rules.md: the exclusion is on screen with the unlocks, opens the same
  // gate, costs no credit, and its confirmation edits the saved lists the way Settings would.
  const gateDelayMs: number = 500;
  await configureFastEconomy(extPage, { gateDelayMs });
  await startTestSession(extPage, { strictness: 'friction' });
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'));
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  const before: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });

  await expect
    .poll(async (): Promise<string[]> => closedShadowButtonNames(context, page))
    .toContain('Exclude this site');
  await clickClosedShadowButton(context, page, 'Exclude this site');
  await expect
    .poll(async (): Promise<string | null> => {
      const snapshot: SessionSnapshot = await sendExtensionRequest(extPage, {
        type: 'getSnapshot',
      });
      return snapshot.gate === null ? null : `${snapshot.gate.kind}:${String(snapshot.gate.host)}`;
    })
    .toBe('excludeSite:blocked.example');
  const gate: GateState = await captureGate(extPage);
  expect(gate.readyAt - gate.openedAt).toBe(gateDelayMs);
  await expect
    .poll(async (): Promise<string[]> => closedShadowButtonNames(context, page))
    .toContain('Keep focusing');

  // The gate's own confirm carries the action's name and is refused until the delay has passed.
  const early = await sendExtensionRequest(extPage, {
    type: 'confirmGate',
    expectedGate: gate,
    typedPhrase: null,
  });
  expect(early).toMatchObject({ ok: false, code: 'gate-not-ready' });
  await expect
    .poll(
      async (): Promise<boolean | null> =>
        closedShadowButtonDisabled(context, page, 'Exclude this site'),
    )
    .toBe(false);
  await clickClosedShadowButton(context, page, 'Exclude this site');

  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);
  await expect(page.locator('#marker')).toHaveText('plain page');
  const lists = await sendExtensionRequest(extPage, { type: 'getLists' });
  expect(lists.custom).toEqual([]);
  const after: SessionSnapshot = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(after.gate).toBeNull();
  expect(after.activeUnlocks).toEqual([]);
  expect(after.bankMs).toBeGreaterThanOrEqual(before.bankMs);

  // The exclusion outlives this page: a fresh visit is not blocked either.
  const again: Page = await context.newPage();
  await again.goto(siteUrl('/plain.html'));
  await expect(again.locator('#marker')).toHaveText('plain page');
  await expect(again.locator('focus-lock-overlay')).toHaveCount(0);
});

test('a hard session refuses Exclude this site in place', async ({ context, extPage, siteUrl }) => {
  await startTestSession(extPage, { strictness: 'hard' });
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'));
  await expect(page.locator('focus-lock-overlay')).toBeAttached();

  await expect
    .poll(
      async (): Promise<boolean | null> =>
        closedShadowButtonDisabled(context, page, 'Exclude this site'),
    )
    .toBe(true);
  await expect
    .poll(async (): Promise<string[]> => closedShadowButtonNames(context, page))
    .toContainEqual(expect.stringContaining('Not during a hard session'));
  expect(
    await sendExtensionRequest(extPage, {
      type: 'openGate',
      gate: 'excludeSite',
      host: 'blocked.example',
    }),
  ).toMatchObject({ ok: false });
  expect((await sendExtensionRequest(extPage, { type: 'getLists' })).custom).toHaveLength(1);
});
