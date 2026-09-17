import { t } from './i18n';

export const SYNCED_DATA_ITEMS: readonly string[] = [
  t('shared_synced_settings'),
  t('shared_synced_lists'),
  t('shared_synced_credit'),
  t('shared_synced_streaks'),
  t('shared_synced_aggregates'),
];

/** Shown while the setup record carries `legacy-remote-policy-dropped`. */
export const LEGACY_REMOTE_POLICY_DROPPED_COPY: string = t('shared_legacy_policy_dropped');

/**
 * Shown beside the disabled all-data control while the snapshot holds a session, a gate, or an
 * unlock, and in place of the worker's refusal when a lagging snapshot let the request through.
 * The worker refuses that clear on purpose: a Hard session must not be escapable through a delete
 * button.
 */
export const ALL_DATA_CLEAR_RUNNING_SESSION_COPY: string = t('shared_all_data_clear_running');

/** The worker's own refusal string for an all-data clear over a runtime that is not stopped. */
export const WORKER_ALL_DATA_CLEAR_RUNNING_REFUSAL: string =
  'stop the active session and blocking state before deleting all data';

export const LOCAL_ONLY_DATA_ITEMS: readonly string[] = [
  t('shared_local_full_urls'),
  t('shared_local_intentions'),
  t('shared_local_events'),
  t('shared_local_runtime'),
];
