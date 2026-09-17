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
 * The same phases again, lightened for the ring that is drawn on the green tile.
 *
 * The badge sits on the browser's own background and can use the palette above. The ring cannot:
 * focus green on tile green is the most common state of all and it vanished, so each phase gets a
 * tint chosen to read against `#2ebf58` while staying recognisably the same colour.
 */
const RING_COLORS: Record<Phase, string> = {
  idle: '#e5e7eb',
  focus: '#a7f3a9',
  break: '#5eead4',
  paused: '#fcd34d',
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
 * Pure description of the icon for a v2 snapshot: phase color, shackle position, and
 * phase progress. Indefinite focus has no phase end, so it draws no ring. An indefinite
 * pause does have one, so its pause ring still fills toward the pause end.
 */
export function iconSpecV2(snapshot: SessionSnapshotV2): IconSpec {
  const color: string = RING_COLORS[snapshot.phase];
  if (
    !projectsActiveClocks(snapshot) ||
    snapshot.phaseStartedAt === null ||
    snapshot.phaseEndsAt === null
  ) {
    return { color, open: snapshot.phase === 'idle', progress: 0, glyph: 'lock', ring: false };
  }
  const span: number = snapshot.phaseEndsAt - snapshot.phaseStartedAt;
  const progress: number =
    span <= 0 ? 0 : Math.min(1, Math.max(0, (snapshot.at - snapshot.phaseStartedAt) / span));
  return {
    color,
    open: false,
    progress,
    glyph: snapshot.phase === 'break' ? 'cup' : 'lock',
    ring: true,
  };
}
