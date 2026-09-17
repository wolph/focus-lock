import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { t } from '../shared/i18n';
import type { Ack, SoundId } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import type { Settings, SoundSettings } from '../shared/types';

export interface SoundsBadgeProps {
  settings: Settings;
  onChange: (next: Settings) => void;
}

/** The catalogue keys naming the sounds, none of which takes a placeholder. */
type SoundLabelKey =
  | 'options_sound_session_complete'
  | 'options_sound_break_start'
  | 'options_sound_break_end'
  | 'options_sound_schedule_start';

interface SoundEvent {
  id: SoundId;
  key: keyof SoundSettings;
  labelKey: SoundLabelKey;
}

const SOUND_EVENTS: readonly SoundEvent[] = [
  {
    id: 'sessionComplete',
    key: 'sessionComplete',
    labelKey: 'options_sound_session_complete',
  },
  { id: 'breakStart', key: 'breakStart', labelKey: 'options_sound_break_start' },
  { id: 'breakEnd', key: 'breakEnd', labelKey: 'options_sound_break_end' },
  { id: 'scheduleStart', key: 'scheduleStart', labelKey: 'options_sound_schedule_start' },
];

/** Master volume, per-event sound toggles with previews, badge countdown. */
export function SoundsBadge(props: SoundsBadgeProps): VNode {
  const s: Settings = props.settings;
  const [pendingSound, setPendingSound]: [SoundId | null, Dispatch<StateUpdater<SoundId | null>>] =
    useState<SoundId | null>(null);
  const [previewError, setPreviewError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);

  const preview: (sound: SoundId) => Promise<void> = async (sound: SoundId): Promise<void> => {
    setPreviewError(null);
    setPendingSound(sound);
    try {
      const ack: Ack = await sendRequest({ type: 'previewSound', sound });
      const responseError: string | null = ackError(ack, t('options_sound_preview_error'));
      if (responseError !== null) setPreviewError(responseError);
    } catch {
      setPreviewError(t('options_sound_preview_error'));
    } finally {
      setPendingSound(null);
    }
  };
  return (
    <div>
      <h3>{t('options_sounds_heading')}</h3>
      <label class="field">
        {t('options_master_volume')}
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(s.sounds.masterVolume * 100)}
          onInput={(event: Event): void => {
            const value: number = Number((event.currentTarget as HTMLInputElement).value);
            props.onChange({ ...s, sounds: { ...s.sounds, masterVolume: value / 100 } });
          }}
        />
      </label>
      {SOUND_EVENTS.map((sound: SoundEvent): VNode => {
        const label: string = t(sound.labelKey);
        return (
          <div class="field" key={sound.id}>
            <label class="check">
              <input
                type="checkbox"
                checked={s.sounds[sound.key] === true}
                onClick={(): void => {
                  props.onChange({
                    ...s,
                    sounds: { ...s.sounds, [sound.key]: s.sounds[sound.key] !== true },
                  });
                }}
              />
              {label}
            </label>
            <button
              type="button"
              class="ghost"
              aria-label={t('options_sound_preview_aria', { SOUND: label })}
              disabled={pendingSound !== null}
              onClick={(): void => {
                void preview(sound.id);
              }}
            >
              {t('options_sound_play')}
            </button>
          </div>
        );
      })}
      {previewError !== null ? (
        <p class="save-error" role="alert">
          {previewError}
        </p>
      ) : null}
      <h3>{t('options_sounds_notifications_heading')}</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={s.sessionCompleteNotification}
          onClick={(): void => {
            props.onChange({
              ...s,
              sessionCompleteNotification: !s.sessionCompleteNotification,
            });
          }}
        />
        {t('options_session_complete_notification')}
      </label>
      <h3>{t('options_badge_heading')}</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={s.badgeCountdown}
          onClick={(): void => {
            props.onChange({ ...s, badgeCountdown: !s.badgeCountdown });
          }}
        />
        {t('options_badge_countdown')}
      </label>
    </div>
  );
}
