import { INDEFINITE_BADGE_TEXT } from '../shared/session-copy';
import { formatBadge } from '../shared/time';
import type { Phase, SessionSnapshotV2 } from '../shared/types';
import type { IconSpec } from './icon';

/**
 * The one phase palette. It was exported for `icon.ts`, which held a copy while the v1 projections
 * lived there. Those are gone and the only reader is this module, so the export went with them.
 */
const STATE_COLORS: Record<Phase, string> = {
  idle: '#9ca3af',
  focus: '#22c55e',
  break: '#14b8a6',
  paused: '#f59e0b',
};

/**
 * Only an active session has clocks to report. Starting, cleanup, and error hide a
 * durable session behind a journal, so nothing about it may reach the toolbar.
 */
function projectsActiveClocks(snapshot: SessionSnapshotV2): boolean {
  return snapshot.lifecycle.kind === 'active' && snapshot.phase !== 'idle';
}

/**
 * Badge text and color for one v2 snapshot. A timed session counts the whole session
 * down, never the phase, so a phase transition cannot make the badge jump upward.
 */
export function badgeForV2(
  snapshot: SessionSnapshotV2,
  countdown: boolean,
): { text: string; color: string } {
  const color: string = STATE_COLORS[snapshot.phase];
  if (!countdown || !projectsActiveClocks(snapshot)) return { text: '', color };
  if (snapshot.sessionEndsAt === null) return { text: INDEFINITE_BADGE_TEXT, color };
  return { text: formatBadge(snapshot.sessionEndsAt - snapshot.at), color };
}

/**
 * Pure description of the icon for a v2 snapshot: is the lock shut.
 *
 * A session locks sites only while its focus phase runs, so a break and a pause draw the shackle
 * open even though the session is still alive. That is the honest reading: during a break nothing
 * is blocked, and an icon that stayed shut would claim otherwise. The badge still names the phase
 * and counts the session down, which is where the detail the icon dropped now lives.
 */
export function iconSpecV2(snapshot: SessionSnapshotV2): IconSpec {
  return { open: !locksSites(snapshot) };
}

/** The one definition of locked, matching `isLocked` on the site so the two marks agree. */
function locksSites(snapshot: SessionSnapshotV2): boolean {
  return snapshot.lifecycle.kind === 'active' && snapshot.phase === 'focus';
}
