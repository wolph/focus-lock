import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_FAILED_COPY,
  BREAK_CLOCK_LABEL,
  DATA_CLEAR_ERROR_COPY,
  DATA_CLEAR_PENDING_COPY,
  DEEP_WORK_NOTE,
  END_FAILED_COPY,
  END_SESSION_LABEL,
  FOCUS_PHASE_CLOCK_LABEL,
  FOCUS_TIME_LABEL,
  HARD_UNAVAILABLE_REASON,
  INDEFINITE_BADGE_TEXT,
  INFINITY_GLYPH,
  LOCK_UNTIL_MANUAL_UNLOCK_LABEL,
  PAUSE_CLOCK_LABEL,
  POPUP_CLOSURE_CLEANUP_COPY,
  POPUP_CLOSURE_ERROR_COPY,
  POPUP_STARTING_COPY,
  POPUP_TRANSITION_CLEANUP_COPY,
  POPUP_TRANSITION_ERROR_COPY,
  PRESET_LABELS,
  RETRY_CLEANUP_LABEL,
  RETRY_FAILED_COPY,
  SCHEDULE_STARTED_TITLE,
  SCHEDULE_UNTIL_STOPPED_BODY,
  SCHEDULE_UNTIL_STOPPED_COPY,
  SCHEDULE_WINDOW_LABEL,
  SETTINGS_CLEANUP_COPY,
  SETTINGS_ERROR_COPY,
  SETTINGS_INDEFINITE_COPY,
  SETTINGS_SESSION_DISCLOSURE,
  SETTINGS_STARTING_COPY,
  START_UNTIL_STOPPED_LABEL,
  settingsTimedCopy,
  statsOutcomeLabelV2,
  statsPlanLabelV2,
  TOTAL_SESSION_CLOCK_LABEL,
  timedDurationHint,
  UNLOCK_LABEL,
  UNTIL_STOPPED_DISCLOSURE,
  UNTIL_STOPPED_LABEL,
  untilStoppedHint,
} from '../../../src/shared/session-copy';
import type { CycleConfig, SessionDuration, SessionEndReasonV2 } from '../../../src/shared/types';

const OUTCOME_LABELS: ReadonlyArray<readonly [SessionEndReasonV2, string]> = [
  ['timer-completed', 'Completed'],
  ['manual-completed', 'Completed manually'],
  ['manual-canceled', 'Ended early'],
  ['website-access-lost', 'Ended: website access lost'],
  ['content-registration-failed', 'Ended: blocking setup failed'],
  ['alarm-failed', 'Ended: timer setup failed'],
  ['tab-enforcement-failed', 'Ended: page enforcement failed'],
  ['invalid-active-state', 'Ended: recovery failed'],
];

describe('session copy', (): void => {
  it('publishes the exact duration and forced-control copy', (): void => {
    expect(UNTIL_STOPPED_LABEL).toBe('Until stopped');
    expect(START_UNTIL_STOPPED_LABEL).toBe('Start until stopped');
    expect(LOCK_UNTIL_MANUAL_UNLOCK_LABEL).toBe('Lock until manual unlock');
    expect(UNTIL_STOPPED_DISCLOSURE).toBe(
      'Until stopped sessions keep Flexible or Friction and cannot use focus and break cycles.',
    );
    expect(HARD_UNAVAILABLE_REASON).toBe(
      'Hard lock is not available for Until stopped: with no timer and no manual end, the session could never end.',
    );
    expect(END_SESSION_LABEL).toBe('End session');
    expect(UNLOCK_LABEL).toBe('Unlock');
  });

  it('states the end behaviour of an until-stopped session before it starts', (): void => {
    expect(untilStoppedHint('flexible', { delayMs: 10_000, requireTypedPhrase: false })).toBe(
      'Runs until you end it with End session. Cycles off.',
    );
    expect(untilStoppedHint('friction', { delayMs: 10_000, requireTypedPhrase: false })).toBe(
      'Runs until you unlock it: a 10-second wait, then Unlock. Cycles off.',
    );
    expect(untilStoppedHint('friction', { delayMs: 30_000, requireTypedPhrase: true })).toBe(
      'Runs until you unlock it: a 30-second wait and a typed sentence, then Unlock. Cycles off.',
    );
    expect(untilStoppedHint('friction', { delayMs: 0, requireTypedPhrase: true })).toBe(
      'Runs until you unlock it: no wait and a typed sentence, then Unlock. Cycles off.',
    );
  });

  it('publishes the exact preset labels and the deep work note', (): void => {
    expect(PRESET_LABELS).toEqual(['short', 'focus', 'deep work']);
    expect(DEEP_WORK_NOTE).toBe(
      'A preference, not science: one long uninterrupted block, with no automatic breaks.',
    );
    expect(INFINITY_GLYPH).toBe('∞');
  });

  it('states the timed plan under the presets from the effective minutes and cycles', (): void => {
    const cycle: CycleConfig = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };

    expect(timedDurationHint(50, null)).toBe('50 min uninterrupted focus');
    expect(timedDurationHint(50, cycle)).toBe('50 min total, with 25 min focus blocks');
    // A focus block that is not shorter than the session never interrupts it.
    expect(timedDurationHint(25, cycle)).toBe('25 min uninterrupted focus');
    expect(timedDurationHint(20, cycle)).toBe('20 min uninterrupted focus');
  });

  it('publishes the exact clock labels', (): void => {
    expect(FOCUS_TIME_LABEL).toBe('Focus time');
    expect(FOCUS_PHASE_CLOCK_LABEL).toBe('focus phase');
    expect(TOTAL_SESSION_CLOCK_LABEL).toBe('total session');
    expect(PAUSE_CLOCK_LABEL).toBe('pause');
    expect(BREAK_CLOCK_LABEL).toBe('break');
  });

  it('publishes the exact badge text', (): void => {
    expect(INDEFINITE_BADGE_TEXT).toBe('ON');
  });

  it('publishes the exact popup lifecycle and command error copy', (): void => {
    expect(POPUP_STARTING_COPY).toBe('Focus Lock is starting. Applying your selected rules.');
    expect(POPUP_CLOSURE_CLEANUP_COPY).toBe('Session ended. Finishing browser cleanup.');
    expect(POPUP_TRANSITION_CLEANUP_COPY).toBe(
      'Focus Lock could not start. Finishing browser cleanup.',
    );
    expect(POPUP_TRANSITION_ERROR_COPY).toBe('Focus Lock could not clean up an incomplete start.');
    expect(POPUP_CLOSURE_ERROR_COPY).toBe('Focus Lock could not finish browser cleanup.');
    expect(RETRY_CLEANUP_LABEL).toBe('Retry cleanup');
    expect(END_FAILED_COPY).toBe('Could not end session. Try again.');
    expect(RETRY_FAILED_COPY).toBe('Could not retry cleanup. Try again.');
    expect(ACTION_FAILED_COPY).toBe('Could not request that action. Try again.');
    expect(DATA_CLEAR_PENDING_COPY).toBe('Deleting Focus Lock data. Finishing cleanup.');
    expect(DATA_CLEAR_ERROR_COPY).toBe('Could not delete data. Try again.');
  });

  it('publishes the exact schedule copy', (): void => {
    expect(SCHEDULE_WINDOW_LABEL).toBe('Until window ends');
    expect(SCHEDULE_UNTIL_STOPPED_COPY).toBe(
      'Starts on schedule and runs until you stop it: End session for Flexible, Unlock through the deliberation gate for Friction. Cycles off.',
    );
    expect(SCHEDULE_STARTED_TITLE).toBe('Focus schedule started');
    expect(SCHEDULE_UNTIL_STOPPED_BODY).toBe('Active until you stop it.');
  });

  it('publishes the exact Settings session copy', (): void => {
    expect(SETTINGS_INDEFINITE_COPY).toBe(
      'Until stopped session active. Use the toolbar popup to view or end it.',
    );
    expect(settingsTimedCopy('14:30')).toBe(
      'Timed session active until 14:30. It ends automatically. Use the toolbar popup for live status.',
    );
    expect(settingsTimedCopy('09:05')).toBe(
      'Timed session active until 09:05. It ends automatically. Use the toolbar popup for live status.',
    );
    expect(SETTINGS_STARTING_COPY).toBe(
      'Focus Lock is starting. Checking website access and applying your rules.',
    );
    expect(SETTINGS_CLEANUP_COPY).toBe('Session ended. Finishing browser cleanup.');
    expect(SETTINGS_ERROR_COPY).toBe(
      'Focus Lock could not finish browser cleanup. Open the popup and retry.',
    );
    expect(SETTINGS_SESSION_DISCLOSURE).toBe(
      'The toolbar popup owns session controls. Your changes reach the running session as you make them, except a hard lock, which holds anything that unblocks until it ends.',
    );
  });

  it('maps every v2 end reason to its Stats wording', (): void => {
    for (const [reason, label] of OUTCOME_LABELS) {
      expect(statsOutcomeLabelV2(reason)).toBe(label);
    }
  });

  it('labels the Stats plan column for both durations', (): void => {
    const indefinite: SessionDuration = { kind: 'until-stopped' };
    const timed: SessionDuration = { kind: 'timed', minutes: 25 };
    const long: SessionDuration = { kind: 'timed', minutes: 90 };

    expect(statsPlanLabelV2(indefinite)).toBe('Until stopped');
    expect(statsPlanLabelV2(timed)).toBe('25 m');
    expect(statsPlanLabelV2(long)).toBe('1 h 30 m');
  });

  it('never describes focus time as active computer use, on any surface', (): void => {
    // The rule is about product copy, so this reads the copy rather than the source. Scanning file
    // text finds `KeyboardEvent` and `onKeyDown`, which are DOM identifiers and not copy, and
    // scanning only `session-copy.ts` could not fail for any reason the byte-for-byte assertions
    // above would not already have caught. String literals across the surfaces are the copy.
    const literals: Array<{ file: string; text: string }> = [
      'src/popup',
      'src/options',
      'src/stats',
      'src/content',
      'src/shared',
    ].flatMap(
      (directory: string): Array<{ file: string; text: string }> =>
        readdirSync(resolve(directory), { recursive: true, encoding: 'utf8' })
          .filter((entry: string): boolean => /\.(ts|tsx)$/.test(entry))
          .flatMap((entry: string): Array<{ file: string; text: string }> => {
            const file: string = resolve(directory, entry);
            const source: string = readFileSync(file, 'utf8');
            return [...source.matchAll(/'([^'\\\n]*)'|`([^`\\]*)`/g)].map(
              (match: RegExpMatchArray): { file: string; text: string } => ({
                file,
                text: (match[1] ?? match[2] ?? '').toLowerCase(),
              }),
            );
          }),
    );

    expect(literals.length).toBeGreaterThan(500);
    for (const literal of literals) {
      // The phrase itself is banned outright, wherever it appears.
      expect(literal.text, literal.file).not.toContain('active computer use');
      // The two mechanism words are banned only in copy that is about focus time. The charts say
      // "use the keyboard to move through data points", which is a navigation hint and not a
      // claim about what focus time measures.
      if (!literal.text.includes('focus time')) continue;
      for (const term of ['keyboard', 'mouse']) {
        expect(literal.text, `${literal.file} describes focus time with "${term}"`).not.toContain(
          term,
        );
      }
    }
    expect(FOCUS_TIME_LABEL).toBe('Focus time');
  });
});
