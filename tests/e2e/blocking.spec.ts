import type { Buffer } from 'node:buffer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, CDPSession, Frame, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { expect, startTestSession, test } from './fixtures';

const BLOCK_LIST_PROVENANCE: string = 'Blocked by your block list: blocked.example';
const OVERLAY_VIEWPORTS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 375, height: 667 },
  { width: 768, height: 800 },
  { width: 1280, height: 800 },
];

interface ElementBounds {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

interface DomNodeSnapshot {
  attributes?: string[];
  backendNodeId: number;
  children?: DomNodeSnapshot[];
  nodeName: string;
  shadowRoots?: DomNodeSnapshot[];
}

interface OverlayDomState {
  backdropBackendNodeId: number;
  backendNodeIds: ReadonlySet<number>;
  panelBackendNodeId: number;
}

function boxBounds(quad: number[]): ElementBounds {
  const xs: number[] = quad.filter((_value: number, index: number): boolean => index % 2 === 0);
  const ys: number[] = quad.filter((_value: number, index: number): boolean => index % 2 === 1);
  return {
    bottom: Math.max(...ys),
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
  };
}

function flattenDomNode(node: DomNodeSnapshot): DomNodeSnapshot[] {
  const descendants: DomNodeSnapshot[] = [node];
  for (const child of node.children ?? []) descendants.push(...flattenDomNode(child));
  for (const shadowRoot of node.shadowRoots ?? []) {
    descendants.push(...flattenDomNode(shadowRoot));
  }
  return descendants;
}

function hasClass(node: DomNodeSnapshot, className: string): boolean {
  const attributes: string[] = node.attributes ?? [];
  for (let index: number = 0; index < attributes.length; index += 2) {
    if (attributes[index] === 'class') {
      return attributes[index + 1]?.split(/\s+/).includes(className) ?? false;
    }
  }
  return false;
}

async function overlayDomState(session: CDPSession): Promise<OverlayDomState> {
  await session.send('DOM.enable');
  const document = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const allNodes: DomNodeSnapshot[] = flattenDomNode(document.root as DomNodeSnapshot);
  const host: DomNodeSnapshot | undefined = allNodes.find(
    (node: DomNodeSnapshot): boolean => node.nodeName === 'FOCUS-LOCK-OVERLAY',
  );
  if (host === undefined) throw new Error('overlay host was not found');
  const overlayNodes: DomNodeSnapshot[] = (host.shadowRoots ?? []).flatMap(
    (shadowRoot: DomNodeSnapshot): DomNodeSnapshot[] => flattenDomNode(shadowRoot),
  );
  const panel: DomNodeSnapshot | undefined = overlayNodes.find((node: DomNodeSnapshot): boolean =>
    hasClass(node, 'panel'),
  );
  if (panel === undefined) throw new Error('overlay panel was not found');
  const backdrop: DomNodeSnapshot | undefined = overlayNodes.find(
    (node: DomNodeSnapshot): boolean => hasClass(node, 'backdrop'),
  );
  if (backdrop === undefined) throw new Error('overlay backdrop was not found');
  return {
    backdropBackendNodeId: backdrop.backendNodeId,
    backendNodeIds: new Set<number>(
      overlayNodes.map((node: DomNodeSnapshot): number => node.backendNodeId),
    ),
    panelBackendNodeId: panel.backendNodeId,
  };
}

async function overlayAccessibilityState(
  session: CDPSession,
  expectedLabel: string,
): Promise<{ labelBackendNodeId: number | null; matchingLinkCount: number }> {
  const overlay: OverlayDomState = await overlayDomState(session);
  const tree = await session.send('Accessibility.getFullAXTree');
  const scopedLabelNode = tree.nodes.find(
    (node): boolean =>
      node.backendDOMNodeId !== undefined &&
      overlay.backendNodeIds.has(node.backendDOMNodeId) &&
      node.role?.value === 'StaticText' &&
      node.name?.value === expectedLabel,
  );
  return {
    labelBackendNodeId: scopedLabelNode?.backendDOMNodeId ?? null,
    matchingLinkCount: tree.nodes.filter(
      (node): boolean =>
        node.backendDOMNodeId !== undefined &&
        overlay.backendNodeIds.has(node.backendDOMNodeId) &&
        node.role?.value === 'link' &&
        node.name?.value === expectedLabel,
    ).length,
  };
}

async function panelBounds(session: CDPSession): Promise<ElementBounds> {
  const overlay: OverlayDomState = await overlayDomState(session);
  const box = await session.send('DOM.getBoxModel', {
    backendNodeId: overlay.panelBackendNodeId,
  });
  return boxBounds(box.model.border);
}

/** How far the overlay's backdrop, the one scroll container on the blocked page, can scroll. */
async function backdropScrollRange(session: CDPSession): Promise<number> {
  const overlay: OverlayDomState = await overlayDomState(session);
  const resolved = await session.send('DOM.resolveNode', {
    backendNodeId: overlay.backdropBackendNodeId,
  });
  if (resolved.object.objectId === undefined) throw new Error('overlay backdrop has no object');
  const range = await session.send('Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: 'function () { return this.scrollHeight - this.clientHeight; }',
    returnByValue: true,
  });
  return Number(range.result.value);
}

async function assertAndCaptureOverlay(
  context: BrowserContext,
  page: Page,
  surface: 'existing' | 'stopped',
): Promise<void> {
  const evidenceDir: string | undefined = process.env.TASK4_EVIDENCE_DIR;
  if (evidenceDir !== undefined) await mkdir(path.resolve(evidenceDir), { recursive: true });
  for (const viewport of OVERLAY_VIEWPORTS) {
    await page.setViewportSize(viewport);
    const session: CDPSession = await context.newCDPSession(page);
    try {
      await expect
        .poll(
          async (): Promise<{ labelBackendNodeId: number | null; matchingLinkCount: number }> =>
            await overlayAccessibilityState(session, BLOCK_LIST_PROVENANCE),
        )
        .toEqual({ labelBackendNodeId: expect.any(Number), matchingLinkCount: 0 });
      const accessibility = await overlayAccessibilityState(session, BLOCK_LIST_PROVENANCE);
      if (accessibility.labelBackendNodeId === null) {
        throw new Error('overlay provenance text was not found');
      }
      const panel: ElementBounds = await panelBounds(session);
      expect(panel.left).toBeGreaterThanOrEqual(0);
      expect(panel.top).toBeGreaterThanOrEqual(0);
      expect(panel.right).toBeLessThanOrEqual(viewport.width);
      // Site access is open from the first paint (docs/product-rules.md, rule 7), so on a short
      // phone screen the panel runs past the fold. What is below it has to be one scroll away.
      const overflow: number = Math.max(0, panel.bottom - viewport.height);
      expect(await backdropScrollRange(session)).toBeGreaterThanOrEqual(Math.floor(overflow));
      const widths: { clientWidth: number; scrollWidth: number } = await page.evaluate(
        (): { clientWidth: number; scrollWidth: number } => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }),
      );
      expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
      if (evidenceDir === undefined) continue;
      const stem: string = `${surface}-${viewport.width}`;
      await page.screenshot({
        path: path.join(path.resolve(evidenceDir), `${stem}-full.png`),
        animations: 'disabled',
      });
      const labelBox = await session.send('DOM.getBoxModel', {
        backendNodeId: accessibility.labelBackendNodeId,
      });
      const label: ElementBounds = boxBounds(labelBox.model.border);
      const padding: number = 24;
      const x: number = Math.max(0, label.left - padding);
      const y: number = Math.max(0, label.top - padding);
      await page.screenshot({
        path: path.join(path.resolve(evidenceDir), `${stem}-provenance.png`),
        animations: 'disabled',
        clip: {
          x,
          y,
          width: Math.min(viewport.width - x, label.right - label.left + padding * 2),
          height: Math.min(viewport.height - y, label.bottom - label.top + padding * 2),
        },
      });
    } finally {
      await session.detach();
    }
  }
}

test('fresh navigation to a blocked site is stopped and overlaid', async ({
  context,
  extPage,
  siteUrl,
}) => {
  await startTestSession(extPage);
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });

  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(page).toHaveTitle(/Locked/);
  await assertAndCaptureOverlay(context, page, 'stopped');
  await expect
    .poll(async (): Promise<boolean> => {
      const screenshot: Buffer = await page.screenshot();
      const image: PNG = PNG.sync.read(screenshot);
      const offset: number = (5 * image.width + 5) * 4;
      const red: number = image.data[offset] ?? 255;
      const green: number = image.data[offset + 1] ?? 255;
      const blue: number = image.data[offset + 2] ?? 255;
      const alpha: number = image.data[offset + 3] ?? 0;
      return red === 248 && green === 250 && blue === 252 && alpha === 255;
    })
    .toBe(true);
  await expect(page.locator('#marker')).toHaveCount(0);
});

test('existing tab overlays, mutes, and resumes without reload', async ({
  context,
  extPage,
  siteUrl,
  worker,
}) => {
  const url: string = siteUrl('/plain.html');
  const page = await context.newPage();
  await page.goto(url);
  let navigationEvents: number = 0;
  page.on('framenavigated', (frame: Frame): void => {
    if (frame === page.mainFrame()) navigationEvents += 1;
  });
  await page.locator('#keep').fill('still here');
  await page.evaluate((): void => {
    (window as typeof window & { __focusLockAlive?: boolean }).__focusLockAlive = true;
    const decoy: HTMLDivElement = document.createElement('div');
    decoy.className = 'panel';
    decoy.style.position = 'fixed';
    decoy.style.left = '2000px';
    decoy.textContent = 'Blocked by your block list: blocked.example';
    document.body.appendChild(decoy);
  });

  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.12 } });
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await assertAndCaptureOverlay(context, page, 'existing');
  await expect
    .poll(async (): Promise<boolean> => {
      const tabs: chrome.tabs.Tab[] = await worker.evaluate(
        async (): Promise<chrome.tabs.Tab[]> => await chrome.tabs.query({}),
      );
      return tabs.some(
        (tab: chrome.tabs.Tab): boolean => tab.url === url && tab.mutedInfo?.muted === true,
      );
    })
    .toBe(true);

  await expect(page.locator('focus-lock-overlay')).toHaveCount(0, { timeout: 20_000 });
  expect(
    await page.evaluate(
      (): boolean =>
        (window as typeof window & { __focusLockAlive?: boolean }).__focusLockAlive === true,
    ),
  ).toBe(true);
  await expect(page.locator('#keep')).toHaveValue('still here');
  expect(navigationEvents).toBe(0);
  await expect
    .poll(async (): Promise<boolean> => {
      const tabs: chrome.tabs.Tab[] = await worker.evaluate(
        async (): Promise<chrome.tabs.Tab[]> => await chrome.tabs.query({}),
      );
      return tabs.some(
        (tab: chrome.tabs.Tab): boolean => tab.url === url && tab.mutedInfo?.muted === false,
      );
    })
    .toBe(true);
});

test('a stopped tab reloads after the session ends', async ({ context, extPage, siteUrl }) => {
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.12 } });
  const page = await context.newPage();
  await page.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });

  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(page.locator('#marker')).toHaveCount(0);
  await expect(page.locator('#marker')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);
  await expect(page).toHaveTitle('Plain test page');
});

test('SPA history navigation is blocked without a reload', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const page = await context.newPage();
  await page.goto(siteUrl('/spa.html'));
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.3 } }, [
    { kind: 'regex', pattern: 'blocked\\.example(?::\\d+)?/shorts' },
  ]);
  await expect(page.locator('focus-lock-overlay')).toHaveCount(0);

  await page.locator('#navigate').click();
  await expect(page).toHaveURL(/blocked\.example.*\/shorts\/feed/);
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect(page.locator('#marker')).toHaveText('shorts feed');
});

test('a blocked media tab is muted', async ({ context, extPage, siteUrl, worker }) => {
  const url: string = siteUrl('/media.html');
  const page = await context.newPage();
  await page.goto(url);
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 0.12 } });

  await expect(page.locator('focus-lock-overlay')).toBeAttached();
  await expect
    .poll(async (): Promise<boolean> => {
      const tabs: chrome.tabs.Tab[] = await worker.evaluate(
        async (): Promise<chrome.tabs.Tab[]> => await chrome.tabs.query({}),
      );
      return tabs.some(
        (tab: chrome.tabs.Tab): boolean => tab.url === url && tab.mutedInfo?.muted === true,
      );
    })
    .toBe(true);
});
