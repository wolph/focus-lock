import { t } from './i18n';
import { growBank } from './live';
import { formatClock } from './time';
import type { SessionSnapshotV2 } from './types';

export interface AccessAvailability {
  affordable: boolean;
  /** Focus time still needed, 0 when affordable now, null when a message explains why not. */
  waitMs: number | null;
  message: string | null;
}

/** The earlier of the two deadlines, or null when neither bounds the current focus block. */
function focusBoundary(snapshot: SessionSnapshotV2): number | null {
  if (snapshot.phaseEndsAt === null) return snapshot.sessionEndsAt;
  if (snapshot.sessionEndsAt === null) return snapshot.phaseEndsAt;
  return Math.min(snapshot.phaseEndsAt, snapshot.sessionEndsAt);
}

function unavailable(message: string): AccessAvailability {
  return { affordable: false, waitMs: null, message };
}

/**
 * Describe when a spend of `costMs` becomes affordable within the current focus block. The wait
 * counts to the amount this action costs, not to the next earned minute, and a cost the block can
 * never reach gets an explanation instead of a countdown.
 */
export function accessAvailability(
  snapshot: SessionSnapshotV2,
  now: number,
  costMs: number,
): AccessAvailability {
  const endsAt: number | null = focusBoundary(snapshot);
  if (endsAt !== null && now >= endsAt) return unavailable(t('shared_updating_session'));
  const bank: number = growBank(
    snapshot.bankMs,
    snapshot.bankAccrualPerMs,
    snapshot.bankCapMs,
    snapshot.at,
    now,
  );
  if (bank >= costMs) return { affordable: true, waitMs: 0, message: null };
  if (costMs > snapshot.bankCapMs) return unavailable(t('shared_cost_exceeds_limit'));
  if (snapshot.phase !== 'focus') return unavailable(t('shared_credit_resumes_focus'));
  if (snapshot.bankAccrualPerMs <= 0) return unavailable(t('shared_credit_off'));
  const rawWait: number = (costMs - bank) / snapshot.bankAccrualPerMs;
  if (!Number.isFinite(rawWait) || (endsAt !== null && rawWait >= endsAt - now)) {
    return unavailable(t('shared_not_enough_time'));
  }
  const waitMs: number = Math.ceil(rawWait / 1_000) * 1_000;
  return {
    affordable: false,
    waitMs,
    message: t('shared_ready_in', { CLOCK: formatClock(waitMs) }),
  };
}

/** Focus time needed for the bank to reach its next whole credit minute. */
export function msUntilNextEarnedMinute(
  bankMs: number,
  accrualPerMs: number,
  capMs: number,
): number | null {
  if (
    !Number.isFinite(bankMs) ||
    !Number.isFinite(accrualPerMs) ||
    !Number.isFinite(capMs) ||
    accrualPerMs <= 0 ||
    capMs < 0
  ) {
    return null;
  }
  const balanceMs: number = Math.max(0, bankMs);
  const remainderMs: number = balanceMs % 60_000;
  const pauseMsNeeded: number = remainderMs === 0 ? 60_000 : 60_000 - remainderMs;
  if (balanceMs + pauseMsNeeded > capMs) return null;
  const focusMsNeeded: number = pauseMsNeeded / accrualPerMs;
  if (!Number.isFinite(focusMsNeeded)) return null;
  const roundedMs: number = Math.ceil(focusMsNeeded / 1_000) * 1_000;
  return Number.isFinite(roundedMs) ? roundedMs : null;
}
