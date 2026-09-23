import { describe, expect, it } from 'vitest';
import { rulesFromLists } from '../../../src/shared/constants';
import { composeSessionRules } from '../../../src/shared/session-rules';
import type { ListsConfig, SessionRuleSnapshot } from '../../../src/shared/types';

function lists(overrides: Partial<ListsConfig> = {}): ListsConfig {
  return {
    custom: [],
    whitelist: [],
    categories: {
      social: true,
      video: false,
      news: false,
      shopping: false,
      gaming: false,
      forums: false,
      mail: false,
    },
    exclusions: {},
    ...overrides,
  };
}

describe('composeSessionRules', () => {
  it('takes rules the saved lists gained after the session started', () => {
    const snapshot: SessionRuleSnapshot = rulesFromLists(lists());
    const saved: ListsConfig = lists({ custom: [{ kind: 'host', pattern: 'reddit.com' }] });

    const composed: SessionRuleSnapshot = composeSessionRules(saved, snapshot);

    expect(composed.permanentBlacklist).toEqual([{ kind: 'host', pattern: 'reddit.com' }]);
  });

  it('keeps a session-only category override over a moved baseline', () => {
    const started: ListsConfig = lists();
    const snapshot: SessionRuleSnapshot = {
      ...rulesFromLists(started),
      categories: { ...rulesFromLists(started).categories, video: true },
    };
    const saved: ListsConfig = lists({
      categories: { ...started.categories, news: true },
    });

    const composed: SessionRuleSnapshot = composeSessionRules(saved, snapshot);

    expect(composed.categories.video).toBe(true);
    expect(composed.categories.news).toBe(true);
    expect(composed.baselineCategories.video).toBe(false);
  });

  it('drops a saved rule the session started with once the lists lose it', () => {
    const started: ListsConfig = lists({ custom: [{ kind: 'host', pattern: 'reddit.com' }] });
    const snapshot: SessionRuleSnapshot = rulesFromLists(started);

    const composed: SessionRuleSnapshot = composeSessionRules(lists(), snapshot);

    expect(composed.permanentBlacklist).toEqual([]);
  });

  it('carries the session-only lists through unchanged', () => {
    const snapshot: SessionRuleSnapshot = {
      ...rulesFromLists(lists()),
      sessionAllowlist: [{ kind: 'host', pattern: 'docs.example.com' }],
      sessionBlacklist: [{ kind: 'host', pattern: 'news.example.com' }],
    };

    const composed: SessionRuleSnapshot = composeSessionRules(lists(), snapshot);

    expect(composed.sessionAllowlist).toEqual([{ kind: 'host', pattern: 'docs.example.com' }]);
    expect(composed.sessionBlacklist).toEqual([{ kind: 'host', pattern: 'news.example.com' }]);
  });

  it('canonicalises what the saved lists hold', () => {
    const composed: SessionRuleSnapshot = composeSessionRules(
      lists({ custom: [{ kind: 'host', pattern: 'Facebook.com' }] }),
      rulesFromLists(lists()),
    );

    expect(composed.permanentBlacklist).toEqual([{ kind: 'host', pattern: 'facebook.com' }]);
  });
});
