import type { VNode } from 'preact';
import { ALL_CATEGORIES } from '../core/categories';
import { hostRuleCoversHost } from '../core/matcher';
import { HelpPopover } from '../shared/HelpPopover';
import { formatNumber, t, tPlural } from '../shared/i18n';
import type {
  CategoryId,
  CategoryList,
  ListsConfig,
  Rule,
  SessionMode,
  SessionRuleSnapshot,
} from '../shared/types';

/**
 * The two fields this summary reads. Narrower than any caller's draft on purpose, so a
 * caller never has to fabricate a duration or a session type it does not have.
 */
export interface RuleSummaryDraft {
  mode: SessionMode;
  rules: SessionRuleSnapshot;
}

export interface RuleSummaryProps {
  draft: RuleSummaryDraft;
  /**
   * The permanent lists as the person edited them, which is what this summary renders for them.
   * `rulesFromLists` canonicalizes every host on the way into the snapshot, because the runtime
   * validator accepts only the normalized form, so reading `draft.rules.permanentBlacklist` here
   * would show `facebook.com` to someone who typed `Facebook.com` in Settings while Settings itself
   * still showed what they typed. The rules are the same rules: the draft's permanent lists are
   * these lists mapped one to one, in order. Only the session lists come from the draft, and those
   * were normalized by `addDraftAllowHost` as the person added them.
   */
  lists: ListsConfig;
  categoriesEditable: boolean;
  onCategoryToggle: (id: CategoryId) => void;
  onOpenSettings: () => void;
}

/**
 * Why the category toggles refuse. It existed only as a suffix on a page-level alert below the
 * whole form, so a screen reader reading a disabled button was told nothing about it. Named here,
 * beside the buttons it describes, and pointed at by `aria-describedby`.
 */
export const CATEGORIES_LOCKED_COPY: string = t('popup_categories_locked');
const CATEGORIES_LOCKED_ID: string = 'draft-categories-locked';

/**
 * Category membership rows rendered in the popup. A bundled category holds hundreds of hosts and
 * every row here is a popover trigger, so the summary names the first few and counts the rest.
 * Settings is where the whole list is searchable.
 */
const MEMBERSHIP_PREVIEW: number = 8;

function RuleDetail({ kind, pattern }: { kind: 'domain' | 'regex'; pattern: string }): VNode {
  return (
    <HelpPopover
      label={
        kind === 'regex'
          ? t('popup_show_full_regex', { PATTERN: pattern })
          : t('popup_show_full_domain', { PATTERN: pattern })
      }
      triggerClassName="rule-detail"
      triggerContent={<span class="rule-value">{pattern}</span>}
    >
      <span class="rule-detail__full">{pattern}</span>
    </HelpPopover>
  );
}

function RuleValue({ rule }: { rule: Rule }): VNode {
  const kind: 'domain' | 'regex' = rule.kind === 'regex' ? 'regex' : 'domain';
  return (
    <li class="rule-item">
      <span class="rule-kind">
        {kind === 'regex' ? t('popup_rule_kind_regex') : t('popup_rule_kind_domain')}
      </span>
      <RuleDetail kind={kind} pattern={rule.pattern} />
    </li>
  );
}

function scrollRuleList(event: KeyboardEvent): void {
  const region: HTMLElement = event.currentTarget as HTMLElement;
  let delta: number = 0;
  if (event.key === 'ArrowDown') delta = 40;
  else if (event.key === 'ArrowUp') delta = -40;
  else if (event.key === 'PageDown') delta = region.clientHeight;
  else if (event.key === 'PageUp') delta = -region.clientHeight;
  else return;
  event.preventDefault();
  region.scrollTop += delta;
}

function customHostRuleOverridesException(host: string, rules: Rule[]): boolean {
  return rules.some((rule: Rule): boolean => hostRuleCoversHost(rule, host));
}

function BlockRules({
  draft,
  lists,
  categoriesEditable,
  onCategoryToggle,
}: RuleSummaryProps): VNode {
  const extraRules: Rule[] = [...lists.custom, ...draft.rules.sessionBlacklist];
  const exclusionRows: Array<{ category: CategoryList; host: string }> = ALL_CATEGORIES.flatMap(
    (category: CategoryList): Array<{ category: CategoryList; host: string }> =>
      draft.rules.categories[category.id]
        ? (lists.exclusions[category.id] ?? [])
            .filter((host: string): boolean => !customHostRuleOverridesException(host, extraRules))
            .map((host: string): { category: CategoryList; host: string } => ({ category, host }))
        : [],
  );

  return (
    <div class="rule-sections">
      <section class="rule-section" aria-labelledby="draft-categories-heading">
        <h3 id="draft-categories-heading">{t('popup_blocked_categories_heading')}</h3>
        {categoriesEditable ? null : (
          <p id={CATEGORIES_LOCKED_ID} class="radio-hint">
            {CATEGORIES_LOCKED_COPY}
          </p>
        )}
        <div class="draft-categories">
          {ALL_CATEGORIES.map((category: CategoryList): VNode => {
            const enabled: boolean = draft.rules.categories[category.id];
            const exclusions: ReadonlySet<string> = new Set(
              (draft.rules.exclusions[category.id] ?? []).filter(
                (host: string): boolean => !customHostRuleOverridesException(host, extraRules),
              ),
            );
            const effectiveHosts: string[] = category.hosts.filter(
              (host: string): boolean => !exclusions.has(host),
            );
            return (
              <section class="draft-category" key={category.id}>
                <button
                  type="button"
                  class={enabled ? 'draft-category__toggle is-selected' : 'draft-category__toggle'}
                  aria-label={category.title}
                  aria-pressed={enabled}
                  disabled={!categoriesEditable}
                  aria-describedby={categoriesEditable ? undefined : CATEGORIES_LOCKED_ID}
                  onClick={(): void => onCategoryToggle(category.id)}
                >
                  <span>{category.title}</span>
                  <span class="draft-category__count" aria-hidden="true">
                    {tPlural('popup_sites', effectiveHosts.length)}
                  </span>
                </button>
                {enabled ? (
                  <>
                    <ul
                      class="rule-membership"
                      aria-label={t('popup_category_sites_label', { CATEGORY: category.title })}
                    >
                      {effectiveHosts.slice(0, MEMBERSHIP_PREVIEW).map(
                        (host: string): VNode => (
                          <li key={host}>
                            <RuleDetail kind="domain" pattern={host} />
                          </li>
                        ),
                      )}
                    </ul>
                    {effectiveHosts.length > MEMBERSHIP_PREVIEW ? (
                      <p class="rule-membership__more">
                        {tPlural('popup_more_sites', effectiveHosts.length - MEMBERSHIP_PREVIEW)}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </section>
            );
          })}
        </div>
      </section>

      {exclusionRows.length > 0 ? (
        <section class="rule-section" aria-labelledby="draft-exclusions-heading">
          <h3 id="draft-exclusions-heading">{t('popup_allowed_exceptions_heading')}</h3>
          <ul class="rule-list">
            {exclusionRows.map(
              ({ category, host }: { category: CategoryList; host: string }): VNode => (
                <li class="rule-item" key={`${category.id}:${host}`}>
                  <span class="rule-kind">{category.title}</span>
                  <RuleDetail kind="domain" pattern={host} />
                </li>
              ),
            )}
          </ul>
        </section>
      ) : null}

      <section class="rule-section" aria-labelledby="draft-extra-blocked-heading">
        <h3 id="draft-extra-blocked-heading">{t('popup_extra_blocked_heading')}</h3>
        {extraRules.length === 0 ? (
          <p class="rule-empty">{t('popup_no_extra_blocked')}</p>
        ) : (
          <ul class="rule-list">
            {extraRules.map(
              (rule: Rule, index: number): VNode => (
                <RuleValue key={`${rule.kind}:${rule.pattern}:${index}`} rule={rule} />
              ),
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function AllowRules({ draft, lists }: Pick<RuleSummaryProps, 'draft' | 'lists'>): VNode {
  const allowedRules: Rule[] = [...lists.whitelist, ...draft.rules.sessionAllowlist];
  return (
    <section class="rule-section" aria-labelledby="draft-allowed-heading">
      <h3 id="draft-allowed-heading">{t('popup_allowed_heading')}</h3>
      {allowedRules.length === 0 ? (
        <p class="rule-empty">{t('popup_no_allowed_sites')}</p>
      ) : (
        <ul class="rule-list">
          {allowedRules.map(
            (rule: Rule, index: number): VNode => (
              <RuleValue key={`${rule.kind}:${rule.pattern}:${index}`} rule={rule} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

export function RuleSummary(props: RuleSummaryProps): VNode {
  const enabledCount: number = ALL_CATEGORIES.filter(
    (category: CategoryList): boolean => props.draft.rules.categories[category.id],
  ).length;
  const extraBlockedCount: number =
    props.lists.custom.length + props.draft.rules.sessionBlacklist.length;
  const allowedCount: number =
    props.lists.whitelist.length + props.draft.rules.sessionAllowlist.length;

  return (
    <section class="rule-summary" aria-labelledby="rule-summary-heading">
      <div class="rule-summary__heading">
        <h2 id="rule-summary-heading">
          {props.draft.mode === 'blacklist'
            ? t('popup_what_will_be_blocked')
            : t('popup_what_will_be_allowed')}
        </h2>
        {props.draft.mode === 'blacklist' ? (
          <p>
            <span>
              {t('popup_categories_selected', {
                SELECTED: formatNumber(enabledCount),
                TOTAL: formatNumber(ALL_CATEGORIES.length),
              })}
            </span>
            <span>{tPlural('popup_extra_blocked_rules', extraBlockedCount)}</span>
          </p>
        ) : (
          <p>{tPlural('popup_allowed_rules', allowedCount)}</p>
        )}
        <div class="rule-summary__scope">
          <span>
            {props.draft.mode === 'whitelist'
              ? t('popup_scope_whitelist')
              : t('popup_scope_blacklist')}
          </span>
          <button type="button" onClick={props.onOpenSettings}>
            {t('popup_open_settings_defaults')}
          </button>
        </div>
      </div>
      <section
        class="rule-summary__scroll"
        aria-label={t('popup_rule_details_label')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region must receive keyboard scroll commands.
        tabIndex={0}
        onKeyDown={scrollRuleList}
      >
        {props.draft.mode === 'blacklist' ? (
          <BlockRules {...props} />
        ) : (
          <AllowRules draft={props.draft} lists={props.lists} />
        )}
      </section>
    </section>
  );
}
