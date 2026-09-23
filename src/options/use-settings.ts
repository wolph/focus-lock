import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import {
  parsePendingChanges,
  type PendingPath,
  type PendingPolicyChange,
} from '../background/pending-policy-changes';
import { t } from '../shared/i18n';
import type { Ack, ClearFocusLockDataResponse } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import {
  ALL_DATA_CLEAR_RUNNING_SESSION_COPY,
  WORKER_ALL_DATA_CLEAR_RUNNING_REFUSAL,
} from '../shared/privacy-copy';
import { reloadOnceForInvalidSnapshot } from '../shared/reload-once';
import {
  ackError,
  isBootFailureResponse,
  isListsConfig,
  isRetrySyncResponse,
  isSessionSnapshot,
  isSetupState,
  isWebsiteAccessReconciliation,
  parseStoredSettingsV2,
} from '../shared/runtime-validation';
import { DATA_CLEAR_ERROR_COPY } from '../shared/session-copy';
import { LOCAL_PENDING_CHANGES, LOCAL_SETUP } from '../shared/storage-keys';
import { updateTheme } from '../shared/theme';
import type {
  BootFailure,
  ListsConfig,
  SessionSnapshot,
  Settings,
  SetupState,
  StorageMode,
  ThemeMode,
} from '../shared/types';

const LOAD_ERROR: string = t('options_error_load');
const RETRY_BOOT_ERROR: string = t('options_error_retry_boot');

/**
 * The failure that stopped the worker, or null. Asked only after a load failed: a running worker
 * answers null, and a stopped one is the reason the load failed in the first place.
 */
async function loadBootFailure(): Promise<BootFailure | null> {
  try {
    const response: unknown = await sendRequest({ type: 'getBootFailure' });
    return isBootFailureResponse(response) ? response.failure : null;
  } catch {
    return null;
  }
}

type ScheduleMutation = {
  section: 'schedule';
  value: Pick<Settings, 'schedule'>;
};

type BehaviorMutation = {
  section: 'behavior';
  value: Pick<
    Settings,
    | 'presetsMin'
    | 'defaultMode'
    | 'defaultStrictness'
    | 'defaultCycling'
    | 'cyclingOnByDefault'
    | 'gate'
  >;
};

type BudgetMutation = {
  section: 'budget';
  value: Pick<Settings, 'pause' | 'streakGoalMin' | 'streakFreezeIntervalDays' | 'retentionDays'>;
};

type NotificationsMutation = {
  section: 'notifications';
  value: Pick<Settings, 'sounds' | 'badgeCountdown' | 'sessionCompleteNotification'>;
};

export type SettingsMutation =
  | ScheduleMutation
  | BehaviorMutation
  | BudgetMutation
  | NotificationsMutation;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SettingsStore {
  /** null until the initial load resolves */
  settings: Settings | null;
  lists: ListsConfig | null;
  snapshot: SessionSnapshot | null;
  setup: SetupState | null;
  loadError: string | null;
  /** Why the worker did not start, when that is what the load error reports. */
  bootFailure: BootFailure | null;
  /** Weakening edits a hard lock refused and still owes, newest last. */
  pendingChanges: PendingPolicyChange[];
  /** resolves null on success, the worker's rejection string verbatim otherwise */
  saveSettings(mutation: SettingsMutation): Promise<string | null>;
  /** Drops one held edit. Resolves null on success, an error string otherwise. */
  cancelPendingChange(path: PendingPath): Promise<string | null>;
  saveTheme(next: ThemeMode): Promise<string | null>;
  saveLists(next: ListsConfig): Promise<string | null>;
  reconcileWebsiteAccess(): Promise<string | null>;
  setStorageMode(next: StorageMode): Promise<string | null>;
  retrySync(): Promise<string | null>;
  clearData(scope: 'local-history' | 'synced-policy' | 'all'): Promise<string | null>;
  /** Resumes an all-data deletion that ran out of automatic attempts. */
  retryDataClear(): Promise<string | null>;
  /** Runs the worker's boot again after a failure, then loads the page again. */
  retryBoot(): Promise<string | null>;
}

interface WriteQueue {
  current: Promise<void>;
}

function enqueueWrite<T>(queue: WriteQueue, operation: () => Promise<T>): Promise<T> {
  const result: Promise<T> = queue.current.then(operation, operation);
  queue.current = result.then(
    (): void => {},
    (): void => {},
  );
  return result;
}

function applySettingsMutation(current: Settings, mutation: SettingsMutation): Settings {
  switch (mutation.section) {
    case 'schedule':
      return { ...current, ...mutation.value };
    case 'behavior':
      return { ...current, ...mutation.value };
    case 'budget':
      return { ...current, ...mutation.value };
    case 'notifications':
      return { ...current, ...mutation.value };
  }
}

function clearDataError(
  value: unknown,
  scope: 'local-history' | 'synced-policy' | 'all',
): string | null {
  if (!isRecord(value)) return DATA_CLEAR_ERROR_COPY;
  const keys: string[] = Object.keys(value).sort();
  if (
    value.ok === true &&
    keys.join(',') === 'ok,scope,status' &&
    value.scope === scope &&
    value.status === 'cleared'
  ) {
    return null;
  }
  if (
    value.ok === false &&
    keys.join(',') === 'error,ok,scope,status' &&
    typeof value.error === 'string' &&
    /\S/.test(value.error) &&
    value.scope === scope &&
    (value.status === 'pending' || value.status === 'cleared')
  ) {
    // The one refusal a person can act on gets product copy. Every other worker string is the
    // diagnostic the page has always shown verbatim.
    return scope === 'all' && value.error === WORKER_ALL_DATA_CLEAR_RUNNING_REFUSAL
      ? ALL_DATA_CLEAR_RUNNING_SESSION_COPY
      : value.error;
  }
  return DATA_CLEAR_ERROR_COPY;
}

/**
 * The retry answer, read exactly. Anything but the worker's own `ok` is a retry that did not begin,
 * and the copy says so rather than reporting a deletion that resumed when it did not.
 */
function retryDataClearError(value: unknown): string | null {
  if (!isRecord(value)) return DATA_CLEAR_ERROR_COPY;
  const keys: string[] = Object.keys(value).sort();
  if (value.ok === true && keys.join(',') === 'code,ok' && value.code === 'ok') return null;
  return DATA_CLEAR_ERROR_COPY;
}

/**
 * Loads settings, lists, and the session snapshot once, keeps the snapshot
 * live via the stateChanged broadcast, and exposes save calls that only
 * update the store after the worker accepts the write.
 */
export function useSettingsStore(): SettingsStore {
  const [settings, setSettings]: [Settings | null, Dispatch<StateUpdater<Settings | null>>] =
    useState<Settings | null>(null);
  const [lists, setLists]: [ListsConfig | null, Dispatch<StateUpdater<ListsConfig | null>>] =
    useState<ListsConfig | null>(null);
  const [snapshot, setSnapshot]: [
    SessionSnapshot | null,
    Dispatch<StateUpdater<SessionSnapshot | null>>,
  ] = useState<SessionSnapshot | null>(null);
  const [setup, setSetup]: [SetupState | null, Dispatch<StateUpdater<SetupState | null>>] =
    useState<SetupState | null>(null);
  const [loadError, setLoadError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const [bootFailure, setBootFailure]: [
    BootFailure | null,
    Dispatch<StateUpdater<BootFailure | null>>,
  ] = useState<BootFailure | null>(null);
  const [pendingChanges, setPendingChanges]: [
    PendingPolicyChange[],
    Dispatch<StateUpdater<PendingPolicyChange[]>>,
  ] = useState<PendingPolicyChange[]>([]);
  const settingsRef: { current: Settings | null } = useRef<Settings | null>(null);
  /** The initial load, kept so a boot retry can run it again outside the effect that owns it. */
  const reload: { current: () => Promise<void> } = useRef<() => Promise<void>>(
    async (): Promise<void> => undefined,
  );
  const rereadPendingRef: { current: () => Promise<void> } = useRef<() => Promise<void>>(
    async (): Promise<void> => undefined,
  );
  const settingsWrites: WriteQueue = useRef<Promise<void>>(Promise.resolve());
  const listWrites: WriteQueue = useRef<Promise<void>>(Promise.resolve());
  const setupWrites: WriteQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect((): (() => void) => {
    let alive: boolean = true;
    let latestBroadcast: SessionSnapshot | null = null;
    /**
     * A load that failed asks whether the worker started at all. A stopped worker refuses every
     * request with the same reason, and that reason is the more useful error to show, beside the
     * retry that can fix it.
     */
    const failLoad: () => Promise<void> = async (): Promise<void> => {
      const failure: BootFailure | null = await loadBootFailure();
      if (!alive) return;
      setBootFailure(failure);
      setLoadError(
        failure === null ? LOAD_ERROR : `Focus Lock could not start: ${failure.message}`,
      );
    };
    const load: () => Promise<void> = async (): Promise<void> => {
      try {
        const [loadedSettings, loadedLists, loadedSnapshot, loadedSetup, loadedPending]: [
          unknown,
          unknown,
          unknown,
          unknown,
          unknown,
        ] = await Promise.all([
          sendRequest({ type: 'getSettings' }),
          sendRequest({ type: 'getLists' }),
          sendRequest({ type: 'getSnapshot' }),
          sendRequest({ type: 'getSetupState' }),
          sendRequest({ type: 'getPendingChanges' }),
        ]);
        if (!alive) return;
        // A stored or synced v1 schedule entry reads as a window entry through the v2 parser.
        const parsedSettings: Settings | null = parseStoredSettingsV2(loadedSettings);
        if (parsedSettings === null || !isListsConfig(loadedLists) || !isSetupState(loadedSetup)) {
          await failLoad();
          return;
        }
        if (!isSessionSnapshot(loadedSnapshot)) {
          if (reloadOnceForInvalidSnapshot()) return;
          await failLoad();
          return;
        }
        const currentSnapshot: SessionSnapshot = latestBroadcast ?? loadedSnapshot;
        const currentSettings: Settings = { ...parsedSettings, theme: currentSnapshot.theme };
        settingsRef.current = currentSettings;
        setSettings(currentSettings);
        setLists(loadedLists);
        setSnapshot(currentSnapshot);
        setSetup(loadedSetup);
        setPendingChanges(parsePendingChanges((loadedPending as { changes?: unknown } | null)?.changes));
        setBootFailure(null);
        setLoadError(null);
      } catch {
        if (alive) await failLoad();
      }
    };
    reload.current = load;
    void load();
    /**
     * Silent on purpose. `refreshSetup` answers a message for the control the user just pressed,
     * but this reread follows a worker write nobody asked for, so a transient failure keeps the
     * record it already has rather than raising a banner about an action the user did not take.
     */
    const rereadSetup: () => Promise<void> = async (): Promise<void> => {
      try {
        const response: unknown = await sendRequest({ type: 'getSetupState' });
        if (alive && isSetupState(response)) setSetup(response);
      } catch {
        // Keep the record already rendered.
      }
    };
    /**
     * The worker drains the queue on its own, when a lock ends or a boot finds one owed, so the
     * page follows the stored value rather than asking after each of its own writes alone.
     */
    const rereadPending: () => Promise<void> = async (): Promise<void> => {
      try {
        const response: unknown = await sendRequest({ type: 'getPendingChanges' });
        if (!alive) return;
        setPendingChanges(parsePendingChanges((response as { changes?: unknown } | null)?.changes));
      } catch {
        // Keep the record already rendered.
      }
    };
    rereadPendingRef.current = rereadPending;
    const onBroadcast: (message: unknown) => void = (message: unknown): void => {
      if (isRecord(message) && message.type === 'stateChanged') {
        if (!isSessionSnapshot(message.snapshot)) {
          // The page that cannot validate the broadcast reloads once, then keeps what it has.
          reloadOnceForInvalidSnapshot();
          return;
        }
        latestBroadcast = message.snapshot;
        setSnapshot(message.snapshot);
        const theme: ThemeMode = message.snapshot.theme;
        setSettings((current: Settings | null): Settings | null => {
          const next: Settings | null = current === null ? null : { ...current, theme };
          settingsRef.current = next;
          return next;
        });
      }
    };
    chrome.runtime.onMessage.addListener(onBroadcast);
    /**
     * The snapshot is live through `stateChanged`, but the setup record is not, and no
     * `setupChanged` broadcast exists. Settings renders website-access capability, the Chrome Sync
     * write status and the data-clear journal straight out of that record, and all three are
     * written by the worker without this page asking: a revoked host permission, a failed sync
     * publication, and every phase of an all-data clear. Read once, Settings would keep reporting
     * blocking as enabled while enforcement is off, and would never show the retry the person
     * needs. This is the listener `f8d9d25` gave the popup for the same reason.
     */
    const onStored: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void =
      (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
        if (area !== 'local') return;
        if (Object.hasOwn(changes, LOCAL_PENDING_CHANGES)) void rereadPending();
        if (!Object.hasOwn(changes, LOCAL_SETUP)) return;
        void rereadSetup();
      };
    chrome.storage.onChanged.addListener(onStored);
    return (): void => {
      alive = false;
      chrome.runtime.onMessage.removeListener(onBroadcast);
      chrome.storage.onChanged.removeListener(onStored);
    };
  }, []);

  const refreshSetup: () => Promise<string | null> = async (): Promise<string | null> => {
    try {
      const response: unknown = await sendRequest({ type: 'getSetupState' });
      if (!isSetupState(response)) return t('options_error_refresh_privacy');
      setSetup(response);
      return null;
    } catch {
      return t('options_error_refresh_privacy');
    }
  };

  const reconcileWebsiteAccess: () => Promise<string | null> = async (): Promise<string | null> => {
    return enqueueWrite(setupWrites, async (): Promise<string | null> => {
      let error: string | null = null;
      try {
        const response: unknown = await sendRequest({ type: 'reconcileWebsiteAccess' });
        error = isWebsiteAccessReconciliation(response)
          ? response.ok
            ? null
            : response.error
          : t('options_error_website_blocking');
      } catch {
        error = t('options_error_website_blocking');
      }
      const refreshError: string | null = await refreshSetup();
      return error ?? refreshError;
    });
  };

  const setStorageMode: (next: StorageMode) => Promise<string | null> = async (
    next: StorageMode,
  ): Promise<string | null> => {
    return enqueueWrite(setupWrites, async (): Promise<string | null> => {
      let error: string | null = null;
      try {
        const response: unknown = await sendRequest({
          type: 'setStorageMode',
          storageMode: next,
          deleteRemote: false,
        });
        error = ackError(response, t('options_error_change_sync'));
      } catch {
        error = t('options_error_change_sync');
      }
      const refreshError: string | null = await refreshSetup();
      return error ?? refreshError;
    });
  };

  const retrySync: () => Promise<string | null> = async (): Promise<string | null> => {
    return enqueueWrite(setupWrites, async (): Promise<string | null> => {
      let error: string | null = null;
      try {
        const response: unknown = await sendRequest({ type: 'retrySync' });
        error = isRetrySyncResponse(response)
          ? response.ok
            ? null
            : response.error
          : t('options_error_retry_sync');
      } catch {
        error = t('options_error_retry_sync');
      }
      const refreshError: string | null = await refreshSetup();
      return error ?? refreshError;
    });
  };

  const clearData: (scope: 'local-history' | 'synced-policy' | 'all') => Promise<string | null> =
    async (scope: 'local-history' | 'synced-policy' | 'all'): Promise<string | null> => {
      return enqueueWrite(setupWrites, async (): Promise<string | null> => {
        let error: string | null = null;
        try {
          const response: ClearFocusLockDataResponse = await sendRequest({
            type: 'clearFocusLockData',
            scope,
          });
          error = clearDataError(response, scope);
        } catch {
          error = DATA_CLEAR_ERROR_COPY;
        }
        const refreshError: string | null = await refreshSetup();
        return error ?? refreshError;
      });
    };

  const retryBoot: () => Promise<string | null> = async (): Promise<string | null> => {
    return enqueueWrite(setupWrites, async (): Promise<string | null> => {
      let error: string | null = null;
      try {
        error = ackError(await sendRequest({ type: 'retryBoot' }), RETRY_BOOT_ERROR);
      } catch {
        error = RETRY_BOOT_ERROR;
      }
      // Loaded again either way: a worker that started serves the page, and one that did not
      // reports its reason through the same load error as before.
      await reload.current();
      return error;
    });
  };

  const retryDataClear: () => Promise<string | null> = async (): Promise<string | null> => {
    return enqueueWrite(setupWrites, async (): Promise<string | null> => {
      let error: string | null = null;
      try {
        error = retryDataClearError(await sendRequest({ type: 'retryDataClear' }));
      } catch {
        error = DATA_CLEAR_ERROR_COPY;
      }
      const refreshError: string | null = await refreshSetup();
      return error ?? refreshError;
    });
  };

  const saveSettings: (mutation: SettingsMutation) => Promise<string | null> = async (
    mutation: SettingsMutation,
  ): Promise<string | null> => {
    return enqueueWrite(settingsWrites, async (): Promise<string | null> => {
      const current: Settings | null = settingsRef.current;
      if (current === null) return t('options_error_save_settings');
      const requestSettings: Settings = applySettingsMutation(current, mutation);
      const ack: Ack = await sendRequest({ type: 'updateSettings', settings: requestSettings });
      const responseError: string | null = ackError(ack, t('options_error_save_settings'));
      if (responseError !== null) return responseError;
      setSettings((latest: Settings | null): Settings => {
        const accepted: Settings = {
          ...requestSettings,
          theme: latest?.theme ?? requestSettings.theme,
        };
        settingsRef.current = accepted;
        return accepted;
      });
      return null;
    });
  };

  const saveLists: (next: ListsConfig) => Promise<string | null> = async (
    next: ListsConfig,
  ): Promise<string | null> => {
    return enqueueWrite(listWrites, async (): Promise<string | null> => {
      const ack: Ack = await sendRequest({ type: 'updateLists', lists: next });
      const responseError: string | null = ackError(ack, t('options_error_save_lists'));
      if (responseError !== null) return responseError;
      setLists(next);
      return null;
    });
  };

  const cancelPendingChange: (path: PendingPath) => Promise<string | null> = async (
    path: PendingPath,
  ): Promise<string | null> => {
    return enqueueWrite(settingsWrites, async (): Promise<string | null> => {
      const ack: Ack = await sendRequest({ type: 'cancelPendingChange', path });
      const responseError: string | null = ackError(ack, t('options_error_save_settings'));
      await rereadPendingRef.current();
      return responseError;
    });
  };

  const saveTheme: (next: ThemeMode) => Promise<string | null> = async (
    next: ThemeMode,
  ): Promise<string | null> => {
    return enqueueWrite(settingsWrites, async (): Promise<string | null> => {
      const responseError: string | null = await updateTheme(next);
      if (responseError !== null) return responseError;
      setSettings((current: Settings | null): Settings | null => {
        const updated: Settings | null = current === null ? null : { ...current, theme: next };
        settingsRef.current = updated;
        return updated;
      });
      return null;
    });
  };

  return {
    settings,
    lists,
    snapshot,
    setup,
    loadError,
    bootFailure,
    pendingChanges,
    saveSettings,
    cancelPendingChange,
    saveTheme,
    saveLists,
    reconcileWebsiteAccess,
    setStorageMode,
    retrySync,
    clearData,
    retryDataClear,
    retryBoot,
  };
}
