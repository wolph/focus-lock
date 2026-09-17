import type { TargetedEvent, TargetedMouseEvent, VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../shared/i18n';
import { sendRequest } from '../shared/messages';
import { WEBSITE_ORIGINS } from '../shared/permissions';
import {
  ALL_DATA_CLEAR_RUNNING_SESSION_COPY,
  LEGACY_REMOTE_POLICY_DROPPED_COPY,
  LOCAL_ONLY_DATA_ITEMS,
  SYNCED_DATA_ITEMS,
} from '../shared/privacy-copy';
import { parseEventExportResponse } from '../shared/runtime-validation';
import { localDateStr } from '../shared/time';
import type { SessionSnapshot, SetupState, StorageMode } from '../shared/types';

type Confirmation = 'local-history' | 'synced-policy' | 'all' | null;

export interface PrivacyDataProps {
  setup: SetupState;
  /** The live snapshot, null until the first load answers. */
  snapshot: SessionSnapshot | null;
  onReconcileWebsiteAccess: () => Promise<string | null>;
  onStorageModeChange: (next: StorageMode) => Promise<string | null>;
  onRetrySync: () => Promise<string | null>;
  onClearData: (scope: 'local-history' | 'synced-policy' | 'all') => Promise<string | null>;
  onRetryDataClear: () => Promise<string | null>;
}

interface WebsiteAccessPresentation {
  action: 'enable' | 'retry' | null;
  actionLabel: string | null;
  detail: string;
  title: string;
}

function websiteAccessPresentation(setup: SetupState): WebsiteAccessPresentation {
  if (setup.websiteAccess !== 'granted') {
    return {
      action: 'enable',
      actionLabel: t('options_privacy_website_enable_action'),
      title: t('options_privacy_website_off_title'),
      detail: t('options_privacy_website_off_detail'),
    };
  }
  if (setup.blockingRegistration !== 'ready') {
    return {
      action: 'retry',
      actionLabel: t('options_privacy_website_retry_action'),
      title: t('options_privacy_website_unregistered_title'),
      detail: t('options_privacy_website_unregistered_detail'),
    };
  }
  return {
    action: null,
    actionLabel: null,
    title: t('options_privacy_website_on_title'),
    detail: t('options_privacy_website_on_detail'),
  };
}

function DataScope(props: { items: readonly string[]; title: string }): VNode {
  return (
    <section class="privacy-data-scope">
      <h4>{props.title}</h4>
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

interface ConfirmationCopy {
  title: string;
  confirmLabel: string;
  success: string;
}

/** Read at call time so the dialog copy follows the browser's UI language. */
function confirmationCopy(kind: Exclude<Confirmation, null>): ConfirmationCopy {
  if (kind === 'local-history') {
    return {
      title: t('options_privacy_confirm_local_history_title'),
      confirmLabel: t('options_privacy_confirm_local_history_action'),
      success: t('options_privacy_local_history_deleted'),
    };
  }
  if (kind === 'synced-policy') {
    return {
      title: t('options_privacy_confirm_synced_policy_title'),
      confirmLabel: t('options_privacy_confirm_synced_policy_action'),
      success: t('options_privacy_synced_policy_deleted'),
    };
  }
  return {
    title: t('options_privacy_confirm_all_title'),
    confirmLabel: t('options_privacy_confirm_all_action'),
    success: t('options_privacy_all_deleted'),
  };
}

/**
 * True while the worker would refuse an all-data clear: its stopped-runtime rule wants no session,
 * gate, unlock, or pending cleanup, and the snapshot is the page's view of the same runtime. A gate
 * or an unlock only exists on an active lifecycle (the snapshot validator refuses them otherwise),
 * so every one of those states reads as a lifecycle that is not idle.
 */
function runtimeHoldsSession(snapshot: SessionSnapshot | null): boolean {
  return snapshot !== null && snapshot.lifecycle.kind !== 'idle';
}

/**
 * What an all-data clear removes, composed from the two item lists the Chrome Sync card shows so
 * a scope added to either list reaches this dialog without a second copy of it. The Chrome Sync
 * copies go in every mode: the worker sweeps every Focus Lock key left there, syncing or not.
 */
function AllDataBody(): VNode {
  return (
    <>
      <p>{t('options_privacy_all_body_intro')}</p>
      <ul>
        {[...SYNCED_DATA_ITEMS, ...LOCAL_ONLY_DATA_ITEMS].map(
          (item: string): VNode => (
            <li key={item}>{item}</li>
          ),
        )}
      </ul>
      <p>{t('options_privacy_all_body_outro')}</p>
    </>
  );
}

function ConfirmationDialog(props: {
  kind: Exclude<Confirmation, null>;
  localOnlyAggregates: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): VNode {
  const dialog: { current: HTMLDialogElement | null } = useRef<HTMLDialogElement>(null);
  const cancelButton: { current: HTMLButtonElement | null } = useRef<HTMLButtonElement>(null);
  useEffect((): (() => void) => {
    const current: HTMLDialogElement | null = dialog.current;
    if (current === null) return (): void => {};
    if (typeof current.showModal === 'function') current.showModal();
    else current.setAttribute('open', '');
    cancelButton.current?.focus();
    return (): void => {
      if (current.open && typeof current.close === 'function') current.close();
    };
  }, []);
  useEffect((): (() => void) => {
    const onKeyDown: (event: KeyboardEvent) => void = (event: KeyboardEvent): void => {
      const current: HTMLDialogElement | null = dialog.current;
      if (current === null) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!props.pending) props.onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls: HTMLButtonElement[] = Array.from(
        current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      );
      event.preventDefault();
      if (controls.length === 0) {
        current.focus();
        return;
      }
      const first: HTMLButtonElement | undefined = controls[0];
      const last: HTMLButtonElement | undefined = controls.at(-1);
      if (first === undefined || last === undefined) {
        current.focus();
        return;
      }
      const active: Element | null = document.activeElement;
      if (event.shiftKey) {
        (active === first || !current.contains(active) ? last : first).focus();
      } else {
        (active === last || !current.contains(active) ? first : last).focus();
      }
    };
    const blockBackgroundClick: (event: MouseEvent) => void = (event: MouseEvent): void => {
      const current: HTMLDialogElement | null = dialog.current;
      const target: Node | null = event.target instanceof Node ? event.target : null;
      if (current === null || (target !== null && current.contains(target))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', blockBackgroundClick, true);
    return (): void => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', blockBackgroundClick, true);
    };
  }, [props.onCancel, props.pending]);
  const copy: ConfirmationCopy = confirmationCopy(props.kind);
  const title: string = copy.title;
  const confirmLabel: string = copy.confirmLabel;
  return (
    <dialog
      ref={dialog}
      class="privacy-confirmation"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onCancel={(event: TargetedEvent<HTMLDialogElement>): void => {
        event.preventDefault();
        if (!props.pending) props.onCancel();
      }}
    >
      <h4>{title}</h4>
      {props.kind === 'local-history' ? (
        <p>
          {props.localOnlyAggregates
            ? t('options_privacy_confirm_local_history_body_aggregates')
            : t('options_privacy_confirm_local_history_body')}
        </p>
      ) : props.kind === 'synced-policy' ? (
        <p>{t('options_privacy_confirm_synced_policy_body')}</p>
      ) : (
        <AllDataBody />
      )}
      <div class="privacy-confirmation-actions">
        <button
          ref={cancelButton}
          type="button"
          class="secondary"
          disabled={props.pending}
          onClick={props.onCancel}
        >
          {t('options_cancel')}
        </button>
        <button type="button" class="danger" disabled={props.pending} onClick={props.onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

function durableError(setup: SetupState): string | null {
  if (setup.dataClear.status === 'error') {
    if (setup.dataClear.scope === 'local-history') {
      return t('options_privacy_error_local_history_clear');
    }
    if (setup.dataClear.scope === 'synced-policy') {
      return t('options_privacy_error_synced_policy_clear');
    }
    return t('options_privacy_error_all_clear');
  }
  if (setup.syncWriteStatus === 'error') {
    return t('options_privacy_error_sync_write');
  }
  if (setup.storageError === 'legacy-remote-policy-dropped') {
    return LEGACY_REMOTE_POLICY_DROPPED_COPY;
  }
  return null;
}

export function PrivacyData(props: PrivacyDataProps): VNode {
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [confirmation, setConfirmation]: [Confirmation, Dispatch<StateUpdater<Confirmation>>] =
    useState<Confirmation>(null);
  const [actionError, setActionError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const [status, setStatus]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const actionLocked: { current: boolean } = useRef<boolean>(false);
  const confirmationOrigin: { current: HTMLButtonElement | null } = useRef<HTMLButtonElement>(null);
  const previousConfirmation: { current: Confirmation } = useRef<Confirmation>(null);

  useEffect((): void => {
    const previous: Confirmation = previousConfirmation.current;
    previousConfirmation.current = confirmation;
    if (previous === null || confirmation !== null) return;
    const active: Element | null = document.activeElement;
    if (active === document.body || active?.closest('.privacy-confirmation') !== null) {
      confirmationOrigin.current?.focus();
    }
  }, [confirmation]);

  const runAction: (action: () => Promise<string | null>, success: string) => Promise<void> =
    async (action: () => Promise<string | null>, success: string): Promise<void> => {
      if (actionLocked.current) return;
      actionLocked.current = true;
      setPending(true);
      setActionError(null);
      setStatus('');
      try {
        const error: string | null = await action();
        if (error === null) setStatus(success);
        else setActionError(error);
      } catch {
        setActionError(t('options_privacy_error_request'));
      } finally {
        actionLocked.current = false;
        setPending(false);
      }
    };

  const enableWebsiteBlocking: () => Promise<void> = async (): Promise<void> => {
    if (actionLocked.current) return;
    actionLocked.current = true;
    setPending(true);
    setActionError(null);
    setStatus('');
    try {
      const granted: boolean = await chrome.permissions.request({ origins: [...WEBSITE_ORIGINS] });
      const error: string | null = await props.onReconcileWebsiteAccess();
      if (error === null) {
        setStatus(
          granted
            ? t('options_privacy_website_access_updated')
            : t('options_privacy_website_access_denied'),
        );
      } else setActionError(error);
    } catch {
      setActionError(t('options_privacy_error_website_access'));
    } finally {
      actionLocked.current = false;
      setPending(false);
    }
  };

  const exportLocalEvents: () => Promise<string | null> = async (): Promise<string | null> => {
    try {
      const response: unknown = await sendRequest({ type: 'exportEvents' });
      if (parseEventExportResponse(response) === null) return t('options_privacy_error_export');
      const exportResponse: { json: string } = response as { json: string };
      const blob: Blob = new Blob([exportResponse.json], { type: 'application/json' });
      const url: string = URL.createObjectURL(blob);
      const anchor: HTMLAnchorElement = document.createElement('a');
      anchor.href = url;
      anchor.download = `focus-lock-events-${localDateStr(Date.now())}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      return null;
    } catch {
      return t('options_privacy_error_export_retry');
    }
  };

  const confirmDeletion: () => void = (): void => {
    const scope: Confirmation = confirmation;
    if (scope === null) return;
    void runAction(async (): Promise<string | null> => {
      const error: string | null = await props.onClearData(scope);
      if (error === null) setConfirmation(null);
      return error;
    }, confirmationCopy(scope).success);
  };

  const openConfirmation: (kind: Exclude<Confirmation, null>, origin: HTMLButtonElement) => void = (
    kind: Exclude<Confirmation, null>,
    origin: HTMLButtonElement,
  ): void => {
    confirmationOrigin.current = origin;
    setConfirmation(kind);
  };

  const website: WebsiteAccessPresentation = websiteAccessPresentation(props.setup);
  const syncing: boolean = props.setup.storageMode === 'sync';
  const localMode: boolean = props.setup.storageMode === 'local';
  const syncPending: boolean = props.setup.syncWriteStatus === 'pending';
  const syncFailure: boolean =
    props.setup.syncWriteStatus === 'error' && props.setup.dataClear.status === 'idle';
  const firstSyncFailure: boolean = syncFailure && props.setup.storageMode !== 'sync';
  const dataClearFailure: Exclude<SetupState['dataClear']['scope'], null> | null =
    props.setup.dataClear.status === 'error' ? props.setup.dataClear.scope : null;
  // A pending clear has a retry alarm armed, and a new all-data request would spend one of its
  // automatic attempts, so the opener waits for idle rather than only for a stuck one.
  const dataClearBusy: boolean = props.setup.dataClear.status !== 'idle';
  const sessionRunning: boolean = runtimeHoldsSession(props.snapshot);
  const visibleError: string | null = actionError ?? durableError(props.setup);

  return (
    <div class="privacy-data">
      <section class="privacy-card" aria-labelledby="website-access-heading">
        <h3 id="website-access-heading">{t('options_privacy_website_access_heading')}</h3>
        <strong class="privacy-card-status">{website.title}</strong>
        <p>{website.detail}</p>
        <div class="privacy-actions">
          {website.actionLabel === null ? null : (
            <button
              type="button"
              class="primary"
              disabled={pending}
              onClick={(): void => {
                if (website.action === 'enable') void enableWebsiteBlocking();
                else
                  void runAction(
                    props.onReconcileWebsiteAccess,
                    t('options_privacy_website_blocking_enabled'),
                  );
              }}
            >
              {website.actionLabel}
            </button>
          )}
          <button
            type="button"
            class="secondary"
            disabled={pending}
            onClick={(): void => {
              void runAction(async (): Promise<string | null> => {
                try {
                  await chrome.tabs.create({
                    url: `chrome://extensions/?id=${chrome.runtime.id}`,
                  });
                  return null;
                } catch {
                  return t('options_privacy_error_open_chrome_settings');
                }
              }, t('options_privacy_chrome_settings_opened'));
            }}
          >
            {t('options_privacy_open_chrome_settings')}
          </button>
        </div>
      </section>

      <section class="privacy-card" aria-labelledby="chrome-sync-heading">
        <h3 id="chrome-sync-heading">{t('options_privacy_sync_heading')}</h3>
        <label class="privacy-switch">
          <input
            type="checkbox"
            role="switch"
            aria-checked={syncing}
            checked={syncing}
            disabled={pending || syncPending || props.setup.storageMode === null}
            onChange={(event: TargetedEvent<HTMLInputElement>): void => {
              const next: StorageMode = event.currentTarget.checked ? 'sync' : 'local';
              void runAction(
                (): Promise<string | null> => props.onStorageModeChange(next),
                next === 'sync'
                  ? t('options_privacy_sync_enabled')
                  : t('options_privacy_sync_disabled'),
              );
            }}
          />
          <span>{t('options_privacy_sync_switch_label')}</span>
        </label>
        {syncPending ? (
          <p>{t('options_privacy_sync_saving')}</p>
        ) : syncFailure ? null : (
          <p>{syncing ? t('options_privacy_sync_on') : t('options_privacy_sync_off')}</p>
        )}
        {syncFailure ? (
          <button
            type="button"
            class="secondary"
            disabled={pending}
            onClick={(): void => {
              void runAction(
                firstSyncFailure
                  ? (): Promise<string | null> => props.onStorageModeChange('sync')
                  : props.onRetrySync,
                firstSyncFailure
                  ? t('options_privacy_sync_enabled')
                  : t('options_privacy_sync_changes_saved'),
              );
            }}
          >
            {firstSyncFailure
              ? t('options_privacy_retry_enable_sync')
              : t('options_privacy_retry_sync')}
          </button>
        ) : null}
        <div class="privacy-data-grid">
          <DataScope title={t('options_privacy_scope_synced')} items={SYNCED_DATA_ITEMS} />
          <DataScope title={t('options_privacy_scope_local_only')} items={LOCAL_ONLY_DATA_ITEMS} />
        </div>
        <p class="privacy-developer-note">{t('options_privacy_developer_note')}</p>
      </section>

      <section class="privacy-card" aria-labelledby="local-log-heading">
        <h3 id="local-log-heading">{t('options_privacy_local_log_heading')}</h3>
        <p>{t('options_privacy_local_log_detail')}</p>
        <div class="privacy-actions">
          <button
            type="button"
            class="secondary"
            disabled={pending}
            onClick={(): void => {
              void runAction(exportLocalEvents, t('options_privacy_local_log_exported'));
            }}
          >
            {t('options_privacy_export_local_log')}
          </button>
          <button
            type="button"
            class="danger"
            disabled={pending}
            onClick={(event: TargetedMouseEvent<HTMLButtonElement>): void =>
              openConfirmation('local-history', event.currentTarget)
            }
          >
            {t('options_privacy_delete_local_history')}
          </button>
        </div>
      </section>

      {!localMode ? null : (
        <section class="privacy-card" aria-labelledby="remote-data-heading">
          <h3 id="remote-data-heading">{t('options_privacy_remote_data_heading')}</h3>
          <p>{t('options_privacy_remote_data_detail')}</p>
          <button
            type="button"
            class="danger"
            disabled={pending}
            onClick={(event: TargetedMouseEvent<HTMLButtonElement>): void =>
              openConfirmation('synced-policy', event.currentTarget)
            }
          >
            {t('options_privacy_delete_remote_data')}
          </button>
        </section>
      )}

      <section class="privacy-card privacy-card-destructive" aria-labelledby="all-data-heading">
        <h3 id="all-data-heading">{t('options_privacy_all_data_heading')}</h3>
        <p>{t('options_privacy_all_data_detail')}</p>
        <button
          type="button"
          class="danger"
          disabled={pending || dataClearBusy || sessionRunning}
          onClick={(event: TargetedMouseEvent<HTMLButtonElement>): void =>
            openConfirmation('all', event.currentTarget)
          }
        >
          {t('options_delete_all_data')}
        </button>
        {sessionRunning ? (
          <p class="privacy-card-reason">{ALL_DATA_CLEAR_RUNNING_SESSION_COPY}</p>
        ) : null}
      </section>

      {confirmation === null ? null : (
        <ConfirmationDialog
          kind={confirmation}
          localOnlyAggregates={localMode}
          pending={pending}
          onCancel={(): void => setConfirmation(null)}
          onConfirm={confirmDeletion}
        />
      )}
      {visibleError === null ? null : (
        <p class="save-error privacy-message" role="alert">
          {visibleError}
        </p>
      )}
      {dataClearFailure === null ? null : (
        <button
          type="button"
          class="secondary privacy-retry"
          disabled={pending}
          onClick={(): void => {
            // An all-data deletion in progress is retried, never started again. Asking for a new
            // deletion runs no phase of the one that is already stuck and answers success for it.
            if (dataClearFailure === 'all') {
              void runAction(props.onRetryDataClear, t('options_privacy_resuming_all_clear'));
              return;
            }
            const success: string =
              dataClearFailure === 'local-history'
                ? t('options_privacy_local_history_deleted')
                : t('options_privacy_synced_policy_deleted');
            void runAction(
              (): Promise<string | null> => props.onClearData(dataClearFailure),
              success,
            );
          }}
        >
          {dataClearFailure === 'local-history'
            ? t('options_privacy_retry_local_history')
            : dataClearFailure === 'synced-policy'
              ? t('options_privacy_retry_remote_sync')
              : t('options_privacy_retry_all_data')}
        </button>
      )}
      <p class="privacy-live-region" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
