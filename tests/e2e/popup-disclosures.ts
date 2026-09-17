import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures';

/**
 * Put a popup section in the state a person would be looking at before using its controls.
 *
 * The start form still keeps its settings behind a disclosure. The running session does not: its
 * actions are on screen from the moment the popup opens, by product rule, so asking to "open" them
 * is a check that they are already there rather than a click. See
 * docs/superpowers/specs/2026-09-17-popup-visibility-rules.md.
 */
export async function openPopupSection(
  page: Page,
  label: 'Session settings' | 'Session actions',
): Promise<void> {
  if (label === 'Session actions') {
    await expect(page.locator('.session-actions .actions')).toBeVisible();
    return;
  }
  const summary: Locator = page.locator('summary').filter({ hasText: new RegExp(`^${label}$`) });
  await expect(summary).toBeVisible();
  const details: Locator = summary.locator('..');
  if ((await details.getAttribute('open')) === null) await summary.click();
  await expect(details).toHaveAttribute('open', '');
}

/** Starting and recovery states expose their permitted End action directly. */
export async function revealSessionActions(page: Page): Promise<void> {
  await expect(page.locator('.active-view, .lifecycle-view')).toBeVisible();
  if ((await page.locator('.active-view').count()) > 0) {
    await openPopupSection(page, 'Session actions');
  }
}
