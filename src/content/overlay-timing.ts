/**
 * The numbers the blocked page may work out on its own from a frozen active view: how much of
 * this focus block is left, how far along it is, and how the bank has grown since capture. The
 * words around those numbers come from the message catalogue, in the browser's own language.
 * Nothing here reads the public snapshot.
 */
import type { DocumentOverlayView, RemainingSuffix } from '../shared/enforcement-v2';
import { t, tPlural } from '../shared/i18n';
import { growBank } from '../shared/live';
import type { EndActionLabelV2 } from '../shared/types';

export type ActiveOverlayView = Extract<DocumentOverlayView, { presentation: 'active' }>;

/** The earlier of the two deadlines, or null when neither bounds this focus block. */
export function focusBoundary(view: ActiveOverlayView): number | null {
  const phaseEndsAt: number | null = view.timing.phaseEndsAt;
  const sessionEndsAt: number | null = view.timing.sessionEndsAt;
  if (phaseEndsAt === null) return sessionEndsAt;
  if (sessionEndsAt === null) return phaseEndsAt;
  return Math.min(phaseEndsAt, sessionEndsAt);
}

/** Milliseconds until the focus boundary, never negative, null when the block has no end. */
export function remainingFocusMs(view: ActiveOverlayView, now: number): number | null {
  const endsAt: number | null = focusBoundary(view);
  return endsAt === null ? null : Math.max(0, endsAt - now);
}

/** How far this focus block has run, from 0 to 1. An unbounded block never advances. */
export function focusProgress(view: ActiveOverlayView, now: number): number {
  const endsAt: number | null = focusBoundary(view);
  if (endsAt === null) return 0;
  const startedAt: number = view.timing.phaseStartedAt;
  const span: number = endsAt - startedAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - startedAt) / span));
}

/**
 * The calm time line: `18 min left in this session`, `Less than a minute until your break`,
 * `Until stopped`, or the updating label once the boundary has passed and the worker's next
 * view has not yet arrived. The words are the view's, the number is this module's.
 */
export function remainingLabel(view: ActiveOverlayView, now: number): string {
  const suffix: RemainingSuffix | null = view.copy.remainingSuffix;
  const remaining: number | null = remainingFocusMs(view, now);
  // A timed status line is composed by the worker, which has already translated it.
  if (suffix === null || remaining === null) {
    return view.copy.status.kind === 'timed' ? view.copy.status.text : t('shared_until_stopped');
  }
  if (remaining === 0) return t('shared_updating_session');
  const duration: string =
    remaining < 60_000
      ? t('shared_less_than_a_minute')
      : tPlural('shared_minutes', Math.ceil(remaining / 60_000));
  return suffix === 'until your break'
    ? t('shared_focus_remaining_break', { DURATION: duration })
    : t('shared_focus_remaining_session', { DURATION: duration });
}

/** Grows the frozen bank forward from the capture time, through the shared rule. */
export function bankAt(view: ActiveOverlayView, now: number): number {
  return growBank(
    view.economy.bankMs,
    view.economy.bankAccrualPerMs,
    view.economy.bankCapMs,
    view.timing.capturedAt,
    now,
  );
}

/** Why an action cannot be afforded right now, or `ready-in` with the focus time still needed. */
export type AccessWaitReason =
  | 'ready-in'
  | 'updating'
  | 'above-limit'
  | 'earning-off'
  | 'not-enough-time';

export interface AccessWait {
  affordable: boolean;
  /** Focus time still needed, rounded up to a whole second. 0 when affordable, null otherwise. */
  waitMs: number | null;
  reason: AccessWaitReason | null;
}

function unreachable(reason: AccessWaitReason): AccessWait {
  return { affordable: false, waitMs: null, reason };
}

/**
 * When a spend of `costMs` becomes affordable within this focus block. The wait counts to the
 * amount this action costs, never past the block's boundary, and a cost the block can never
 * reach gets a reason instead of a countdown. The view is always a focus phase, so the break-time
 * explanation the popup can give has no counterpart here.
 */
export function accessWait(view: ActiveOverlayView, now: number, costMs: number): AccessWait {
  const endsAt: number | null = focusBoundary(view);
  if (endsAt !== null && now >= endsAt) return unreachable('updating');
  const bank: number = bankAt(view, now);
  if (bank >= costMs) return { affordable: true, waitMs: 0, reason: null };
  if (costMs > view.economy.bankCapMs) return unreachable('above-limit');
  if (view.economy.bankAccrualPerMs <= 0) return unreachable('earning-off');
  const rawWait: number = (costMs - bank) / view.economy.bankAccrualPerMs;
  if (!Number.isFinite(rawWait) || (endsAt !== null && rawWait >= endsAt - now)) {
    return unreachable('not-enough-time');
  }
  const waitMs: number = Math.ceil(rawWait / 1_000) * 1_000;
  return { affordable: false, waitMs, reason: 'ready-in' };
}

/** The End control's label, translated from the tag the worker published. */
export function endActionLabel(tag: EndActionLabelV2): string {
  return tag === 'Unlock' ? t('shared_unlock') : t('shared_end_session');
}
