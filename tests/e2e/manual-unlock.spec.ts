import type { Page } from '@playwright/test';
import type { CommandResponseV2, SessionCommandResultCodeV2 } from '../../src/shared/messages';
import type { GateState, ListsConfig, SessionSnapshotV2, Settings } from '../../src/shared/types';
import { assertNoUnexpectedBrowserDiagnostics } from './browser-diagnostics';
import {
  browserDiagnosticsFor,
  type ExtensionLaunch,
  expect,
  sendExtensionRequest,
  test,
  waitForLifecycle,
} from './fixtures';
import { openPopupSection, revealSessionActions } from './popup-disclosures';

/** Copy the spec fixes, spelled out here rather than imported, so a wording change fails loudly. */
const UNTIL_STOPPED_LABEL: string = 'Until stopped';
const LOCK_UNTIL_MANUAL_UNLOCK_LABEL: string = 'Lock until manual unlock';
const START_UNTIL_STOPPED_LABEL: string = 'Start until stopped';
const UNLOCK_LABEL: string = 'Unlock';
const END_SESSION_LABEL: string = 'End session';
const FRICTION_HINT: string = 'Runs until you unlock it: a 1-second wait, then Unlock. Cycles off.';
const FLEXIBLE_HINT: string = 'Runs until you end it with End session. Cycles off.';
const BLOCKED_HOST: string = 'blocked.example';

async function seedBlockedList(extPage: Page): Promise<void> {
  const lists: ListsConfig = await sendExtensionRequest(extPage, { type: 'getLists' });
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateLists',
    lists: { ...lists, custom: [{ kind: 'host', pattern: BLOCKED_HOST }] },
  });
  if (!ack.ok) throw new Error(ack.error);
}

async function useOneSecondGate(extPage: Page, defaultStrictness: Settings['defaultStrictness']) {
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  expect(
    await sendExtensionRequest(extPage, {
      type: 'updateSettings',
      settings: {
        ...settings,
        gate: { delayMs: 1_000, requireTypedPhrase: false, allowForceEnd: false },
        cyclingOnByDefault: true,
        defaultStrictness,
      },
    }),
  ).toEqual({ ok: true });
}

test('a Friction manual lock survives browser restart and unlocks only through its gate', async ({
  restartableExtension,
  siteUrl,
}) => {
  const original: ExtensionLaunch = await restartableExtension.launch();
  await original.extPage.setViewportSize({ width: 1280, height: 1000 });
  // Hard is the Settings default here, so the clamp to Friction is what the button reports.
  await useOneSecondGate(original.extPage, 'hard');
  await seedBlockedList(original.extPage);
  await original.extPage.reload();
  await expect(original.extPage.locator('body')).toHaveCSS('width', '600px');

  await original.extPage.getByRole('button', { name: UNTIL_STOPPED_LABEL, exact: true }).click();
  await openPopupSection(original.extPage, 'Session settings');
  await expect(original.extPage.getByRole('button', { name: 'Hard lock' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(original.extPage.locator('.session-timing')).toHaveText(FRICTION_HINT);
  await original.extPage
    .getByRole('button', { name: LOCK_UNTIL_MANUAL_UNLOCK_LABEL, exact: true })
    .click();

  const before: SessionSnapshotV2 = await waitForLifecycle(original.extPage, 'active');
  expect(before).toMatchObject({
    phase: 'focus',
    config: { duration: { kind: 'until-stopped' }, strictness: 'friction', cycling: null },
    phaseEndsAt: null,
    sessionEndsAt: null,
  });
  await revealSessionActions(original.extPage);
  await expect(
    original.extPage.getByRole('button', { name: UNLOCK_LABEL, exact: true }),
  ).toBeVisible();
  const blocked: Page = await original.context.newPage();
  await blocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blocked.locator('focus-lock-overlay')).toBeAttached();
  await restartableExtension.close();

  const restored: ExtensionLaunch = await restartableExtension.launch();
  const snapshot: SessionSnapshotV2 = await waitForLifecycle(restored.extPage, 'active', 60_000);
  expect(snapshot).toMatchObject({
    phase: 'focus',
    startedAt: before.startedAt,
    config: { duration: { kind: 'until-stopped' }, strictness: 'friction' },
    phaseEndsAt: null,
    sessionEndsAt: null,
  });
  const stillBlocked: Page = await restored.context.newPage();
  await stillBlocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(stillBlocked.locator('focus-lock-overlay')).toBeAttached();

  // Unlock opens the gate, and the gate's confirm reads Unlock as well.
  await revealSessionActions(restored.extPage);
  await restored.extPage.getByRole('button', { name: UNLOCK_LABEL, exact: true }).click();
  const confirm = restored.extPage.locator('.gate-confirm');
  await expect(confirm).toHaveText(UNLOCK_LABEL);
  await expect(confirm).toBeDisabled();
  const gate: GateState | null = (
    await sendExtensionRequest(restored.extPage, { type: 'getSnapshot' })
  ).gate;
  if (gate === null) throw new Error('the Unlock click did not open a gate');
  const premature: CommandResponseV2<SessionCommandResultCodeV2> = await sendExtensionRequest(
    restored.extPage,
    { type: 'confirmGate', typedPhrase: null, expectedGate: gate },
  );
  expect(premature.ok).toBe(false);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await waitForLifecycle(restored.extPage, 'idle', 60_000);
  await expect(stillBlocked.locator('focus-lock-overlay')).not.toBeAttached();
  expect((): void =>
    assertNoUnexpectedBrowserDiagnostics(restartableExtension.diagnostics),
  ).not.toThrow();
});

test('a Flexible manual start reads Start until stopped and ends at once', async ({
  context,
  extPage,
  siteUrl,
}) => {
  await useOneSecondGate(extPage, 'friction');
  await seedBlockedList(extPage);
  await extPage.reload();

  await extPage.getByRole('button', { name: UNTIL_STOPPED_LABEL, exact: true }).click();
  await openPopupSection(extPage, 'Session settings');
  await extPage.getByRole('button', { name: 'Flexible' }).click();
  // The choice opens its explanation popover over the sticky start button. Escape closes it.
  await extPage.keyboard.press('Escape');
  await expect(extPage.locator('.session-timing')).toHaveText(FLEXIBLE_HINT);
  await extPage.getByRole('button', { name: START_UNTIL_STOPPED_LABEL, exact: true }).click();

  const snapshot: SessionSnapshotV2 = await waitForLifecycle(extPage, 'active');
  expect(snapshot).toMatchObject({
    phase: 'focus',
    config: { duration: { kind: 'until-stopped' }, strictness: 'flexible', cycling: null },
    phaseEndsAt: null,
    sessionEndsAt: null,
  });
  const blocked: Page = await context.newPage();
  await blocked.goto(siteUrl('/plain.html'), { waitUntil: 'commit' });
  await expect(blocked.locator('focus-lock-overlay')).toBeAttached();

  await revealSessionActions(extPage);
  await extPage.getByRole('button', { name: END_SESSION_LABEL, exact: true }).click();
  await waitForLifecycle(extPage, 'idle', 60_000);
  await expect(blocked.locator('focus-lock-overlay')).not.toBeAttached();
  expect((): void =>
    assertNoUnexpectedBrowserDiagnostics(browserDiagnosticsFor(context)),
  ).not.toThrow();
});
