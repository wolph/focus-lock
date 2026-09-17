import type { JSX } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { t } from '../shared/i18n';
import { type StatsBundle, sendRequest } from '../shared/messages';
import { isSetupState } from '../shared/runtime-validation';
import { SettingsNav } from '../shared/SettingsNav';
import { applyTheme } from '../shared/theme';
import type { EventRecord, PauseEconomy, StorageMode } from '../shared/types';
import { Charts } from './Charts';
import { SessionLog } from './SessionLog';
import { Streak } from './Streak';
import { Tiles } from './Tiles';
import {
  type AttemptEventsState,
  type EconomyState,
  type StatsLoadState,
  useAttemptEvents,
  useEconomy,
  useStats,
} from './use-stats';

function partialLoadError(attempts: boolean, economy: boolean): string | null {
  if (attempts && economy) return t('stats_partial_error_both');
  if (attempts) return t('stats_partial_error_attempts');
  if (economy) return t('stats_partial_error_economy');
  return null;
}

type ScopeLoadState =
  | { status: 'loading'; storageMode: null }
  | { status: 'error'; storageMode: null }
  | { status: 'ready'; storageMode: StorageMode };

interface SetupScopeState {
  load: ScopeLoadState;
  retry(): void;
}

type SetupScopeRequest = () => Promise<unknown>;

export function requestSetupScope(
  onSettled: (load: ScopeLoadState) => void,
  request: SetupScopeRequest = (): Promise<unknown> => sendRequest({ type: 'getSetupState' }),
): () => void {
  let active: boolean = true;
  void request()
    .then((setup: unknown): void => {
      if (!active) return;
      if (isSetupState(setup) && setup.completed && setup.storageMode !== null) {
        onSettled({ status: 'ready', storageMode: setup.storageMode });
      } else {
        onSettled({ status: 'error', storageMode: null });
      }
    })
    .catch((): void => {
      if (active) onSettled({ status: 'error', storageMode: null });
    });
  return (): void => {
    active = false;
  };
}

function useSetupScope(): SetupScopeState {
  const [load, setLoad]: [ScopeLoadState, Dispatch<StateUpdater<ScopeLoadState>>] =
    useState<ScopeLoadState>({ status: 'loading', storageMode: null });
  const [attempt, setAttempt]: [number, Dispatch<StateUpdater<number>>] = useState<number>(0);
  useEffect((): (() => void) => requestSetupScope(setLoad), [attempt]);
  return {
    load,
    retry: (): void => {
      setLoad({ status: 'loading', storageMode: null });
      setAttempt((current: number): number => current + 1);
    },
  };
}

function pageScope(storageMode: StorageMode): string {
  return storageMode === 'sync' ? t('stats_scope_synced') : t('stats_scope_local');
}

function ScopeDisclosure(props: SetupScopeState): JSX.Element {
  const error: boolean = props.load.status === 'error';
  return (
    <div aria-atomic="true" class={`page-scope${error ? ' page-scope-error' : ''}`} role="status">
      <span>
        {props.load.status === 'ready'
          ? pageScope(props.load.storageMode)
          : props.load.status === 'loading'
            ? t('stats_scope_checking')
            : t('stats_scope_unavailable')}
      </span>
      {error ? (
        <button type="button" class="scope-retry" onClick={props.retry}>
          {t('stats_scope_retry')}
        </button>
      ) : null}
    </div>
  );
}

export function App(): JSX.Element {
  const stats: StatsLoadState = useStats();
  const economyState: EconomyState = useEconomy();
  const attempts: AttemptEventsState = useAttemptEvents();
  const bundle: StatsBundle | null = stats.bundle;
  const economy: PauseEconomy = economyState.economy;
  const events: EventRecord[] | null = attempts.events;
  const partialError: string | null = partialLoadError(attempts.error, economyState.error);
  const setupScope: SetupScopeState = useSetupScope();
  const now: number = Date.now();

  useEffect((): void => {
    if (economyState.theme !== null) applyTheme(document.documentElement, economyState.theme);
  }, [economyState.theme]);

  return (
    <div class="stats-shell">
      <SettingsNav page="stats" theme={economyState.theme} onThemeChange={economyState.saveTheme} />
      <main class="stats-page">
        <header class="page-header">
          <h1>{t('stats_page_title')}</h1>
          <ScopeDisclosure {...setupScope} />
        </header>
        {stats.error ? (
          <p class="empty-line" role="alert">
            {t('stats_load_error')}
          </p>
        ) : bundle === null ? (
          <p class="empty-line">{t('stats_loading')}</p>
        ) : (
          <>
            {partialError === null ? null : (
              <p class="empty-line" role="alert">
                {partialError}
              </p>
            )}
            <Tiles bundle={bundle} economy={economy} now={now} />
            <Streak streak={bundle.streak} now={now} />
            <Charts bundle={bundle} events={events} now={now} />
            <SessionLog events={bundle.recentSessions} />
          </>
        )}
      </main>
    </div>
  );
}
