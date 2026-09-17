import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { ALL_CATEGORIES } from '../core/categories';
import { HostBrowser } from '../shared/HostBrowser';
import { t, tPlural } from '../shared/i18n';
import { MODE_LABELS } from '../shared/session-copy';
import type { CategoryId, CategoryList, ListsConfig } from '../shared/types';

export interface StartingListsStepProps {
  lists: ListsConfig;
  pending: boolean;
  onListsChange: (lists: ListsConfig) => void | Promise<void>;
  onContinue: () => void | Promise<void>;
}

/** The sentence with its mode name in bold, wherever the translation places that name. */
function modeRule(text: string, label: string): VNode {
  const start: number = text.indexOf(label);
  if (start < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <strong>{label}</strong>
      {text.slice(start + label.length)}
    </>
  );
}

export function StartingListsStep(props: StartingListsStepProps): VNode {
  const [expanded, setExpanded]: [Set<CategoryId>, Dispatch<StateUpdater<Set<CategoryId>>>] =
    useState<Set<CategoryId>>(new Set<CategoryId>());

  const toggleCategory: (categoryId: CategoryId) => void = (categoryId: CategoryId): void => {
    const lists: ListsConfig = {
      ...props.lists,
      categories: {
        ...props.lists.categories,
        [categoryId]: !props.lists.categories[categoryId],
      },
    };
    void props.onListsChange(lists);
  };

  const toggleExpanded: (categoryId: CategoryId) => void = (categoryId: CategoryId): void => {
    setExpanded((current: Set<CategoryId>): Set<CategoryId> => {
      const next: Set<CategoryId> = new Set<CategoryId>(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  };

  return (
    <section aria-labelledby="starting-lists-heading">
      <h1 id="starting-lists-heading" tabIndex={-1}>
        {t('onboarding_lists_heading')}
      </h1>
      <p>
        {modeRule(
          t('onboarding_lists_blacklist_rule', { MODE: MODE_LABELS.blacklist }),
          MODE_LABELS.blacklist,
        )}{' '}
        {modeRule(
          t('onboarding_lists_whitelist_rule', { MODE: MODE_LABELS.whitelist }),
          MODE_LABELS.whitelist,
        )}
      </p>
      <p>{t('onboarding_lists_defaults_note')}</p>
      <fieldset class="category-list" disabled={props.pending}>
        <legend>{t('onboarding_lists_legend')}</legend>
        {ALL_CATEGORIES.map((category: CategoryList): VNode => {
          const open: boolean = expanded.has(category.id);
          const regionId: string = `category-domains-${category.id}`;
          return (
            <div class="category-card" key={category.id}>
              <div class="category-card-summary">
                <label class="category-choice">
                  <input
                    type="checkbox"
                    checked={props.lists.categories[category.id]}
                    onChange={(): void => toggleCategory(category.id)}
                  />
                  <span>{category.title}</span>
                </label>
                <span class="category-site-count">
                  {tPlural('onboarding_site_count', category.hosts.length)}
                </span>
                <button
                  type="button"
                  class="disclosure-button"
                  aria-expanded={open}
                  aria-controls={regionId}
                  onClick={(): void => toggleExpanded(category.id)}
                >
                  {open
                    ? t('onboarding_hide_category_sites', { CATEGORY: category.title })
                    : t('onboarding_show_category_sites', { CATEGORY: category.title })}
                </button>
              </div>
              {open ? (
                <HostBrowser
                  hosts={category.hosts}
                  title={category.title}
                  regionId={regionId}
                  regionLabel={t('onboarding_category_domains_label', {
                    CATEGORY: category.title,
                  })}
                  regionClass="category-domains-scroll"
                  listClass="category-domains"
                  renderHost={(host: string): VNode => <li key={host}>{host}</li>}
                />
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <button
        type="button"
        class="primary-button"
        disabled={props.pending}
        onClick={(): void => void props.onContinue()}
      >
        {t('onboarding_continue_button')}
      </button>
    </section>
  );
}
