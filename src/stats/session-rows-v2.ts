import { t } from '../shared/i18n';
import { statsOutcomeLabelV2, statsPlanLabelV2 } from '../shared/session-copy';
import type {
  LegacyEventRecord,
  SessionEndedEventV2,
  SessionEventRecordV2,
  SessionStartedEventV2,
} from '../shared/types';

const MAX_ROWS: number = 20;

/**
 * Wording for rows the v2 reason table cannot describe. A legacy terminal event carries no
 * reason, so it claims none, but it lands in the same Outcome column as the v2 rows and takes
 * that column's casing: one column, one spelling per outcome.
 */
const LEGACY_COMPLETED_OUTCOME: string = t('stats_outcome_completed');
const LEGACY_ENDED_EARLY_OUTCOME: string = t('stats_outcome_ended_early');

/**
 * A row closed without any end event has no reason either, but it sits in the same
 * column as the v2 reason table, so it takes that table's casing.
 */
const ENDED_EARLY_OUTCOME: string = t('stats_outcome_ended_early');
const RUNNING_OUTCOME: string = t('stats_outcome_running');

export interface SessionRowV2 {
  startedAt: number;
  plan: string;
  intention: string;
  source: 'manual' | 'schedule';
  outcome: string;
  outcomeKind: 'completed' | 'ended' | 'running';
  /** null while the session is still running or its end event is missing */
  focusedMs: number | null;
  pauseMs: number;
  unlockMs: number;
}

type LegacyStartEvent = Extract<LegacyEventRecord, { t: 'sessionStarted' }>;
type StartEvent = LegacyStartEvent | SessionStartedEventV2;

interface OpenRowV2 {
  sessionId?: string;
  superseded: boolean;
  startedAt: number;
  plan: string;
  intention: string;
  source: 'manual' | 'schedule';
  pauseMs: number;
  unlockMs: number;
}

/**
 * A legacy start stores planned minutes, so it reports as the timed plan it was. A null duration
 * is the v1 indefinite session, which reports as the until-stopped plan it was.
 */
function planOf(event: StartEvent): string {
  if ('version' in event) return statsPlanLabelV2(event.duration);
  return statsPlanLabelV2(
    event.durationMin === null
      ? { kind: 'until-stopped' }
      : { kind: 'timed', minutes: event.durationMin },
  );
}

function closed(
  open: OpenRowV2,
  outcome: string,
  outcomeKind: SessionRowV2['outcomeKind'],
  focusedMs: number | null,
): SessionRowV2 {
  return {
    startedAt: open.startedAt,
    plan: open.plan,
    intention: open.intention,
    source: open.source,
    outcome,
    outcomeKind,
    focusedMs,
    pauseMs: open.pauseMs,
    unlockMs: open.unlockMs,
  };
}

function endedRow(open: OpenRowV2, event: SessionEndedEventV2): SessionRowV2 {
  return closed(
    open,
    statsOutcomeLabelV2(event.reason),
    event.outcome === 'completed' ? 'completed' : 'ended',
    event.focusedMs,
  );
}

function matchingOpenIndex(opens: OpenRowV2[], event: SessionEventRecordV2): number {
  const sessionId: string | undefined = 'sessionId' in event ? event.sessionId : undefined;
  if (sessionId !== undefined) {
    return opens.findIndex((open: OpenRowV2): boolean => open.sessionId === sessionId);
  }
  const legacy: number = opens.findIndex(
    (open: OpenRowV2): boolean => open.sessionId === undefined,
  );
  if (legacy >= 0) return legacy;
  return event.t === 'pauseTaken' || event.t === 'unlockTaken' ? opens.length - 1 : -1;
}

/** Migration binds a legacy start to the UUID its later v2 end will carry. */
function bindAssignedIdentity(opens: OpenRowV2[], startedAt: number, sessionId: string): void {
  const open: OpenRowV2 | undefined = opens.find(
    (candidate: OpenRowV2): boolean =>
      candidate.sessionId === undefined && candidate.startedAt === startedAt,
  );
  if (open === undefined) return;
  if (opens.some((candidate: OpenRowV2): boolean => candidate.sessionId === sessionId)) return;
  open.sessionId = sessionId;
}

/**
 * Pairs each start with the end that closes it, across both event generations.
 * Input is newest first, as `StatsBundle.recentSessions` stores it. A dangling newest
 * start is still running. A start displaced by a later start closed without an end
 * event, so it reports as ended with unknown focus. A legacy start bound through
 * `sessionIdentityAssigned` pairs with the later v2 end and gets no synthetic v2 start.
 */
export function pairSessionRowsV2(events: readonly SessionEventRecordV2[]): SessionRowV2[] {
  const chronological: SessionEventRecordV2[] = [...events].reverse();
  const rows: SessionRowV2[] = [];
  const opens: OpenRowV2[] = [];

  for (const event of chronological) {
    if (event.t === 'sessionIdentityAssigned') {
      bindAssignedIdentity(opens, event.startedAt, event.sessionId);
      continue;
    }
    if (event.t === 'sessionStarted') {
      for (const open of opens) open.superseded = true;
      const sessionId: string | undefined = event.sessionId;
      const displacedIndex: number = opens.findIndex(
        (open: OpenRowV2): boolean => open.sessionId === sessionId,
      );
      if (displacedIndex >= 0) {
        const displaced: OpenRowV2 | undefined = opens.splice(displacedIndex, 1)[0];
        if (displaced !== undefined) {
          rows.push(closed(displaced, ENDED_EARLY_OUTCOME, 'ended', null));
        }
      }
      opens.push({
        ...(sessionId === undefined ? {} : { sessionId }),
        superseded: false,
        startedAt: event.at,
        plan: planOf(event),
        intention: event.intention,
        source: event.source,
        pauseMs: 0,
        unlockMs: 0,
      });
      continue;
    }

    const openIndex: number = matchingOpenIndex(opens, event);
    const open: OpenRowV2 | undefined = opens[openIndex];
    if (open === undefined) continue;
    if (event.t === 'pauseTaken') {
      open.pauseMs += event.ms;
    } else if (event.t === 'unlockTaken') {
      open.unlockMs += event.ms;
    } else if (event.t === 'sessionEnded') {
      rows.push(endedRow(open, event));
      opens.splice(openIndex, 1);
    } else if (event.t === 'sessionCompleted') {
      rows.push(closed(open, LEGACY_COMPLETED_OUTCOME, 'completed', event.focusedMs));
      opens.splice(openIndex, 1);
    } else if (event.t === 'sessionCanceled') {
      rows.push(closed(open, LEGACY_ENDED_EARLY_OUTCOME, 'ended', event.focusedMs));
      opens.splice(openIndex, 1);
    }
  }

  for (const open of opens) {
    rows.push(
      open.superseded
        ? closed(open, ENDED_EARLY_OUTCOME, 'ended', null)
        : closed(open, RUNNING_OUTCOME, 'running', null),
    );
  }
  rows.sort((left: SessionRowV2, right: SessionRowV2): number => right.startedAt - left.startedAt);
  return rows.slice(0, MAX_ROWS);
}
