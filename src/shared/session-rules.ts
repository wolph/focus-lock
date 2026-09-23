import { CATEGORY_IDS, rulesFromLists } from './constants';
import type { CategoryId, ListsConfig, SessionRuleSnapshot } from './types';

/**
 * The rules a running session is judged by: the saved lists as they stand now, with the session's
 * own overrides applied over them. A category the popup toggled for this session only is a
 * difference between `categories` and `baselineCategories`, so it survives the baseline moving
 * underneath it. The session lists are session-only by construction and are carried through
 * untouched.
 */
export function composeSessionRules(
  lists: ListsConfig,
  snapshot: SessionRuleSnapshot,
): SessionRuleSnapshot {
  const baseline: SessionRuleSnapshot = rulesFromLists(lists);
  const categories: Record<CategoryId, boolean> = { ...baseline.categories };
  for (const id of CATEGORY_IDS) {
    if (snapshot.categories[id] !== snapshot.baselineCategories[id]) {
      categories[id] = snapshot.categories[id];
    }
  }
  return {
    ...baseline,
    categories,
    sessionBlacklist: structuredClone(snapshot.sessionBlacklist),
    sessionAllowlist: structuredClone(snapshot.sessionAllowlist),
  };
}
