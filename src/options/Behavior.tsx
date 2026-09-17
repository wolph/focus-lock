import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { t, tPlural } from '../shared/i18n';
import {
  isRelativeMinuteDuration,
  isSafeDayCount,
  MAX_RELATIVE_DURATION_MS,
  MAX_RELATIVE_MINUTES,
  MAX_SAFE_DAY_COUNT,
  MIN_RELATIVE_MINUTES,
} from '../shared/numeric-validation';
import { minToMs } from '../shared/time';
import type { Settings } from '../shared/types';

export interface BehaviorProps {
  settings: Settings;
  onChange: (next: Settings) => void;
}

interface NumberFieldProps {
  label: string;
  value: number;
  onValue: (value: number) => void;
  allowZero?: boolean;
  allowFraction?: boolean;
  errorMessage?: string;
  isValid?: (value: number) => boolean;
  max?: number;
  min?: number;
}

function NumberField(props: NumberFieldProps): VNode {
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const allowZero: boolean = props.allowZero ?? false;
  const allowFraction: boolean = props.allowFraction ?? false;
  const errorMessage: string =
    props.errorMessage ??
    (allowFraction
      ? t('options_number_error_nonnegative', { LABEL: props.label })
      : allowZero
        ? t('options_number_error_whole', { LABEL: props.label })
        : t('options_number_error_positive', { LABEL: props.label }));
  return (
    <label class="field">
      {props.label}
      <input
        type="number"
        min={String(props.min ?? (allowZero ? 0 : 1))}
        max={props.max === undefined ? undefined : String(props.max)}
        step={allowFraction ? 'any' : '1'}
        value={props.value}
        onInput={(event: Event): void => {
          const raw: string = (event.currentTarget as HTMLInputElement).value;
          const value: number = Number(raw);
          const valid: boolean =
            raw.trim() !== '' &&
            Number.isFinite(value) &&
            (allowZero ? value >= 0 : value > 0) &&
            (allowFraction || Number.isInteger(value)) &&
            (props.isValid?.(value) ?? true);
          if (!valid) {
            setError(errorMessage);
            return;
          }
          setError(null);
          props.onValue(value);
        }}
      />
      {error !== null ? (
        <span class="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

/** Default mode, strictness, cycling numbers, and the deliberation gate. */
export function BehaviorDefaults(props: BehaviorProps): VNode {
  const s: Settings = props.settings;
  const delayIsPreset: boolean =
    s.gate.delayMs === 0 || s.gate.delayMs === 10_000 || s.gate.delayMs === 30_000;
  const [customDelaySeconds, setCustomDelaySeconds]: [number, Dispatch<StateUpdater<number>>] =
    useState<number>(delayIsPreset ? 60 : s.gate.delayMs / 1_000);
  return (
    <div>
      <h3>{t('options_session_defaults_heading')}</h3>
      <p class="help">{t('options_session_defaults_help')}</p>
      <NumberField
        label={t('options_preset_short_label')}
        value={s.presetsMin[0]}
        allowFraction
        min={MIN_RELATIVE_MINUTES}
        max={MAX_RELATIVE_MINUTES}
        isValid={isRelativeMinuteDuration}
        errorMessage={t('options_number_error_minute_range', {
          LABEL: t('options_preset_short_label'),
        })}
        onValue={(value: number): void => {
          props.onChange({ ...s, presetsMin: [value, s.presetsMin[1], s.presetsMin[2]] });
        }}
      />
      <NumberField
        label={t('options_preset_default_label')}
        value={s.presetsMin[1]}
        allowFraction
        min={MIN_RELATIVE_MINUTES}
        max={MAX_RELATIVE_MINUTES}
        isValid={isRelativeMinuteDuration}
        errorMessage={t('options_number_error_minute_range', {
          LABEL: t('options_preset_default_label'),
        })}
        onValue={(value: number): void => {
          props.onChange({ ...s, presetsMin: [s.presetsMin[0], value, s.presetsMin[2]] });
        }}
      />
      <NumberField
        label={t('options_preset_deep_label')}
        value={s.presetsMin[2]}
        allowFraction
        min={MIN_RELATIVE_MINUTES}
        max={MAX_RELATIVE_MINUTES}
        isValid={isRelativeMinuteDuration}
        errorMessage={t('options_number_error_minute_range', {
          LABEL: t('options_preset_deep_label'),
        })}
        onValue={(value: number): void => {
          props.onChange({ ...s, presetsMin: [s.presetsMin[0], s.presetsMin[1], value] });
        }}
      />
      <div class="field">
        <label class="check">
          <input
            type="radio"
            name="default-mode"
            checked={s.defaultMode === 'blacklist'}
            onClick={(): void => {
              props.onChange({ ...s, defaultMode: 'blacklist' });
            }}
          />
          {t('options_mode_blacklist_label')}
        </label>
        <label class="check">
          <input
            type="radio"
            name="default-mode"
            checked={s.defaultMode === 'whitelist'}
            onClick={(): void => {
              props.onChange({ ...s, defaultMode: 'whitelist' });
            }}
          />
          {t('options_mode_whitelist_label')}
        </label>
      </div>
      <div class="field">
        <label class="check">
          <input
            type="radio"
            name="default-strictness"
            checked={s.defaultStrictness === 'friction'}
            onClick={(): void => {
              props.onChange({ ...s, defaultStrictness: 'friction' });
            }}
          />
          {t('options_strictness_friction_label')}
        </label>
        <label class="check">
          <input
            type="radio"
            name="default-strictness"
            checked={s.defaultStrictness === 'hard'}
            onClick={(): void => {
              props.onChange({ ...s, defaultStrictness: 'hard' });
            }}
          />
          {t('options_strictness_hard_label')}
        </label>
      </div>
      <h3>{t('options_cycle_heading')}</h3>
      <p class="help">{t('options_cycle_help')}</p>
      <label class="check">
        <input
          type="checkbox"
          checked={s.cyclingOnByDefault}
          onClick={(): void => {
            props.onChange({ ...s, cyclingOnByDefault: !s.cyclingOnByDefault });
          }}
        />
        {t('options_cycle_default_label')}
      </label>
      <NumberField
        label={t('options_focus_minutes_label')}
        value={s.defaultCycling.focusMin}
        onValue={(value: number): void => {
          props.onChange({ ...s, defaultCycling: { ...s.defaultCycling, focusMin: value } });
        }}
      />
      <NumberField
        label={t('options_short_break_minutes_label')}
        value={s.defaultCycling.shortBreakMin}
        onValue={(value: number): void => {
          props.onChange({ ...s, defaultCycling: { ...s.defaultCycling, shortBreakMin: value } });
        }}
      />
      <NumberField
        label={t('options_long_break_minutes_label')}
        value={s.defaultCycling.longBreakMin}
        onValue={(value: number): void => {
          props.onChange({ ...s, defaultCycling: { ...s.defaultCycling, longBreakMin: value } });
        }}
      />
      <NumberField
        label={t('options_long_every_label')}
        value={s.defaultCycling.longEvery}
        onValue={(value: number): void => {
          props.onChange({ ...s, defaultCycling: { ...s.defaultCycling, longEvery: value } });
        }}
      />
      <h3>{t('options_gate_heading')}</h3>
      <p class="help">{t('options_gate_help')}</p>
      <div class="field">
        <label class="check">
          <input
            type="radio"
            name="gate-delay"
            checked={s.gate.delayMs === 0}
            onClick={(): void => {
              props.onChange({ ...s, gate: { ...s.gate, delayMs: 0 } });
            }}
          />
          {tPlural('options_gate_wait', 0)}
        </label>
        <label class="check">
          <input
            type="radio"
            name="gate-delay"
            checked={s.gate.delayMs === 10_000}
            onClick={(): void => {
              props.onChange({ ...s, gate: { ...s.gate, delayMs: 10_000 } });
            }}
          />
          {tPlural('options_gate_wait', 10)}
        </label>
        <label class="check">
          <input
            type="radio"
            name="gate-delay"
            checked={s.gate.delayMs === 30_000}
            onClick={(): void => {
              props.onChange({ ...s, gate: { ...s.gate, delayMs: 30_000 } });
            }}
          />
          {tPlural('options_gate_wait', 30)}
        </label>
        <label class="check">
          <input
            type="radio"
            name="gate-delay"
            checked={!delayIsPreset}
            onClick={(): void => {
              props.onChange({
                ...s,
                gate: { ...s.gate, delayMs: customDelaySeconds * 1_000 },
              });
            }}
          />
          {t('options_gate_wait_custom')}
        </label>
      </div>
      <NumberField
        label={t('options_custom_delay_label')}
        value={customDelaySeconds}
        max={MAX_RELATIVE_DURATION_MS / 1_000}
        isValid={(value: number): boolean => Number.isSafeInteger(value * 1_000)}
        errorMessage={t('options_custom_delay_error')}
        onValue={(value: number): void => {
          setCustomDelaySeconds(value);
          props.onChange({ ...s, gate: { ...s.gate, delayMs: value * 1_000 } });
        }}
      />
      <label class="check">
        <input
          type="checkbox"
          checked={s.gate.requireTypedPhrase}
          onClick={(): void => {
            props.onChange({
              ...s,
              gate: { ...s.gate, requireTypedPhrase: !s.gate.requireTypedPhrase },
            });
          }}
        />
        {t('options_gate_typed_phrase_label')}
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={s.gate.allowForceEnd}
          onClick={(): void => {
            props.onChange({
              ...s,
              gate: { ...s.gate, allowForceEnd: !s.gate.allowForceEnd },
            });
          }}
        />
        {t('options_gate_force_end_label')}
      </label>
    </div>
  );
}

/** Earn rate, bank cap, spend lengths, streak goal, retention. */
export function PauseEconomy(props: BehaviorProps): VNode {
  const s: Settings = props.settings;
  const earnPer30: number = Math.round(s.pause.earnRatio * 30 * 100) / 100;
  return (
    <div>
      <p class="help">{t('options_credit_help')}</p>
      <NumberField
        label={t('options_earn_rate_label')}
        value={earnPer30}
        allowZero
        allowFraction
        onValue={(value: number): void => {
          props.onChange({ ...s, pause: { ...s.pause, earnRatio: value / 30 } });
        }}
      />
      <NumberField
        label={t('options_credit_cap_label')}
        value={s.pause.capMs / 60_000}
        allowZero
        onValue={(value: number): void => {
          props.onChange({ ...s, pause: { ...s.pause, capMs: minToMs(value) } });
        }}
      />
      <NumberField
        label={t('options_pause_length_label')}
        value={s.pause.pauseMs / 60_000}
        onValue={(value: number): void => {
          props.onChange({ ...s, pause: { ...s.pause, pauseMs: minToMs(value) } });
        }}
      />
      <NumberField
        label={t('options_unlock_length_label')}
        value={s.pause.unlockMs / 60_000}
        onValue={(value: number): void => {
          props.onChange({ ...s, pause: { ...s.pause, unlockMs: minToMs(value) } });
        }}
      />
      <h3>{t('options_streak_heading')}</h3>
      <p class="help">{t('options_streak_help')}</p>
      <NumberField
        label={t('options_streak_goal_label')}
        value={s.streakGoalMin}
        onValue={(value: number): void => {
          props.onChange({ ...s, streakGoalMin: value });
        }}
      />
      <NumberField
        label={t('options_freeze_interval_label')}
        value={s.streakFreezeIntervalDays}
        max={MAX_SAFE_DAY_COUNT}
        isValid={isSafeDayCount}
        errorMessage={t('options_number_error_day_range', {
          LABEL: t('options_freeze_interval_label'),
        })}
        onValue={(value: number): void => {
          props.onChange({ ...s, streakFreezeIntervalDays: value });
        }}
      />
      <NumberField
        label={t('options_retention_label')}
        value={s.retentionDays}
        max={MAX_SAFE_DAY_COUNT}
        isValid={isSafeDayCount}
        errorMessage={t('options_number_error_day_range', { LABEL: t('options_retention_label') })}
        onValue={(value: number): void => {
          props.onChange({ ...s, retentionDays: value });
        }}
      />
    </div>
  );
}
