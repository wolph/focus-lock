import type { Page } from '@playwright/test';
import { decodeListsSyncSnapshot } from '../../src/background/list-sync-codec';
import {
  LOCAL_FIRST_SYNC_PUBLICATION,
  LOCAL_LISTS,
  LOCAL_ONBOARDING_DRAFT,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
  LOCAL_SYNC_JOURNAL,
  SYNC_SETTINGS,
} from '../../src/shared/storage-keys';
import type {
  ListsConfig,
  SessionConfig,
  SessionSnapshot,
  SetupState,
} from '../../src/shared/types';
import {
  assertNoUnexpectedBrowserDiagnostics,
  type BrowserDiagnostics,
} from './browser-diagnostics';
import {
  expect,
  type FreshInstallLaunch,
  sendExtensionRequest,
  startTestSession,
  test,
} from './fixtures';

test.setTimeout(90_000);

function expectNoDiagnostics(diagnostics: BrowserDiagnostics): void {
  expect((): void => assertNoUnexpectedBrowserDiagnostics(diagnostics)).not.toThrow();
}

async function currentSetup(launch: FreshInstallLaunch): Promise<SetupState> {
  return await sendExtensionRequest(launch.extPage, { type: 'getSetupState' });
}

test('fresh install has no host access and popup routes to unfinished setup', async ({
  freshInstallExtension,
}) => {
  const launch: FreshInstallLaunch = await freshInstallExtension.launch();
  const diagnostics: BrowserDiagnostics = freshInstallExtension.diagnostics;

  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(false);
  expect(await freshInstallExtension.dynamicRegistrations()).toEqual([]);
  expect(await currentSetup(launch)).toMatchObject({
    completed: false,
    websiteAccess: 'denied',
    blockingRegistration: 'unavailable',
    storageMode: null,
  });
  await expect(launch.onboardingPage).toHaveURL(freshInstallExtension.onboardingUrl());
  await expect(
    launch.onboardingPage.getByRole('heading', { name: 'Choose your starting block list' }),
  ).toBeVisible();
  await expect(
    launch.extPage.getByRole('heading', { name: 'Finish setting up Focus Lock' }),
  ).toBeVisible();
  await expect(launch.extPage.getByRole('button', { name: /^Start/ })).toHaveCount(0);
  expectNoDiagnostics(diagnostics);
});

test('setup completion waits for delayed initial load and step transitions', async ({
  freshInstallExtension,
}) => {
  test.info().setTimeout(15_000);
  const launch: FreshInstallLaunch = await freshInstallExtension.launch();
  await launch.onboardingPage.addInitScript((delayMs: number): void => {
    const originalSendMessage: typeof chrome.runtime.sendMessage = chrome.runtime.sendMessage.bind(
      chrome.runtime,
    );
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable: true,
      value: async (...args: Parameters<typeof chrome.runtime.sendMessage>): Promise<unknown> => {
        await new Promise<void>((resolve: () => void): void => {
          globalThis.setTimeout(resolve, delayMs);
        });
        return await originalSendMessage(...args);
      },
    });
  }, 200);

  expect(await freshInstallExtension.completeSetup('local')).toMatchObject({
    completed: true,
    storageMode: 'local',
  });
});

test('denied access can be retried, completed locally, and block a real page', async ({
  freshInstallExtension,
  siteUrl,
}) => {
  let launch: FreshInstallLaunch = await freshInstallExtension.launch();
  const diagnostics: BrowserDiagnostics = freshInstallExtension.diagnostics;
  await launch.onboardingPage.getByRole('button', { name: 'Continue' }).click();

  await freshInstallExtension.denyWebsiteAccess();
  await expect(
    launch.onboardingPage.getByText('Chrome did not grant website access. You can retry.'),
  ).toBeVisible();
  await expect(launch.onboardingPage.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(false);

  launch = await freshInstallExtension.grantWebsiteAccess();
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(true);
  expect(await freshInstallExtension.dynamicRegistrations()).toMatchObject([
    {
      id: 'focus-lock-blocker',
      matches: ['http://*/*', 'https://*/*'],
      runAt: 'document_start',
      persistAcrossSessions: true,
    },
  ]);
  await launch.onboardingPage.getByRole('button', { name: 'Retry' }).click();
  await expect(
    launch.onboardingPage.getByRole('heading', {
      name: 'Choose where your settings are stored',
    }),
  ).toBeVisible();

  const setup: SetupState = await freshInstallExtension.completeSetup('local');
  expect(setup).toMatchObject({
    completed: true,
    storageMode: 'local',
    websiteAccess: 'granted',
    blockingRegistration: 'ready',
  });
  await startTestSession(launch.extPage, { duration: { kind: 'timed', minutes: 0.3 } });
  const blockedPage: Page = await launch.context.newPage();
  await blockedPage.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
  await expect(blockedPage).toHaveTitle('Locked - Focus Lock');
  expectNoDiagnostics(diagnostics);
});

test('sync completion and dynamic registration survive a browser restart', async ({
  freshInstallExtension,
}) => {
  await freshInstallExtension.launch();
  let launch: FreshInstallLaunch = await freshInstallExtension.grantWebsiteAccess();
  const diagnostics: BrowserDiagnostics = freshInstallExtension.diagnostics;

  const completed: SetupState = await freshInstallExtension.completeSetup('sync');
  expect(completed).toMatchObject({
    completed: true,
    storageMode: 'sync',
    syncWriteStatus: 'idle',
    storageError: null,
    websiteAccess: 'granted',
    blockingRegistration: 'ready',
  });
  expect(await freshInstallExtension.syncItems()).toHaveProperty(SYNC_SETTINGS);

  launch = await freshInstallExtension.relaunch();
  // A boot republishes the completed setup to Sync, and the status reads `pending` while it does.
  // Measured at about ten seconds on this machine, so the comparison waits for the write to settle
  // rather than racing it. A write that failed would report `error` here and fail the comparison.
  await expect
    .poll(async (): Promise<string> => (await currentSetup(launch)).syncWriteStatus, {
      timeout: 60_000,
    })
    .toBe('idle');
  expect(await currentSetup(launch)).toEqual(completed);
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(true);
  expect(await freshInstallExtension.dynamicRegistrations()).toHaveLength(1);
  await expect(
    launch.onboardingPage.getByRole('heading', { name: 'Setup complete' }),
  ).toBeVisible();
  await expect(launch.extPage.getByRole('button', { name: /^Start/ })).toBeVisible();
  expectNoDiagnostics(diagnostics);
});

test('permission revocation ends a session and rejects another session start', async ({
  freshInstallExtension,
}) => {
  await freshInstallExtension.launch();
  const launch: FreshInstallLaunch = await freshInstallExtension.grantWebsiteAccess();
  const diagnostics: BrowserDiagnostics = freshInstallExtension.diagnostics;
  await freshInstallExtension.completeSetup('local');
  await startTestSession(launch.extPage, { duration: { kind: 'timed', minutes: 0.3 } });
  const active: SessionSnapshot = await sendExtensionRequest(launch.extPage, {
    type: 'getSnapshot',
  });
  const config: SessionConfig | null = active.config;
  if (config === null) throw new Error('active session config is unavailable');

  await freshInstallExtension.revokeWebsiteAccess();
  expect(await freshInstallExtension.hasWebsiteAccess()).toBe(false);
  expect(await freshInstallExtension.dynamicRegistrations()).toEqual([]);
  expect(await sendExtensionRequest(launch.extPage, { type: 'getSnapshot' })).toMatchObject({
    phase: 'idle',
    config: null,
  });
  expect(await currentSetup(launch)).toMatchObject({
    completed: true,
    websiteAccess: 'denied',
    blockingRegistration: 'unavailable',
    websiteAccessNotice: 'revoked-during-session',
  });
  expect(
    await sendExtensionRequest(launch.extPage, {
      type: 'startSession',
      config,
    }),
    // Refused at admission, before any transition runs, so the answer is the boundary code rather
    // than a transition failure reason. Naming a step would claim the start reached one. The popup
    // cannot reach this: it renders the website-blocking screen instead of the start form whenever
    // `blockingRegistration` is not ready, which the assertions below check.
  ).toEqual({ ok: false, code: 'invalid-request', error: 'invalid-request' });
  await launch.extPage.reload();
  await expect(
    launch.extPage.getByText('Your session ended because website access was removed.'),
  ).toBeVisible();
  await expect(
    launch.extPage.getByRole('heading', { name: 'Website blocking is off' }),
  ).toBeVisible();
  await expect(launch.extPage.getByRole('button', { name: /^Start/ })).toHaveCount(0);
  expectNoDiagnostics(diagnostics);
});

test('quota-backed first sync checkpoint survives worker and browser restart, then retries', async ({
  freshInstallExtension,
}) => {
  let launch: FreshInstallLaunch = await freshInstallExtension.launch();
  const diagnostics: BrowserDiagnostics = freshInstallExtension.diagnostics;
  const socialMedia = launch.onboardingPage.getByRole('checkbox', { name: 'Social media' });
  await socialMedia.click();
  await expect(socialMedia).toBeChecked();
  await launch.onboardingPage.getByRole('button', { name: 'Continue' }).click();
  await launch.onboardingPage.getByRole('button', { name: 'Not now' }).click();
  await launch.worker.evaluate(async (): Promise<void> => {
    await chrome.storage.sync.set({ foreignSyncSentinel: { owner: 'another extension test' } });
  });
  const filler: { bytes: number; keys: string[]; quota: number } =
    await freshInstallExtension.fillSyncNearQuota();
  expect(filler.keys.length).toBeGreaterThan(0);
  expect(filler.bytes).toBeGreaterThanOrEqual(filler.quota - 128);

  await launch.onboardingPage
    .getByRole('button', { name: 'Finish setup with sync enabled' })
    .click();
  await expect(launch.onboardingPage.getByRole('alert')).toHaveText(
    'Could not complete setup. Your choices are still saved. Try again.',
  );
  expect(await currentSetup(launch)).toMatchObject({
    completed: false,
    storageMode: null,
    syncWriteStatus: 'error',
    storageError: 'sync-publish-failed',
  });
  const failedLocal: Record<string, unknown> = await freshInstallExtension.localItems();
  expect(failedLocal).toHaveProperty(LOCAL_FIRST_SYNC_PUBLICATION);
  expect(failedLocal).toHaveProperty(LOCAL_ONBOARDING_DRAFT);
  expect(failedLocal).toHaveProperty(LOCAL_SETTINGS);
  expect(failedLocal).toHaveProperty(LOCAL_LISTS);
  expect(failedLocal[LOCAL_LISTS]).toMatchObject({ categories: { social: true } });
  const failedSettings: unknown = structuredClone(failedLocal[LOCAL_SETTINGS]);
  const failedLists: ListsConfig = structuredClone(failedLocal[LOCAL_LISTS] as ListsConfig);
  const failedJournal = failedLocal[LOCAL_SYNC_JOURNAL] as {
    sets: Record<string, unknown>;
    removes: string[];
  };
  expect(Object.keys(failedJournal.sets).length).toBeGreaterThan(0);

  launch = await freshInstallExtension.restartWorker();
  expect(await currentSetup(launch)).toMatchObject({
    completed: false,
    storageMode: null,
    storageError: 'sync-publish-failed',
  });
  expect(await freshInstallExtension.localItems()).toHaveProperty(LOCAL_FIRST_SYNC_PUBLICATION);

  launch = await freshInstallExtension.relaunch();
  await expect(
    launch.onboardingPage.getByRole('heading', {
      name: 'Choose where your settings are stored',
    }),
  ).toBeVisible();
  // Nothing publishes the outbox before setup finishes, so the relaunch keeps the failure it had.
  expect(await currentSetup(launch)).toMatchObject({
    completed: false,
    storageMode: null,
    syncWriteStatus: 'error',
    storageError: 'sync-publish-failed',
  });
  expect(await freshInstallExtension.localItems()).toMatchObject({
    [LOCAL_FIRST_SYNC_PUBLICATION]: { phase: 'publishing' },
    [LOCAL_SYNC_JOURNAL]: failedJournal,
  });

  await freshInstallExtension.clearSyncFiller();
  const afterClear: Record<string, unknown> = await freshInstallExtension.syncItems();
  expect(afterClear.foreignSyncSentinel).toEqual({ owner: 'another extension test' });
  expect(filler.keys.some((key: string): boolean => Object.hasOwn(afterClear, key))).toBe(false);
  await launch.onboardingPage
    .getByRole('button', { name: 'Finish setup with sync enabled' })
    .click();
  await expect(
    launch.onboardingPage.getByRole('heading', { name: 'Setup complete' }),
  ).toBeVisible();

  expect(await currentSetup(launch)).toMatchObject({
    completed: true,
    storageMode: 'sync',
    syncWriteStatus: 'idle',
    storageError: null,
  });
  const recoveredLocal: Record<string, unknown> = await freshInstallExtension.localItems();
  const recoveredRemote: Record<string, unknown> = await freshInstallExtension.syncItems();
  expect(recoveredLocal[LOCAL_SETTINGS]).toEqual(failedSettings);
  expect(recoveredLocal[LOCAL_LISTS]).toEqual(failedLists);
  expect(recoveredRemote[SYNC_SETTINGS]).toEqual(failedSettings);
  expect(decodeListsSyncSnapshot(recoveredRemote)).toEqual({
    kind: 'complete',
    lists: failedLists,
  });
  expect(recoveredRemote.foreignSyncSentinel).toEqual({ owner: 'another extension test' });
  expect(recoveredLocal[LOCAL_SYNC_JOURNAL]).toEqual({ sets: {}, removes: [] });
  expect(recoveredLocal).not.toHaveProperty(LOCAL_FIRST_SYNC_PUBLICATION);
  expect(recoveredLocal).not.toHaveProperty(LOCAL_ONBOARDING_DRAFT);
  expect(recoveredLocal[LOCAL_SETUP]).toEqual(await currentSetup(launch));
  expectNoDiagnostics(diagnostics);
});
