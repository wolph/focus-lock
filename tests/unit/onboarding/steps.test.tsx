/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import { HOST_PAGE_SIZE } from '../../../src/core/host-search';
import { StartingListsStep } from '../../../src/onboarding/StartingListsStep';
import { SyncChoiceStep } from '../../../src/onboarding/SyncChoiceStep';
import { WebsiteAccessStep } from '../../../src/onboarding/WebsiteAccessStep';
import { DEFAULT_LISTS } from '../../../src/shared/constants';
import { t, tPlural } from '../../../src/shared/i18n';
import type { CategoryList, ListsConfig, WebsiteAccessChoice } from '../../../src/shared/types';

afterEach((): void => cleanup());

describe('StartingListsStep', (): void => {
  it('lists all seven bundled categories and expands their exact domains', (): void => {
    const view = render(
      <StartingListsStep
        lists={structuredClone(DEFAULT_LISTS)}
        pending={false}
        onListsChange={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    expect(view.getAllByRole('checkbox')).toHaveLength(7);
    for (const category of ALL_CATEGORIES) {
      expect(view.getByRole('checkbox', { name: category.title })).toBeTruthy();
      expect(
        view.getAllByText(tPlural('onboarding_site_count', category.hosts.length)).length,
      ).toBeGreaterThan(0);
    }

    const social: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'social',
    ) as CategoryList;
    fireEvent.click(
      view.getByRole('button', {
        name: t('onboarding_show_category_sites', { CATEGORY: 'Social media' }),
      }),
    );
    const domains: HTMLElement = view.getByRole('region', {
      name: t('onboarding_category_domains_label', { CATEGORY: 'Social media' }),
    });
    expect(
      Array.from(
        domains.querySelectorAll('li'),
        (item: Element): string | null => item.textContent,
      ),
    ).toEqual(social.hosts.slice(0, HOST_PAGE_SIZE));
    expect(domains.classList.contains('category-domains-scroll')).toBe(true);
    expect(view.getByRole('status').textContent).toBe(
      `Showing ${HOST_PAGE_SIZE} of ${social.hosts.length} sites. Search to narrow the list.`,
    );
  });

  it('reaches a host past the first page through the search field', (): void => {
    const social: CategoryList = ALL_CATEGORIES.find(
      (category: CategoryList): boolean => category.id === 'social',
    ) as CategoryList;
    const beyondFirstPage: string = social.hosts[social.hosts.length - 1] as string;
    expect(social.hosts.indexOf(beyondFirstPage)).toBeGreaterThanOrEqual(HOST_PAGE_SIZE);
    const view = render(
      <StartingListsStep
        lists={structuredClone(DEFAULT_LISTS)}
        pending={false}
        onListsChange={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    fireEvent.click(
      view.getByRole('button', {
        name: t('onboarding_show_category_sites', { CATEGORY: 'Social media' }),
      }),
    );
    expect(view.queryByText(beyondFirstPage)).toBeNull();
    fireEvent.input(view.getByLabelText('Search Social media sites'), {
      target: { value: beyondFirstPage },
    });

    const domains: HTMLElement = view.getByRole('region', {
      name: t('onboarding_category_domains_label', { CATEGORY: 'Social media' }),
    });
    expect(
      Array.from(
        domains.querySelectorAll('li'),
        (item: Element): string | null => item.textContent,
      ),
    ).toEqual([beyondFirstPage]);
    expect(view.getByRole('status').textContent).toBe(`Showing 1 of ${social.hosts.length} sites.`);
  });

  it('says so when a search matches no site in the category', (): void => {
    const view = render(
      <StartingListsStep
        lists={structuredClone(DEFAULT_LISTS)}
        pending={false}
        onListsChange={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    fireEvent.click(
      view.getByRole('button', {
        name: t('onboarding_show_category_sites', { CATEGORY: 'Social media' }),
      }),
    );
    fireEvent.input(view.getByLabelText('Search Social media sites'), {
      target: { value: 'no-such-site.example' },
    });

    expect(view.getByRole('status').textContent).toBe('No Social media site matches your search.');
    expect(
      view
        .getByRole('region', {
          name: t('onboarding_category_domains_label', { CATEGORY: 'Social media' }),
        })
        .querySelectorAll('li'),
    ).toHaveLength(0);
  });

  it('changes only the selected category without discarding list rules', (): void => {
    const lists: ListsConfig = {
      ...structuredClone(DEFAULT_LISTS),
      custom: [{ kind: 'host', pattern: 'example.com' }],
      exclusions: { social: ['facebook.com'] },
    };
    const onListsChange = vi.fn<(next: ListsConfig) => void>();
    const view = render(
      <StartingListsStep
        lists={lists}
        pending={false}
        onListsChange={onListsChange}
        onContinue={vi.fn()}
      />,
    );

    fireEvent.click(view.getByRole('checkbox', { name: 'Social media' }));

    expect(onListsChange).toHaveBeenCalledWith({
      ...lists,
      categories: { ...lists.categories, social: true },
    });
  });
});

describe('WebsiteAccessStep', (): void => {
  it('gives the secondary action a distinct hover and keyboard-focus surface', (): void => {
    const css: string = readFileSync(resolve('src/onboarding/onboarding.css'), 'utf8');

    expect(css).toMatch(
      /\.secondary-button:hover:not\(:disabled\),\s*\.secondary-button:focus-visible\s*\{[^}]*background:\s*var\(--accent-soft\)/s,
    );
  });

  it('explains local address matching and all-sites access before the request action', (): void => {
    const view = render(
      <WebsiteAccessStep
        choice={'pending' satisfies WebsiteAccessChoice}
        pending={false}
        error={null}
        onEnable={vi.fn()}
        onDefer={vi.fn()}
      />,
    );

    expect(view.getByText(/checks page addresses locally/i)).toBeTruthy();
    expect(view.getByText(t('onboarding_access_capability'))).toBeTruthy();
    expect(view.getByText(/restore affected pages/i)).toBeTruthy();
    expect(view.getByRole('button', { name: t('onboarding_access_enable_button') })).toBeTruthy();
    expect(view.getByRole('button', { name: t('onboarding_access_defer_button') })).toBeTruthy();
  });

  it('shows denial status and an explicit retry action', (): void => {
    const onEnable = vi.fn<() => void>();
    const view = render(
      <WebsiteAccessStep
        choice={'denied' satisfies WebsiteAccessChoice}
        pending={false}
        error={null}
        onEnable={onEnable}
        onDefer={vi.fn()}
      />,
    );

    expect(view.getByRole('status').textContent).toContain('Chrome did not grant website access');
    fireEvent.click(view.getByRole('button', { name: t('onboarding_retry_button') }));
    expect(onEnable).toHaveBeenCalledOnce();
  });
});

describe('SyncChoiceStep', (): void => {
  it('starts on with one switch and lists exact synced and local-only data', (): void => {
    const view = render(
      <SyncChoiceStep
        syncEnabled={true}
        pending={false}
        error={null}
        onSyncChange={vi.fn()}
        onComplete={vi.fn()}
      />,
    );

    expect(view.getAllByRole('switch')).toHaveLength(1);
    expect(
      (view.getByRole('switch', { name: t('onboarding_sync_switch_label') }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    for (const label of [
      'Settings',
      'Block and allow lists',
      'Site access credit',
      'Streaks',
      'Domain-level blocked-attempt aggregates',
      'Full URLs',
      'Focus intentions',
      'Detailed session events',
      'Active runtime session',
    ]) {
      expect(view.getByText(label)).toBeTruthy();
    }
    expect(view.getByRole('region', { name: t('onboarding_sync_synced_title') })).toBeTruthy();
    expect(view.getByRole('region', { name: t('onboarding_sync_local_title') })).toBeTruthy();
    expect(view.getByText(t('onboarding_sync_developer_note'))).toBeTruthy();
    expect(view.getByRole('button', { name: t('onboarding_sync_finish_enabled') })).toBeTruthy();
  });

  it('changes the explanation and finish label when sync is turned off', (): void => {
    const onSyncChange = vi.fn<(enabled: boolean) => void>();
    const view = render(
      <SyncChoiceStep
        syncEnabled={false}
        pending={false}
        error={null}
        onSyncChange={onSyncChange}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(view.getByRole('switch', { name: t('onboarding_sync_switch_label') }));
    expect(onSyncChange).toHaveBeenCalledWith(true);
    expect(view.getByText(/stays in this Chrome profile/i)).toBeTruthy();
    expect(view.getByRole('button', { name: t('onboarding_sync_finish_disabled') })).toBeTruthy();
  });
});
