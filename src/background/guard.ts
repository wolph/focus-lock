import { t } from '../shared/i18n';
import type {
  ListsConfig,
  Rule,
  ScheduleEntry,
  SessionMode,
  SessionState,
  Settings,
  Strictness,
} from '../shared/types';

/**
 * Weakening guard for hard sessions. Additive edits always pass, edits
 * that would unlock something mid-session are rejected with a
 * user-facing reason. Friction sessions and idle allow everything.
 * Null means allowed, a string is the rejection reason.
 */

function ruleIds(rules: Rule[]): Set<string> {
  return new Set(rules.map((r: Rule): string => `${r.kind}:${r.pattern}`));
}

function removedAny(current: Rule[], incoming: Rule[]): boolean {
  const next: Set<string> = ruleIds(incoming);
  return [...ruleIds(current)].some((id: string): boolean => !next.has(id));
}

function addedAny(current: Rule[], incoming: Rule[]): boolean {
  return removedAny(incoming, current);
}

function isHard(session: SessionState | null): boolean {
  return session !== null && session.config.strictness === 'hard';
}

const STRICTNESS_STRENGTH: Record<Strictness, number> = {
  flexible: 0,
  friction: 1,
  hard: 2,
};

function strictnessWeakened(current: Strictness, incoming: Strictness): boolean {
  return STRICTNESS_STRENGTH[incoming] < STRICTNESS_STRENGTH[current];
}

export function listsChangeAllowed(
  session: SessionState | null,
  mode: SessionMode | null,
  current: ListsConfig,
  incoming: ListsConfig,
): string | null {
  if (!isHard(session)) return null;
  if (mode === 'blacklist' && removedAny(current.custom, incoming.custom)) {
    return t('notify_guard_lists_remove_blocked');
  }
  if (mode === 'whitelist' && addedAny(current.whitelist, incoming.whitelist)) {
    return t('notify_guard_lists_add_whitelist');
  }
  for (const [id, enabled] of Object.entries(current.categories)) {
    if (
      mode === 'blacklist' &&
      enabled &&
      incoming.categories[id as keyof ListsConfig['categories']] === false
    ) {
      return t('notify_guard_lists_disable_category');
    }
  }
  for (const [id, hosts] of Object.entries(incoming.exclusions)) {
    const before: Set<string> = new Set(
      current.exclusions[id as keyof ListsConfig['categories']] ?? [],
    );
    if (mode === 'blacklist' && (hosts ?? []).some((h: string): boolean => !before.has(h))) {
      return t('notify_guard_lists_add_exclusion');
    }
  }
  return null;
}

function scheduleWeakened(
  sourceEntryId: string | null,
  current: ScheduleEntry[],
  incoming: ScheduleEntry[],
): boolean {
  if (sourceEntryId === null) return false;
  const before: ScheduleEntry | undefined = current.find(
    (e: ScheduleEntry): boolean => e.id === sourceEntryId,
  );
  if (before === undefined) return false;
  const after: ScheduleEntry | undefined = incoming.find(
    (e: ScheduleEntry): boolean => e.id === sourceEntryId,
  );
  if (after === undefined) return true;
  if (before.enabled && !after.enabled) return true;
  if (before.days.some((day: number): boolean => !after.days.includes(day))) return true;
  if (after.start > before.start || after.end < before.end) return true;
  return strictnessWeakened(before.strictness, after.strictness);
}

export function settingsChangeAllowed(
  session: SessionState | null,
  current: Settings,
  incoming: Settings,
): string | null {
  if (!isHard(session)) return null;
  if (strictnessWeakened(current.defaultStrictness, incoming.defaultStrictness)) {
    return t('notify_guard_settings_weaken_strictness');
  }
  if (incoming.gate.delayMs < current.gate.delayMs) {
    return t('notify_guard_settings_shorten_delay');
  }
  if (current.gate.requireTypedPhrase && !incoming.gate.requireTypedPhrase) {
    return t('notify_guard_settings_drop_phrase');
  }
  if (incoming.pause.earnRatio > current.pause.earnRatio) {
    return t('notify_guard_settings_raise_earn_rate');
  }
  if (incoming.pause.capMs > current.pause.capMs) {
    return t('notify_guard_settings_raise_cap');
  }
  if (incoming.pause.pauseMs < current.pause.pauseMs) {
    return t('notify_guard_settings_shorten_pause');
  }
  if (incoming.pause.unlockMs < current.pause.unlockMs) {
    return t('notify_guard_settings_shorten_unlock');
  }
  if (
    scheduleWeakened(
      session?.config.scheduleOccurrence?.entryId ?? null,
      current.schedule,
      incoming.schedule,
    )
  ) {
    return t('notify_guard_settings_schedule_weakened');
  }
  return null;
}
