import type { Locator } from '@playwright/test';
import type { CommandResponseV2, SessionCommandResultCodeV2 } from '../../src/shared/messages';
import type { SessionSnapshotV2 } from '../../src/shared/types';
import { expect, sendExtensionRequest, startTestSession, test } from './fixtures';

test('the start form shows every setting and submits the visible plan', async ({ extPage }) => {
  const custom: Locator = extPage.getByRole('spinbutton', { name: 'Custom minutes' });
  await expect(extPage.locator('.start-form > :first-child .start-button')).toBeVisible();
  await expect(extPage.locator('.duration-control > :last-child')).toHaveAttribute(
    'aria-label',
    'Custom minutes',
  );
  await expect(custom).toBeVisible();
  // Nothing is folded away: the session type, the rules and the cycles are on screen without a
  // click, and there is no disclosure and no work tab chooser to open.
  await expect(extPage.locator('details')).toHaveCount(0);
  await expect(extPage.getByRole('combobox')).toHaveCount(0);
  await expect(extPage.getByRole('button', { name: 'Hard lock' })).toBeVisible();
  await expect(extPage.getByRole('heading', { name: 'What will be blocked' })).toBeAttached();
  await expect(extPage.getByRole('checkbox', { name: /^Cycles:/ })).toBeAttached();
  await expect(extPage.getByRole('button', { name: 'Statistics' })).toHaveCount(0);
  await extPage.getByLabel('Intention').fill('Review the release notes');
  await custom.fill('37');
  await expect(
    extPage.getByRole('button', { name: 'Start 37 min focus', exact: true }),
  ).toBeVisible();
  await expect(custom).toHaveValue('37');
  await extPage.getByRole('button', { name: 'Start 37 min focus', exact: true }).click();
  await expect(extPage.locator('.active-view')).toBeVisible();
  const snapshot: SessionSnapshotV2 = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  expect(snapshot.config?.duration).toEqual({ kind: 'timed', minutes: 37 });
  expect(snapshot.config?.intention).toBe('Review the release notes');
  // End session is on screen from the moment the popup opens, by product rule.
  // See docs/superpowers/specs/2026-09-17-popup-visibility-rules.md.
  await expect(extPage.getByRole('button', { name: 'End session', exact: true })).toBeVisible();
});

test('an invalid custom duration focuses its field', async ({ extPage }) => {
  const custom: Locator = extPage.getByRole('spinbutton', { name: 'Custom minutes' });
  await custom.fill('0');
  await extPage.getByRole('button', { name: /^Start / }).click();
  await expect(custom).toBeVisible();
  await expect(custom).toBeFocused();
  await expect(extPage.getByRole('alert')).toContainText('greater than zero');
});

test('a gate opened elsewhere is visible alongside the session actions', async ({ extPage }) => {
  await startTestSession(extPage, { strictness: 'friction' });
  // End session is on screen from the moment the popup opens, by product rule.
  // See docs/superpowers/specs/2026-09-17-popup-visibility-rules.md.
  await expect(extPage.getByRole('button', { name: 'End session', exact: true })).toBeVisible();
  const response: CommandResponseV2<SessionCommandResultCodeV2> = await sendExtensionRequest(
    extPage,
    { type: 'openEndGate' },
  );
  expect(response.ok).toBe(true);
  await expect(extPage.locator('.gate-panel')).toBeVisible();
  await expect(extPage.getByRole('button', { name: 'Keep focusing', exact: true })).toBeVisible();
  await extPage.getByRole('button', { name: 'Keep focusing', exact: true }).click();
  await expect(extPage.locator('.gate-panel')).toHaveCount(0);
  await expect(extPage.locator('.active-view :focus')).toHaveCount(1);
});
