import { describe, expect, it } from 'vitest';
import {
  applyPendingToLists,
  applyPendingToSettings,
  capturePendingChange,
  parsePendingChanges,
  type PendingIntent,
  type PendingPolicyChange,
  pathForGuardReason,
  pendingListsDelta,
  pendingSettingsValue,
} from '../../../src/background/pending-policy-changes';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { ListsConfig, Rule, Settings } from '../../../src/shared/types';

function lists(custom: string[]): ListsConfig {
  return {
    ...DEFAULT_LISTS,
    custom: custom.map((pattern: string): Rule => ({ kind: 'host', pattern })),
  };
}

function change(overrides: Partial<PendingPolicyChange> = {}): PendingPolicyChange {
  return {
    path: 'lists',
    intent: { kind: 'value', value: 1 },
    reasonKey: 'notify_guard_lists_remove_blocked',
    at: 1_000,
    ...overrides,
  };
}

describe('pendingListsDelta', () => {
  it('removes only what was refused, keeping a rule added afterwards', () => {
    const before: ListsConfig = lists(['reddit.com']);
    const refused: ListsConfig = lists([]);
    const delta: PendingIntent = pendingListsDelta(before, refused);

    const laterAllowedEdit: ListsConfig = lists(['reddit.com', 'news.example.com']);
    const applied: ListsConfig = applyPendingToLists(laterAllowedEdit, delta);

    expect(applied.custom.map((rule: Rule): string => rule.pattern)).toEqual([
      'news.example.com',
    ]);
  });

  it('records a disabled category and an added exclusion host', () => {
    const before: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true, news: true },
    };
    const refused: ListsConfig = {
      ...before,
      categories: { ...before.categories, social: false },
      exclusions: { news: ['work.example.com'] },
    };

    const delta: PendingIntent = pendingListsDelta(before, refused);
    const applied: ListsConfig = applyPendingToLists(before, delta);

    expect(applied.categories.social).toBe(false);
    expect(applied.categories.news).toBe(true);
    expect(applied.exclusions.news).toEqual(['work.example.com']);
  });

  it('records an allow-list addition a whitelist session refused', () => {
    const before: ListsConfig = { ...DEFAULT_LISTS, whitelist: [] };
    const refused: ListsConfig = {
      ...DEFAULT_LISTS,
      whitelist: [{ kind: 'host', pattern: 'github.com' }],
    };

    const applied: ListsConfig = applyPendingToLists(before, pendingListsDelta(before, refused));

    expect(applied.whitelist).toEqual([{ kind: 'host', pattern: 'github.com' }]);
  });

  it('leaves a list alone when the refused edit has already been made by hand', () => {
    const before: ListsConfig = lists(['reddit.com']);
    const delta: PendingIntent = pendingListsDelta(before, lists([]));

    expect(applyPendingToLists(lists([]), delta)).toEqual(lists([]));
  });
});

describe('capturePendingChange', () => {
  it('replaces an entry with the same path and keeps the others', () => {
    const first: PendingPolicyChange = change({ path: 'settings.gate.delayMs', at: 1 });
    const other: PendingPolicyChange = change({ path: 'lists', at: 2 });
    const replacement: PendingPolicyChange = change({ path: 'settings.gate.delayMs', at: 3 });

    const queue: PendingPolicyChange[] = capturePendingChange(
      capturePendingChange([first], other),
      replacement,
    );

    expect(queue).toHaveLength(2);
    expect(queue.find((c: PendingPolicyChange): boolean => c.path === 'settings.gate.delayMs')).toBe(
      replacement,
    );
  });
});

describe('settings paths', () => {
  it('maps each settings refusal to the field it names', () => {
    expect(pathForGuardReason('notify_guard_settings_shorten_delay')).toBe('settings.gate.delayMs');
    expect(pathForGuardReason('notify_guard_settings_drop_phrase')).toBe(
      'settings.gate.requireTypedPhrase',
    );
    expect(pathForGuardReason('notify_guard_settings_raise_cap')).toBe('settings.pause.capMs');
    expect(pathForGuardReason('notify_guard_lists_remove_blocked')).toBe('lists');
  });

  it('reads and writes one scalar, leaving every other setting alone', () => {
    const refused: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    };
    const value: unknown = pendingSettingsValue(refused, 'settings.gate.delayMs');

    const applied: Settings = applyPendingToSettings(
      DEFAULT_SETTINGS,
      change({ path: 'settings.gate.delayMs', intent: { kind: 'value', value } }),
    );

    expect(applied.gate.delayMs).toBe(1_000);
    expect({ ...applied, gate: DEFAULT_SETTINGS.gate }).toEqual(DEFAULT_SETTINGS);
  });
});

describe('parsePendingChanges', () => {
  it('returns nothing for a stored value that is not an array', () => {
    expect(parsePendingChanges(undefined)).toEqual([]);
    expect(parsePendingChanges({ path: 'lists' })).toEqual([]);
  });

  it('drops one malformed entry and keeps a valid neighbour', () => {
    const valid: PendingPolicyChange = change();

    expect(parsePendingChanges([{ path: 'lists' }, valid, null])).toEqual([valid]);
  });

  it('drops an entry naming a path this build no longer has', () => {
    expect(parsePendingChanges([change({ path: 'settings.retired.field' } as never)])).toEqual([]);
  });
});
