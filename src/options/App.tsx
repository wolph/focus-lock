import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { t } from '../shared/i18n';
import {
  parseSettingsSectionHash,
  SETTINGS_SECTIONS,
  SettingsNav,
  type SettingsSectionId,
} from '../shared/SettingsNav';
import { applyTheme } from '../shared/theme';
import type { ListsConfig, Rule, ScheduleEntry, Settings } from '../shared/types';
import { BehaviorDefaults, PauseEconomy } from './Behavior';
import { Categories } from './Categories';
import { PrivacyData } from './PrivacyData';
import { RulesEditor } from './RulesEditor';
import { Schedule } from './Schedule';
import { SessionStatus } from './SessionStatus';
import { SoundsBadge } from './SoundsBadge';
import {
  type AutosaveController,
  type AutosaveDestination,
  type AutosaveStatus,
  useAutosave,
} from './use-autosave';
import type { SettingsStore } from './use-settings';
import { useSettingsStore } from './use-settings';

interface SectionProps {
  section: SettingsSectionId;
  settings: Settings;
  lists: ListsConfig;
  store: SettingsStore;
  onSettings: (next: Settings) => void;
  onLists: (next: ListsConfig) => void;
}

function BlockingSection(props: SectionProps): VNode {
  return (
    <section>
      <h2>{t('options_blocking_heading')}</h2>
      <p class="help">{t('options_blocking_help')}</p>
      <RulesEditor
        title={t('options_custom_blacklist_title')}
        rules={props.lists.custom}
        onChange={(next: Rule[]): void => {
          props.onLists({ ...props.lists, custom: next });
        }}
      />
      <RulesEditor
        title={t('options_whitelist_title')}
        rules={props.lists.whitelist}
        onChange={(next: Rule[]): void => {
          props.onLists({ ...props.lists, whitelist: next });
        }}
      />
      <div class="lists-categories-section">
        <h3>{t('options_bundled_categories_heading')}</h3>
        <p class="help">{t('options_bundled_categories_help')}</p>
        <Categories lists={props.lists} onChange={props.onLists} />
      </div>
    </section>
  );
}

function ScheduleSection(props: SectionProps): VNode {
  return (
    <section>
      <h2>{t('options_schedule_heading')}</h2>
      <p class="help">{t('options_schedule_help')}</p>
      <Schedule
        entries={props.settings.schedule}
        defaults={props.settings}
        onChange={(next: ScheduleEntry[]): void => {
          props.onSettings({ ...props.settings, schedule: next });
        }}
      />
    </section>
  );
}

function BehaviorSection(props: SectionProps): VNode {
  return (
    <section>
      <h2>{t('options_behavior_heading')}</h2>
      <BehaviorDefaults settings={props.settings} onChange={props.onSettings} />
    </section>
  );
}

function BudgetSection(props: SectionProps): VNode {
  return (
    <section>
      <h2>{t('options_budget_heading')}</h2>
      <PauseEconomy settings={props.settings} onChange={props.onSettings} />
    </section>
  );
}

function NotificationsSection(props: SectionProps): VNode {
  return (
    <section>
      <h2>{t('options_notifications_heading')}</h2>
      <SoundsBadge settings={props.settings} onChange={props.onSettings} />
    </section>
  );
}

/**
 * The load error, with the boot retry beside it when the worker is what did not start. The retry
 * loads the page again on its own, so a second failure lands in the same line with its reason.
 */
function LoadError({ store }: { store: SettingsStore }): VNode {
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [confirmingDelete, setConfirmingDelete]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [actionError, setActionError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const retry: () => Promise<void> = async (): Promise<void> => {
    setPending(true);
    setActionError(null);
    try {
      await store.retryBoot();
    } finally {
      setPending(false);
    }
  };
  /**
   * The way out of a profile no retry can fix. The worker clears everything and boots into setup
   * on its own, so the page only has to load again once the clear answers.
   */
  const deleteAll: () => Promise<void> = async (): Promise<void> => {
    setPending(true);
    setActionError(null);
    try {
      const clearError: string | null = await store.clearData('all');
      if (clearError !== null) {
        setActionError(clearError);
        return;
      }
      setConfirmingDelete(false);
      await store.retryBoot();
    } finally {
      setPending(false);
    }
  };
  return (
    <div class="load-error">
      <p class="save-error" role="alert">
        {actionError ?? store.loadError}
      </p>
      {store.bootFailure !== null ? (
        <div class="load-error__actions">
          <button
            type="button"
            class="secondary"
            disabled={pending}
            onClick={(): void => {
              void retry();
            }}
          >
            {t('options_load_error_retry')}
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                class="danger"
                disabled={pending}
                onClick={(): void => {
                  void deleteAll();
                }}
              >
                {t('options_load_error_delete_all')}
              </button>
              <button
                type="button"
                class="secondary"
                disabled={pending}
                onClick={(): void => setConfirmingDelete(false)}
              >
                {t('options_load_error_keep_data')}
              </button>
            </>
          ) : (
            <button
              type="button"
              class="danger"
              disabled={pending}
              onClick={(): void => setConfirmingDelete(true)}
            >
              {t('options_delete_all_data')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PrivacySection(props: SectionProps): VNode {
  return (
    <section>
      <h2>{t('options_privacy_heading')}</h2>
      {props.store.setup === null ? (
        <p>{t('options_privacy_loading')}</p>
      ) : (
        <PrivacyData
          setup={props.store.setup}
          snapshot={props.store.snapshot}
          onReconcileWebsiteAccess={props.store.reconcileWebsiteAccess}
          onStorageModeChange={props.store.setStorageMode}
          onRetrySync={props.store.retrySync}
          onClearData={props.store.clearData}
          onRetryDataClear={props.store.retryDataClear}
        />
      )}
    </section>
  );
}

function SectionBody(props: SectionProps): VNode {
  switch (props.section) {
    case 'blocking':
      return <BlockingSection {...props} />;
    case 'schedule':
      return <ScheduleSection {...props} />;
    case 'behavior':
      return <BehaviorSection {...props} />;
    case 'budget':
      return <BudgetSection {...props} />;
    case 'notifications':
      return <NotificationsSection {...props} />;
    case 'privacy':
      return <PrivacySection {...props} />;
  }
}

interface SectionPanelsProps {
  section: SettingsSectionId;
  settings: Settings;
  lists: ListsConfig;
  store: SettingsStore;
  autosave: AutosaveController;
}

/**
 * Every section is rendered and all but one hidden, so a change keeps its place when the person
 * moves between them. Each panel writes through on change, and a write the worker refused reports
 * itself above the controls that tried it rather than at the foot of the page.
 */
function SectionPanels(props: SectionPanelsProps): VNode {
  return (
    <>
      {SETTINGS_SECTIONS.map(({ id }: { id: SettingsSectionId }): VNode => {
        const destination: AutosaveDestination = id === 'blocking' ? 'lists' : id;
        const error: string | null = props.autosave.errorFor(destination);
        return (
          <div key={id} data-settings-section={id} hidden={props.section !== id}>
            {error === null ? null : (
              <p class="save-error" role="alert">
                {error}
              </p>
            )}
            <SectionBody
              section={id}
              settings={props.settings}
              lists={props.lists}
              store={props.store}
              onSettings={(next: Settings): void => props.autosave.updateSettings(id, next)}
              onLists={(next: ListsConfig): void => props.autosave.updateLists(next)}
            />
          </div>
        );
      })}
    </>
  );
}

/** The one line that says whether what you changed is stored. */
function AutosaveStatusLine({ status }: { status: AutosaveStatus }): VNode | null {
  if (status === 'idle') return null;
  const message: string =
    status === 'saving'
      ? t('options_autosave_saving')
      : status === 'saved'
        ? t('options_autosave_saved')
        : t('options_autosave_failed');
  return (
    <p class={`autosave-status autosave-status--${status}`} aria-live="polite">
      {message}
    </p>
  );
}

export function App(): VNode {
  const store: SettingsStore = useSettingsStore();
  const autosave: AutosaveController = useAutosave(store);
  const [section, setSection]: [SettingsSectionId, Dispatch<StateUpdater<SettingsSectionId>>] =
    useState<SettingsSectionId>(
      (): SettingsSectionId => parseSettingsSectionHash(window.location.hash),
    );

  useEffect((): (() => void) => {
    const onHashChange: () => void = (): void => {
      setSection(parseSettingsSectionHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return (): void => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect((): void => {
    if (store.settings !== null) applyTheme(document.documentElement, store.settings.theme);
  }, [store.settings]);
  // A page going away takes its debounce with it, so what is waiting is written first.
  useEffect((): (() => void) => {
    const onHide: () => void = (): void => {
      if (document.visibilityState === 'hidden') void autosave.flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return (): void => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [autosave.flush]);

  const settings: Settings | null = autosave.settings;
  const lists: ListsConfig | null = autosave.lists;

  return (
    <div class="options">
      <SettingsNav
        page="options"
        section={section}
        theme={store.settings?.theme ?? null}
        onThemeChange={store.saveTheme}
        onSectionChange={setSection}
      />
      <main class="content">
        <div class="content-body">
          <h1>{t('options_heading')}</h1>
          {store.snapshot === null ? null : <SessionStatus snapshot={store.snapshot} />}
          {store.loadError !== null ? (
            <LoadError store={store} />
          ) : settings === null || lists === null ? (
            <p>{t('options_loading_settings')}</p>
          ) : (
            <>
              <SectionPanels
                section={section}
                settings={settings}
                lists={lists}
                store={store}
                autosave={autosave}
              />
              {section === 'privacy' ? null : <AutosaveStatusLine status={autosave.status} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
