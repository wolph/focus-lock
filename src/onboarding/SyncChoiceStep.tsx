import type { TargetedEvent, VNode } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { t } from '../shared/i18n';
import { LOCAL_ONLY_DATA_ITEMS, SYNCED_DATA_ITEMS } from '../shared/privacy-copy';

export interface SyncChoiceStepProps {
  syncEnabled: boolean;
  pending: boolean;
  error: string | null;
  onSyncChange: (enabled: boolean) => void | Promise<void>;
  onComplete: () => void | Promise<void>;
}

function DataList(props: { id: string; title: string; items: readonly string[] }): VNode {
  const headingId: string = `${props.id}-heading`;
  return (
    <section class="storage-data-list" aria-labelledby={headingId}>
      <h2 id={headingId}>{props.title}</h2>
      <ul>
        {props.items.map(
          (item: string): VNode => (
            <li key={item}>{item}</li>
          ),
        )}
      </ul>
    </section>
  );
}

export function SyncChoiceStep(props: SyncChoiceStepProps): VNode {
  const completionLabel: string = props.syncEnabled
    ? t('onboarding_sync_finish_enabled')
    : t('onboarding_sync_finish_disabled');
  const syncControl: { current: HTMLInputElement | null } = useRef<HTMLInputElement>(null);
  const restoreSyncFocus: { current: boolean } = useRef<boolean>(false);
  useLayoutEffect((): void => {
    if (props.pending || !restoreSyncFocus.current) return;
    restoreSyncFocus.current = false;
    syncControl.current?.focus();
  }, [props.pending, props.syncEnabled]);

  const changeSync: (event: TargetedEvent<HTMLInputElement>) => void = (
    event: TargetedEvent<HTMLInputElement>,
  ): void => {
    restoreSyncFocus.current = true;
    void props.onSyncChange(event.currentTarget.checked);
  };

  return (
    <section aria-labelledby="sync-choice-heading">
      <h1 id="sync-choice-heading" tabIndex={-1}>
        {t('onboarding_sync_heading')}
      </h1>
      <label class="sync-choice">
        <input
          ref={syncControl}
          type="checkbox"
          role="switch"
          aria-label={t('onboarding_sync_switch_label')}
          aria-checked={props.syncEnabled}
          checked={props.syncEnabled}
          disabled={props.pending}
          onChange={changeSync}
        />
        <span>
          <strong>{t('onboarding_sync_switch_label')}</strong>
          <small>
            {props.syncEnabled
              ? t('onboarding_sync_enabled_note')
              : t('onboarding_sync_disabled_note')}
          </small>
        </span>
      </label>
      <div class="storage-data-grid">
        <DataList
          id="synced-data"
          title={t('onboarding_sync_synced_title')}
          items={SYNCED_DATA_ITEMS}
        />
        <DataList
          id="local-data"
          title={t('onboarding_sync_local_title')}
          items={LOCAL_ONLY_DATA_ITEMS}
        />
      </div>
      <p class="developer-data-note">{t('onboarding_sync_developer_note')}</p>
      {props.error !== null ? <p role="alert">{props.error}</p> : null}
      <button
        type="button"
        class="primary-button"
        disabled={props.pending}
        onClick={(): void => void props.onComplete()}
      >
        {completionLabel}
      </button>
    </section>
  );
}
