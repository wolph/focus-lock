import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDocumentLocale,
  bidiDir,
  formatNumber,
  t,
  tPlural,
  uiLanguage,
} from '../../../src/shared/i18n';

type ChromeStub = {
  i18n: { getMessage: (key: string, subs?: string[]) => string; getUILanguage: () => string };
};

function stubChrome(language: string, translations: Record<string, string>): ChromeStub {
  const stub: ChromeStub = {
    i18n: {
      getMessage: (key: string, subs: string[] = []): string => {
        if (key === '@@bidi_dir') return ['ar', 'he', 'fa'].includes(language) ? 'rtl' : 'ltr';
        if (key === '@@ui_locale') return language.replace('-', '_');
        const text: string | undefined = translations[key];
        return text === undefined
          ? ''
          : text.replace(/\$(\d)/g, (_w, n: string) => subs[Number(n) - 1] ?? '');
      },
      getUILanguage: (): string => language,
    },
  };
  vi.stubGlobal('chrome', stub);
  return stub;
}

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('t without chrome', () => {
  it('returns the en message', () => {
    expect(t('app_name')).toBe('Focus Lock');
  });
  it('substitutes named placeholders into the en message', () => {
    expect(t('shared_timed_hint_cycles', { MINUTES: '50', FOCUS: '25' })).toBe(
      '50 min total, with 25 min focus blocks',
    );
  });
  it('reports ltr and en', () => {
    expect(bidiDir()).toBe('ltr');
    expect(uiLanguage()).toMatch(/^en/);
  });
});

describe('t with chrome.i18n', () => {
  it('prefers the browser translation and passes substitutions positionally', () => {
    stubChrome('nl', { shared_timed_hint_cycles: '$1 min totaal, met blokken van $2 min' });
    expect(t('shared_timed_hint_cycles', { MINUTES: '50', FOCUS: '25' })).toBe(
      '50 min totaal, met blokken van 25 min',
    );
  });
  it('falls back to en for a key the locale lacks', () => {
    stubChrome('nl', {});
    expect(t('app_name')).toBe('Focus Lock');
  });
  it('reports rtl for Arabic and stamps the document', () => {
    stubChrome('ar', {});
    expect(bidiDir()).toBe('rtl');
    const doc = { documentElement: { lang: '', dir: '' } } as unknown as Document;
    applyDocumentLocale(doc);
    expect(doc.documentElement.lang).toBe('ar');
    expect(doc.documentElement.dir).toBe('rtl');
  });
});

describe('uiLanguage', () => {
  it('prefers the locale the catalogue was resolved from over the browser preference', () => {
    vi.stubGlobal('chrome', {
      i18n: {
        getMessage: (key: string): string => (key === '@@ui_locale' ? 'en_US' : ''),
        getUILanguage: (): string => 'fr',
      },
    });
    expect(uiLanguage()).toBe('en-US');
  });

  it('falls back to the browser preference when no catalogue locale is reported', () => {
    vi.stubGlobal('chrome', {
      i18n: {
        getMessage: (): string => '',
        getUILanguage: (): string => 'fr',
      },
    });
    expect(uiLanguage()).toBe('fr');
  });
});

describe('tPlural', () => {
  it('picks one and other in en', () => {
    expect(tPlural('shared_minutes', 1)).toBe('1 min');
    expect(tPlural('shared_minutes', 25)).toBe('25 min');
  });
  it('uses the locale plural category and number format', () => {
    stubChrome('ru', { shared_minutes_few: '$1 минуты', shared_minutes_other: '$1 минут' });
    expect(tPlural('shared_minutes', 3)).toBe('3 минуты');
    expect(tPlural('shared_minutes', 5)).toBe('5 минут');
  });
  it('falls back to other when the locale form is missing', () => {
    stubChrome('ru', { shared_minutes_other: '$1 минут' });
    expect(tPlural('shared_minutes', 3)).toBe('3 минут');
  });
  it('formats numbers in the UI language', () => {
    stubChrome('de', {});
    expect(formatNumber(1234)).toBe('1.234');
  });
});
