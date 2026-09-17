/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseSettingsSectionHash,
  SETTINGS_SECTIONS,
  SettingsNav,
} from '../../../src/shared/SettingsNav';

afterEach((): void => cleanup());

describe('settings navigation', (): void => {
  it('bounds and end-aligns theme errors inside the responsive navigation', (): void => {
    const css: string = readFileSync(resolve('src/shared/settings-nav.css'), 'utf8');
    // The offset is logical rather than physical, so the error sits at the end of the line in a
    // right-to-left language as well.
    expect(css).toMatch(/\.settings-nav \.theme-error\s*\{[^}]*inset-inline-end:\s*0/s);
    expect(css).toMatch(/\.settings-nav \.theme-error\s*\{[^}]*max-width:/s);
    expect(css).toMatch(/\.settings-nav \.theme-error\s*\{[^}]*white-space:\s*normal/s);
  });

  it('parses canonical hashes, preserves aliases, and falls back to Blocking', (): void => {
    expect(parseSettingsSectionHash('#blocking')).toBe('blocking');
    expect(parseSettingsSectionHash('#schedule')).toBe('schedule');
    expect(parseSettingsSectionHash('#lists')).toBe('blocking');
    expect(parseSettingsSectionHash('#categories')).toBe('blocking');
    expect(parseSettingsSectionHash('#strictness')).toBe('behavior');
    expect(parseSettingsSectionHash('#pause')).toBe('budget');
    expect(parseSettingsSectionHash('#sounds')).toBe('notifications');
    expect(parseSettingsSectionHash('#data')).toBe('privacy');
    expect(parseSettingsSectionHash('#not-a-section')).toBe('blocking');
    expect(parseSettingsSectionHash('')).toBe('blocking');
  });

  it('renders Overview, a non-link Settings group, and six destinations', (): void => {
    const { getAllByRole, getByRole, getByText } = render(
      <SettingsNav
        page="options"
        section="blocking"
        theme="auto"
        onThemeChange={async () => null}
      />,
    );
    expect(getByRole('navigation', { name: 'Product navigation' })).toBeTruthy();
    expect(SETTINGS_SECTIONS).toHaveLength(6);
    expect(getAllByRole('link')).toHaveLength(7);
    expect(getByRole('link', { name: 'Overview' }).getAttribute('href')).toBe(
      '../stats/stats.html',
    );
    expect(getByText('Settings', { selector: '.settings-nav-group-label' })).toBeTruthy();
    expect(getByRole('link', { name: 'Blocking' }).getAttribute('href')).toBe('#blocking');
    expect(getByRole('link', { name: 'Blocking' }).getAttribute('aria-current')).toBe('page');
    expect(getByText('Focus Lock', { selector: '.settings-nav-brand' })).toBeTruthy();
    expect(document.querySelectorAll('h1')).toHaveLength(0);
  });

  it('renders exact Options hashes and marks Overview current on Stats', (): void => {
    const { getByRole } = render(
      <SettingsNav page="stats" theme="dark" onThemeChange={async () => null} />,
    );
    expect(getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    for (const section of SETTINGS_SECTIONS) {
      expect(getByRole('link', { name: section.label }).getAttribute('href')).toBe(
        `../options/options.html#${section.id}`,
      );
    }
  });
});
