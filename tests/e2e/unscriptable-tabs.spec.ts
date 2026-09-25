/**
 * A tab the browser will not let the extension into must not refuse the person a session.
 *
 * Every open http tab is an enforcement target, and a document with no listener used to be fatal
 * without asking why it had none. One tab showing "This site can't be reached" was therefore
 * enough to make every start answer `tab-enforcement-failed`, with nothing on screen naming the
 * tab responsible. An error document can host no content script and can show no blocked site
 * either, so it is recorded as excluded and the session starts.
 */

import type { Page } from '@playwright/test';
import { DEFAULT_LISTS, rulesFromLists } from '../../src/shared/constants';
import type { ListsConfig, SessionSnapshotV2 } from '../../src/shared/types';
import { beginExpectedRequestErrorWindow } from './browser-diagnostics';
import {
  browserDiagnosticsFor,
  expect,
  sendExtensionRequest,
  test,
  waitForLifecycle,
} from './fixtures';

/** A host on a port nothing answers, so the tab commits an address and then fails to load it. */
const UNREACHABLE_URL: string = 'http://blocked.example:44322/';

const BLOCKED: ListsConfig = {
  ...DEFAULT_LISTS,
  custom: [{ kind: 'host', pattern: 'blocked.example' }],
};

test('a start is not refused by a tab that failed to load', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const ordinary: Page = await context.newPage();
  await ordinary.goto(siteUrl('/plain.html'), { waitUntil: 'commit' }).catch((): null => null);

  const closeRequestWindow: () => void = beginExpectedRequestErrorWindow(
    browserDiagnosticsFor(context),
    UNREACHABLE_URL,
  );
  try {
    const dead: Page = await context.newPage();
    await dead.goto(UNREACHABLE_URL, { waitUntil: 'commit' }).catch((): null => null);

    await sendExtensionRequest(extPage, { type: 'updateLists', lists: BLOCKED });
    const ack: unknown = await sendExtensionRequest(extPage, {
      type: 'startSession',
      config: {
        mode: 'blacklist',
        strictness: 'hard',
        duration: { kind: 'timed', minutes: 25 },
        cycling: null,
        intention: 'lock it',
        source: 'manual',
        scheduleOccurrence: null,
        rules: rulesFromLists(BLOCKED),
      },
    });

    expect(ack).toMatchObject({ ok: true });
    const snapshot: SessionSnapshotV2 = await waitForLifecycle(extPage, 'active');
    expect(snapshot.lifecycle.kind).toBe('active');

    // The page that can be reached is still covered, so the exclusion cost one document and not
    // the blocking the session exists for.
    await expect(ordinary.locator('focus-lock-overlay')).toBeAttached({ timeout: 10_000 });
  } finally {
    closeRequestWindow();
  }
});
