import type { VNode } from 'preact';
import { t } from '../shared/i18n';

export interface DirtySaveBarProps {
  dirty: boolean;
  pending: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}

export function DirtySaveBar(props: DirtySaveBarProps): VNode {
  const disabled: boolean = !props.dirty || props.pending;
  const sticky: boolean = props.dirty || props.pending || props.error !== null;
  const message: string = props.pending
    ? t('options_dirty_saving')
    : props.dirty
      ? t('options_dirty_unsaved')
      : t('options_dirty_clean');

  return (
    <div class={`dirty-save-bar${sticky ? ' dirty-save-bar--sticky' : ''}`}>
      {props.error === null ? null : (
        <p class="save-error dirty-save-error" role="alert">
          {props.error}
        </p>
      )}
      <p class="dirty-save-state" aria-live="polite">
        {message}
      </p>
      <div class="dirty-save-actions">
        <button type="button" class="secondary" disabled={disabled} onClick={props.onDiscard}>
          {t('options_dirty_discard')}
        </button>
        <button type="button" class="primary" disabled={disabled} onClick={props.onSave}>
          {t('options_dirty_save')}
        </button>
      </div>
    </div>
  );
}
