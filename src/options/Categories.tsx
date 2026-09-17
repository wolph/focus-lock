import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import { ALL_CATEGORIES } from '../core/categories';
import { HostBrowser } from '../shared/HostBrowser';
import { formatNumber, t, tPlural } from '../shared/i18n';
import type { CategoryId, CategoryList, ListsConfig } from '../shared/types';

export interface CategoriesProps {
  lists: ListsConfig;
  onChange: (next: ListsConfig) => void;
}

/**
 * One row per bundled category: toggle, title, entry count, expander.
 * Expanded rows list every host with a checkbox. Unchecked hosts land in
 * lists.exclusions so a single site stays available while the category
 * blocks. Exclusions survive the category being toggled off.
 */
export function Categories(props: CategoriesProps): VNode {
  const [expanded, setExpanded]: [Set<CategoryId>, Dispatch<StateUpdater<Set<CategoryId>>>] =
    useState<Set<CategoryId>>(new Set());
  const [announcement, setAnnouncement]: [string, Dispatch<StateUpdater<string>>] =
    useState<string>('');

  const toggleCategory: (id: CategoryId, on: boolean) => void = (
    id: CategoryId,
    on: boolean,
  ): void => {
    const title: string =
      ALL_CATEGORIES.find((category: CategoryList): boolean => category.id === id)?.title ?? id;
    setAnnouncement(
      on
        ? t('options_category_on_announcement', { CATEGORY: title })
        : t('options_category_off_announcement', { CATEGORY: title }),
    );
    props.onChange({
      ...props.lists,
      categories: { ...props.lists.categories, [id]: on },
    });
  };

  const setAllCategories: (enabled: boolean) => void = (enabled: boolean): void => {
    const categories: Record<CategoryId, boolean> = { ...props.lists.categories };
    ALL_CATEGORIES.forEach((category: CategoryList): void => {
      categories[category.id] = enabled;
    });
    setAnnouncement(
      enabled
        ? t('options_all_categories_on_announcement')
        : t('options_all_categories_off_announcement'),
    );
    props.onChange({ ...props.lists, categories });
  };

  const toggleHost: (id: CategoryId, host: string, active: boolean) => void = (
    id: CategoryId,
    host: string,
    active: boolean,
  ): void => {
    const current: string[] = props.lists.exclusions[id] ?? [];
    const next: string[] = active
      ? current.filter((h: string): boolean => h !== host)
      : [...current, host];
    setAnnouncement(
      active
        ? t('options_host_included_announcement', { HOST: host })
        : t('options_host_kept_available_announcement', { HOST: host }),
    );
    props.onChange({
      ...props.lists,
      exclusions: { ...props.lists.exclusions, [id]: next },
    });
  };

  const setAllHosts: (category: CategoryList, active: boolean) => void = (
    category: CategoryList,
    active: boolean,
  ): void => {
    const current: string[] = props.lists.exclusions[category.id] ?? [];
    const bundledHosts: Set<string> = new Set(category.hosts);
    const next: string[] = active
      ? [...new Set(current.filter((host: string): boolean => !bundledHosts.has(host)))]
      : [...new Set([...current, ...category.hosts])];
    setAnnouncement(
      active
        ? t('options_all_sites_included_announcement', { CATEGORY: category.title })
        : t('options_all_sites_kept_available_announcement', { CATEGORY: category.title }),
    );
    props.onChange({
      ...props.lists,
      exclusions: { ...props.lists.exclusions, [category.id]: next },
    });
  };

  const toggleExpanded: (id: CategoryId) => void = (id: CategoryId): void => {
    const next: Set<CategoryId> = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpanded(next);
  };

  const allCategoriesSelected: boolean = ALL_CATEGORIES.every(
    (category: CategoryList): boolean => props.lists.categories[category.id],
  );
  const allCategoriesDeselected: boolean = ALL_CATEGORIES.every(
    (category: CategoryList): boolean => !props.lists.categories[category.id],
  );
  const selectedCategoryCount: number = ALL_CATEGORIES.filter(
    (category: CategoryList): boolean => props.lists.categories[category.id],
  ).length;
  const deselectedCategoryCount: number = ALL_CATEGORIES.length - selectedCategoryCount;

  return (
    <div class="categories">
      <p class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <fieldset class="cat-bulk-actions" aria-label={t('options_category_bulk_actions_aria')}>
        <span class="selection-count selected">
          {t('options_selected_count', { COUNT: formatNumber(selectedCategoryCount) })}
        </span>
        <span class="selection-count deselected">
          {t('options_deselected_count', { COUNT: formatNumber(deselectedCategoryCount) })}
        </span>
        <span class="spacer" />
        <button
          type="button"
          class="ghost"
          aria-label={t('options_select_all_categories_aria')}
          disabled={allCategoriesSelected}
          onClick={(): void => {
            setAllCategories(true);
          }}
        >
          {t('options_select_all')}
        </button>
        <button
          type="button"
          class="ghost"
          aria-label={t('options_deselect_all_categories_aria')}
          disabled={allCategoriesDeselected}
          onClick={(): void => {
            setAllCategories(false);
          }}
        >
          {t('options_deselect_all')}
        </button>
      </fieldset>

      {ALL_CATEGORIES.map((category: CategoryList): VNode => {
        const enabled: boolean = props.lists.categories[category.id];
        const excluded: string[] = props.lists.exclusions[category.id] ?? [];
        const excludedHosts: Set<string> = new Set(excluded);
        const deselectedHostCount: number = category.hosts.filter((host: string): boolean =>
          excludedHosts.has(host),
        ).length;
        const selectedHostCount: number = category.hosts.length - deselectedHostCount;
        const open: boolean = expanded.has(category.id);
        const allHostsSelected: boolean = category.hosts.every(
          (host: string): boolean => !excluded.includes(host),
        );
        const allHostsDeselected: boolean = category.hosts.every((host: string): boolean =>
          excluded.includes(host),
        );
        return (
          <div key={category.id}>
            <div class="cat-row">
              <label class="check">
                <input
                  type="checkbox"
                  checked={enabled}
                  onClick={(): void => {
                    toggleCategory(category.id, !enabled);
                  }}
                />
                {category.title}
              </label>
              <span class="selection-count selected">
                {t('options_selected_count', { COUNT: formatNumber(selectedHostCount) })}
              </span>
              <span class="selection-count deselected">
                {t('options_deselected_count', { COUNT: formatNumber(deselectedHostCount) })}
              </span>
              <span class="spacer" />
              <button
                type="button"
                class="ghost"
                aria-expanded={open}
                onClick={(): void => {
                  toggleExpanded(category.id);
                }}
              >
                {open
                  ? t('options_hide_category_sites', { CATEGORY: category.title })
                  : t('options_show_category_sites', { CATEGORY: category.title })}
              </button>
            </div>
            <p class="category-state">
              {enabled ? (
                tPlural('options_category_sites_included', selectedHostCount)
              ) : (
                <>
                  <strong>{t('options_category_off')}</strong>
                  <span>{tPlural('options_included_when_enabled', selectedHostCount)}</span>
                </>
              )}
            </p>
            {open ? (
              <div>
                <p class="help">{t('options_category_uncheck_help')}</p>
                <fieldset
                  class="cat-bulk-actions cat-site-actions"
                  aria-label={t('options_category_site_bulk_actions_aria', {
                    CATEGORY: category.title,
                  })}
                >
                  <button
                    type="button"
                    class="ghost"
                    aria-label={t('options_select_all_category_sites_aria', {
                      CATEGORY: category.title,
                    })}
                    disabled={allHostsSelected}
                    onClick={(): void => {
                      setAllHosts(category, true);
                    }}
                  >
                    {t('options_select_all')}
                  </button>
                  <button
                    type="button"
                    class="ghost"
                    aria-label={t('options_deselect_all_category_sites_aria', {
                      CATEGORY: category.title,
                    })}
                    disabled={allHostsDeselected}
                    onClick={(): void => {
                      setAllHosts(category, false);
                    }}
                  >
                    {t('options_deselect_all')}
                  </button>
                </fieldset>
                <HostBrowser
                  hosts={category.hosts}
                  title={category.title}
                  regionLabel={t('options_category_sites_region_aria', {
                    CATEGORY: category.title,
                  })}
                  regionClass="cat-hosts-scroll"
                  listClass="cat-hosts"
                  renderHost={(host: string): VNode => {
                    const active: boolean = !excluded.includes(host);
                    return (
                      <li key={host}>
                        <label class="check">
                          <input
                            type="checkbox"
                            checked={active}
                            onClick={(): void => {
                              toggleHost(category.id, host, !active);
                            }}
                          />
                          {host}
                        </label>
                      </li>
                    );
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
