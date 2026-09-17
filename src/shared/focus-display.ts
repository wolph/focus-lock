import { t, tPlural } from './i18n';
import { UNTIL_STOPPED_LABEL } from './session-copy';
import { minToMs } from './time';
import type { CycleConfig, SessionSnapshotV2 } from './types';

export interface FocusDisplay {
  text: string;
  endsAt: number | null;
  progress: number;
}

const UPDATING_TEXT: string = t('shared_updating_session');

function hasUpcomingBreak(
  snapshot: SessionSnapshotV2,
  phaseEnd: number,
  sessionEnd: number,
): boolean {
  const cycling: CycleConfig | null = snapshot.config?.cycling ?? null;
  if (cycling === null || phaseEnd >= sessionEnd) return false;
  const isLong: boolean = (snapshot.cycleIndex + 1) % cycling.longEvery === 0;
  const breakMs: number = minToMs(isLong ? cycling.longBreakMin : cycling.shortBreakMin);
  // The session machine completes early when its final break leaves no focus time.
  return breakMs > 0 && phaseEnd + breakMs < sessionEnd - 1;
}

/** The earlier of the two deadlines, or null when neither bounds the current phase. */
function phaseBoundary(phaseEnd: number | null, sessionEnd: number | null): number | null {
  if (phaseEnd === null) return sessionEnd;
  if (sessionEnd === null) return phaseEnd;
  return Math.min(phaseEnd, sessionEnd);
}

/** Present the next focus boundary without a constantly changing seconds display. */
export function focusDisplay(snapshot: SessionSnapshotV2, now: number): FocusDisplay {
  const phaseEnd: number | null = snapshot.phaseEndsAt;
  const sessionEnd: number | null = snapshot.sessionEndsAt;
  const untilStopped: boolean = snapshot.config?.duration.kind === 'until-stopped';
  if (untilStopped && phaseEnd === null && sessionEnd === null) {
    return { text: UNTIL_STOPPED_LABEL, endsAt: null, progress: 0 };
  }
  const endsAt: number | null = phaseBoundary(phaseEnd, sessionEnd);
  if (endsAt === null || snapshot.phaseStartedAt === null) {
    return { text: UPDATING_TEXT, endsAt: null, progress: 0 };
  }
  const remaining: number = Math.max(0, endsAt - now);
  const span: number = endsAt - snapshot.phaseStartedAt;
  const progress: number =
    span <= 0 ? 1 : Math.min(1, Math.max(0, (now - snapshot.phaseStartedAt) / span));
  if (remaining === 0) return { text: UPDATING_TEXT, endsAt, progress };
  const minutes: number = Math.ceil(remaining / 60_000);
  const duration: string =
    remaining < 60_000 ? t('shared_less_than_a_minute') : tPlural('shared_minutes', minutes);
  const upcomingBreak: boolean =
    phaseEnd !== null && sessionEnd !== null && hasUpcomingBreak(snapshot, phaseEnd, sessionEnd);
  const text: string = upcomingBreak
    ? t('shared_focus_remaining_break', { DURATION: duration })
    : t('shared_focus_remaining_session', { DURATION: duration });
  return { text, endsAt, progress };
}
