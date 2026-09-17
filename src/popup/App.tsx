import type { VNode } from 'preact';
import {
  type Dispatch,
  type StateUpdater,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../shared/constants';
import { t, uiLanguage } from '../shared/i18n';
import { sendRequest } from '../shared/messages';
import { WEBSITE_ORIGINS } from '../shared/permissions';
import {
  isAck,
  isBootFailureResponse,
  isListsConfig,
  isSettings,
  isSetupState,
  isWebsiteAccessReconciliation,
} from '../shared/runtime-validation';
import { DATA_CLEAR_ERROR_COPY } from '../shared/session-copy';
import { LOCAL_SETUP } from '../shared/storage-keys';
import { applyTheme } from '../shared/theme';
import type {
  BootFailure,
  ListsConfig,
  SessionSnapshot,
  Settings,
  SetupState,
  ThemeMode,
} from '../shared/types';
import { type WebsiteAccessOutcome, websiteAccessOutcome } from '../shared/website-access-state';
import { ActiveView } from './ActiveView';
import { LifecycleView } from './LifecycleView';
import { CATEGORIES_LOCKED_COPY } from './RuleSummary';
import { type StartFeedback, StartForm } from './StartForm';
import { useSnapshot } from './use-snapshot';

/**
 * The short weekday name in the UI language. Intl carries every locale's own abbreviations, so
 * the footer needs no weekday messages, and a locale Intl refuses leaves the day out entirely,
 * exactly as an out-of-range index did before.
 */
function weekdayName(date: Date): string {
  try {
    return new Intl.DateTimeFormat(uiLanguage(), { weekday: 'short' }).format(date);
  } catch {
    return '';
  }
}

function formatNextSchedule(startsAt: number): string {
  const d: Date = new Date(startsAt);
  const hh: string = String(d.getHours()).padStart(2, '0');
  const mm: string = String(d.getMinutes()).padStart(2, '0');
  return t('popup_next_schedule', { DAY: weekdayName(d), TIME: `${hh}:${mm}` });
}

function PadlockGlyph(): VNode {
  return (
    <svg class="padlock" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" fill="currentColor" />
      <path
        d="M8 10V7a4 4 0 0 1 8 0v3"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      />
    </svg>
  );
}

function Header(): VNode {
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);

  const openSettings: () => Promise<void> = async (): Promise<void> => {
    setError(null);
    setPending(true);
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      setError(t('popup_open_settings_failed'));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <header class="header">
        <PadlockGlyph />
        <h1 class="title">{t('app_name')}</h1>
        <span class="spacer" />
        <button
          type="button"
          class="icon-button"
          aria-label={t('popup_settings_button_label')}
          disabled={pending}
          onClick={(): void => void openSettings()}
        >
          <svg
            class="settings-cog"
            data-icon="settings"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2" />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </header>
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function Footer({ snapshot }: { snapshot: SessionSnapshot }): VNode | null {
  if (snapshot.nextSchedule === null) return null;
  return (
    <footer class="footer">
      {snapshot.nextSchedule !== null ? (
        <span>{formatNextSchedule(snapshot.nextSchedule.startsAt)}</span>
      ) : null}
    </footer>
  );
}

function IdleView({ onStartFeedback }: { onStartFeedback: StartFeedback }): VNode {
  const [settings, setSettings]: [Settings | null, Dispatch<StateUpdater<Settings | null>>] =
    useState<Settings | null>(null);
  const [lists, setLists]: [ListsConfig | null, Dispatch<StateUpdater<ListsConfig | null>>] =
    useState<ListsConfig | null>(null);
  const [loadError, setLoadError]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [listsEditable, setListsEditable]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  useEffect((): void => {
    // Boundary guard: a stub or restarting worker may answer with a
    // rejection object instead of the data. Fall back to defaults so the
    // form still renders, the worker validates everything on start anyway.
    void sendRequest({ type: 'getSettings' })
      .then((s: Settings): void => {
        const valid: boolean = isSettings(s);
        setSettings(valid ? s : DEFAULT_SETTINGS);
        if (!valid) setLoadError(true);
      })
      .catch((): void => {
        setSettings(DEFAULT_SETTINGS);
        setLoadError(true);
      });
    void sendRequest({ type: 'getLists' })
      .then((l: ListsConfig): void => {
        const valid: boolean = isListsConfig(l);
        setLists(valid ? l : DEFAULT_LISTS);
        setListsEditable(valid);
        if (!valid) setLoadError(true);
      })
      .catch((): void => {
        setLists(DEFAULT_LISTS);
        setListsEditable(false);
        setLoadError(true);
      });
  }, []);
  if (settings === null || lists === null) {
    return <section class="view" aria-busy="true" />;
  }
  return (
    <>
      <StartForm
        settings={settings}
        lists={lists}
        categoriesEditable={listsEditable}
        onStartFeedback={onStartFeedback}
      />
      {loadError ? (
        <p class="form-error" role="alert">
          {t('popup_settings_load_failed')}
          {!listsEditable ? ` ${CATEGORIES_LOCKED_COPY}` : ''}
        </p>
      ) : null}
    </>
  );
}

/**
 * The all-data journal the popup must render over every setup gate, or null when no such
 * journal exists. The worker writes DEFAULT_SETUP with the journal attached from the local
 * phase onward, so `completed` is false and `blockingRegistration` is unavailable while the
 * profile is being deleted: reading the journal before those gates is the only way the
 * deleting copy and the exhausted-clear retry are reachable.
 */
function allDataJournal(dataClear: SetupState['dataClear']): SetupState['dataClear'] | null {
  const active: boolean =
    dataClear.scope === 'all' && (dataClear.status === 'pending' || dataClear.status === 'error');
  return active ? dataClear : null;
}

/**
 * One switch from the public lifecycle to the view that owns it. An all-data journal outranks every
 * lifecycle, including idle, because the profile is being deleted and no session may start on top
 * of that. Nothing else disables a start on an idle lifecycle, and no branch offers one while a
 * journal exists.
 */
function Body({
  snapshot,
  now,
  dataClear,
  onStartFeedback,
}: {
  snapshot: SessionSnapshot;
  now: number;
  dataClear: SetupState['dataClear'];
  onStartFeedback: StartFeedback;
}): VNode {
  const journal: SetupState['dataClear'] | null = allDataJournal(dataClear);
  if (journal !== null) {
    return <LifecycleView snapshot={snapshot} now={now} dataClear={journal} />;
  }
  if (snapshot.lifecycle.kind === 'idle') return <IdleView onStartFeedback={onStartFeedback} />;
  if (snapshot.lifecycle.kind === 'active') return <ActiveView snapshot={snapshot} now={now} />;
  return <LifecycleView snapshot={snapshot} now={now} dataClear={dataClear} />;
}

function SetupRequired(): VNode {
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const openSetup: () => Promise<void> = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const response: unknown = await sendRequest({ type: 'openOnboarding' });
      if (!isAck(response)) throw new Error('invalid setup response');
      if (!response.ok) throw new Error(response.error);
    } catch {
      setError(t('popup_open_setup_failed'));
    } finally {
      setPending(false);
    }
  };
  return (
    <section class="view setup-required" aria-labelledby="setup-required-heading">
      <h2 id="setup-required-heading">{t('popup_setup_required_heading')}</h2>
      <p>{t('popup_setup_required_body')}</p>
      <button
        type="button"
        class="start-button"
        disabled={pending}
        onClick={(): void => void openSetup()}
      >
        {t('popup_open_setup_button')}
      </button>
      {error !== null ? (
        <p role="alert" class="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function WebsiteBlockingOff(props: {
  setup: SetupState;
  onReconciled: (setup: SetupState) => void;
}): VNode {
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [attempted, setAttempted]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const actionInFlight: { current: boolean } = useRef<boolean>(false);
  const enableButton: { current: HTMLButtonElement | null } = useRef<HTMLButtonElement>(null);
  const restoreEnableFocus: { current: boolean } = useRef<boolean>(false);
  const denied: boolean = props.setup.websiteAccess === 'denied';
  const registrationError: boolean =
    props.setup.websiteAccess === 'granted' && props.setup.blockingRegistration === 'error';

  useLayoutEffect((): void => {
    if (pending || !restoreEnableFocus.current) return;
    restoreEnableFocus.current = false;
    const active: Element | null = document.activeElement;
    if (active === document.body || active === enableButton.current) {
      enableButton.current?.focus();
    }
  }, [pending]);

  const enable: () => Promise<void> = async (): Promise<void> => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    restoreEnableFocus.current = true;
    setAttempted(true);
    setPending(true);
    setError(null);
    try {
      await chrome.permissions.request({ origins: [...WEBSITE_ORIGINS] });
      const response: unknown = await sendRequest({ type: 'reconcileWebsiteAccess' });
      if (!isWebsiteAccessReconciliation(response)) {
        setError(t('popup_blocking_confirm_failed'));
        return;
      }
      const outcome: WebsiteAccessOutcome = websiteAccessOutcome(response);
      if (outcome.kind === 'ready') {
        props.onReconciled({
          ...props.setup,
          websiteAccess: 'granted',
          blockingRegistration: 'ready',
          websiteAccessNotice: null,
        });
        return;
      }
      if (outcome.kind === 'denied') {
        props.onReconciled({
          ...props.setup,
          websiteAccess: 'denied',
          blockingRegistration: 'unavailable',
        });
        if (outcome.error !== null) setError(outcome.error);
        return;
      }
      if (outcome.kind === 'registration-error') {
        props.onReconciled({
          ...props.setup,
          websiteAccess: 'granted',
          blockingRegistration: 'error',
        });
        setError(outcome.error);
        return;
      }
      setError(outcome.error);
    } catch {
      setError(t('popup_blocking_enable_failed'));
    } finally {
      actionInFlight.current = false;
      setPending(false);
    }
  };

  return (
    <section
      class="view setup-required website-blocking-off"
      aria-labelledby="blocking-off-heading"
    >
      <h2 id="blocking-off-heading">{t('popup_blocking_off_heading')}</h2>
      <p>{t('popup_blocking_off_body')}</p>
      {denied ? <p role="status">{t('popup_blocking_off_denied')}</p> : null}
      {registrationError ? <p role="status">{t('popup_blocking_off_registration_error')}</p> : null}
      <button
        ref={enableButton}
        type="button"
        class="start-button"
        disabled={pending}
        onClick={(): void => void enable()}
      >
        {attempted ? t('popup_retry_button') : t('popup_enable_blocking_button')}
      </button>
      {error !== null ? (
        <p role="alert" class="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function WebsiteAccessNotice(props: {
  notice: Exclude<SetupState['websiteAccessNotice'], null>;
  onDismissed: () => void;
}): VNode {
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const message: string =
    props.notice === 'revoked-during-session'
      ? t('popup_notice_access_revoked')
      : t('popup_notice_blocking_failed');
  const dismiss: () => Promise<void> = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const response: unknown = await sendRequest({ type: 'dismissWebsiteAccessNotice' });
      if (!isAck(response)) {
        setError(t('popup_dismiss_notice_failed'));
        return;
      }
      if (!response.ok) {
        setError(response.error);
        return;
      }
      props.onDismissed();
    } catch {
      setError(t('popup_dismiss_notice_failed'));
    } finally {
      setPending(false);
    }
  };
  return (
    <aside class="website-access-notice" role="status">
      <span>{message}</span>
      <button
        type="button"
        aria-label={t('popup_dismiss_notice_label')}
        disabled={pending}
        onClick={(): void => void dismiss()}
      >
        {t('popup_dismiss_button')}
      </button>
      {error !== null ? <span role="alert">{error}</span> : null}
    </aside>
  );
}

/** The worker did not finish starting. Its setup record carries the overlay that opens this view. */
function bootFailed(setup: SetupState): boolean {
  return setup.storageError === 'boot-failed' || setup.storageError === 'runtime-boot-failed';
}

/** The all-data clear's answer, read exactly. Anything but the worker's own `cleared` is an error. */
function clearAllDataError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return DATA_CLEAR_ERROR_COPY;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  if (record.ok === true && record.scope === 'all' && record.status === 'cleared') return null;
  if (record.ok === false && typeof record.error === 'string' && record.error.trim().length > 0) {
    return record.error;
  }
  return DATA_CLEAR_ERROR_COPY;
}

/**
 * The recovery screen for a worker whose boot failed. The reason comes from the failure channel,
 * which answers while every other request is refused. Retry runs the boot again. The runtime reset
 * is offered only when the stored runtime is what failed, because that is the one stage where
 * parking it costs nothing the person cares about.
 */
function BootFailed(props: { setup: SetupState; onRecovered: () => void }): VNode {
  const [failure, setFailure]: [BootFailure | null, Dispatch<StateUpdater<BootFailure | null>>] =
    useState<BootFailure | null>(null);
  const [reasonUnavailable, setReasonUnavailable]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [confirmingDelete, setConfirmingDelete]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const actionInFlight: { current: boolean } = useRef<boolean>(false);
  const runtimeStage: boolean = props.setup.storageError === 'runtime-boot-failed';

  useEffect((): (() => void) => {
    let alive: boolean = true;
    void sendRequest({ type: 'getBootFailure' })
      .then((response: unknown): void => {
        if (!alive) return;
        if (isBootFailureResponse(response) && response.failure !== null) {
          setFailure(response.failure);
          return;
        }
        setReasonUnavailable(true);
      })
      .catch((): void => {
        if (alive) setReasonUnavailable(true);
      });
    return (): void => {
      alive = false;
    };
  }, []);

  const recover: (request: { type: 'retryBoot' } | { type: 'resetLocalRuntime' }) => Promise<void> =
    async (request: { type: 'retryBoot' } | { type: 'resetLocalRuntime' }): Promise<void> => {
      if (actionInFlight.current) return;
      actionInFlight.current = true;
      setPending(true);
      setError(null);
      try {
        const response: unknown = await sendRequest(request);
        if (!isAck(response)) {
          setError(t('popup_restart_failed'));
          return;
        }
        if (!response.ok) {
          setError(response.error);
          return;
        }
        props.onRecovered();
      } catch {
        setError(t('popup_restart_failed'));
      } finally {
        actionInFlight.current = false;
        setPending(false);
      }
    };

  /**
   * The way out of a profile no retry can fix. The worker clears everything and boots into setup
   * on its own, so a cleared answer means the popup only has to read the record again.
   */
  const deleteAll: () => Promise<void> = async (): Promise<void> => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const response: unknown = await sendRequest({ type: 'clearFocusLockData', scope: 'all' });
      const clearError: string | null = clearAllDataError(response);
      if (clearError !== null) {
        setError(clearError);
        return;
      }
      setConfirmingDelete(false);
      props.onRecovered();
    } catch {
      setError(DATA_CLEAR_ERROR_COPY);
    } finally {
      actionInFlight.current = false;
      setPending(false);
    }
  };

  return (
    <section class="view setup-required boot-failed" aria-labelledby="boot-failed-heading">
      <h2 id="boot-failed-heading">{t('popup_boot_failed_heading')}</h2>
      {failure !== null ? (
        <p role="status">{failure.message}</p>
      ) : reasonUnavailable ? (
        <p role="status">{t('popup_boot_reason_unavailable')}</p>
      ) : null}
      <button
        type="button"
        class="start-button"
        disabled={pending}
        onClick={(): void => void recover({ type: 'retryBoot' })}
      >
        {t('popup_retry_button')}
      </button>
      {runtimeStage ? (
        <>
          <button
            type="button"
            class="secondary-button"
            disabled={pending}
            onClick={(): void => void recover({ type: 'resetLocalRuntime' })}
          >
            {t('popup_reset_runtime_button')}
          </button>
          <p>{t('popup_reset_runtime_note')}</p>
        </>
      ) : null}
      {confirmingDelete ? (
        <div class="boot-failed__confirm">
          <button
            type="button"
            class="danger-button"
            disabled={pending}
            onClick={(): void => void deleteAll()}
          >
            {t('popup_delete_all_confirm_button')}
          </button>
          <button
            type="button"
            class="secondary-button"
            disabled={pending}
            onClick={(): void => setConfirmingDelete(false)}
          >
            {t('popup_keep_data_button')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          class="danger-button"
          disabled={pending}
          onClick={(): void => setConfirmingDelete(true)}
        >
          {t('popup_delete_all_button')}
        </button>
      )}
      {error !== null ? (
        <p role="alert" class="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function App(): VNode {
  /** Bumped after a recovery so the snapshot is read again from the worker that now runs. */
  const [snapshotVersion, setSnapshotVersion]: [number, Dispatch<StateUpdater<number>>] =
    useState<number>(0);
  const {
    error,
    snapshot,
    now,
  }: { snapshot: SessionSnapshot | null; now: number; error: boolean } =
    useSnapshot(snapshotVersion);
  const [theme, setTheme]: [ThemeMode | null, Dispatch<StateUpdater<ThemeMode | null>>] =
    useState<ThemeMode | null>(null);
  const [setup, setSetup]: [SetupState | null, Dispatch<StateUpdater<SetupState | null>>] =
    useState<SetupState | null>(null);
  const [setupError, setSetupError]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  /**
   * A start that succeeded except for its work tab answers after the snapshot has already
   * replaced the form, so the form hands the message up here, where it outlives the form.
   */
  const [startFeedback, setStartFeedback]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const onStartFeedback: StartFeedback = (message: string | null): void => {
    setStartFeedback(message);
  };
  useEffect((): void => {
    if (snapshot?.lifecycle.kind === 'idle') setStartFeedback(null);
  }, [snapshot]);

  /** Guards a read that lands after the popup closed. Set once the effect below is torn down. */
  const disposed: { current: boolean } = useRef<boolean>(false);
  const readSetup: () => void = useCallback((): void => {
    void sendRequest({ type: 'getSetupState' })
      .then((value: SetupState): void => {
        if (disposed.current) return;
        if (!isSetupState(value)) {
          setSetupError(true);
          return;
        }
        setSetupError(false);
        setSetup(value);
      })
      .catch((): void => {
        if (!disposed.current) setSetupError(true);
      });
  }, []);

  useEffect((): (() => void) => {
    disposed.current = false;
    readSetup();
    /**
     * The snapshot is live through the stateChanged broadcast, but the setup record is not, and
     * no setupChanged broadcast exists. A data-clear journal is written straight into that
     * record, and its browser-reset phase is worker-initiated, so a popup that read the record
     * once would keep offering the wrong branch while the profile is being deleted. Every write
     * lands on one local key, so the popup rereads through the worker whenever it changes.
     */
    const onStored: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void =
      (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
        if (area !== 'local' || !Object.hasOwn(changes, LOCAL_SETUP)) return;
        readSetup();
      };
    chrome.storage.onChanged.addListener(onStored);
    return (): void => {
      disposed.current = true;
      chrome.storage.onChanged.removeListener(onStored);
    };
  }, [readSetup]);

  /** A recovery means the worker runs now: the setup record and the snapshot are read again. */
  const onRecovered: () => void = (): void => {
    readSetup();
    setSnapshotVersion((version: number): number => version + 1);
  };

  useEffect((): void => {
    if (snapshot !== null) setTheme(snapshot.theme);
  }, [snapshot]);

  useEffect((): void => {
    if (theme !== null) applyTheme(document.documentElement, theme);
  }, [theme]);

  const journal: SetupState['dataClear'] | null =
    setup === null ? null : allDataJournal(setup.dataClear);
  /**
   * A closure that ended for `website-access-lost` leaves blocking unavailable while its own
   * cleanup or error still needs the user, and Settings tells that user to open the popup and
   * retry. So cleanup and error outrank the website-blocking screen: stale enforcement pixels
   * are not runtime authority, and the retry has to be reachable where the copy promises it.
   */
  const attentionSnapshot: SessionSnapshot | null =
    snapshot !== null &&
    (snapshot.lifecycle.kind === 'cleanup' || snapshot.lifecycle.kind === 'error')
      ? snapshot
      : null;

  return (
    <div class="app">
      <Header />
      {setupError ? (
        <section class="view snapshot-status snapshot-status--retry" role="alert">
          <span>{t('popup_setup_status_unavailable')}</span>
          <button type="button" class="secondary-button" onClick={readSetup}>
            {t('popup_retry_button')}
          </button>
        </section>
      ) : setup === null ? (
        <section class="view" aria-busy="true" />
      ) : journal !== null ? (
        <LifecycleView snapshot={snapshot} now={now} dataClear={journal} />
      ) : bootFailed(setup) ? (
        <BootFailed setup={setup} onRecovered={onRecovered} />
      ) : !setup.completed ? (
        <SetupRequired />
      ) : attentionSnapshot !== null ? (
        <LifecycleView snapshot={attentionSnapshot} now={now} dataClear={setup.dataClear} />
      ) : setup.blockingRegistration !== 'ready' ? (
        <WebsiteBlockingOff setup={setup} onReconciled={setSetup} />
      ) : error ? (
        <section class="view snapshot-status" role="status">
          {t('popup_snapshot_unavailable')}
        </section>
      ) : snapshot === null ? (
        <section class="view" aria-busy="true" />
      ) : (
        <Body
          snapshot={snapshot}
          now={now}
          dataClear={setup.dataClear}
          onStartFeedback={onStartFeedback}
        />
      )}
      {startFeedback !== null ? (
        <p class="view form-error" role="alert">
          {startFeedback}
        </p>
      ) : null}
      {setup?.completed &&
      setup.blockingRegistration !== 'ready' &&
      setup.websiteAccessNotice !== null ? (
        <WebsiteAccessNotice
          notice={setup.websiteAccessNotice}
          onDismissed={(): void => setSetup({ ...setup, websiteAccessNotice: null })}
        />
      ) : null}
      {setup?.completed === true && snapshot !== null ? <Footer snapshot={snapshot} /> : null}
    </div>
  );
}
