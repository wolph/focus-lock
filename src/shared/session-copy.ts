import { formatMinutes } from './format';
import { t } from './i18n';
import type {
  CycleConfig,
  GateSettings,
  SessionDuration,
  SessionEndReasonV2,
  Strictness,
} from './types';

/** Duration control, the start button, and the forced cycle disclosure. */
export const UNTIL_STOPPED_LABEL: string = t('shared_until_stopped');
/** The Until stopped chip shows this glyph and carries UNTIL_STOPPED_LABEL as its name. */
export const INFINITY_GLYPH: string = '∞';
/** Positional labels for the three timed presets, read after the minutes: "50 deep work". */
export const PRESET_LABELS: readonly [string, string, string] = [
  t('shared_preset_short'),
  t('shared_preset_focus'),
  t('shared_preset_deep_work'),
];
/** The hover explanation of the deep work chip. The label itself stays short. */
export const DEEP_WORK_NOTE: string = t('shared_deep_work_note');

/**
 * The hint under the presets for a timed draft. Cycles only interrupt a session longer than one
 * focus block, so a 25 minute session under 25 minute blocks reads as uninterrupted.
 */
export function timedDurationHint(minutes: number, cycling: CycleConfig | null): string {
  if (cycling !== null && cycling.focusMin < minutes) {
    return t('shared_timed_hint_cycles', {
      MINUTES: String(minutes),
      FOCUS: String(cycling.focusMin),
    });
  }
  return t('shared_timed_hint_plain', { MINUTES: String(minutes) });
}
/** The start button of a Flexible until-stopped draft. */
export const START_UNTIL_STOPPED_LABEL: string = t('shared_start_until_stopped');
/** The start button of a Friction until-stopped draft, which ends through its gate. */
export const LOCK_UNTIL_MANUAL_UNLOCK_LABEL: string = t('shared_lock_until_manual_unlock');
export const UNTIL_STOPPED_DISCLOSURE: string = t('shared_until_stopped_disclosure');
/**
 * Why Hard lock is disabled while Until stopped is selected. One sentence, rendered on the
 * choice itself in the popup and next to the schedule editor's radio.
 */
export const HARD_UNAVAILABLE_REASON: string = t('shared_hard_unavailable_reason');
export const END_SESSION_LABEL: string = t('shared_end_session');
/** The End control and the gate confirm of a Friction until-stopped session. */
export const UNLOCK_LABEL: string = t('shared_unlock');

function formatDelaySeconds(delayMs: number): string {
  const seconds: number = delayMs / 1_000;
  return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(3)));
}

/** The deliberation wait as a phrase: "no wait" or "a 10-second wait". */
export function formatGateWait(delayMs: number): string {
  return delayMs === 0
    ? t('shared_gate_wait_none')
    : t('shared_gate_wait', { SECONDS: formatDelaySeconds(delayMs) });
}

/**
 * The hint under the duration control while Until stopped is selected. It says how the session
 * will end before it starts, with the configured wait and phrase for Friction, and that cycles are
 * off. Hard never reaches this hint, because the draft clamps it away from Until stopped.
 */
export function untilStoppedHint(
  strictness: Exclude<Strictness, 'hard'>,
  gate: Pick<GateSettings, 'delayMs' | 'requireTypedPhrase'>,
): string {
  if (strictness === 'flexible') {
    return t('shared_until_stopped_hint_flexible', { LABEL: END_SESSION_LABEL });
  }
  const wait: string = formatGateWait(gate.delayMs);
  const requirement: string = gate.requireTypedPhrase
    ? t('shared_gate_requirement_typed', { WAIT: wait })
    : wait;
  return t('shared_until_stopped_hint_friction', {
    REQUIREMENT: requirement,
    LABEL: UNLOCK_LABEL,
  });
}

/**
 * The accessible name of the forced cycles group. Both the popup start form and the schedule
 * editor render it, and a screen reader is the only place it is heard, so a copy that drifted
 * in one file would be invisible to sighted review.
 */
export const FORCED_CYCLES_LABEL: string = t('shared_forced_cycles_label');

/**
 * The two blocking modes, named once. The start button reads the same pair the mode radios
 * render, so renaming one used to leave the button and the radio disagreeing.
 */
export const MODE_LABELS: { blacklist: string; whitelist: string } = {
  blacklist: t('shared_mode_blacklist'),
  whitelist: t('shared_mode_whitelist'),
};

/** Clock labels. Focus time is wall-clock time in the focus phase. */
export const FOCUS_TIME_LABEL: string = t('shared_focus_time_label');
export const FOCUS_PHASE_CLOCK_LABEL: string = t('shared_clock_focus_phase');
export const TOTAL_SESSION_CLOCK_LABEL: string = t('shared_clock_total_session');
export const PAUSE_CLOCK_LABEL: string = t('shared_clock_pause');
export const BREAK_CLOCK_LABEL: string = t('shared_clock_break');

/** Shown on the toolbar badge while a session runs with no finite end. */
export const INDEFINITE_BADGE_TEXT: string = t('shared_badge_indefinite');

/** Popup lifecycle and command errors. */
export const POPUP_STARTING_COPY: string = t('shared_popup_starting');
export const POPUP_CLOSURE_CLEANUP_COPY: string = t('shared_popup_closure_cleanup');
export const POPUP_TRANSITION_CLEANUP_COPY: string = t('shared_popup_transition_cleanup');
export const POPUP_TRANSITION_ERROR_COPY: string = t('shared_popup_transition_error');
export const POPUP_CLOSURE_ERROR_COPY: string = t('shared_popup_closure_error');
export const RETRY_CLEANUP_LABEL: string = t('shared_retry_cleanup');
export const END_FAILED_COPY: string = t('shared_end_failed');
export const RETRY_FAILED_COPY: string = t('shared_retry_failed');
export const ACTION_FAILED_COPY: string = t('shared_action_failed');
export const RETURN_TO_WORK_FAILED_COPY: string = t('shared_return_to_work_failed');
export const DATA_CLEAR_PENDING_COPY: string = t('shared_data_clear_pending');
export const DATA_CLEAR_ERROR_COPY: string = t('shared_data_clear_error');

/** Schedule editor and the scheduled start notification. */
export const SCHEDULE_WINDOW_LABEL: string = t('shared_schedule_window_label');
export const SCHEDULE_UNTIL_STOPPED_COPY: string = t('shared_schedule_until_stopped');
export const SCHEDULE_STARTED_TITLE: string = t('shared_schedule_started_title');
export const SCHEDULE_UNTIL_STOPPED_BODY: string = t('shared_schedule_until_stopped_body');

/** Settings, which is read-only for active session control. */
export const SETTINGS_INDEFINITE_COPY: string = t('shared_settings_indefinite');
export const SETTINGS_STARTING_COPY: string = t('shared_settings_starting');
/**
 * The specification lists this line in two sections, so two names are right. Two independent
 * literals were not: editing the popup line left Settings on the old wording, and the copy test
 * would have passed because it spelled the string twice as well.
 */
export const SETTINGS_CLEANUP_COPY: string = POPUP_CLOSURE_CLEANUP_COPY;
export const SETTINGS_ERROR_COPY: string = t('shared_settings_error');
export const SETTINGS_SESSION_DISCLOSURE: string = t('shared_settings_session_disclosure');

/** Settings copy for an active timed session, ending at a local "HH:MM" wall clock. */
export function settingsTimedCopy(endsAtHhMm: string): string {
  return t('shared_settings_timed', { TIME: endsAtHhMm });
}

const STATS_OUTCOME_KEYS: Record<SessionEndReasonV2, Parameters<typeof t>[0]> = {
  'timer-completed': 'shared_outcome_timer_completed',
  'manual-completed': 'shared_outcome_manual_completed',
  'manual-canceled': 'shared_outcome_manual_canceled',
  'website-access-lost': 'shared_outcome_website_access_lost',
  'content-registration-failed': 'shared_outcome_content_registration_failed',
  'alarm-failed': 'shared_outcome_alarm_failed',
  'tab-enforcement-failed': 'shared_outcome_tab_enforcement_failed',
  'invalid-active-state': 'shared_outcome_invalid_active_state',
};

/** Stats outcome wording for one ended session. */
export function statsOutcomeLabelV2(reason: SessionEndReasonV2): string {
  return t(STATS_OUTCOME_KEYS[reason]);
}

/** Stats plan wording for one session, "Until stopped" or the planned length. */
export function statsPlanLabelV2(duration: SessionDuration): string {
  return duration.kind === 'until-stopped' ? UNTIL_STOPPED_LABEL : formatMinutes(duration.minutes);
}
