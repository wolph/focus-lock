import { t } from './i18n';
import type { CategoryId, Verdict } from './types';

const CATEGORY_KEYS: Readonly<Record<CategoryId, Parameters<typeof t>[0]>> = {
  social: 'shared_category_social',
  video: 'shared_category_video',
  news: 'shared_category_news',
  mail: 'shared_category_mail',
  shopping: 'shared_category_shopping',
  gaming: 'shared_category_gaming',
  forums: 'shared_category_forums',
};

/** The translated display name of one blocking category. */
export function categoryLabel(id: CategoryId): string {
  return t(CATEGORY_KEYS[id]);
}

function withPattern(label: string, matchedPattern: string | null): string {
  return matchedPattern === null
    ? label
    : t('shared_verdict_with_pattern', { LABEL: label, PATTERN: matchedPattern });
}

/** Human-readable explanation for an authoritative worker verdict. */
export function verdictLabel(verdict: Verdict): string {
  if (verdict.blocked) {
    if (verdict.reason === 'category' && verdict.categoryId !== null) {
      return withPattern(
        t('shared_verdict_blocked_category', { CATEGORY: categoryLabel(verdict.categoryId) }),
        verdict.matchedPattern,
      );
    }
    if (verdict.reason === 'custom') {
      return withPattern(t('shared_verdict_blocked_custom'), verdict.matchedPattern);
    }
    if (verdict.reason === 'whitelist-miss') return t('shared_verdict_whitelist_miss');
    return t('shared_verdict_blocked_session');
  }
  if (verdict.reason === 'whitelist') {
    return withPattern(t('shared_verdict_allow_list'), verdict.matchedPattern);
  }
  if (verdict.reason === 'always-allow') return t('shared_verdict_always_allowed');
  if (verdict.reason === 'unlock') return t('shared_verdict_unlock');
  if (verdict.reason === 'excluded') return t('shared_verdict_excluded');
  if (verdict.reason === 'no-session') return t('shared_verdict_no_session');
  return t('shared_verdict_allowed_session');
}
