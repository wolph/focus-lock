import type { VNode } from 'preact';
import type {
  PendingIntent,
  PendingPath,
  PendingPolicyChange,
} from '../background/pending-policy-changes';
import { CATEGORY_IDS } from '../shared/constants';
import { formatDuration } from '../shared/format';
import { t } from '../shared/i18n';
import { formatGateWait } from '../shared/session-copy';
import type { CategoryId, Strictness } from '../shared/types';
import { categoryLabel } from '../shared/verdict-label';

/**
 * The line under a control that a hard lock refused to change.
 *
 * The control above it keeps showing the value in force, because a control showing a value that
 * is not being enforced is exactly the confusion this line exists to clear up. What the person
 * asked for lives here instead, with the reason the lock gave and a way to drop it.
 */

export interface PendingChangeProps {
  path: PendingPath;
  changes: readonly PendingPolicyChange[];
  onCancel: (path: PendingPath) => void;
}

function strictnessLabel(value: Strictness): string {
  switch (value) {
    case 'flexible':
      return t('options_strictness_flexible_label');
    case 'friction':
      return t('options_strictness_friction_label');
    case 'hard':
      return t('options_strictness_hard_label');
  }
}

/** What the person asked for, in the same terms the control above states it. */
function describeValue(change: PendingPolicyChange): string {
  const intent: PendingIntent = change.intent;
  if (intent.kind === 'lists-delta') return describeListsDelta(intent);
  const value: unknown = intent.value;
  switch (change.path) {
    case 'settings.gate.delayMs':
      return formatGateWait(value as number);
    case 'settings.pause.capMs':
    case 'settings.pause.pauseMs':
    case 'settings.pause.unlockMs':
      return formatDuration(value as number);
    case 'settings.gate.requireTypedPhrase':
      return value === true ? t('options_pending_value_on') : t('options_pending_value_off');
    case 'settings.pause.earnRatio':
      return String(Math.round((value as number) * 30 * 100) / 100);
    case 'settings.defaultStrictness':
      return strictnessLabel(value as Strictness);
    case 'settings.schedule':
      return t('options_schedule_heading');
    case 'lists':
      return '';
  }
}

function describeListsDelta(intent: Extract<PendingIntent, { kind: 'lists-delta' }>): string {
  const parts: string[] = [
    ...intent.removeCustom.map((id: string): string => id.replace(/^host:/, '')),
    ...intent.addWhitelist.map((rule: { pattern: string }): string => rule.pattern),
    ...intent.disableCategories.map((id: CategoryId): string => categoryLabel(id)),
    ...CATEGORY_IDS.flatMap((id: CategoryId): string[] => intent.addExclusions[id] ?? []),
  ];
  return parts.join(', ');
}

export function PendingChange({ path, changes, onCancel }: PendingChangeProps): VNode | null {
  const change: PendingPolicyChange | undefined = changes.find(
    (candidate: PendingPolicyChange): boolean => candidate.path === path,
  );
  if (change === undefined) return null;
  return (
    <div class="pending-change" data-pending-change={path}>
      <p class="pending-change__value">
        {t('options_pending_waiting', { VALUE: describeValue(change) })}
      </p>
      <p class="pending-change__reason">{t(change.reasonKey)}</p>
      <button type="button" class="secondary" onClick={(): void => onCancel(path)}>
        {t('options_pending_cancel')}
      </button>
    </div>
  );
}
