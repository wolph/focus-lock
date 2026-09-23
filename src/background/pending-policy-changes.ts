/**
 * The weakening edits a hard lock refused, kept until it allows them.
 *
 * A refused edit is not thrown away and it is not applied either. It waits here and is retried
 * whenever the guard's answer could have changed, so a person does not have to remember what they
 * wanted and make the edit a second time.
 *
 * A list edit is stored as the delta the guard refused rather than as the whole list, because a
 * list the person edits again while the lock runs would make a stored whole list stale: applying
 * it later would silently undo the edit they were allowed to make. A scalar is stored as the
 * value they asked for, and the newest one wins.
 */
import { CATEGORY_IDS } from '../shared/constants';
import type { CategoryId, ListsConfig, Rule, ScheduleEntry, Settings } from '../shared/types';
import type { GuardReasonKey } from './guard';

/** Every list weakening shares one path: one delta carries them and one write saves them. */
export const LISTS_PATH = 'lists';

export type PendingPath =
  | typeof LISTS_PATH
  | 'settings.gate.delayMs'
  | 'settings.gate.requireTypedPhrase'
  | 'settings.pause.earnRatio'
  | 'settings.pause.capMs'
  | 'settings.pause.pauseMs'
  | 'settings.pause.unlockMs'
  | 'settings.defaultStrictness'
  | 'settings.schedule';

export type PendingIntent =
  | { kind: 'value'; value: unknown }
  | {
      kind: 'lists-delta';
      removeCustom: string[];
      addWhitelist: Rule[];
      disableCategories: CategoryId[];
      addExclusions: Partial<Record<CategoryId, string[]>>;
    };

export interface PendingPolicyChange {
  path: PendingPath;
  intent: PendingIntent;
  /** The guard's message key, localised where it is shown rather than where it was refused. */
  reasonKey: GuardReasonKey;
  at: number;
}

const SETTINGS_PATHS: readonly PendingPath[] = [
  'settings.gate.delayMs',
  'settings.gate.requireTypedPhrase',
  'settings.pause.earnRatio',
  'settings.pause.capMs',
  'settings.pause.pauseMs',
  'settings.pause.unlockMs',
  'settings.defaultStrictness',
  'settings.schedule',
];

const PATH_BY_REASON: Record<GuardReasonKey, PendingPath> = {
  notify_guard_lists_remove_blocked: LISTS_PATH,
  notify_guard_lists_add_whitelist: LISTS_PATH,
  notify_guard_lists_disable_category: LISTS_PATH,
  notify_guard_lists_add_exclusion: LISTS_PATH,
  notify_guard_settings_shorten_delay: 'settings.gate.delayMs',
  notify_guard_settings_drop_phrase: 'settings.gate.requireTypedPhrase',
  notify_guard_settings_raise_earn_rate: 'settings.pause.earnRatio',
  notify_guard_settings_raise_cap: 'settings.pause.capMs',
  notify_guard_settings_shorten_pause: 'settings.pause.pauseMs',
  notify_guard_settings_shorten_unlock: 'settings.pause.unlockMs',
  notify_guard_settings_weaken_strictness: 'settings.defaultStrictness',
  notify_guard_settings_schedule_weakened: 'settings.schedule',
};

/** The field one refusal names, which is the field the queue holds the person's answer for. */
export function pathForGuardReason(reason: GuardReasonKey): PendingPath {
  return PATH_BY_REASON[reason];
}

function ruleId(rule: Rule): string {
  return `${rule.kind}:${rule.pattern}`;
}

function ruleIds(rules: readonly Rule[]): Set<string> {
  return new Set(rules.map(ruleId));
}

/** Exactly the four weakening shapes the guard refuses, as a delta over whatever it is applied to. */
export function pendingListsDelta(current: ListsConfig, incoming: ListsConfig): PendingIntent {
  const incomingCustom: Set<string> = ruleIds(incoming.custom);
  const currentWhitelist: Set<string> = ruleIds(current.whitelist);
  const disableCategories: CategoryId[] = CATEGORY_IDS.filter(
    (id: CategoryId): boolean => current.categories[id] && !incoming.categories[id],
  );
  const addExclusions: Partial<Record<CategoryId, string[]>> = {};
  for (const id of CATEGORY_IDS) {
    const before: Set<string> = new Set(current.exclusions[id] ?? []);
    const added: string[] = (incoming.exclusions[id] ?? []).filter(
      (host: string): boolean => !before.has(host),
    );
    if (added.length > 0) addExclusions[id] = added;
  }
  return {
    kind: 'lists-delta',
    removeCustom: current.custom
      .filter((rule: Rule): boolean => !incomingCustom.has(ruleId(rule)))
      .map(ruleId),
    addWhitelist: incoming.whitelist.filter(
      (rule: Rule): boolean => !currentWhitelist.has(ruleId(rule)),
    ),
    disableCategories,
    addExclusions,
  };
}

/** Applies a held list edit to the lists as they stand, so an allowed edit made meanwhile lives. */
export function applyPendingToLists(lists: ListsConfig, intent: PendingIntent): ListsConfig {
  if (intent.kind !== 'lists-delta') return lists;
  const removing: Set<string> = new Set(intent.removeCustom);
  const present: Set<string> = ruleIds(lists.whitelist);
  const categories: Record<CategoryId, boolean> = { ...lists.categories };
  for (const id of intent.disableCategories) categories[id] = false;
  const exclusions: Partial<Record<CategoryId, string[]>> = { ...lists.exclusions };
  for (const id of CATEGORY_IDS) {
    const added: string[] | undefined = intent.addExclusions[id];
    if (added === undefined) continue;
    const before: string[] = exclusions[id] ?? [];
    exclusions[id] = [...before, ...added.filter((host: string): boolean => !before.includes(host))];
  }
  return {
    ...lists,
    custom: lists.custom.filter((rule: Rule): boolean => !removing.has(ruleId(rule))),
    whitelist: [
      ...lists.whitelist,
      ...intent.addWhitelist.filter((rule: Rule): boolean => !present.has(ruleId(rule))),
    ],
    categories,
    exclusions,
  };
}

/** The value a refused settings write asked for, read out of the settings it was refused from. */
export function pendingSettingsValue(settings: Settings, path: PendingPath): unknown {
  switch (path) {
    case 'settings.gate.delayMs':
      return settings.gate.delayMs;
    case 'settings.gate.requireTypedPhrase':
      return settings.gate.requireTypedPhrase;
    case 'settings.pause.earnRatio':
      return settings.pause.earnRatio;
    case 'settings.pause.capMs':
      return settings.pause.capMs;
    case 'settings.pause.pauseMs':
      return settings.pause.pauseMs;
    case 'settings.pause.unlockMs':
      return settings.pause.unlockMs;
    case 'settings.defaultStrictness':
      return settings.defaultStrictness;
    case 'settings.schedule':
      return structuredClone(settings.schedule);
    case LISTS_PATH:
      return null;
  }
}

/** Writes one held scalar back into the settings as they stand now. */
export function applyPendingToSettings(settings: Settings, change: PendingPolicyChange): Settings {
  if (change.intent.kind !== 'value') return settings;
  const value: unknown = change.intent.value;
  switch (change.path) {
    case 'settings.gate.delayMs':
      return { ...settings, gate: { ...settings.gate, delayMs: value as number } };
    case 'settings.gate.requireTypedPhrase':
      return { ...settings, gate: { ...settings.gate, requireTypedPhrase: value as boolean } };
    case 'settings.pause.earnRatio':
      return { ...settings, pause: { ...settings.pause, earnRatio: value as number } };
    case 'settings.pause.capMs':
      return { ...settings, pause: { ...settings.pause, capMs: value as number } };
    case 'settings.pause.pauseMs':
      return { ...settings, pause: { ...settings.pause, pauseMs: value as number } };
    case 'settings.pause.unlockMs':
      return { ...settings, pause: { ...settings.pause, unlockMs: value as number } };
    case 'settings.defaultStrictness':
      return { ...settings, defaultStrictness: value as Settings['defaultStrictness'] };
    case 'settings.schedule':
      return { ...settings, schedule: structuredClone(value) as ScheduleEntry[] };
    case LISTS_PATH:
      return settings;
  }
}

/** One entry per field: a second refusal of the same field is the answer that counts. */
export function capturePendingChange(
  changes: readonly PendingPolicyChange[],
  next: PendingPolicyChange,
): PendingPolicyChange[] {
  return [
    ...changes.filter((change: PendingPolicyChange): boolean => change.path !== next.path),
    next,
  ];
}

function isPendingPath(value: unknown): value is PendingPath {
  return value === LISTS_PATH || SETTINGS_PATHS.includes(value as PendingPath);
}

function isPendingIntent(value: unknown): value is PendingIntent {
  if (typeof value !== 'object' || value === null) return false;
  const kind: unknown = (value as { kind?: unknown }).kind;
  if (kind === 'value') return 'value' in value;
  if (kind !== 'lists-delta') return false;
  const delta = value as Partial<Extract<PendingIntent, { kind: 'lists-delta' }>>;
  return (
    Array.isArray(delta.removeCustom) &&
    Array.isArray(delta.addWhitelist) &&
    Array.isArray(delta.disableCategories) &&
    typeof delta.addExclusions === 'object' &&
    delta.addExclusions !== null
  );
}

/**
 * A stored queue is read on a boot that has to keep working, so anything that does not parse is
 * dropped rather than thrown. A held edit that cannot be read is a held edit that is lost, which
 * is a smaller failure than a worker that will not start.
 */
export function parsePendingChanges(raw: unknown): PendingPolicyChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry: unknown): entry is PendingPolicyChange => {
    if (typeof entry !== 'object' || entry === null) return false;
    const change = entry as Partial<PendingPolicyChange>;
    return (
      isPendingPath(change.path) &&
      isPendingIntent(change.intent) &&
      typeof change.reasonKey === 'string' &&
      typeof change.at === 'number' &&
      Number.isFinite(change.at)
    );
  });
}
