import type { VNode } from 'preact';
import { HelpPopover } from '../shared/HelpPopover';
import { t } from '../shared/i18n';
import { formatGateWait } from '../shared/session-copy';
import type { Strictness } from '../shared/types';

interface SessionTypeChoice {
  value: Strictness;
  label: string;
  consequence: string;
  /** What this type does to a rule change made while the session runs. */
  edits: string;
  /** The one-sentence reason this choice cannot be selected, null while it can. */
  unavailableReason: string | null;
}

export interface SessionTypeControlProps {
  value: Strictness;
  frictionDelayMs: number;
  requireTypedPhrase: boolean;
  /**
   * Set while Hard cannot be chosen, which an Until stopped draft asks for. The choice stays
   * visible and disclosable, reads the reason where its consequence would be, and refuses the
   * selection.
   */
  hardUnavailableReason?: string;
  onChange: (value: Strictness) => void;
}

function frictionConsequence(delayMs: number, requireTypedPhrase: boolean): string {
  const wait: string = formatGateWait(delayMs);
  return requireTypedPhrase
    ? t('popup_session_type_friction_hint_phrase', { WAIT: wait })
    : t('popup_session_type_friction_hint', { WAIT: wait });
}

export function SessionTypeControl({
  value,
  frictionDelayMs,
  requireTypedPhrase,
  hardUnavailableReason,
  onChange,
}: SessionTypeControlProps): VNode {
  const choices: readonly SessionTypeChoice[] = [
    {
      value: 'flexible',
      label: t('popup_session_type_flexible'),
      consequence: t('popup_session_type_flexible_hint'),
      edits: t('popup_session_type_flexible_edits'),
      unavailableReason: null,
    },
    {
      value: 'friction',
      label: t('popup_session_type_friction'),
      consequence: frictionConsequence(frictionDelayMs, requireTypedPhrase),
      edits: t('popup_session_type_friction_edits'),
      unavailableReason: null,
    },
    {
      value: 'hard',
      label: t('popup_session_type_hard'),
      consequence: t('popup_session_type_hard_hint'),
      edits: t('popup_session_type_hard_edits'),
      unavailableReason: hardUnavailableReason ?? null,
    },
  ];
  return (
    <fieldset class="session-type-control" aria-label={t('popup_session_type_legend')}>
      <legend>{t('popup_session_type_legend')}</legend>
      <div class="session-type-choices">
        {choices.map((choice: SessionTypeChoice): VNode => {
          const disabled: boolean = choice.unavailableReason !== null;
          const explanation: string = choice.unavailableReason ?? choice.consequence;
          return (
            <HelpPopover
              key={choice.value}
              label={choice.label}
              triggerContent={
                <span class="session-type-choice__content">
                  <span class="session-type-choice__label">{choice.label}</span>
                  <span class="session-type-choice__hint">{explanation}</span>
                  {disabled ? null : <span class="session-type-choice__edits">{choice.edits}</span>}
                </span>
              }
              triggerClassName="session-type-choice"
              triggerPressed={value === choice.value}
              triggerDisabled={disabled}
              onTriggerClick={(): void => onChange(choice.value)}
            >
              {disabled ? explanation : `${explanation} ${choice.edits}`}
            </HelpPopover>
          );
        })}
      </div>
    </fieldset>
  );
}
