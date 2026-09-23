export const SYNC_SETTINGS: string = 'settings';
export const SYNC_LISTS: string = 'lists';
const SYNC_LIST_CATEGORY_PREFIX: string = 'lists:category:';
export const SYNC_BANK: string = 'bank';
export const SYNC_STREAK: string = 'streak';

export function syncAggKey(deviceId: string, date: string): string {
  return `agg:${deviceId}:${date}`;
}
export function syncMonthKey(deviceId: string, month: string): string {
  return `aggm:${deviceId}:${month}`;
}

export const LOCAL_RUNTIME: string = 'runtime';
/**
 * The v2 schema marker and the migration checkpoint behind it. The marker is never written alone:
 * one `chrome.storage.local.set` call stores both keys, so a marker can never outlive the
 * checkpoint that explains it and strand a live v1 runtime behind a cutoff it cannot answer.
 */
export const LOCAL_RUNTIME_SCHEMA: string = 'runtimeSchema';
export const LOCAL_RUNTIME_MIGRATION: string = 'runtimeMigration';
/**
 * Diagnostic copy of a runtime value that boot refused or a manual reset parked. Never read back
 * as authority. Removed by the all-data clear.
 */
export const LOCAL_RUNTIME_REJECTED: string = 'runtimeRejected';
export const LOCAL_EVENTS: string = 'events';
/**
 * Weakening edits a hard lock refused, retried whenever the guard's answer could have changed.
 * Local because it is an intention for this profile, not policy any other device should adopt.
 * Removed by the all-data clear.
 */
export const LOCAL_PENDING_CHANGES: string = 'pendingChanges';
export const LOCAL_DEVICE_ID: string = 'deviceId';
export const LOCAL_SYNC_JOURNAL: string = 'syncJournal';
export const LOCAL_FIRST_SYNC_PUBLICATION: string = 'firstSyncPublication';
export const LOCAL_SYNC_QUOTA_EVICTION: string = 'syncQuotaEviction';
export const LOCAL_CACHES: string = 'caches';
export const LOCAL_LISTS_SNAPSHOT: string = 'listsSnapshot';
export const LOCAL_SETUP: string = 'setup';
export const LOCAL_INSTALL_MARKER: string = 'installMarker';
export const LOCAL_ONBOARDING_DRAFT: string = 'onboardingDraft';
export const LOCAL_POLICY_GENERATION_PREFIX: string = 'policyGeneration:';
export const LOCAL_POLICY_COMMIT: string = 'policyCommit';
export const LOCAL_DATA_CLEAR_JOURNAL: string = 'dataClearJournal';
export const LOCAL_AGGREGATE_TOMBSTONES: string = 'aggregateTombstones';
export const LOCAL_AGGREGATE_PRUNE: string = 'aggregatePrune';
export const LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS: string = 'blockedAggregatePublications';
export const LOCAL_SETTINGS: string = 'settings';
export const LOCAL_LISTS: string = 'lists';
export const LOCAL_BANK: string = 'bank';
export const LOCAL_STREAK: string = 'streak';

export const LOCAL_V2_SESSION_AUTHORITY_KEYS: readonly [string, string, string, string, string] = [
  LOCAL_RUNTIME,
  LOCAL_EVENTS,
  LOCAL_DATA_CLEAR_JOURNAL,
  LOCAL_RUNTIME_SCHEMA,
  LOCAL_RUNTIME_MIGRATION,
];

export function syncListCategoryKey(categoryId: string): string {
  return `${SYNC_LIST_CATEGORY_PREFIX}${categoryId}`;
}
