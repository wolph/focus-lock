import type { JSX } from 'preact';
import { formatDuration, formatTimeOfDay } from '../shared/format';
import { t } from '../shared/i18n';
import type { EventRecord } from '../shared/types';
import { pairSessionRowsV2, type SessionRowV2 } from './session-rows-v2';

/** The chip a row wears, from the outcome kind the pairing already decided. */
function chipClass(outcomeKind: SessionRowV2['outcomeKind']): string {
  if (outcomeKind === 'completed') return 'chip completed';
  if (outcomeKind === 'running') return 'chip running';
  return 'chip neutral';
}

/** How a session was started, spelled for the narrow-screen card. */
function sourceLabel(source: 'manual' | 'schedule'): string {
  return source === 'schedule'
    ? t('stats_session_source_schedule')
    : t('stats_session_source_manual');
}

function SourceGlyph(props: { source: 'manual' | 'schedule' }): JSX.Element {
  if (props.source === 'schedule') {
    return (
      <svg
        class="glyph source"
        viewBox="0 0 16 16"
        aria-label={t('stats_session_source_scheduled')}
        role="img"
      >
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path
          d="M8 4.5V8l2.4 1.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
    );
  }
  return (
    <svg
      class="glyph source"
      viewBox="0 0 16 16"
      aria-label={t('stats_session_source_manual')}
      role="img"
    >
      <circle cx="8" cy="8" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function SessionLog(props: { events: EventRecord[] }): JSX.Element {
  const rows: SessionRowV2[] = pairSessionRowsV2(props.events);
  if (rows.length === 0) {
    return (
      <section class="card">
        <h2>{t('stats_sessions_heading')}</h2>
        <p class="empty-line">{t('stats_sessions_empty')}</p>
      </section>
    );
  }
  return (
    <section class="card">
      <h2>{t('stats_sessions_heading')}</h2>
      <div class="session-table-wrap">
        <table class="session-table">
          <thead>
            <tr>
              <th>{t('stats_sessions_col_date')}</th>
              <th>{t('stats_sessions_col_start')}</th>
              <th>{t('stats_sessions_col_planned')}</th>
              <th>{t('stats_sessions_col_focused')}</th>
              <th>{t('stats_sessions_col_all_sites')}</th>
              <th>{t('stats_sessions_col_one_site')}</th>
              <th>{t('stats_sessions_col_intention')}</th>
              <th>{t('stats_sessions_col_outcome')}</th>
              <th>
                <span class="visually-hidden">{t('stats_sessions_col_source')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(
              (row: SessionRowV2): JSX.Element => (
                <tr key={row.startedAt}>
                  <td>{new Date(row.startedAt).toLocaleDateString()}</td>
                  <td>{formatTimeOfDay(row.startedAt)}</td>
                  <td>{row.plan}</td>
                  <td>{row.focusedMs === null ? '-' : formatDuration(row.focusedMs)}</td>
                  <td>{formatDuration(row.pauseMs)}</td>
                  <td>{formatDuration(row.unlockMs)}</td>
                  <td class="intention-cell">{row.intention}</td>
                  <td>
                    <span class={chipClass(row.outcomeKind)}>{row.outcome}</span>
                  </td>
                  <td>
                    <SourceGlyph source={row.source} />
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      <div class="session-articles">
        {rows.map(
          (row: SessionRowV2): JSX.Element => (
            <article
              class="session-article"
              aria-label={t('stats_session_article_label', {
                INTENTION: row.intention || t('stats_session_no_intention'),
              })}
              key={row.startedAt}
            >
              <div class="session-article-heading">
                <strong>{row.intention || t('stats_session_no_intention')}</strong>
                <span class={chipClass(row.outcomeKind)}>{row.outcome}</span>
              </div>
              <dl class="session-fields">
                <div>
                  <dt>{t('stats_sessions_col_date')}</dt>
                  <dd>{new Date(row.startedAt).toLocaleDateString()}</dd>
                </div>
                <div>
                  <dt>{t('stats_sessions_col_start')}</dt>
                  <dd>{formatTimeOfDay(row.startedAt)}</dd>
                </div>
                <div>
                  <dt>{t('stats_sessions_col_planned')}</dt>
                  <dd>{row.plan}</dd>
                </div>
                <div>
                  <dt>{t('stats_sessions_col_focused')}</dt>
                  <dd>{row.focusedMs === null ? '-' : formatDuration(row.focusedMs)}</dd>
                </div>
                <div>
                  <dt>{t('stats_sessions_col_all_sites')}</dt>
                  <dd>{formatDuration(row.pauseMs)}</dd>
                </div>
                <div>
                  <dt>{t('stats_sessions_col_one_site')}</dt>
                  <dd>{formatDuration(row.unlockMs)}</dd>
                </div>
                <div>
                  <dt>{t('stats_sessions_col_source')}</dt>
                  <dd class="session-source">
                    <SourceGlyph source={row.source} />
                    {sourceLabel(row.source)}
                  </dd>
                </div>
              </dl>
            </article>
          ),
        )}
      </div>
    </section>
  );
}
