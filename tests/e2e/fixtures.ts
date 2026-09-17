import {
  type BrowserContext,
  test as base,
  type CDPSession,
  chromium,
  type Page,
  type Worker,
} from '@playwright/test';
import { parseStoredEventLogV2 } from '../../src/background/event-log-v2';
import type { RuntimeStateV2 } from '../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../src/background/runtime-v2-validation';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../src/shared/constants';
import type { Request, ResponseMap, SoundId } from '../../src/shared/messages';
import { CONTENT_SCRIPT_ID, WEBSITE_ORIGINS } from '../../src/shared/permissions';
import {
  LOCAL_EVENTS,
  LOCAL_POLICY_COMMIT,
  LOCAL_POLICY_GENERATION_PREFIX,
  LOCAL_RUNTIME,
} from '../../src/shared/storage-keys';
import type {
  ListsConfig,
  OnboardingDraft,
  Rule,
  SessionConfigV2,
  SessionEventRecordV2,
  SessionLifecycleV2,
  SessionSnapshotV2,
  SetupState,
  StorageMode,
} from '../../src/shared/types';
import {
  type BrowserDiagnostics,
  beginIntentionalWorkerStopDiagnosticWindow,
  closeAndAssertBrowserDiagnostics,
  createBrowserDiagnostics,
  monitorBrowserContext,
} from './browser-diagnostics';
import { closeContextOnSetupFailure } from './context-cleanup';
import {
  createIsolatedExtensionDist,
  resolveExtensionDist,
  withPermissionGrantManifest,
} from './extension-dist';
import { startServer, type TestServer } from './server';

interface ExtFixtures {
  extensionTimezone: string | undefined;
  /**
   * Launches the browser with GPU rasterization off, for a spec whose captures are compared byte
   * for byte. On the compositor's own path the same build paints a handful of edge pixels
   * differently between runs, which is enough to fail a comparison that has to stay exact.
   */
  extensionDeterministicPaint: boolean;
  /** The browser UI language the extension renders in. Defaults to English for every other spec. */
  extensionUiLanguage: string;
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  extPage: Page;
  siteUrl(pathname: string): string;
  restartableExtension: RestartableExtension;
  freshInstallExtension: FreshInstallExtension;
}

const fixtureDiagnostics: WeakMap<BrowserContext, BrowserDiagnostics> = new WeakMap<
  BrowserContext,
  BrowserDiagnostics
>();

export function browserDiagnosticsFor(context: BrowserContext): BrowserDiagnostics {
  const diagnostics: BrowserDiagnostics | undefined = fixtureDiagnostics.get(context);
  if (diagnostics === undefined) throw new Error('browser context diagnostics are unavailable');
  return diagnostics;
}

export interface ExtensionLaunch {
  context: BrowserContext;
  diagnostics: BrowserDiagnostics;
  worker: Worker;
  extensionId: string;
  extPage: Page;
}

export interface FreshInstallLaunch extends ExtensionLaunch {
  onboardingPage: Page;
}

export interface FreshInstallExtension {
  diagnostics: BrowserDiagnostics;
  launch(): Promise<FreshInstallLaunch>;
  close(): Promise<void>;
  relaunch(): Promise<FreshInstallLaunch>;
  grantWebsiteAccess(): Promise<FreshInstallLaunch>;
  denyWebsiteAccess(): Promise<void>;
  revokeWebsiteAccess(): Promise<void>;
  restartWorker(): Promise<FreshInstallLaunch>;
  onboardingUrl(): string;
  hasWebsiteAccess(): Promise<boolean>;
  dynamicRegistrations(): Promise<chrome.scripting.RegisteredContentScript[]>;
  completeSetup(storageMode: StorageMode): Promise<SetupState>;
  fillSyncNearQuota(): Promise<{ bytes: number; keys: string[]; quota: number }>;
  clearSyncFiller(): Promise<void>;
  localItems(): Promise<Record<string, unknown>>;
  syncItems(): Promise<Record<string, unknown>>;
}

export interface ObservedSound {
  type: 'playSound';
  sound: SoundId;
  volume: number;
}

export interface RestartableExtension {
  diagnostics: BrowserDiagnostics;
  launch(): Promise<ExtensionLaunch>;
  close(): Promise<void>;
}

/** What a launch needs from the environment beyond the profile and the build under test. */
interface LaunchEnvironmentV2 {
  timezoneId?: string | undefined;
  deterministicPaint?: boolean;
  /**
   * The browser UI language, which is what `chrome.i18n` reads. Every other spec pins `en` so a
   * developer machine set to another language does not change what `getByText` sees.
   */
  uiLanguage?: string | undefined;
}

/** The UI language every spec runs under unless it asks for another one. */
export const DEFAULT_UI_LANGUAGE: string = 'en-US';

function extensionArgs(dist: string, uiLanguage: string): string[] {
  return [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    `--lang=${uiLanguage}`,
    '--host-resolver-rules=MAP blocked.example 127.0.0.1, MAP *.blocked.example 127.0.0.1, MAP other.example 127.0.0.1',
  ];
}

async function extensionLaunch(
  profileDir: string,
  restoreLastSession: boolean,
  distOverride?: string,
  diagnostics: BrowserDiagnostics = createBrowserDiagnostics(),
  environment: LaunchEnvironmentV2 = {},
): Promise<ExtensionLaunch> {
  const timezoneId: string | undefined = environment.timezoneId;
  const dist: string = resolveExtensionDist(distOverride);
  const args: string[] = extensionArgs(dist, environment.uiLanguage ?? DEFAULT_UI_LANGUAGE);
  // `deterministicPaint` is the honest half of this condition: a caller that needs a stable paint
  // says so. The environment-variable arm beside it is a coupling worth knowing about, because a
  // variable named for where evidence is written also decides how the browser draws, and it does so
  // for every launch in the run rather than only for the capture that wanted it. Setting
  // `STATS_EVIDENCE_DIR` to enable the Stats parity assertions therefore changes the rendering
  // configuration of every other scenario too, which is why the release gate does not set it and
  // the evidence procedure in `docs/release-candidate-gate.md` is run on its own. Retiring the
  // variable arm in favour of the explicit option is post-merge work: the captures already on disk
  // were taken under these flags.
  if (process.env.STATS_EVIDENCE_DIR !== undefined || environment.deterministicPaint === true) {
    args.push('--disable-gpu', '--disable-gpu-compositing');
  }
  if (restoreLastSession) args.push('--restore-last-session');
  const browserEnvironment: Record<string, string> | undefined =
    timezoneId === undefined
      ? undefined
      : {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry: [string, string | undefined]): entry is [string, string] =>
                entry[1] !== undefined,
            ),
          ),
          TZ: timezoneId,
        };
  const context: BrowserContext = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    args,
    env: browserEnvironment,
    locale: environment.uiLanguage ?? DEFAULT_UI_LANGUAGE,
    timezoneId,
  });
  monitorBrowserContext(context, diagnostics);
  return await closeContextOnSetupFailure(context, async (): Promise<ExtensionLaunch> => {
    const existing: Worker | undefined = context.serviceWorkers()[0];
    const worker: Worker = existing ?? (await context.waitForEvent('serviceworker'));
    const extensionId: string = new URL(worker.url()).host;
    const extPage: Page = await context.newPage();
    await extPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    return await restartMonitoredWorker({
      context,
      diagnostics,
      worker,
      extensionId,
      extPage,
    });
  });
}

interface ServiceWorkerVersionInfo {
  versionId: string;
  scriptURL: string;
  runningStatus: 'stopped' | 'starting' | 'running' | 'stopping';
}

/**
 * The budget for one service-worker version handshake. It was five seconds, which a machine
 * running several extension browsers at once does not always meet: a launch would fail with
 * "running extension worker version is unavailable" while the worker was merely slow to report
 * itself. The wait is still on the condition, so a longer budget costs nothing when the worker is
 * quick and only buys patience when it is not.
 */
const WORKER_VERSION_ATTEMPTS: number = 600;
const WORKER_VERSION_INTERVAL_MS: number = 50;

async function waitForServiceWorkerVersion(
  versions: () => readonly ServiceWorkerVersionInfo[],
  predicate: (version: ServiceWorkerVersionInfo) => boolean,
  failure: string,
  nudge?: () => Promise<void>,
): Promise<ServiceWorkerVersionInfo> {
  for (let attempt: number = 0; attempt < WORKER_VERSION_ATTEMPTS; attempt += 1) {
    const found: ServiceWorkerVersionInfo | undefined = versions().find(predicate);
    if (found !== undefined) return found;
    if (nudge !== undefined) await nudge();
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, WORKER_VERSION_INTERVAL_MS);
    });
  }
  throw new Error(failure);
}

async function restartMonitoredWorker(launch: ExtensionLaunch): Promise<ExtensionLaunch> {
  const session: CDPSession = await launch.context.newCDPSession(launch.extPage);
  let versions: readonly ServiceWorkerVersionInfo[] = [];
  const stoppedVersionIds: Set<string> = new Set<string>();
  session.on('ServiceWorker.workerVersionUpdated', (payload): void => {
    versions = payload.versions as readonly ServiceWorkerVersionInfo[];
    for (const version of versions) {
      if (version.runningStatus === 'stopped') stoppedVersionIds.add(version.versionId);
    }
  });
  try {
    await session.send('ServiceWorker.enable');
    const scriptPrefix: string = `chrome-extension://${launch.extensionId}/`;
    const running: ServiceWorkerVersionInfo = await waitForServiceWorkerVersion(
      (): readonly ServiceWorkerVersionInfo[] => versions,
      (version: ServiceWorkerVersionInfo): boolean =>
        version.scriptURL.startsWith(scriptPrefix) && version.runningStatus === 'running',
      'running extension worker version is unavailable',
    );
    const closeDiagnosticWindow: () => void = beginIntentionalWorkerStopDiagnosticWindow(
      launch.diagnostics,
    );
    let worker: Worker;
    try {
      await session.send('ServiceWorker.stopWorker', { versionId: running.versionId });
      await waitForServiceWorkerVersion(
        (): readonly ServiceWorkerVersionInfo[] =>
          stoppedVersionIds.has(running.versionId) ? [running] : [],
        (version: ServiceWorkerVersionInfo): boolean => version.versionId === running.versionId,
        'extension worker did not stop',
      );
      // A stopped MV3 worker starts again when a message arrives, so the wake is the wait. Sending
      // it once assumed the one message landed, and a message sent while the popup was busy or the
      // machine was loaded could be the one that did not, leaving the wait to time out against a
      // worker nobody had asked to start. Every attempt now carries its own wake.
      const wake: () => Promise<void> = async (): Promise<void> => {
        try {
          await launch.extPage.evaluate(
            async (): Promise<unknown> =>
              await chrome.runtime.sendMessage({ type: 'getSetupState' }),
          );
        } catch {
          // The page is mid-navigation or the worker is still coming up. The next attempt asks
          // again, and the read-back below is the only thing that decides success.
        }
      };
      await wake();
      await waitForServiceWorkerVersion(
        (): readonly ServiceWorkerVersionInfo[] => versions,
        (version: ServiceWorkerVersionInfo): boolean =>
          version.scriptURL.startsWith(scriptPrefix) && version.runningStatus === 'running',
        'extension worker did not restart',
        wake,
      );
      worker =
        launch.context
          .serviceWorkers()
          .find((candidate: Worker): boolean => candidate.url().startsWith(scriptPrefix)) ??
        launch.worker;
      await worker.evaluate(async (): Promise<void> => {
        await chrome.storage.local.get(null);
      });
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 0);
      });
    } finally {
      closeDiagnosticWindow();
    }
    await launch.extPage.reload();
    return { ...launch, worker };
  } finally {
    await session.detach();
  }
}

const SYNC_FILLER_PREFIX: string = '__focusLockE2EQuota:';

/** Bounded patience for Chrome to apply the granting manifest's host permissions. */
const WEBSITE_ACCESS_GRANT_ATTEMPTS: number = 100;
const WEBSITE_ACCESS_GRANT_INTERVAL_MS: number = 100;

async function grantProfileWebsiteAccess(
  profileDir: string,
  baseDist: string,
  diagnostics: BrowserDiagnostics,
  environment: LaunchEnvironmentV2 = {},
): Promise<void> {
  const optionalLaunch: ExtensionLaunch = await extensionLaunch(
    profileDir,
    false,
    baseDist,
    diagnostics,
    environment,
  );
  try {
    await sendExtensionRequest(optionalLaunch.extPage, { type: 'getSetupState' });
  } finally {
    await optionalLaunch.context.close();
  }
  await withPermissionGrantManifest(baseDist, async (grantDist: string): Promise<void> => {
    const grantingLaunch: ExtensionLaunch = await extensionLaunch(
      profileDir,
      false,
      grantDist,
      diagnostics,
      environment,
    );
    try {
      for (let attempt: number = 0; attempt < WEBSITE_ACCESS_GRANT_ATTEMPTS; attempt += 1) {
        const reconciled = await sendExtensionRequest(grantingLaunch.extPage, {
          type: 'reconcileWebsiteAccess',
        });
        if (reconciled.ok && reconciled.granted) break;
        await new Promise<void>((resolve: () => void): void => {
          setTimeout(resolve, WEBSITE_ACCESS_GRANT_INTERVAL_MS);
        });
      }
    } finally {
      await grantingLaunch.context.close();
    }
  });
}

async function completedExtensionLaunch(
  profileDir: string,
  baseDist: string,
  diagnostics: BrowserDiagnostics,
  environment: LaunchEnvironmentV2 = {},
): Promise<ExtensionLaunch> {
  await grantProfileWebsiteAccess(profileDir, baseDist, diagnostics, environment);
  const launch: ExtensionLaunch = await extensionLaunch(
    profileDir,
    false,
    baseDist,
    diagnostics,
    environment,
  );
  const reconciled = await sendExtensionRequest(launch.extPage, {
    type: 'reconcileWebsiteAccess',
  });
  if (!reconciled.ok || !reconciled.granted || reconciled.registration !== 'ready') {
    const permissions = await launch.worker.evaluate(
      async (): Promise<chrome.permissions.Permissions> => await chrome.permissions.getAll(),
    );
    const setup: SetupState = await sendExtensionRequest(launch.extPage, {
      type: 'getSetupState',
    });
    await launch.context.close();
    throw new Error(
      `could not prepare website access for the default E2E fixture: ${JSON.stringify({
        reconciled,
        permissions,
        setup,
      })}`,
    );
  }
  const completed = await sendExtensionRequest(launch.extPage, {
    type: 'completeSetup',
    storageMode: 'sync',
    settings: structuredClone(DEFAULT_SETTINGS),
    lists: structuredClone(DEFAULT_LISTS),
  });
  if (!completed.ok) {
    await launch.context.close();
    throw new Error(completed.error);
  }
  return launch;
}

export const test = base.extend<ExtFixtures>({
  extensionTimezone: [undefined, { option: true }],
  extensionDeterministicPaint: [false, { option: true }],
  extensionUiLanguage: [DEFAULT_UI_LANGUAGE, { option: true }],
  context: async (
    { extensionTimezone, extensionDeterministicPaint, extensionUiLanguage },
    use,
    testInfo,
  ) => {
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    const profileDir: string = testInfo.outputPath('default-profile');
    const baseDist: string = await createIsolatedExtensionDist(
      testInfo.outputPath('unpacked-dist'),
      resolveExtensionDist(),
    );
    const launch: ExtensionLaunch = await completedExtensionLaunch(
      profileDir,
      baseDist,
      diagnostics,
      {
        timezoneId: extensionTimezone,
        deterministicPaint: extensionDeterministicPaint,
        uiLanguage: extensionUiLanguage,
      },
    );
    fixtureDiagnostics.set(launch.context, diagnostics);
    try {
      await use(launch.context);
    } finally {
      try {
        await closeAndAssertBrowserDiagnostics(
          async (): Promise<void> => await launch.context.close(),
          diagnostics,
        );
      } finally {
        fixtureDiagnostics.delete(launch.context);
      }
    }
  },
  worker: async ({ context }, use) => {
    const existing: Worker | undefined = context.serviceWorkers()[0];
    const worker: Worker = existing ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  extPage: async ({ context, extensionId }, use) => {
    const page: Page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await use(page);
  },
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  siteUrl: async ({}, use) => {
    const server: TestServer = await startServer();
    await use((requestedPath: string): string => {
      const pathname: string = requestedPath.startsWith('/') ? requestedPath : `/${requestedPath}`;
      return `http://blocked.example:${server.port}${pathname}`;
    });
    await server.close();
  },
  restartableExtension: async (
    { extensionTimezone, extensionDeterministicPaint, extensionUiLanguage },
    use,
    testInfo,
  ) => {
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    const profileDir: string = testInfo.outputPath('restart-profile');
    const baseDist: string = await createIsolatedExtensionDist(
      testInfo.outputPath('restart-unpacked-dist'),
      resolveExtensionDist(),
    );
    const environment: LaunchEnvironmentV2 = {
      timezoneId: extensionTimezone,
      deterministicPaint: extensionDeterministicPaint,
      uiLanguage: extensionUiLanguage,
    };
    const prepared: ExtensionLaunch = await completedExtensionLaunch(
      profileDir,
      baseDist,
      diagnostics,
      environment,
    );
    await prepared.context.close();
    let current: ExtensionLaunch | null = null;
    const close = async (): Promise<void> => {
      if (current === null) return;
      const closing: ExtensionLaunch = current;
      current = null;
      await closing.context.close();
    };
    const launch = async (): Promise<ExtensionLaunch> => {
      if (current !== null) throw new Error('close the isolated browser before relaunching it');
      current = await extensionLaunch(profileDir, true, baseDist, diagnostics, environment);
      return current;
    };

    try {
      await use({ diagnostics, launch, close });
    } finally {
      await closeAndAssertBrowserDiagnostics(close, diagnostics);
    }
  },
  freshInstallExtension: async (
    { extensionTimezone, extensionDeterministicPaint, extensionUiLanguage },
    use,
    testInfo,
  ) => {
    const diagnostics: BrowserDiagnostics = createBrowserDiagnostics();
    const profileDir: string = testInfo.outputPath('fresh-install-profile');
    const baseDist: string = await createIsolatedExtensionDist(
      testInfo.outputPath('fresh-unpacked-dist'),
      resolveExtensionDist(),
    );
    let current: FreshInstallLaunch | null = null;
    const requireCurrent = (): FreshInstallLaunch => {
      if (current === null) throw new Error('launch the fresh-install browser first');
      return current;
    };
    const close = async (): Promise<void> => {
      if (current === null) return;
      const closing: FreshInstallLaunch = current;
      current = null;
      await closing.context.close();
    };
    const launch = async (): Promise<FreshInstallLaunch> => {
      if (current !== null) throw new Error('close the isolated browser before relaunching it');
      const baseLaunch: ExtensionLaunch = await extensionLaunch(
        profileDir,
        true,
        baseDist,
        diagnostics,
        {
          timezoneId: extensionTimezone,
          deterministicPaint: extensionDeterministicPaint,
          uiLanguage: extensionUiLanguage,
        },
      );
      const onboardingPage: Page = await baseLaunch.context.newPage();
      await onboardingPage.goto(
        `chrome-extension://${baseLaunch.extensionId}/src/onboarding/onboarding.html`,
      );
      current = { ...baseLaunch, onboardingPage };
      return current;
    };
    const relaunch = async (): Promise<FreshInstallLaunch> => {
      await close();
      return await launch();
    };
    const onboardingUrl = (): string => {
      const launchState: FreshInstallLaunch = requireCurrent();
      return `chrome-extension://${launchState.extensionId}/src/onboarding/onboarding.html`;
    };
    const hasWebsiteAccess = async (): Promise<boolean> =>
      await requireCurrent().worker.evaluate(
        async (origins: string[]): Promise<boolean> =>
          await chrome.permissions.contains({ origins }),
        [...WEBSITE_ORIGINS],
      );
    const dynamicRegistrations = async (): Promise<chrome.scripting.RegisteredContentScript[]> =>
      await requireCurrent().worker.evaluate(
        async (scriptId: string): Promise<chrome.scripting.RegisteredContentScript[]> =>
          await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] }),
        CONTENT_SCRIPT_ID,
      );
    const localItems = async (): Promise<Record<string, unknown>> =>
      await requireCurrent().worker.evaluate(
        async (): Promise<Record<string, unknown>> => await chrome.storage.local.get(null),
      );
    const syncItems = async (): Promise<Record<string, unknown>> =>
      await requireCurrent().worker.evaluate(
        async (): Promise<Record<string, unknown>> => await chrome.storage.sync.get(null),
      );
    const grantWebsiteAccess = async (): Promise<FreshInstallLaunch> => {
      await close();
      await grantProfileWebsiteAccess(profileDir, baseDist, diagnostics, {
        timezoneId: extensionTimezone,
        deterministicPaint: extensionDeterministicPaint,
        uiLanguage: extensionUiLanguage,
      });
      return await launch();
    };
    const revokeWebsiteAccess = async (): Promise<void> => {
      const removed: boolean = await requireCurrent().extPage.evaluate(
        async (origins: string[]): Promise<boolean> => await chrome.permissions.remove({ origins }),
        [...WEBSITE_ORIGINS],
      );
      if (!removed) throw new Error('Chrome did not remove the test website permission');
      const reconciled = await sendExtensionRequest(requireCurrent().extPage, {
        type: 'reconcileWebsiteAccess',
      });
      if (!reconciled.ok || reconciled.granted || reconciled.registration !== 'unavailable') {
        throw new Error('website access did not reconcile to denied');
      }
    };
    const denyWebsiteAccess = async (): Promise<void> => {
      if (await hasWebsiteAccess()) await revokeWebsiteAccess();
      const launchState: FreshInstallLaunch = requireCurrent();
      const reconciled = await sendExtensionRequest(launchState.extPage, {
        type: 'reconcileWebsiteAccess',
      });
      if (!reconciled.ok || reconciled.granted || reconciled.registration !== 'unavailable') {
        throw new Error('website access did not reconcile to denied');
      }
      const loaded = await sendExtensionRequest(launchState.extPage, {
        type: 'getOnboardingDraft',
      });
      if (!loaded.ok) throw new Error(loaded.error);
      if (loaded.draft === null) throw new Error('onboarding draft is unavailable');
      const deniedDraft: OnboardingDraft = {
        ...loaded.draft,
        websiteAccessChoice: 'denied',
      };
      const saved = await sendExtensionRequest(launchState.extPage, {
        type: 'saveOnboardingDraft',
        draft: deniedDraft,
      });
      if (!saved.ok) throw new Error(saved.error);
      await launchState.onboardingPage.reload();
    };
    const restartWorker = async (): Promise<FreshInstallLaunch> => {
      const launchState: FreshInstallLaunch = requireCurrent();
      const restarted: ExtensionLaunch = await restartMonitoredWorker(launchState);
      current = { ...launchState, worker: restarted.worker };
      return current;
    };
    const completeSetup = async (storageMode: StorageMode): Promise<SetupState> => {
      const launchState: FreshInstallLaunch = requireCurrent();
      const page: Page = launchState.onboardingPage;
      await page.reload();
      const stepOne = page.getByRole('heading', { name: 'Choose your starting block list' });
      const stepTwo = page.getByRole('heading', { name: 'Enable website blocking' });
      const stepThree = page.getByRole('heading', {
        name: 'Choose where your settings are stored',
      });
      const setupComplete = page.getByRole('heading', { name: 'Setup complete' });
      const authoritativeHeading = page.getByRole('heading', {
        name: /^(Choose your starting block list|Enable website blocking|Choose where your settings are stored|Setup complete)$/,
      });
      await authoritativeHeading.waitFor();
      if ((await authoritativeHeading.count()) !== 1) {
        throw new Error('onboarding did not render exactly one authoritative step heading');
      }
      if (await stepOne.isVisible()) {
        await page.getByRole('button', { name: 'Continue' }).click();
        await stepTwo.waitFor();
      }
      if (await stepTwo.isVisible()) {
        if (await hasWebsiteAccess()) {
          await page.getByRole('button', { name: /^(Enable website blocking|Retry)$/ }).click();
        } else {
          await page.getByRole('button', { name: 'Not now' }).click();
        }
        await stepThree.waitFor();
      }
      if (await setupComplete.isVisible()) {
        return await sendExtensionRequest(launchState.extPage, { type: 'getSetupState' });
      }
      await stepThree.waitFor();
      const syncSwitch = page.getByRole('switch', { name: 'Sync across Chrome devices' });
      await syncSwitch.waitFor();
      const wantSync: boolean = storageMode === 'sync';
      if ((await syncSwitch.isChecked()) !== wantSync) await syncSwitch.click();
      await page
        .getByRole('button', {
          name: wantSync ? 'Finish setup with sync enabled' : 'Finish setup without sync',
        })
        .click();
      await setupComplete.waitFor();
      return await sendExtensionRequest(launchState.extPage, { type: 'getSetupState' });
    };
    const fillSyncNearQuota = async (): Promise<{
      bytes: number;
      keys: string[];
      quota: number;
    }> =>
      await requireCurrent().worker.evaluate(
        async (prefix: string): Promise<{ bytes: number; keys: string[]; quota: number }> => {
          const quota: number = chrome.storage.sync.QUOTA_BYTES;
          const itemQuota: number = chrome.storage.sync.QUOTA_BYTES_PER_ITEM;
          const target: number = quota - 128;
          const keys: string[] = [];
          let bytes: number = await chrome.storage.sync.getBytesInUse(null);
          let index: number = 0;
          while (bytes < target) {
            const key: string = `${prefix}${String(index).padStart(2, '0')}`;
            const remaining: number = target - bytes;
            const valueLength: number = Math.max(1, Math.min(itemQuota - 256, remaining - 64));
            await chrome.storage.sync.set({ [key]: 'q'.repeat(valueLength) });
            keys.push(key);
            bytes = await chrome.storage.sync.getBytesInUse(null);
            index += 1;
          }
          return { bytes, keys, quota };
        },
        SYNC_FILLER_PREFIX,
      );
    const clearSyncFiller = async (): Promise<void> => {
      await requireCurrent().worker.evaluate(async (prefix: string): Promise<void> => {
        const stored: Record<string, unknown> = await chrome.storage.sync.get(null);
        const keys: string[] = Object.keys(stored).filter((key: string): boolean =>
          key.startsWith(prefix),
        );
        if (keys.length > 0) await chrome.storage.sync.remove(keys);
      }, SYNC_FILLER_PREFIX);
    };

    try {
      await use({
        diagnostics,
        launch,
        close,
        relaunch,
        grantWebsiteAccess,
        denyWebsiteAccess,
        revokeWebsiteAccess,
        restartWorker,
        onboardingUrl,
        hasWebsiteAccess,
        dynamicRegistrations,
        completeSetup,
        fillSyncNearQuota,
        clearSyncFiller,
        localItems,
        syncItems,
      });
    } finally {
      await closeAndAssertBrowserDiagnostics(close, diagnostics);
    }
  },
});

export const expect = test.expect;

export async function observeSoundMessages(extPage: Page): Promise<void> {
  await extPage.evaluate((): void => {
    const scope = globalThis as unknown as { __focusLockE2ESounds?: ObservedSound[] };
    scope.__focusLockE2ESounds = [];
    chrome.runtime.onMessage.addListener((message: unknown): void => {
      if (typeof message !== 'object' || message === null) return;
      const candidate = message as Partial<ObservedSound>;
      if (
        candidate.type === 'playSound' &&
        typeof candidate.sound === 'string' &&
        typeof candidate.volume === 'number'
      ) {
        scope.__focusLockE2ESounds?.push(candidate as ObservedSound);
      }
    });
  });
}

export async function observedSounds(extPage: Page): Promise<ObservedSound[]> {
  return await extPage.evaluate(
    (): ObservedSound[] =>
      (globalThis as unknown as { __focusLockE2ESounds?: ObservedSound[] }).__focusLockE2ESounds ??
      [],
  );
}

export async function clearNotifications(worker: Worker): Promise<void> {
  await worker.evaluate(async (): Promise<void> => {
    const notifications: Record<string, boolean> = await chrome.notifications.getAll();
    await Promise.all(
      Object.keys(notifications).map(
        async (notificationId: string): Promise<boolean> =>
          await chrome.notifications.clear(notificationId),
      ),
    );
  });
}

export async function notificationIds(worker: Worker): Promise<string[]> {
  return await worker.evaluate(
    async (): Promise<string[]> => Object.keys(await chrome.notifications.getAll()),
  );
}

export async function hasOffscreenAudioDocument(worker: Worker): Promise<boolean> {
  return await worker.evaluate(async (): Promise<boolean> => {
    const contexts: chrome.runtime.ExtensionContext[] = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    return contexts.some(
      (extensionContext: chrome.runtime.ExtensionContext): boolean =>
        typeof extensionContext.documentUrl === 'string' &&
        extensionContext.documentUrl.endsWith('/src/offscreen/audio.html'),
    );
  });
}

export async function sendExtensionRequest<T extends Request['type']>(
  extPage: Page,
  request: Extract<Request, { type: T }>,
): Promise<ResponseMap[T]> {
  return (await extPage.evaluate(
    async (message: Request): Promise<unknown> => await chrome.runtime.sendMessage(message),
    request,
  )) as ResponseMap[T];
}

export async function startTestSession(
  extPage: Page,
  overrides: Partial<SessionConfigV2> = {},
  customRules: Rule[] = [{ kind: 'host', pattern: 'blocked.example' }],
): Promise<void> {
  const lists: ListsConfig = {
    custom: customRules,
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
  const config: SessionConfigV2 = {
    mode: 'blacklist',
    strictness: 'friction',
    duration: { kind: 'timed', minutes: 0.2 },
    cycling: null,
    intention: 'e2e test run',
    source: 'manual',
    scheduleOccurrence: null,
    ...overrides,
    rules: overrides.rules ?? rulesFromLists(lists),
  };

  await extPage.evaluate(
    async ({ cfg, rules }): Promise<void> => {
      const listsAck: { ok: boolean; error?: string } = await chrome.runtime.sendMessage({
        type: 'updateLists',
        lists: {
          custom: rules,
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
        },
      });
      if (!listsAck.ok) throw new Error(listsAck.error ?? 'updateLists rejected');

      const sessionAck: { ok: boolean; code?: string; error?: string } =
        await chrome.runtime.sendMessage({ type: 'startSession', config: cfg });
      if (!sessionAck.ok) {
        throw new Error(sessionAck.code ?? sessionAck.error ?? 'startSession rejected');
      }
    },
    { cfg: config, rules: customRules },
  );
  // A start answers as soon as the worker accepts it, and publication follows the transition, so
  // every caller waits for the lifecycle the session reaches rather than for the ack alone.
  await waitForActiveSession(extPage);
}

/** Waits until the worker publishes an active lifecycle, which is when a session is enforcing. */
export async function waitForActiveSession(
  extPage: Page,
  timeoutMs: number = 10_000,
): Promise<void> {
  await waitForLifecycle(extPage, 'active', timeoutMs);
}

/**
 * Starts a Flexible until-stopped session. The duration and the cycle plan are not overridable,
 * because a start that named its own would not be the session this helper's name promises, and
 * the type stays Flexible so every caller gets the immediate End the suite asserts on.
 */
export async function startUntilStoppedSession(
  extPage: Page,
  overrides: Partial<Omit<SessionConfigV2, 'duration' | 'strictness' | 'cycling'>> = {},
  customRules: Rule[] = [{ kind: 'host', pattern: 'blocked.example' }],
): Promise<void> {
  await startTestSession(
    extPage,
    {
      ...overrides,
      duration: { kind: 'until-stopped' },
      strictness: 'flexible',
      cycling: null,
    },
    customRules,
  );
}

/**
 * Polls the published snapshot until it reports `kind`, and answers the snapshot that reported it.
 * The failure names every lifecycle this wait actually saw, so a timeout says what the worker was
 * doing instead of only what it was asked for.
 */
export async function waitForLifecycle(
  extPage: Page,
  kind: SessionLifecycleV2['kind'],
  timeoutMs: number = 15_000,
): Promise<SessionSnapshotV2> {
  const seen: SessionLifecycleV2['kind'][] = [];
  const deadline: number = Date.now() + timeoutMs;
  for (;;) {
    const snapshot: SessionSnapshotV2 = await sendExtensionRequest(extPage, {
      type: 'getSnapshot',
    });
    if (snapshot.lifecycle.kind === kind) return snapshot;
    if (seen[seen.length - 1] !== snapshot.lifecycle.kind) seen.push(snapshot.lifecycle.kind);
    if (Date.now() >= deadline) {
      throw new Error(
        `the worker never published a ${kind} lifecycle, it published ${seen.join(', ')}`,
      );
    }
    await new Promise((resolve: (value: unknown) => void): void => {
      setTimeout(resolve, 100);
    });
  }
}

/**
 * The durable v2 runtime, read the way the worker's own boot reads it: through the committed
 * policy generation pointer when one exists, and through the plain runtime key otherwise. The
 * shipped parser validates it, so a value this returns is a value the worker would accept.
 */
export async function readRuntimeV2(worker: Worker): Promise<RuntimeStateV2> {
  const raw: unknown = await worker.evaluate(
    async (keys: {
      runtime: string;
      policyCommit: string;
      generationPrefix: string;
    }): Promise<unknown> => {
      const pointerStored: Record<string, unknown> = await chrome.storage.local.get(
        keys.policyCommit,
      );
      const pointer: unknown = pointerStored[keys.policyCommit];
      const id: unknown =
        typeof pointer === 'object' && pointer !== null && 'source' in pointer
          ? (pointer as { source: unknown; id?: unknown }).source === 'generation'
            ? (pointer as { id?: unknown }).id
            : undefined
          : undefined;
      if (typeof id !== 'string') {
        return (await chrome.storage.local.get(keys.runtime))[keys.runtime];
      }
      const generationKey: string = `${keys.generationPrefix}${id}`;
      const stored: Record<string, unknown> = await chrome.storage.local.get(generationKey);
      const generation: unknown = stored[generationKey];
      if (typeof generation !== 'object' || generation === null) {
        throw new Error('the committed runtime generation is missing');
      }
      return (generation as { runtime?: unknown }).runtime;
    },
    {
      runtime: LOCAL_RUNTIME,
      policyCommit: LOCAL_POLICY_COMMIT,
      generationPrefix: LOCAL_POLICY_GENERATION_PREFIX,
    },
  );
  const runtime: RuntimeStateV2 | null = parseRuntimeStateV2(raw);
  if (runtime === null) throw new Error('the stored runtime is not a valid v2 runtime');
  return runtime;
}

/** The durable event log, validated by the shipped parser. Oldest first, as it is stored. */
export async function readEventsV2FromWorker(worker: Worker): Promise<SessionEventRecordV2[]> {
  const raw: unknown = await worker.evaluate(
    async (key: string): Promise<unknown> => (await chrome.storage.local.get(key))[key],
    LOCAL_EVENTS,
  );
  return parseStoredEventLogV2(raw);
}

/** The toolbar badge Chrome is actually showing, which is the only badge authority a test has. */
export async function readBadgeText(worker: Worker): Promise<string> {
  return await worker.evaluate(async (): Promise<string> => await chrome.action.getBadgeText({}));
}

/**
 * Records the lifecycle of every snapshot the worker broadcasts to this page from now on. A
 * transition can open and close between two polls, so a scenario that cares about the order of
 * published states observes them rather than sampling for them. The recording lives on the page,
 * so a reload starts it over and a caller must install it after its last reload.
 */
export async function observeSnapshotBroadcasts(extPage: Page): Promise<void> {
  await extPage.evaluate((): void => {
    const scope = globalThis as unknown as { __focusLockE2ELifecycles?: string[] };
    scope.__focusLockE2ELifecycles = [];
    chrome.runtime.onMessage.addListener((message: unknown): void => {
      if (typeof message !== 'object' || message === null) return;
      const candidate = message as { type?: unknown; snapshot?: unknown };
      if (candidate.type !== 'stateChanged') return;
      const snapshot = candidate.snapshot as { lifecycle?: { kind?: unknown } } | undefined;
      const kind: unknown = snapshot?.lifecycle?.kind;
      if (typeof kind === 'string') scope.__focusLockE2ELifecycles?.push(kind);
    });
  });
}

/** The lifecycles observed since `observeSnapshotBroadcasts`, in publication order. */
export async function observedSnapshotLifecycles(
  extPage: Page,
): Promise<SessionLifecycleV2['kind'][]> {
  return await extPage.evaluate(
    (): SessionLifecycleV2['kind'][] =>
      ((globalThis as unknown as { __focusLockE2ELifecycles?: string[] })
        .__focusLockE2ELifecycles ?? []) as SessionLifecycleV2['kind'][],
  );
}

/**
 * Samples the published snapshot from inside the page, as fast as the message port answers, and
 * returns every lifecycle it saw in order with consecutive repeats collapsed.
 *
 * The worker answers `getSnapshot` off the mutation queue on purpose, so a read lands mid
 * transition and reports the lifecycle the transition is in. A poll driven from Node cannot see
 * that: one round trip through the test runner costs more than the whole transition. This loop
 * runs in the page, so it samples the same window about a hundred times.
 *
 * Start it without awaiting, do the thing that moves the session, then await it:
 *
 * ```ts
 * const sampling: Promise<SessionLifecycleV2['kind'][]> = sampleLifecyclesUntil(extPage, 'active');
 * await startButton.click();
 * expect(await sampling).toEqual(['idle', 'starting', 'active']);
 * ```
 */
export async function sampleLifecyclesUntil(
  extPage: Page,
  terminal: SessionLifecycleV2['kind'],
  timeoutMs: number = 20_000,
): Promise<SessionLifecycleV2['kind'][]> {
  return (await extPage.evaluate(
    async (input: { terminal: string; timeoutMs: number }): Promise<string[]> => {
      const seen: string[] = [];
      const deadline: number = Date.now() + input.timeoutMs;
      for (;;) {
        const snapshot = (await chrome.runtime.sendMessage({ type: 'getSnapshot' })) as {
          lifecycle?: { kind?: string };
        };
        const kind: string | undefined = snapshot?.lifecycle?.kind;
        if (typeof kind === 'string' && seen[seen.length - 1] !== kind) seen.push(kind);
        if (kind === input.terminal || Date.now() >= deadline) return seen;
      }
    },
    { terminal, timeoutMs },
  )) as SessionLifecycleV2['kind'][];
}
