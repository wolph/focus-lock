import type { Page, Worker } from '@playwright/test';
import type { ListsConfig, SessionSnapshotV2 } from '../../src/shared/types';
import type { WorkTargetResult } from '../../src/shared/work-target';
import { expect, sendExtensionRequest, test, waitForLifecycle } from './fixtures';
import { openPopupSection } from './popup-disclosures';

interface TabIdentity {
  tabId: number;
  windowId: number;
}

const BLOCKED_HOST: string = 'blocked.example';

async function seedBlockedList(extPage: Page): Promise<void> {
  const lists: ListsConfig = await sendExtensionRequest(extPage, { type: 'getLists' });
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateLists',
    lists: { ...lists, custom: [{ kind: 'host', pattern: BLOCKED_HOST }] },
  });
  if (!ack.ok) throw new Error(ack.error);
}

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

async function openWorkPage(page: Page, url: string, title: string): Promise<void> {
  await page.goto(url);
  await page.evaluate((value: string): void => {
    document.title = value;
  }, title);
}

test('the popup defaults to the current work tab and can replace a closed target', async ({
  context,
  extPage,
  worker,
  siteUrl,
}) => {
  await seedBlockedList(extPage);
  const workUrl: string = siteUrl('/plain.html').replace(BLOCKED_HOST, 'other.example');
  const workPage: Page = await context.newPage();
  await openWorkPage(workPage, workUrl, 'Write the generator example');
  const work: TabIdentity = await identity(worker, workPage);
  await workPage.bringToFront();
  await extPage.reload();

  await openPopupSection(extPage, 'Session settings');
  const workTab = extPage.getByLabel('Work tab', { exact: true });
  await expect(workTab).toHaveValue(String(work.tabId));
  await workTab.selectOption('');
  await expect(extPage.getByRole('button', { name: 'Use this tab', exact: true })).toHaveCount(0);
  await expect(workTab.locator('option').first()).toHaveText(
    'Write the generator example (Current)',
  );
  await workTab.selectOption(String(work.tabId));
  await expect(workTab).toHaveValue(String(work.tabId));
  await extPage.getByLabel('Intention').fill('Write the first assertion');
  await extPage.getByRole('button', { name: /^Start 25 min focus$/ }).click();

  await expect(extPage.getByRole('button', { name: /^Back to work:/ })).toBeEnabled();
  await expect(extPage.getByRole('button', { name: /^Back to work:/ })).toHaveAccessibleName(
    'Back to work: Write the generator example (other.example)',
  );
  const selected: WorkTargetResult = await target(extPage, work.windowId);
  expect(selected.ok && selected.title).toBe('Write the generator example');
  const snapshot: SessionSnapshotV2 = await waitForLifecycle(extPage, 'active');
  expect(snapshot.config?.intention).toBe('Write the first assertion');

  await workPage.close();
  const replacement: Page = await context.newPage();
  await openWorkPage(replacement, workUrl, 'Finish the example');
  const replacementTab: TabIdentity = await identity(worker, replacement);
  await replacement.bringToFront();
  await extPage.reload();

  await extPage.getByRole('button', { name: 'Choose work tab', exact: true }).click();
  // The running session has no work tab dropdown, so the request focuses the chooser itself.
  // See docs/superpowers/specs/2026-09-17-popup-visibility-rules.md.
  await expect(extPage.getByRole('button', { name: 'Use this tab', exact: true })).toBeFocused();
  await extPage.getByRole('button', { name: 'Use this tab', exact: true }).click();
  await expect
    .poll(async (): Promise<string | null> => {
      const current: WorkTargetResult = await target(extPage, work.windowId);
      return current.ok ? current.title : null;
    })
    .toBe('Finish the example');
  await expect(extPage.getByRole('button', { name: /^Back to work:/ })).toHaveAccessibleName(
    'Back to work: Finish the example (other.example)',
  );

  await extPage.getByRole('button', { name: /^Back to work:/ }).click();
  await expect
    .poll(
      async (): Promise<boolean> =>
        worker.evaluate(async (tabId: number): Promise<boolean> => {
          const tab: chrome.tabs.Tab = await chrome.tabs.get(tabId);
          return tab.active;
        }, replacementTab.tabId),
    )
    .toBe(true);
});
