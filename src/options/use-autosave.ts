import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import type { SettingsSectionId } from '../shared/SettingsNav';
import type { ListsConfig, Settings } from '../shared/types';
import type { SettingsMutation, SettingsStore } from './use-settings';

/**
 * Settings saves what you change, when you change it.
 *
 * A control shows the value you chose at once and the write follows a short moment later, so a
 * number being typed is one write rather than one per keystroke. A write that the worker refuses
 * puts the control back to the value that is really in force: a control showing a value that is
 * not the one being enforced is the confusion this whole change exists to remove.
 */

/** The destinations a write goes to: one per settings section, plus the lists. */
export type AutosaveDestination = SettingsSectionId | 'lists';

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface AutosaveController {
  settings: Settings | null;
  lists: ListsConfig | null;
  status: AutosaveStatus;
  /** The worker's own rejection for one destination, or null while it has none. */
  errorFor(destination: AutosaveDestination): string | null;
  updateSettings(section: SettingsSectionId, next: Settings): void;
  updateLists(next: ListsConfig): void;
  /** Writes anything still waiting on its debounce, for a page that is about to go away. */
  flush(): Promise<void>;
}

/** Long enough that a typed number is one write, short enough to feel immediate. */
export const AUTOSAVE_DEBOUNCE_MS: number = 400;

export function settingsMutationFor(
  section: SettingsSectionId,
  draft: Settings,
): SettingsMutation | null {
  switch (section) {
    case 'schedule':
      return { section, value: { schedule: structuredClone(draft.schedule) } };
    case 'behavior':
      return {
        section,
        value: {
          presetsMin: [...draft.presetsMin],
          defaultMode: draft.defaultMode,
          defaultStrictness: draft.defaultStrictness,
          defaultCycling: structuredClone(draft.defaultCycling),
          cyclingOnByDefault: draft.cyclingOnByDefault,
          gate: { ...draft.gate },
        },
      };
    case 'budget':
      return {
        section,
        value: {
          pause: { ...draft.pause },
          streakGoalMin: draft.streakGoalMin,
          streakFreezeIntervalDays: draft.streakFreezeIntervalDays,
          retentionDays: draft.retentionDays,
        },
      };
    case 'notifications':
      return {
        section,
        value: {
          sounds: { ...draft.sounds },
          badgeCountdown: draft.badgeCountdown,
          sessionCompleteNotification: draft.sessionCompleteNotification,
        },
      };
    case 'blocking':
    case 'privacy':
      return null;
  }
}

interface PendingWrite {
  timer: ReturnType<typeof setTimeout> | null;
  run: () => Promise<void>;
}

export function useAutosave(store: SettingsStore): AutosaveController {
  const [localSettings, setLocalSettings]: [
    Settings | null,
    Dispatch<StateUpdater<Settings | null>>,
  ] = useState<Settings | null>(null);
  const [localLists, setLocalLists]: [
    ListsConfig | null,
    Dispatch<StateUpdater<ListsConfig | null>>,
  ] = useState<ListsConfig | null>(null);
  const [status, setStatus]: [AutosaveStatus, Dispatch<StateUpdater<AutosaveStatus>>] =
    useState<AutosaveStatus>('idle');
  const [errors, setErrors]: [
    Partial<Record<AutosaveDestination, string | null>>,
    Dispatch<StateUpdater<Partial<Record<AutosaveDestination, string | null>>>>,
  ] = useState<Partial<Record<AutosaveDestination, string | null>>>({});
  const waiting: { current: Map<AutosaveDestination, PendingWrite> } = useRef<
    Map<AutosaveDestination, PendingWrite>
  >(new Map<AutosaveDestination, PendingWrite>());
  /** Destinations with a write in flight, whose value the store must not overwrite under them. */
  const inFlight: { current: Set<AutosaveDestination> } = useRef<Set<AutosaveDestination>>(
    new Set<AutosaveDestination>(),
  );

  // The store is the authority. A destination the person is editing keeps what they typed until
  // its write lands, and everything else follows the worker: a theme, a held edit the worker just
  // applied, or a value another page changed.
  useEffect((): void => {
    const loaded: Settings | null = store.settings;
    if (loaded === null) return;
    setLocalSettings((current: Settings | null): Settings => {
      if (current === null) return loaded;
      const editing: boolean = [...waiting.current.keys(), ...inFlight.current].some(
        (destination: AutosaveDestination): boolean => destination !== 'lists',
      );
      return editing ? { ...current, theme: loaded.theme } : loaded;
    });
  }, [store.settings]);

  useEffect((): void => {
    const loaded: ListsConfig | null = store.lists;
    if (loaded === null) return;
    setLocalLists((current: ListsConfig | null): ListsConfig => {
      if (current === null) return loaded;
      const editing: boolean = waiting.current.has('lists') || inFlight.current.has('lists');
      return editing ? current : loaded;
    });
  }, [store.lists]);

  const runWrite: (destination: AutosaveDestination, write: () => Promise<string | null>) => void =
    (destination: AutosaveDestination, write: () => Promise<string | null>): void => {
      const pending: PendingWrite | undefined = waiting.current.get(destination);
      if (pending?.timer !== null && pending?.timer !== undefined) clearTimeout(pending.timer);
      const run: () => Promise<void> = async (): Promise<void> => {
        waiting.current.delete(destination);
        inFlight.current.add(destination);
        setStatus('saving');
        const error: string | null = await write();
        inFlight.current.delete(destination);
        setErrors(
          (current): Partial<Record<AutosaveDestination, string | null>> => ({
            ...current,
            [destination]: error,
          }),
        );
        setStatus(error === null ? 'saved' : 'error');
        if (error === null) return;
        // Refused or failed: the control goes back to the value the worker is really enforcing.
        if (destination === 'lists') setLocalLists(store.lists);
        else setLocalSettings(store.settings);
      };
      waiting.current.set(destination, {
        timer: setTimeout((): void => {
          void run();
        }, AUTOSAVE_DEBOUNCE_MS),
        run,
      });
    };

  useEffect((): (() => void) => {
    const pending: Map<AutosaveDestination, PendingWrite> = waiting.current;
    return (): void => {
      for (const write of pending.values()) {
        if (write.timer !== null) clearTimeout(write.timer);
      }
    };
  }, []);

  return {
    settings: localSettings,
    lists: localLists,
    status,
    errorFor: (destination: AutosaveDestination): string | null => errors[destination] ?? null,
    updateSettings: (section: SettingsSectionId, next: Settings): void => {
      setLocalSettings(next);
      setStatus('idle');
      const mutation: SettingsMutation | null = settingsMutationFor(section, next);
      if (mutation === null) return;
      runWrite(section, (): Promise<string | null> => store.saveSettings(mutation));
    },
    updateLists: (next: ListsConfig): void => {
      setLocalLists(next);
      setStatus('idle');
      runWrite('lists', (): Promise<string | null> => store.saveLists(next));
    },
    flush: async (): Promise<void> => {
      const pending: PendingWrite[] = [...waiting.current.values()];
      for (const write of pending) {
        if (write.timer !== null) clearTimeout(write.timer);
      }
      await Promise.all(pending.map((write: PendingWrite): Promise<void> => write.run()));
    },
  };
}
