import type { VNode } from 'preact';
import { formatNumber, t } from '../shared/i18n';
import type { Strictness } from '../shared/types';
import { effectiveStrictness, type StartDraft } from './start-draft';

/** The current draft's consequences stay beside Start even while its controls are closed. */
export function DraftSummary({
  draft,
  durationHint,
}: {
  draft: StartDraft;
  durationHint: string | null;
}): VNode {
  const categories: number = Object.values(draft.rules.categories).filter(Boolean).length;
  const blocked: number =
    draft.rules.permanentBlacklist.length + draft.rules.sessionBlacklist.length;
  const allowed: number =
    draft.rules.permanentAllowlist.length + draft.rules.sessionAllowlist.length;
  const blocking: string =
    draft.mode === 'whitelist'
      ? t('popup_draft_allowed_only', { COUNT: formatNumber(allowed) })
      : t('popup_draft_blocked_summary', {
          CATEGORIES: formatNumber(categories),
          RULES: formatNumber(blocked),
        });
  const strictness: Strictness = effectiveStrictness(draft);
  const waitSeconds: string = formatNumber(draft.frictionGate.delayMs / 1000);
  const stop: string =
    strictness === 'hard'
      ? t('popup_draft_stop_hard')
      : draft.duration.kind === 'until-stopped'
        ? ''
        : strictness === 'flexible'
          ? t('popup_draft_stop_flexible')
          : draft.frictionGate.requireTypedPhrase
            ? t('popup_draft_stop_friction_phrase', { SECONDS: waitSeconds })
            : t('popup_draft_stop_friction', { SECONDS: waitSeconds });
  return (
    <p class="draft-summary">
      <span>{blocking}</span>
      {durationHint !== null ? (
        <span class="session-timing" role="status">
          {durationHint}
        </span>
      ) : null}
      {stop !== '' ? <span>{stop}</span> : null}
    </p>
  );
}
