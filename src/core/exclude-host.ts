/**
 * The saved-list edit behind "Exclude this site": what the lists look like once `host` is no
 * longer blocked for good. Pure, so the worker can apply it through its ordinary lists update and
 * a test can read the edit without a worker.
 */
import type { CategoryId, ListsConfig, Rule, SessionMode, Verdict } from '../shared/types';

/** Layered rules are peeled one verdict at a time. Nothing sensible needs more rounds than this. */
const MAX_ROUNDS: number = 8;

/**
 * Allow mode adds the host to the allow list. Block mode asks `verdictFor` why the host is blocked
 * under the candidate lists and removes that reason, then asks again, until the host is allowed or
 * the remaining reason is not in the saved lists (a rule added for this session alone, or a URL
 * pattern that a bare host cannot match). The lists come back unchanged when nothing applies.
 */
export function excludedLists(
  lists: ListsConfig,
  host: string,
  mode: SessionMode,
  verdictFor: (candidate: ListsConfig) => Verdict,
): ListsConfig {
  if (mode === 'whitelist') {
    const listed: boolean = lists.whitelist.some(
      (rule: Rule): boolean => rule.kind === 'host' && rule.pattern === host,
    );
    return listed
      ? lists
      : { ...lists, whitelist: [...lists.whitelist, { kind: 'host', pattern: host }] };
  }
  let next: ListsConfig = lists;
  for (let round: number = 0; round < MAX_ROUNDS; round += 1) {
    const verdict: Verdict = verdictFor(next);
    if (!verdict.blocked) return next;
    const peeled: ListsConfig | null = withoutReason(next, host, verdict);
    if (peeled === null) return next;
    next = peeled;
  }
  return next;
}

/** The lists with one verdict's reason gone, or null when that reason is not theirs to remove. */
function withoutReason(lists: ListsConfig, host: string, verdict: Verdict): ListsConfig | null {
  if (verdict.reason === 'custom' && verdict.matchedPattern !== null) {
    const pattern: string = verdict.matchedPattern;
    const custom: Rule[] = lists.custom.filter((rule: Rule): boolean => rule.pattern !== pattern);
    return custom.length === lists.custom.length ? null : { ...lists, custom };
  }
  if (verdict.reason === 'category' && verdict.categoryId !== null) {
    const id: CategoryId = verdict.categoryId;
    const hosts: string[] = lists.exclusions[id] ?? [];
    if (hosts.includes(host)) return null;
    return { ...lists, exclusions: { ...lists.exclusions, [id]: [...hosts, host] } };
  }
  return null;
}
