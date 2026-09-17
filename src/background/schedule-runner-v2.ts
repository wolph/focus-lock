/**
 * The serialized schedule check and the next-schedule read model.
 *
 * Two rules shape this file. A schedule check never touches a session: it starts one only from a
 * fully idle runtime, so an open entry can never restrengthen, reconfigure, or relock a session that
 * is already running or still finishing. And an occurrence is identified by its token, so the same
 * window is suppressed for the rest of its life once it has been started or covered by a closure,
 * which is what keeps a repeated local hour, an edited entry, and a manual end from relocking it.
 *
 * The runner performs no browser effect of its own beyond the notification and sound the product
 * behavior names. Every durable change goes through the runtime ports.
 */

import {
  localStartDateForV2,
  nextScheduleWindowStartV2,
  pruneHandledScheduleOccurrencesV2,
  type ResolvedScheduleOccurrenceV2,
  resolveOpenScheduleOccurrencesV2,
  scheduleOccurrenceTokenV2,
  selectScheduleCandidateV2,
} from '../core/schedule-v2';
import { rulesFromLists } from '../shared/constants';
import { CoreError } from '../shared/errors';
import { exactDataEqual } from '../shared/exact-data';
import { t } from '../shared/i18n';
import { SCHEDULE_STARTED_TITLE, SCHEDULE_UNTIL_STOPPED_BODY } from '../shared/session-copy';
import type {
  HandledScheduleOccurrence,
  ListsConfig,
  ScheduleEntryV2,
  SettingsV2,
} from '../shared/types';
import { carryCommitCheckpointProjectionV2 } from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type { RuntimeStateV2, SessionStartCandidate } from './runtime-v2-types';
import {
  driveTransitionV2,
  type PreparedTransitionV2,
  prepareStartTransitionV2,
  type TransitionDriveResultV2,
} from './transition-runner-v2';

export interface ScheduleRunnerPortsV2 {
  settings(): SettingsV2;
  lists(): ListsConfig;
  websiteBlockingReady(): boolean;
  notify(title: string, body: string): void;
  playSound(sound: 'scheduleStart'): void;
}

export interface ScheduleCheckResultV2 {
  runtime: RuntimeStateV2;
  started: boolean;
}

export interface NextScheduleInfoV2 {
  entryId: string;
  startsAt: number;
}

export function scheduleWindowBody(entry: ScheduleEntryV2): string {
  return t('notify_schedule_window_body', { END: entry.end });
}

/**
 * Runs one schedule check. It returns without a write while any session, transition, or closure
 * exists, which is the whole of the "schedule checks do nothing while a session or any journal
 * exists" rule: the check is a start path and nothing else.
 *
 * The caller serializes this against every other runtime command, because it prepares and drives a
 * transition whose entry points require that.
 */
export async function runScheduleCheckV2(
  ports: RuntimePortsV2,
  schedule: ScheduleRunnerPortsV2,
): Promise<ScheduleCheckResultV2> {
  const runtime: RuntimeStateV2 = ports.runtime();
  if (
    runtime.session !== null ||
    runtime.pendingEnforcementTransition !== null ||
    runtime.pendingClosure !== null
  ) {
    return { runtime, started: false };
  }
  const now: number = ports.now();
  const entries: readonly ScheduleEntryV2[] = schedule.settings().schedule;
  assertOneCandidatePerToken(entries, now);
  const candidate: ResolvedScheduleOccurrenceV2 | null = selectScheduleCandidateV2(
    entries,
    runtime.handledScheduleOccurrences,
    now,
  );
  if (candidate === null) {
    return { runtime: await withNoticeToken(ports, runtime, null), started: false };
  }
  if (!schedule.websiteBlockingReady()) {
    return {
      runtime: await reportUnavailable(ports, schedule, runtime, candidate),
      started: false,
    };
  }
  return startFromSchedule(ports, schedule, runtime, candidate);
}

/**
 * The next start the popup and badge report. A live handled record hides its own occurrence, so an
 * occurrence the user just ended by hand is never announced as the next start, and the search
 * continues to the following one. An expired record hides nothing.
 */
export function nextScheduleInfoV2(
  entries: readonly ScheduleEntryV2[],
  handledOccurrences: readonly HandledScheduleOccurrence[],
  now: number,
): NextScheduleInfoV2 | null {
  const handledTokens: Set<string> = liveHandledTokens(handledOccurrences, now);
  // Every skipped start consumes one distinct live token, so the search needs no more steps than
  // there are live records, plus the one step that returns.
  let at: number = now;
  for (let step: number = 0; step <= handledTokens.size; step++) {
    // One resolver answers when an entry opens, for this read model and for the check that starts
    // the session. Two would drift, and the drift shows up as a start the popup announced and the
    // check declined.
    const next: { entry: ScheduleEntryV2; startsAt: number } | null = nextScheduleWindowStartV2(
      entries,
      at,
    );
    if (next === null) return null;
    const token: string = occurrenceToken(next.entry.id, next.startsAt);
    if (!handledTokens.has(token)) return { entryId: next.entry.id, startsAt: next.startsAt };
    at = next.startsAt;
  }
  return null;
}

/**
 * Drops every handled record the retention window has passed. The same runtime comes back when
 * nothing changed, so a tick that finds nothing to prune writes nothing.
 */
export function pruneHandledOccurrencesOnTickV2(
  runtime: RuntimeStateV2,
  now: number,
): RuntimeStateV2 {
  const pruned: HandledScheduleOccurrence[] = pruneHandledScheduleOccurrencesV2(
    runtime.handledScheduleOccurrences,
    now,
  );
  if (exactDataEqual(pruned, runtime.handledScheduleOccurrences)) return runtime;
  return { ...runtime, handledScheduleOccurrences: pruned };
}

/**
 * A scheduled start is one transition like any other. The captured window and the occurrence travel
 * with the candidate, so every later recheck reads them instead of rereading mutable Settings.
 */
async function startFromSchedule(
  ports: RuntimePortsV2,
  schedule: ScheduleRunnerPortsV2,
  runtime: RuntimeStateV2,
  candidate: ResolvedScheduleOccurrenceV2,
): Promise<ScheduleCheckResultV2> {
  // A window that starts leaves no unavailable notice behind, so the token is cleared first and
  // the transition preparation reads the runtime this write left durable. A preparation that throws
  // leaves that clear durable, which only means the next unavailable window notifies again.
  await withNoticeToken(ports, runtime, null);
  const start: SessionStartCandidate = scheduleStartCandidate(candidate, schedule.lists());
  const prepared: PreparedTransitionV2 = await prepareStartTransitionV2(ports, start, 'schedule');
  const driven: TransitionDriveResultV2 = await driveTransitionV2(ports, prepared.matcher);
  if (driven.kind !== 'published') return { runtime: driven.runtime, started: false };
  schedule.playSound('scheduleStart');
  schedule.notify(SCHEDULE_STARTED_TITLE, scheduleStartBody(candidate.entry));
  return { runtime: driven.runtime, started: true };
}

/**
 * An indefinite entry keeps the Flexible or Friction type it stored and starts with no cycling
 * whatever the entry stored, because cycling needs a finite session end. The settings boundary
 * refuses a Hard indefinite entry, so none reaches this function.
 */
function scheduleStartCandidate(
  candidate: ResolvedScheduleOccurrenceV2,
  lists: ListsConfig,
): SessionStartCandidate {
  const entry: ScheduleEntryV2 = candidate.entry;
  const indefinite: boolean = entry.duration.kind === 'until-stopped';
  return {
    mode: entry.mode,
    strictness: entry.strictness,
    duration: indefinite ? { kind: 'until-stopped' } : { kind: 'schedule-window' },
    cycling: indefinite ? null : structuredClone(entry.cycling),
    intention: entry.intention,
    source: 'schedule',
    scheduleOccurrence: structuredClone(candidate.occurrence),
    scheduleWindow: {
      windowStartsAt: candidate.windowStartsAt,
      windowEndsAt: candidate.windowEndsAt,
    },
    rules: rulesFromLists(lists),
  };
}

function scheduleStartBody(entry: ScheduleEntryV2): string {
  return entry.duration.kind === 'until-stopped'
    ? SCHEDULE_UNTIL_STOPPED_BODY
    : scheduleWindowBody(entry);
}

/**
 * One notification per occurrence, tracked by the occurrence token itself. A repeated check inside
 * the same window is silent, and the next occurrence notifies again.
 */
async function reportUnavailable(
  ports: RuntimePortsV2,
  schedule: ScheduleRunnerPortsV2,
  runtime: RuntimeStateV2,
  candidate: ResolvedScheduleOccurrenceV2,
): Promise<RuntimeStateV2> {
  const token: string = candidate.occurrence.token;
  if (runtime.scheduleUnavailableNoticeToken === token) return runtime;
  const next: RuntimeStateV2 = await withNoticeToken(ports, runtime, token);
  schedule.notify(t('notify_schedule_unavailable_title'), t('notify_schedule_unavailable_body'));
  return next;
}

/**
 * Writes the notice token only when it actually changes, so a quiet check stays quiet.
 *
 * The value written is the runtime as it stands at the write, not the copy the check read at its
 * start. Nothing awaits between those two points today, so the copy is current, and a write built
 * on it is correct only for as long as that stays true. Reading here makes it correct by
 * construction: this write carries one field of its own and everything else exactly as stored.
 */
async function withNoticeToken(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  token: string | null,
): Promise<RuntimeStateV2> {
  if (runtime.scheduleUnavailableNoticeToken === token) return runtime;
  const next: RuntimeStateV2 = { ...ports.runtime(), scheduleUnavailableNoticeToken: token };
  await ports.writeRuntime(carryCommitCheckpointProjectionV2(next));
  return ports.runtime();
}

/**
 * Two enabled entries that resolve to one token would make the same window both handled and open,
 * so the stored settings are already invalid. `parseStoredSettingsV2` rejects overlapping entries
 * upstream, and this refuses the value rather than picking one of the two.
 */
function assertOneCandidatePerToken(entries: readonly ScheduleEntryV2[], now: number): void {
  const seen: Set<string> = new Set<string>();
  for (const resolved of resolveOpenScheduleOccurrencesV2(entries, now)) {
    const token: string = resolved.occurrence.token;
    if (seen.has(token)) {
      throw new CoreError(
        'invalid-schedule',
        `two open schedule entries share the occurrence token ${token}`,
      );
    }
    seen.add(token);
  }
}

function liveHandledTokens(
  handledOccurrences: readonly HandledScheduleOccurrence[],
  now: number,
): Set<string> {
  const tokens: Set<string> = new Set<string>();
  for (const occurrence of handledOccurrences) {
    if (occurrence.expiresAt > now) tokens.add(occurrence.token);
  }
  return tokens;
}

/**
 * The occurrence identity of one start instant, built from the resolver's own token grammar and its
 * own local-date arithmetic, so a derived token and a stored one cannot drift apart.
 */
function occurrenceToken(entryId: string, startsAt: number): string {
  return scheduleOccurrenceTokenV2(entryId, localStartDateForV2(startsAt));
}
