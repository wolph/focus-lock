import { describe, expect, it } from 'vitest';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import { excludedLists } from '../../../src/core/exclude-host';
import { compileMatcher, evaluateUrl } from '../../../src/core/matcher';
import { DEFAULT_LISTS } from '../../../src/shared/constants';
import type { ListsConfig, SessionMode, Verdict } from '../../../src/shared/types';

const NOW: number = 1_700_000_000_000;

function verdictFor(host: string, mode: SessionMode): (lists: ListsConfig) => Verdict {
  return (lists: ListsConfig): Verdict =>
    evaluateUrl(compileMatcher(lists, ALL_CATEGORIES, mode), `https://${host}/`, [], NOW);
}

function lists(overrides: Partial<ListsConfig>): ListsConfig {
  return { ...structuredClone(DEFAULT_LISTS), ...overrides };
}

describe('excludedLists', () => {
  it('removes the block rule the host matched', () => {
    const before: ListsConfig = lists({
      custom: [
        { kind: 'host', pattern: 'blocked.example' },
        { kind: 'host', pattern: 'other.example' },
      ],
    });

    const after: ListsConfig = excludedLists(
      before,
      'blocked.example',
      'blacklist',
      verdictFor('blocked.example', 'blacklist'),
    );

    expect(after.custom).toEqual([{ kind: 'host', pattern: 'other.example' }]);
    expect(verdictFor('blocked.example', 'blacklist')(after).blocked).toBe(false);
    expect(before.custom).toHaveLength(2);
  });

  it('records a category exclusion when a category brought the host', () => {
    const before: ListsConfig = lists({
      categories: { ...DEFAULT_LISTS.categories, social: true },
    });
    expect(verdictFor('facebook.com', 'blacklist')(before)).toMatchObject({
      blocked: true,
      reason: 'category',
      categoryId: 'social',
    });

    const after: ListsConfig = excludedLists(
      before,
      'facebook.com',
      'blacklist',
      verdictFor('facebook.com', 'blacklist'),
    );

    expect(after.exclusions.social).toEqual(['facebook.com']);
    expect(after.custom).toEqual(before.custom);
    expect(verdictFor('facebook.com', 'blacklist')(after).blocked).toBe(false);
  });

  it('peels a block rule and a category one after the other', () => {
    const before: ListsConfig = lists({
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
      categories: { ...DEFAULT_LISTS.categories, social: true },
    });

    const after: ListsConfig = excludedLists(
      before,
      'facebook.com',
      'blacklist',
      verdictFor('facebook.com', 'blacklist'),
    );

    expect(after.custom).toEqual([]);
    expect(after.exclusions.social).toEqual(['facebook.com']);
    expect(verdictFor('facebook.com', 'blacklist')(after).blocked).toBe(false);
  });

  it('adds the host to the allow list when the session allows selected sites only', () => {
    const before: ListsConfig = lists({ whitelist: [{ kind: 'host', pattern: 'docs.example' }] });

    const after: ListsConfig = excludedLists(
      before,
      'blocked.example',
      'whitelist',
      verdictFor('blocked.example', 'whitelist'),
    );

    expect(after.whitelist).toEqual([
      { kind: 'host', pattern: 'docs.example' },
      { kind: 'host', pattern: 'blocked.example' },
    ]);
    expect(verdictFor('blocked.example', 'whitelist')(after).blocked).toBe(false);
    expect(excludedLists(after, 'blocked.example', 'whitelist', verdictFor('x', 'whitelist'))).toBe(
      after,
    );
  });

  it('leaves the lists alone when the host is not blocked, or blocked by something not theirs', () => {
    const open: ListsConfig = lists({});
    expect(
      excludedLists(open, 'free.example', 'blacklist', verdictFor('free.example', 'blacklist')),
    ).toBe(open);

    // A verdict the saved lists cannot explain, such as a rule this session added on its own.
    const sessionOnly: (candidate: ListsConfig) => Verdict = (): Verdict => ({
      blocked: true,
      reason: 'custom',
      categoryId: null,
      matchedPattern: 'session.example',
    });
    expect(excludedLists(open, 'session.example', 'blacklist', sessionOnly)).toBe(open);
  });
});
