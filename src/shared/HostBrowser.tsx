import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useId, useMemo, useState } from 'preact/hooks';
import { filterHosts, HOST_PAGE_SIZE } from '../core/host-search';
import './host-browser.css';
import { formatNumber, t } from './i18n';

export interface HostBrowserProps {
  /** Every host in the category, in list order. */
  hosts: readonly string[];
  /** Category title, which names the search field for a screen reader. */
  title: string;
  /** Accessible name for the scroll region, so each page keeps its own wording. */
  regionLabel: string;
  /** Id the disclosure button points at with aria-controls. */
  regionId?: string;
  regionClass: string;
  listClass: string;
  renderHost: (host: string) => VNode;
}

function statusText(title: string, total: number, matched: number, shown: number): string {
  if (matched === 0) return t('shared_host_none', { TITLE: title });
  if (shown < matched) {
    return t('shared_host_partial', { SHOWN: formatNumber(shown), MATCHED: formatNumber(matched) });
  }
  if (matched < total) {
    return t('shared_host_matched', { MATCHED: formatNumber(matched), TOTAL: formatNumber(total) });
  }
  return t('shared_host_all', { TOTAL: formatNumber(total) });
}

/**
 * A searchable, scrolling view of one category's hosts. Only the first page of matches reaches the
 * DOM, because a category holds hundreds of entries and every row in the options view carries a
 * checkbox. Narrowing the search is what reaches the rest of the list.
 */
export function HostBrowser(props: HostBrowserProps): VNode {
  const [query, setQuery]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const searchId: string = `host-search-${useId()}`;
  const matches: string[] = useMemo(
    (): string[] => filterHosts(props.hosts, query),
    [props.hosts, query],
  );
  const visible: string[] = matches.slice(0, HOST_PAGE_SIZE);

  return (
    <div class="host-browser">
      <label class="host-browser__field" for={searchId}>
        <span class="visually-hidden">{t('shared_host_search_label', { TITLE: props.title })}</span>
        <input
          id={searchId}
          type="search"
          class="host-browser__search"
          placeholder={t('shared_host_search_label', { TITLE: props.title })}
          value={query}
          onInput={(event: Event): void => {
            setQuery((event.currentTarget as HTMLInputElement).value);
          }}
        />
      </label>
      <p class="host-browser__status" role="status" aria-live="polite">
        {statusText(props.title, props.hosts.length, matches.length, visible.length)}
      </p>
      <section
        id={props.regionId}
        class={`host-browser__scroll ${props.regionClass}`}
        aria-label={props.regionLabel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region must take keyboard scroll commands.
        tabIndex={0}
      >
        {visible.length > 0 ? (
          <ul class={props.listClass}>{visible.map(props.renderHost)}</ul>
        ) : null}
      </section>
    </div>
  );
}
