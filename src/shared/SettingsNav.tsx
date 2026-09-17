import type { JSX, VNode } from 'preact';
import { t } from './i18n';
import { ThemeControl } from './ThemeControl';
import type { ThemeMode } from './types';

export type SettingsSectionId =
  | 'blocking'
  | 'schedule'
  | 'behavior'
  | 'budget'
  | 'notifications'
  | 'privacy';

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: 'blocking', label: t('shared_section_blocking') },
  { id: 'schedule', label: t('shared_section_schedule') },
  { id: 'behavior', label: t('shared_section_behavior') },
  { id: 'budget', label: t('shared_section_budget') },
  { id: 'notifications', label: t('shared_section_notifications') },
  { id: 'privacy', label: t('shared_section_privacy') },
];

const SETTINGS_SECTION_ALIASES: Readonly<Record<string, SettingsSectionId>> = {
  lists: 'blocking',
  categories: 'blocking',
  strictness: 'behavior',
  pause: 'budget',
  sounds: 'notifications',
  data: 'privacy',
};

export function parseSettingsSectionHash(hash: string): SettingsSectionId {
  const candidate: string = hash.startsWith('#') ? hash.slice(1) : hash;
  const alias: SettingsSectionId | undefined = SETTINGS_SECTION_ALIASES[candidate];
  if (alias !== undefined) return alias;
  return SETTINGS_SECTIONS.some(({ id }: { id: SettingsSectionId }): boolean => id === candidate)
    ? (candidate as SettingsSectionId)
    : 'blocking';
}

interface SettingsNavProps {
  page: 'options' | 'stats';
  section?: SettingsSectionId;
  theme: ThemeMode | null;
  onThemeChange: (next: ThemeMode) => Promise<string | null>;
  onSectionChange?: (next: SettingsSectionId) => void;
}

export function SettingsNav(props: SettingsNavProps): VNode {
  return (
    <nav class="settings-nav" aria-label={t('shared_nav_product')}>
      <div class="settings-nav-heading">
        <span class="settings-nav-brand">{t('shared_nav_brand')}</span>
        <ThemeControl mode={props.theme} onChange={props.onThemeChange} />
      </div>
      <a
        class={`settings-nav-item${props.page === 'stats' ? ' current' : ''}`}
        href="../stats/stats.html"
        aria-current={props.page === 'stats' ? 'page' : undefined}
      >
        {t('shared_nav_overview')}
      </a>
      <div class="settings-nav-group-label">{t('shared_nav_settings')}</div>
      {SETTINGS_SECTIONS.map(({ id, label }: { id: SettingsSectionId; label: string }): VNode => {
        const current: boolean = props.page === 'options' && props.section === id;
        return (
          <a
            key={id}
            class={`settings-nav-item${current ? ' current' : ''}`}
            href={props.page === 'options' ? `#${id}` : `../options/options.html#${id}`}
            aria-current={current ? 'page' : undefined}
            onClick={
              props.page === 'options'
                ? (event: JSX.TargetedMouseEvent<HTMLAnchorElement>): void => {
                    if (
                      event.button !== 0 ||
                      event.altKey ||
                      event.ctrlKey ||
                      event.metaKey ||
                      event.shiftKey
                    ) {
                      return;
                    }
                    event.preventDefault();
                    window.history.pushState(null, '', `#${id}`);
                    props.onSectionChange?.(id);
                  }
                : undefined
            }
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}
