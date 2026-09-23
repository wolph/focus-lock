import { openPopupSection, revealSessionActions } from './popup-disclosures';
/**
 * Product flows for the "Until stopped" session, driven through the surfaces a user touches: the
 * popup start form, the blocked page, the toolbar badge, Settings, Stats, and the schedule.
 *
 * One published-state fact shapes how these scenarios watch a transition, measured against this
 * build rather than assumed. The worker publishes exactly one snapshot per command, so the
 * `starting` and `cleanup` lifecycles a fast start and a successful end pass through never reach
 * the broadcast stream. They do reach a `getSnapshot` read, which the worker answers off the
 * mutation queue, so the scenarios that care about transition order sample that channel from
 * inside the page through `sampleLifecyclesUntil` rather than polling it from the test runner.
 */

import type { BrowserContext, CDPSession, Locator, Page, Worker } from '@playwright/test';
import type { AllDataClearJournalV2 } from '../../src/background/data-clear-journal';
import type { RuntimeTabState } from '../../src/background/runtime-leaf-types';
import type {
  DailyAgg,
  ListsConfig,
  ScheduleEntryV2,
  SessionEndedEventV2,
  SessionEventRecordV2,
  SessionLifecycleV2,
  SessionSnapshotV2,
  Settings,
} from '../../src/shared/types';
import { assertNoUnexpectedBrowserDiagnostics } from './browser-diagnostics';
import {
  browserDiagnosticsFor,
  clearNotifications,
  expect,
  notificationIds,
  type ObservedSound,
  observedSnapshotLifecycles,
  observedSounds,
  observeSnapshotBroadcasts,
  observeSoundMessages,
  readBadgeText,
  readEventsV2FromWorker,
  readRuntimeV2,
  sampleLifecyclesUntil,
  sendExtensionRequest,
  startTestSession,
  startUntilStoppedSession,
  test,
  waitForLifecycle,
} from './fixtures';

/**
 * Copy the spec fixes, spelled out here rather than imported. A test that imported the shipped
 * constant would agree with any wording the product later chose, which is the one thing these
 * assertions exist to refuse.
 */
const UNTIL_STOPPED_LABEL: string = 'Until stopped';
const START_UNTIL_STOPPED_LABEL: string = 'Start until stopped';
const LOCK_UNTIL_MANUAL_UNLOCK_LABEL: string = 'Lock until manual unlock';
/** The hint for the default Friction type under the default ten-second gate with no phrase. */
const UNTIL_STOPPED_FRICTION_HINT: string =
  'Runs until you unlock it: a 10-second wait, then Unlock. Cycles off.';
const UNTIL_STOPPED_FLEXIBLE_HINT: string = 'Runs until you end it with End session. Cycles off.';
const HARD_UNAVAILABLE_REASON: string =
  'Hard lock is not available for Until stopped: with no timer and no manual end, the session could never end.';
const END_SESSION_LABEL: string = 'End session';
const FOCUS_TIME_LABEL: string = 'Focus time';
const FOCUS_PHASE_CLOCK_LABEL: string = 'focus phase';
const TOTAL_SESSION_CLOCK_LABEL: string = 'total session';
const PAUSE_CLOCK_LABEL: string = 'pause';
const INDEFINITE_BADGE_TEXT: string = 'ON';
const OVERLAY_UNTIL_STOPPED_STATUS: string = 'Until stopped';
const OVERLAY_STOPPED_PAGE_COPY: string =
  'This page did not load. It will load by itself when the session ends.';
const SETTINGS_INDEFINITE_COPY: string =
  'Until stopped session active. Use the toolbar popup to view or end it.';
const SETTINGS_SESSION_DISCLOSURE: string =
  'The toolbar popup owns session controls. Your changes reach the running session as you make them, except a hard lock, which holds anything that unblocks until it ends.';
const SCHEDULE_STARTED_TITLE: string = 'Focus schedule started';
const SCHEDULE_UNTIL_STOPPED_BODY: string = 'Active until you stop it.';
const CANCEL_GATE_TITLE: string = 'End this session';
const CANCEL_GATE_CONFIRM: string = 'End the session';
const CANCEL_GATE_BACK: string = 'Keep focusing';
const STATS_COMPLETED_MANUALLY: string = 'Completed manually';
const STATS_ENDED_EARLY: string = 'Ended early';

const FORCED_CYCLES_LABEL: string = 'Cycles forced by Until stopped';
const SESSION_STATUS_LABEL: string = 'Session status';
const BLOCKED_HOST: string = 'blocked.example';

/**
 * The schedule window a scheduled start needs is a local wall-clock window on the current local
 * day, so a run that straddles local midnight would watch its own window close mid-scenario. The
 * scenario refuses to run inside that band rather than becoming a test that sometimes proves
 * nothing.
 */
const MIDNIGHT_GUARD_MINUTES: number = 20;

interface RecordedNotification {
  title: string;
  message: string;
}

interface DomNodeSnapshot {
  attributes?: string[];
  backendNodeId: number;
  children?: DomNodeSnapshot[];
  nodeName: string;
  shadowRoots?: DomNodeSnapshot[];
}

/** The accessible names the mounted overlay contributes, and nothing the host page contributes. */
interface OverlayCopy {
  statics: string[];
  buttons: string[];
}

interface FastEconomyOptions {
  pauseMs: number;
  gateDelayMs?: number;
}

function expectNoDiagnostics(context: BrowserContext): void {
  expect((): void =>
    assertNoUnexpectedBrowserDiagnostics(browserDiagnosticsFor(context)),
  ).not.toThrow();
}

/**
 * Shortens the pause economy so a bank the user would earn in half an hour is earned in a second.
 * Nothing here changes what a pause means, only how long the test waits to afford one.
 */
async function configureFastEconomy(extPage: Page, options: FastEconomyOptions): Promise<void> {
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateSettings',
    settings: {
      ...settings,
      pause: {
        earnRatio: 10,
        capMs: Math.max(60_000, options.pauseMs),
        pauseMs: options.pauseMs,
        unlockMs: options.pauseMs,
      },
      gate: {
        delayMs: options.gateDelayMs ?? 500,
        requireTypedPhrase: false,
        allowForceEnd: false,
      },
    },
  });
  if (!ack.ok) throw new Error(ack.error);
}

/** Puts the test host on the stored block list, which is what a popup-driven start captures. */
async function seedBlockedList(extPage: Page): Promise<void> {
  const lists: ListsConfig = await sendExtensionRequest(extPage, { type: 'getLists' });
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateLists',
    lists: { ...lists, custom: [{ kind: 'host', pattern: BLOCKED_HOST }] },
  });
  if (!ack.ok) throw new Error(ack.error);
}

function flattenDomNode(node: DomNodeSnapshot): DomNodeSnapshot[] {
  const descendants: DomNodeSnapshot[] = [node];
  for (const child of node.children ?? []) descendants.push(...flattenDomNode(child));
  for (const shadowRoot of node.shadowRoots ?? []) {
    descendants.push(...flattenDomNode(shadowRoot));
  }
  return descendants;
}

/** The overlay renders in a closed shadow root, so its nodes are reachable only through CDP. */
async function overlayNodeIds(session: CDPSession): Promise<ReadonlySet<number>> {
  await session.send('DOM.enable');
  const document = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const allNodes: DomNodeSnapshot[] = flattenDomNode(document.root as DomNodeSnapshot);
  const host: DomNodeSnapshot | undefined = allNodes.find(
    (node: DomNodeSnapshot): boolean => node.nodeName === 'FOCUS-LOCK-OVERLAY',
  );
  if (host === undefined) throw new Error('the Focus Lock overlay is not mounted');
  return new Set<number>(
    (host.shadowRoots ?? [])
      .flatMap((shadowRoot: DomNodeSnapshot): DomNodeSnapshot[] => flattenDomNode(shadowRoot))
      .map((node: DomNodeSnapshot): number => node.backendNodeId),
  );
}

/** Opens the blocked page's collapsed access drawer so its controls join the accessibility tree. */
async function openAccessDrawer(context: BrowserContext, page: Page): Promise<void> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    await session.send('Accessibility.enable');
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

async function overlayCopy(context: BrowserContext, page: Page): Promise<OverlayCopy> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    await session.send('Accessibility.enable');
    const scopedNodeIds: ReadonlySet<number> = await overlayNodeIds(session);
    const tree = await session.send('Accessibility.getFullAXTree');
    const scoped = tree.nodes.filter(
      (node): boolean =>
        node.backendDOMNodeId !== undefined && scopedNodeIds.has(node.backendDOMNodeId),
    );
    return {
      statics: scoped
        .filter((node): boolean => node.role?.value === 'StaticText')
        .map((node): string => String(node.name?.value ?? '')),
      buttons: scoped
        .filter((node): boolean => node.role?.value === 'button')
        .map((node): string => String(node.name?.value ?? '')),
    };
  } finally {
    await session.detach();
  }
}

/** One labelled clock row's value, matched on the exact label so no row can stand in for another. */
function clockValue(page: Page, label: string): Locator {
  return page
    .locator('.clock-stack__row')
    .filter({
      has: page.locator('.clock-stack__label').filter({ hasText: new RegExp(`^${label}$`) }),
    })
    .locator('.clock-stack__value');
}

async function waitForPhase(extPage: Page, phase: string): Promise<SessionSnapshotV2> {
  await expect
    .poll(
      async (): Promise<string> =>
        (await sendExtensionRequest(extPage, { type: 'getSnapshot' })).phase,
      { timeout: 20_000 },
    )
    .toBe(phase);
  return await sendExtensionRequest(extPage, { type: 'getSnapshot' });
}

/**
 * Records what the worker asks Chrome to show. Chrome exposes notification IDs but never the
 * options behind them, so the only way to assert a notification body is to observe the call.
 */
async function observeNotifications(worker: Worker): Promise<void> {
  await worker.evaluate((): void => {
    const scope = globalThis as unknown as {
      __focusLockE2ENotifications?: { title: string; message: string }[];
    };
    scope.__focusLockE2ENotifications = [];
    const create: (...args: unknown[]) => unknown = chrome.notifications.create.bind(
      chrome.notifications,
    ) as unknown as (...args: unknown[]) => unknown;
    const recording: (...args: unknown[]) => unknown = (...args: unknown[]): unknown => {
      for (const argument of args) {
        if (typeof argument !== 'object' || argument === null) continue;
        const options = argument as { title?: unknown; message?: unknown };
        if (typeof options.title === 'string' && typeof options.message === 'string') {
          scope.__focusLockE2ENotifications?.push({
            title: options.title,
            message: options.message,
          });
        }
      }
      return create(...args);
    };
    chrome.notifications.create = recording as unknown as typeof chrome.notifications.create;
  });
}

async function recordedNotifications(worker: Worker): Promise<RecordedNotification[]> {
  return await worker.evaluate(
    (): RecordedNotification[] =>
      (globalThis as unknown as { __focusLockE2ENotifications?: RecordedNotification[] })
        .__focusLockE2ENotifications ?? [],
  );
}

/**
 * Wakes the worker's one-minute maintenance alarm now and waits for the publication it produces,
 * which is the evidence the schedule check actually ran. The alarm keeps its period, so the
 * profile is left with the periodic tick it started with.
 */
async function forceTick(extPage: Page, worker: Worker): Promise<void> {
  const before: number = (await observedSnapshotLifecycles(extPage)).length;
  await worker.evaluate(async (): Promise<void> => {
    await chrome.alarms.create('tick', { when: Date.now(), periodInMinutes: 1 });
  });
  await expect
    .poll(async (): Promise<number> => (await observedSnapshotLifecycles(extPage)).length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(before);
}

function completedToday(runtime: { todayAgg: DailyAgg | null }): number {
  return runtime.todayAgg?.sessionsCompleted ?? 0;
}

function endEventFor(events: SessionEventRecordV2[], sessionId: string): SessionEndedEventV2 {
  const found: SessionEventRecordV2 | undefined = events.find(
    (event: SessionEventRecordV2): boolean =>
      'version' in event && event.version === 2 && event.eventId === `${sessionId}:end`,
  );
  if (found === undefined || !('version' in found) || found.t !== 'sessionEnded') {
    throw new Error(`no end event was recorded for session ${sessionId}`);
  }
  return found;
}

/**
 * True once the worker holds a durable stop record for some tab, which is the only authority on
 * whether a fresh navigation was actually stopped. Answers false rather than throwing, so the
 * caller can report a missing precondition instead of failing on it.
 */
async function stoppedDocumentRecorded(worker: Worker, timeoutMs: number): Promise<boolean> {
  const deadline: number = Date.now() + timeoutMs;
  for (;;) {
    const stopped: boolean = Object.values((await readRuntimeV2(worker)).tabStates).some(
      (state: RuntimeTabState): boolean => state.stoppedDocumentId !== null,
    );
    if (stopped) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve: (value: unknown) => void): void => {
      setTimeout(resolve, 100);
    });
  }
}

async function activeSessionId(worker: Worker): Promise<string> {
  const sessionId: string | undefined = (await readRuntimeV2(worker)).session?.sessionId;
  if (sessionId === undefined) throw new Error('no durable session is active');
  return sessionId;
}

test('manual until-stopped start keeps the chosen plan and reports it everywhere', async ({
  context,
  extPage,
  worker,
}) => {
  await seedBlockedList(extPage);
  await extPage.reload();

  await extPage.getByRole('button', { name: UNTIL_STOPPED_LABEL, exact: true }).click();

  await openPopupSection(extPage, 'Session settings');
  const hardLock: Locator = extPage.getByRole('button', { name: 'Hard lock' });
  await expect(hardLock).toHaveAttribute('aria-disabled', 'true');
  await expect(hardLock).toContainText(HARD_UNAVAILABLE_REASON);
  await expect(extPage.getByRole('button', { name: 'Friction' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(extPage.getByText(UNTIL_STOPPED_FRICTION_HINT, { exact: true })).toBeVisible();
  await expect(extPage.getByRole('button', { name: LOCK_UNTIL_MANUAL_UNLOCK_LABEL })).toBeEnabled();

  await extPage.getByRole('button', { name: 'Flexible' }).click();
  await expect(extPage.getByText(UNTIL_STOPPED_FLEXIBLE_HINT, { exact: true })).toBeVisible();

  await openPopupSection(extPage, 'Session settings');
  const forcedCycles: Locator = extPage.getByRole('group', { name: FORCED_CYCLES_LABEL });
  await expect(forcedCycles).toHaveAttribute('aria-disabled', 'true');
  await expect(forcedCycles.getByRole('checkbox')).not.toBeChecked();

  const startButton: Locator = extPage.getByRole('button', { name: START_UNTIL_STOPPED_LABEL });
  await expect(startButton).toBeEnabled();

  // The sub-second starting window is real and observable, but only on the snapshot channel: the
  // worker answers `getSnapshot` off the mutation queue while a transition runs, and publishes one
  // broadcast per command at the end. So the sampling runs in the page, and it starts before the
  // click that opens the window it is there to catch.
  const sampled: Promise<SessionLifecycleV2['kind'][]> = sampleLifecyclesUntil(extPage, 'active');
  await startButton.click();
  const kinds: SessionLifecycleV2['kind'][] = await sampled;
  expect(kinds).toEqual(['idle', 'starting', 'active']);
  const active: SessionSnapshotV2 = await waitForLifecycle(extPage, 'active');

  expect(active.config?.duration).toEqual({ kind: 'until-stopped' });
  expect(active.config?.strictness).toBe('flexible');
  expect(active.config?.cycling).toBeNull();
  expect(active.phaseEndsAt).toBeNull();
  expect(active.sessionEndsAt).toBeNull();

  await expect(clockValue(extPage, FOCUS_TIME_LABEL)).toBeVisible();
  await expect(extPage.locator('.clock-stack__note')).toHaveText(UNTIL_STOPPED_LABEL);
  await revealSessionActions(extPage);
  await expect(extPage.getByRole('button', { name: END_SESSION_LABEL })).toBeVisible();
  await expect
    .poll(async (): Promise<string> => await readBadgeText(worker))
    .toBe(INDEFINITE_BADGE_TEXT);

  expectNoDiagnostics(context);
});

test('the indefinite blocked page offers the same End the popup does', async ({
  context,
  extPage,
  siteUrl,
}) => {
  const existingPage: Page = await context.newPage();
  await existingPage.goto(siteUrl('/plain.html'));
  await startUntilStoppedSession(extPage);
  await expect(existingPage.locator('focus-lock-overlay')).toBeAttached();

  await expect
    .poll(async (): Promise<string[]> => (await overlayCopy(context, existingPage)).statics)
    .toContain(OVERLAY_UNTIL_STOPPED_STATUS);
  await openAccessDrawer(context, existingPage);
  const existingCopy: OverlayCopy = await overlayCopy(context, existingPage);
  expect(
    existingCopy.statics.filter((text: string): boolean => text.startsWith('Locked until')),
  ).toEqual([]);
  // A Flexible until-stopped page ends at once from the page, the way the popup does.
  expect(existingCopy.buttons).toContain(END_SESSION_LABEL);
  expect(existingCopy.statics).not.toContain(OVERLAY_STOPPED_PAGE_COPY);

  expectNoDiagnostics(context);
});

/**
 * Every claim this suite makes about a fresh navigation lives here, behind one precondition,
 * because whether a navigation is fresh enough to stop is Chrome's call rather than the product's:
 * the content script reads `document.readyState` when it installs, and on a page this small Chrome
 * sometimes injects it after the document has already left `loading`. Measured on this machine,
 * one navigation in eight arrived too late, and forcing a slower parse through request
 * interception made it worse rather than better. The plan already refuses to test the fail-open
 * boundary as fail-closed, so the precondition is read from the worker's own durable stop record
 * and the scenario says out loud when Chrome handed it nothing to stop.
 */
test('a stopped fresh navigation carries the indefinite and stopped-page copy', async ({
  context,
  extPage,
  siteUrl,
  worker,
}) => {
  await startUntilStoppedSession(extPage);
  const stoppedPage: Page = await context.newPage();
  await stoppedPage.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });

  const stopped: boolean = await stoppedDocumentRecorded(worker, 10_000);
  test.skip(
    !stopped,
    'Chrome injected the content script after this document left readyState loading, so there was no fresh navigation to stop',
  );
  await expect(stoppedPage.locator('focus-lock-overlay')).toBeAttached();
  await expect(stoppedPage).toHaveTitle('Locked - Focus Lock');
  await expect(stoppedPage.locator('#marker')).toHaveCount(0);
  await openAccessDrawer(context, stoppedPage);
  const stoppedCopy: OverlayCopy = await overlayCopy(context, stoppedPage);
  expect(stoppedCopy.statics).toContain(OVERLAY_UNTIL_STOPPED_STATUS);
  expect(
    stoppedCopy.statics.filter((text: string): boolean => text.startsWith('Locked until')),
  ).toEqual([]);
  // A Flexible until-stopped page offers End on a stopped document as it does on a loaded one.
  expect(stoppedCopy.buttons).toContain(END_SESSION_LABEL);

  // The worker records the stop after it has already built the command that answered this
  // navigation, so the stopped-page sentence rides on the next live-view refresh rather than on
  // the first render. The refresh here is a theme change, which is a real user action. That
  // ordering is a finding in the task report.
  expect(await sendExtensionRequest(extPage, { type: 'updateTheme', theme: 'dark' })).toEqual({
    ok: true,
  });
  await expect
    .poll(async (): Promise<string[]> => (await overlayCopy(context, stoppedPage)).statics, {
      timeout: 15_000,
    })
    .toContain(OVERLAY_STOPPED_PAGE_COPY);
  await openAccessDrawer(context, stoppedPage);
  const refreshedCopy: OverlayCopy = await overlayCopy(context, stoppedPage);
  expect(refreshedCopy.statics).toContain(OVERLAY_UNTIL_STOPPED_STATUS);
  expect(refreshedCopy.buttons).toContain(END_SESSION_LABEL);

  expectNoDiagnostics(context);
});

test('popup End completes the indefinite session manually and silently', async ({
  context,
  extPage,
  siteUrl,
  worker,
}) => {
  const blockedPage: Page = await context.newPage();
  await blockedPage.goto(siteUrl('/plain.html'));
  await clearNotifications(worker);
  await observeSoundMessages(extPage);
  await startUntilStoppedSession(extPage);
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();

  const sessionId: string = await activeSessionId(worker);
  const completedBefore: number = completedToday(await readRuntimeV2(worker));

  const sampled: Promise<SessionLifecycleV2['kind'][]> = sampleLifecyclesUntil(extPage, 'idle');
  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: END_SESSION_LABEL }).click();
  expect(await sampled).toEqual(['active', 'cleanup', 'idle']);
  await waitForLifecycle(extPage, 'idle', 60_000);

  await expect(blockedPage.locator('focus-lock-overlay')).toHaveCount(0);
  await expect(blockedPage.locator('#marker')).toHaveText('plain page');

  const endEvent: SessionEndedEventV2 = endEventFor(
    await readEventsV2FromWorker(worker),
    sessionId,
  );
  expect(endEvent.reason).toBe('manual-completed');
  expect(endEvent.outcome).toBe('completed');
  expect(endEvent.duration).toEqual({ kind: 'until-stopped' });

  const runtimeAfter = await readRuntimeV2(worker);
  expect(completedToday(runtimeAfter)).toBe(completedBefore + 1);
  // The closure journal is the durable half of the cleanup lifecycle the popup never sees. An end
  // that left it behind would be an end that never finished.
  expect(runtimeAfter.pendingClosure).toBeNull();
  expect(runtimeAfter.session).toBeNull();

  expect(
    (await observedSounds(extPage)).map((sound: ObservedSound): string => sound.sound),
  ).not.toContain('sessionComplete');
  expect(await notificationIds(worker)).toEqual([]);
  expect(await readBadgeText(worker)).toBe('');

  expectNoDiagnostics(context);
});

test('an indefinite pause freezes focus time and still ends from the popup', async ({
  context,
  extPage,
  worker,
}) => {
  // A minute-long pause so the freeze is measured well inside it: the boundary this scenario cares
  // about is the one it must not cross.
  await configureFastEconomy(extPage, { pauseMs: 60_000 });
  await startUntilStoppedSession(extPage);

  const sessionId: string = await activeSessionId(worker);
  await expect
    .poll(
      async (): Promise<number> =>
        (await sendExtensionRequest(extPage, { type: 'getSnapshot' })).bankMs,
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(60_000);

  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: /^Unlock all sites / }).click();
  const confirmPause: Locator = extPage.getByRole('button', {
    name: 'Unlock all sites',
    exact: true,
  });
  await expect(confirmPause).toBeEnabled();
  await confirmPause.click();

  const paused: SessionSnapshotV2 = await waitForPhase(extPage, 'paused');
  expect(paused.lifecycle.kind).toBe('active');
  expect(paused.phaseEndsAt).not.toBeNull();
  expect(paused.sessionEndsAt).toBeNull();
  await expect(clockValue(extPage, PAUSE_CLOCK_LABEL)).toBeVisible();

  const focusTime: Locator = clockValue(extPage, FOCUS_TIME_LABEL);
  const firstRead: string = await focusTime.innerText();
  await expect
    .poll(async (): Promise<string> => await focusTime.innerText(), {
      intervals: [500],
      timeout: 1_500,
    })
    .toBe(firstRead);
  expect(await focusTime.innerText()).toBe(firstRead);

  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: END_SESSION_LABEL }).click();
  await waitForLifecycle(extPage, 'idle', 60_000);

  const endEvent: SessionEndedEventV2 = endEventFor(
    await readEventsV2FromWorker(worker),
    sessionId,
  );
  expect(endEvent.reason).toBe('manual-completed');
  expect(endEvent.outcome).toBe('completed');
  expect((await readRuntimeV2(worker)).pendingClosure).toBeNull();

  expectNoDiagnostics(context);
});

test('a pause that expires resumes indefinite focus with no end in sight', async ({
  context,
  extPage,
  worker,
}) => {
  await configureFastEconomy(extPage, { pauseMs: 6_000 });
  await startUntilStoppedSession(extPage);
  await expect
    .poll(
      async (): Promise<number> =>
        (await sendExtensionRequest(extPage, { type: 'getSnapshot' })).bankMs,
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(6_000);

  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: /^Unlock all sites / }).click();
  const confirmPause: Locator = extPage.getByRole('button', {
    name: 'Unlock all sites',
    exact: true,
  });
  await expect(confirmPause).toBeEnabled();
  await confirmPause.click();

  const paused: SessionSnapshotV2 = await waitForPhase(extPage, 'paused');
  expect(paused.phaseStartedAt).not.toBeNull();

  const resumed: SessionSnapshotV2 = await waitForPhase(extPage, 'focus');
  expect(resumed.lifecycle.kind).toBe('active');
  expect(resumed.phaseEndsAt).toBeNull();
  expect(resumed.sessionEndsAt).toBeNull();
  // A fresh focus phase, not the one the pause interrupted: the resume transition really ran.
  expect(resumed.phaseStartedAt ?? 0).toBeGreaterThan(paused.phaseStartedAt ?? 0);
  expect((await readRuntimeV2(worker)).pendingEnforcementTransition).toBeNull();
  await expect(clockValue(extPage, FOCUS_TIME_LABEL)).toBeVisible();
  await expect(readBadgeText(worker)).resolves.toBe(INDEFINITE_BADGE_TEXT);

  expectNoDiagnostics(context);
});

test('a 50 minute popup start makes the total session prominent above its focus phase', async ({
  context,
  extPage,
  worker,
}) => {
  await extPage.getByRole('button', { name: '50 min', exact: true }).click();
  await openPopupSection(extPage, 'Session settings');
  await extPage.getByRole('checkbox', { name: /^Cycles:/ }).check();
  await extPage.getByRole('button', { name: /^Start 50 min focus$/ }).click();
  const snapshot: SessionSnapshotV2 = await waitForLifecycle(extPage, 'active');

  const primaryRow: Locator = extPage.locator(
    '.clock-stack__row:not(.clock-stack__row--secondary)',
  );
  const secondaryRow: Locator = extPage.locator('.clock-stack__row--secondary');
  await expect(primaryRow.locator('.clock-stack__label')).toHaveText(TOTAL_SESSION_CLOCK_LABEL);
  await expect(secondaryRow.locator('.clock-stack__label')).toHaveText(FOCUS_PHASE_CLOCK_LABEL);

  // Both clocks are read once, right after activation. They tick down, so the tolerance covers the
  // render latency between the durable start and this read and nothing more.
  await expect(clockValue(extPage, FOCUS_PHASE_CLOCK_LABEL)).toHaveText(/^(25:00|24:59|24:58)$/);
  await expect(clockValue(extPage, TOTAL_SESSION_CLOCK_LABEL)).toHaveText(/^(50:00|49:59|49:58)$/);

  expect(snapshot.config?.duration).toEqual({ kind: 'timed', minutes: 50 });
  expect(snapshot.config?.cycling?.focusMin).toBe(25);
  expect((await readRuntimeV2(worker)).session?.config.duration).toEqual({
    kind: 'timed',
    minutes: 50,
  });
  const startedAt: number | null = snapshot.startedAt;
  expect(startedAt).not.toBeNull();
  expect(snapshot.sessionEndsAt).toBe((startedAt ?? 0) + 50 * 60_000);
  expect(snapshot.phaseEndsAt).toBe((startedAt ?? 0) + 25 * 60_000);
  const phaseAlarm: chrome.alarms.Alarm | undefined = await worker.evaluate(
    async (): Promise<chrome.alarms.Alarm | undefined> => await chrome.alarms.get('phase'),
  );
  expect(phaseAlarm).toBeDefined();
  expect(
    Math.abs((phaseAlarm?.scheduledTime ?? 0) - ((startedAt ?? 0) + 25 * 60_000)),
  ).toBeLessThan(1_000);

  expectNoDiagnostics(context);
});

/** Ends one timed and one indefinite session by hand, in that order, newest last. */
async function recordTwoManualEnds(extPage: Page, worker: Worker): Promise<void> {
  await startTestSession(extPage, {
    duration: { kind: 'timed', minutes: 5 },
    strictness: 'flexible',
  });
  const timedSessionId: string = await activeSessionId(worker);
  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: END_SESSION_LABEL }).click();
  await waitForLifecycle(extPage, 'idle', 60_000);
  const timedEnd: SessionEndedEventV2 = endEventFor(
    await readEventsV2FromWorker(worker),
    timedSessionId,
  );
  expect(timedEnd.reason).toBe('manual-canceled');
  expect(timedEnd.outcome).toBe('canceled');

  await startUntilStoppedSession(extPage);
  const indefiniteSessionId: string = await activeSessionId(worker);
  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: END_SESSION_LABEL }).click();
  await waitForLifecycle(extPage, 'idle', 60_000);
  const indefiniteEnd: SessionEndedEventV2 = endEventFor(
    await readEventsV2FromWorker(worker),
    indefiniteSessionId,
  );
  expect(indefiniteEnd.reason).toBe('manual-completed');
  expect(indefiniteEnd.outcome).toBe('completed');
  expect(indefiniteEnd.duration).toEqual({ kind: 'until-stopped' });
}

test('manual end reasons separate a timed cancel from an indefinite completion', async ({
  context,
  extPage,
  worker,
}) => {
  await recordTwoManualEnds(extPage, worker);
  expectNoDiagnostics(context);
});

/**
 * This scenario found the defect that `stats-service.ts` classified terminal events by the version 1
 * names, which dropped every version 2 `sessionEnded` on the way into the stats bundle and left each
 * finished session reporting as `Running` with no focused time. It is the end-to-end proof that both
 * outcome wordings reach the table, which no unit test covered when it was written.
 */
test('stats reports the indefinite plan and both manual outcomes', async ({
  context,
  extPage,
  extensionId,
  worker,
}) => {
  await recordTwoManualEnds(extPage, worker);

  const statsPage: Page = await context.newPage();
  await statsPage.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);
  const rows: Locator = statsPage.locator('.session-table tbody tr');
  await expect(rows.first()).toContainText(UNTIL_STOPPED_LABEL);
  await expect(rows.first()).toContainText(STATS_COMPLETED_MANUALLY);
  await expect(rows.nth(1)).toContainText('5 m');
  await expect(rows.nth(1)).toContainText(STATS_ENDED_EARLY);

  expectNoDiagnostics(context);
});

test('end authority follows the session type a timed session was started with', async ({
  context,
  extPage,
}) => {
  await configureFastEconomy(extPage, { pauseMs: 60_000, gateDelayMs: 500 });

  await startTestSession(extPage, {
    duration: { kind: 'timed', minutes: 5 },
    strictness: 'friction',
  });
  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: END_SESSION_LABEL }).click();
  const gateSnapshot: SessionSnapshotV2 = await expect
    .poll(
      async (): Promise<string | null> =>
        (await sendExtensionRequest(extPage, { type: 'getSnapshot' })).gate?.kind ?? null,
    )
    .toBe('cancel')
    .then(async (): Promise<SessionSnapshotV2> => {
      return await sendExtensionRequest(extPage, { type: 'getSnapshot' });
    });
  const authority: SessionLifecycleV2['endAuthority'] = gateSnapshot.lifecycle.endAuthority;
  expect(authority.kind).toBe('friction-gate');
  // The popup's active view renders the gate's controls but not its title, so the exact title is
  // asserted where the worker publishes it. The report records that gap.
  expect(
    authority.kind === 'friction-gate' && authority.gate !== null ? authority.copy.title : null,
  ).toBe(CANCEL_GATE_TITLE);
  await expect(extPage.getByRole('button', { name: CANCEL_GATE_BACK })).toBeVisible();
  const confirmEnd: Locator = extPage.getByRole('button', { name: CANCEL_GATE_CONFIRM });
  await expect(confirmEnd).toBeEnabled();
  await confirmEnd.click();
  await waitForLifecycle(extPage, 'idle', 60_000);

  await startTestSession(extPage, {
    duration: { kind: 'timed', minutes: 5 },
    strictness: 'hard',
  });
  await expect(clockValue(extPage, TOTAL_SESSION_CLOCK_LABEL)).toBeVisible();
  await expect(extPage.getByRole('button', { name: END_SESSION_LABEL })).toHaveCount(0);

  expectNoDiagnostics(context);
});

test('a scheduled until-stopped window starts once and never relocks inside itself', async ({
  context,
  extPage,
  worker,
}) => {
  // The scenario also waits out a full closure cleanup, which the default budget cannot hold.
  test.setTimeout(120_000);
  await observeNotifications(worker);

  const clock: { hours: number; minutes: number; day: number } = await worker.evaluate(
    (): { hours: number; minutes: number; day: number } => {
      const at: Date = new Date();
      return { hours: at.getHours(), minutes: at.getMinutes(), day: at.getDay() };
    },
  );
  const nowMinutes: number = clock.hours * 60 + clock.minutes;
  test.skip(
    nowMinutes < MIDNIGHT_GUARD_MINUTES || nowMinutes > 24 * 60 - MIDNIGHT_GUARD_MINUTES,
    'a local wall-clock window cannot stay open across local midnight',
  );

  const asHhMm: (minutes: number) => string = (minutes: number): string =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const entry: ScheduleEntryV2 = {
    id: 'e2e-indefinite-window',
    days: [clock.day],
    start: asHhMm(nowMinutes - 1),
    end: asHhMm(nowMinutes + 9),
    duration: { kind: 'until-stopped' },
    mode: 'blacklist',
    strictness: 'flexible',
    cycling: null,
    intention: 'scheduled indefinite e2e',
    enabled: true,
  };
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateSettings',
    settings: { ...settings, schedule: [entry] },
  });
  if (!ack.ok) throw new Error(ack.error);

  const active: SessionSnapshotV2 = await waitForLifecycle(extPage, 'active', 30_000);
  expect(active.config?.source).toBe('schedule');
  expect(active.config?.duration).toEqual({ kind: 'until-stopped' });
  expect(active.config?.strictness).toBe('flexible');
  expect(active.sessionEndsAt).toBeNull();
  expect(active.config?.scheduleOccurrence?.entryId).toBe(entry.id);
  expect(await recordedNotifications(worker)).toContainEqual({
    title: SCHEDULE_STARTED_TITLE,
    message: SCHEDULE_UNTIL_STOPPED_BODY,
  });

  await extPage.reload();
  await observeSnapshotBroadcasts(extPage);
  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: END_SESSION_LABEL }).click();
  await waitForLifecycle(extPage, 'idle', 60_000);
  expect((await readRuntimeV2(worker)).handledScheduleOccurrences).toContainEqual(
    expect.objectContaining({
      token: `${entry.id}@${active.config?.scheduleOccurrence?.localStartDate ?? ''}`,
      reason: 'started',
    }),
  );

  // Three real schedule checks inside the same still-open window. Each one publishes, which is how
  // this scenario knows the check ran rather than assuming it did.
  for (let round: number = 0; round < 3; round += 1) {
    await forceTick(extPage, worker);
    const snapshot: SessionSnapshotV2 = await sendExtensionRequest(extPage, {
      type: 'getSnapshot',
    });
    expect(snapshot.lifecycle.kind).toBe('idle');
    expect(snapshot.config).toBeNull();
  }
  expect(await observedSnapshotLifecycles(extPage)).not.toContain('active');

  expectNoDiagnostics(context);
});

test('settings reports the indefinite session and discloses that the popup owns it', async ({
  context,
  extPage,
  extensionId,
}) => {
  const optionsPage: Page = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(optionsPage.locator('.session-status')).toHaveCount(0);

  await startUntilStoppedSession(extPage);

  const status: Locator = optionsPage.locator('.session-status');
  await expect(status).toHaveText(SETTINGS_INDEFINITE_COPY);
  const statusGroup: Locator = optionsPage.getByRole('group', { name: SESSION_STATUS_LABEL });
  await expect(statusGroup).toHaveAttribute('aria-disabled', 'true');
  await statusGroup.focus();
  await expect(optionsPage.getByRole('tooltip')).toHaveText(SETTINGS_SESSION_DISCLOSURE);

  expectNoDiagnostics(context);
});

interface DataClearProbe {
  remove: typeof chrome.storage.sync.remove;
  journals: (AllDataClearJournalV2 | null)[];
  listener(changes: Record<string, chrome.storage.StorageChange>, area: string): void;
}

async function readDataClearJournal(worker: Worker): Promise<AllDataClearJournalV2 | null> {
  return await worker.evaluate(async (): Promise<AllDataClearJournalV2 | null> => {
    const stored: Record<string, unknown> = await chrome.storage.local.get('dataClearJournal');
    return (stored.dataClearJournal as AllDataClearJournalV2 | undefined) ?? null;
  });
}

/** Fail only the browser deletion boundary. Every journal write and retry remains real. */
async function interceptDataClear(worker: Worker): Promise<void> {
  await worker.evaluate((): void => {
    const probe: DataClearProbe = {
      remove: chrome.storage.sync.remove,
      journals: [],
      listener: (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
        if (area !== 'local' || !Object.hasOwn(changes, 'dataClearJournal')) return;
        probe.journals.push(
          (changes.dataClearJournal?.newValue as AllDataClearJournalV2 | undefined) ?? null,
        );
      },
    };
    (globalThis as unknown as { dataClearProbe: DataClearProbe }).dataClearProbe = probe;
    chrome.storage.sync.remove = async (): Promise<void> => {
      throw new Error('e2e remote deletion unavailable');
    };
    chrome.storage.onChanged.addListener(probe.listener);
  });
}

async function restoreDataClear(worker: Worker, stopObserving: boolean = false): Promise<void> {
  await worker.evaluate((stop: boolean): void => {
    const scope: { dataClearProbe?: DataClearProbe } = globalThis as unknown as {
      dataClearProbe?: DataClearProbe;
    };
    const probe: DataClearProbe | undefined = scope.dataClearProbe;
    if (probe === undefined) return;
    chrome.storage.sync.remove = probe.remove;
    if (stop) {
      chrome.storage.onChanged.removeListener(probe.listener);
      delete scope.dataClearProbe;
    }
  }, stopObserving);
}

test('all-data deletion blocks starts and popup retry completes the exhausted real journal', async ({
  context,
  extPage,
  worker,
}) => {
  await startUntilStoppedSession(extPage);
  const active: SessionSnapshotV2 = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  if (active.config === null) throw new Error('the started session has no configuration');
  await extPage.reload();
  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: END_SESSION_LABEL }).click();
  await waitForLifecycle(extPage, 'idle');
  await interceptDataClear(worker);
  try {
    expect(
      await sendExtensionRequest(extPage, { type: 'clearFocusLockData', scope: 'all' }),
    ).toEqual({
      ok: false,
      scope: 'all',
      status: 'pending',
      error: 'e2e remote deletion unavailable',
    });
    const pending: AllDataClearJournalV2 | null = await readDataClearJournal(worker);
    expect(pending).toMatchObject({
      version: 2,
      scope: 'all',
      phase: 'remote',
      retry: {
        automaticAttempt: 1,
        lastError: 'e2e remote deletion unavailable',
      },
    });
    expect(pending?.retry.nextAttemptAt).toEqual(expect.any(Number));
    expect(
      await sendExtensionRequest(extPage, { type: 'startSession', config: active.config }),
    ).toMatchObject({ ok: false, code: 'data-clear-pending' });
    await extPage.reload();
    await expect(
      extPage.getByText('Deleting Focus Lock data. Finishing cleanup.', { exact: true }),
    ).toBeVisible();
    await expect(extPage.getByRole('button', { name: 'Retry cleanup' })).toHaveCount(0);
    expect(await sendExtensionRequest(extPage, { type: 'retryDataClear' })).toMatchObject({
      ok: false,
      code: 'retry-not-available',
    });

    // Reissuing deletion spends the actual durable budget without waiting hours for its alarms.
    for (let attempt: number = 2; attempt <= 12; attempt += 1) {
      expect(
        await sendExtensionRequest(extPage, { type: 'clearFocusLockData', scope: 'all' }),
      ).toMatchObject({ ok: false, status: 'pending' });
      expect((await readDataClearJournal(worker))?.retry.automaticAttempt).toBe(attempt);
    }
    const exhausted: AllDataClearJournalV2 | null = await readDataClearJournal(worker);
    expect(exhausted?.retry.nextAttemptAt).toBeNull();
    await extPage.reload();
    await expect(
      extPage.getByText('Could not delete data. Try again.', { exact: true }),
    ).toBeVisible();
    await restoreDataClear(worker);
    await extPage.getByRole('button', { name: 'Retry cleanup', exact: true }).click();
    await expect
      .poll(async (): Promise<AllDataClearJournalV2 | null> => await readDataClearJournal(worker))
      .toBeNull();
    const journals: (AllDataClearJournalV2 | null)[] = await worker.evaluate(
      (): (AllDataClearJournalV2 | null)[] =>
        (globalThis as unknown as { dataClearProbe: DataClearProbe }).dataClearProbe.journals,
    );
    const retried: AllDataClearJournalV2[] = journals.filter(
      (journal: AllDataClearJournalV2 | null): journal is AllDataClearJournalV2 =>
        journal !== null && journal.retry.batch === (exhausted?.retry.batch ?? -1) + 1,
    );
    expect([
      ...new Set(retried.map((journal: AllDataClearJournalV2): string => journal.phase)),
    ]).toEqual(['remote', 'local', 'browser-reset']);
    expect(journals.at(-1)).toBeNull();
    expect(
      await worker.evaluate(
        async (): Promise<Record<string, unknown>> => await chrome.storage.sync.get(null),
      ),
    ).toEqual({});
    expect(await sendExtensionRequest(extPage, { type: 'getSetupState' })).toMatchObject({
      completed: false,
      dataClear: { status: 'idle', scope: null, phase: null },
    });
    expect((await readRuntimeV2(worker)).enforcementEpoch).toBe(pending?.resetEpoch);
    await expect(extPage.getByRole('button', { name: 'Retry cleanup' })).toHaveCount(0);
    expectNoDiagnostics(context);
  } finally {
    await restoreDataClear(worker, true);
  }
});
