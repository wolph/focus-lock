/**
 * What a Settings edit does to the session already running.
 *
 * The session used to be judged by the rules it captured at its start, so a block added mid-session
 * did nothing until the next one and the person watching the site stay reachable had no way to tell
 * why. These assert the two directions on a page that is already open, and the one exception: a
 * hard lock still refuses to unblock anything, and now holds the edit until it ends.
 */

import type { Page } from '@playwright/test';
import type { ListsConfig, Rule } from '../../src/shared/types';
import {
  expect,
  sendExtensionRequest,
  startTestSession,
  startUntilStoppedSession,
  test,
  waitForLifecycle,
} from './fixtures';

const NOTHING_BLOCKED: Rule[] = [{ kind: 'host', pattern: 'nothing.example' }];
const BLOCKED: Rule[] = [{ kind: 'host', pattern: 'blocked.example' }];

function listsWith(custom: Rule[]): ListsConfig {
  return {
    custom,
    whitelist: [],
    categories: {
      social: false,
      video: false,
      news: false,
      mail: false,
      shopping: false,
      gaming: false,
      forums: false,
    },
    exclusions: {},
  };
}

async function saveLists(extPage: Page, custom: Rule[]): Promise<{ ok: boolean; error?: string }> {
  return await sendExtensionRequest(extPage, { type: 'updateLists', lists: listsWith(custom) });
}

test('a block added during a Flexible session reaches the tab already open', async ({
  context,
  extPage,
  siteUrl,
}) => {
  await startUntilStoppedSession(extPage, {}, NOTHING_BLOCKED);
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'), { waitUntil: 'commit' }).catch((): null => null);
  await expect(page.locator('focus-lock-overlay')).not.toBeAttached();

  expect(await saveLists(extPage, [...NOTHING_BLOCKED, ...BLOCKED])).toMatchObject({ ok: true });

  // The page that was allowed a moment ago is covered now, without being reloaded by hand.
  await expect(page.locator('focus-lock-overlay')).toBeAttached({ timeout: 10_000 });
});

test('a block removed during a Flexible session clears the tab already open', async ({
  context,
  extPage,
  siteUrl,
}) => {
  await startUntilStoppedSession(extPage, {}, BLOCKED);
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'), { waitUntil: 'commit' }).catch((): null => null);
  await expect(page.locator('focus-lock-overlay')).toBeAttached({ timeout: 10_000 });

  expect(await saveLists(extPage, NOTHING_BLOCKED)).toMatchObject({ ok: true });

  await expect(page.locator('focus-lock-overlay')).not.toBeAttached({ timeout: 10_000 });
});

test('a hard lock takes a new block at once and holds a removal until it ends', async ({
  context,
  extPage,
  siteUrl,
}) => {
  // A timed hard session, short enough that the test can wait out the lock it cannot end.
  await startTestSession(
    extPage,
    { strictness: 'hard', duration: { kind: 'timed', minutes: 0.2 } },
    NOTHING_BLOCKED,
  );
  const page: Page = await context.newPage();
  await page.goto(siteUrl('/plain.html'), { waitUntil: 'commit' }).catch((): null => null);

  // Strengthening is allowed under a hard lock, and it applies to the open tab like any other.
  expect(await saveLists(extPage, [...NOTHING_BLOCKED, ...BLOCKED])).toMatchObject({ ok: true });
  await expect(page.locator('focus-lock-overlay')).toBeAttached({ timeout: 10_000 });

  // Weakening is refused, and the edit is held rather than thrown away.
  expect(await saveLists(extPage, NOTHING_BLOCKED)).toMatchObject({ ok: false });
  const held: { changes: Array<{ path: string }> } = await sendExtensionRequest(extPage, {
    type: 'getPendingChanges',
  });
  expect(held.changes).toMatchObject([{ path: 'lists' }]);
  const stillBlocking: ListsConfig = await sendExtensionRequest(extPage, { type: 'getLists' });
  expect(stillBlocking.custom).toMatchObject([
    { pattern: 'nothing.example' },
    { pattern: 'blocked.example' },
  ]);

  await waitForLifecycle(extPage, 'idle', 60_000);

  // The lock is over, so the edit it was holding applies on its own.
  await expect
    .poll(
      async (): Promise<unknown> =>
        (await sendExtensionRequest(extPage, { type: 'getPendingChanges' })).changes,
      { timeout: 15_000 },
    )
    .toEqual([]);
  const afterwards: ListsConfig = await sendExtensionRequest(extPage, { type: 'getLists' });
  expect(afterwards.custom).toMatchObject([{ pattern: 'nothing.example' }]);
});
