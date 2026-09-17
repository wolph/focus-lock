import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkDefault,
  checkLocales,
  checkTranslation,
  generateLocales,
  LOCALES,
  mergeSurfaces,
  mergeTranslation,
  repairPlaceholders,
  translationProgress,
  unusedKeys,
} from '../../../scripts/locales-lib.mjs';

type Entry = {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string }>;
};
type Catalogue = Record<string, Entry>;

const EN: Catalogue = {
  popup_start: { message: 'Start', description: 'Start button.' },
  shared_hint: {
    message: '$MINUTES$ min total',
    description: 'Hint.',
    placeholders: { MINUTES: { content: '$1' } },
  },
  shared_minutes_one: {
    message: '$COUNT$ min',
    description: 'One minute.',
    placeholders: { COUNT: { content: '$1' } },
  },
  shared_minutes_other: {
    message: '$COUNT$ min',
    description: 'Minutes.',
    placeholders: { COUNT: { content: '$1' } },
  },
};

function translated(overrides: Partial<Catalogue> = {}): Catalogue {
  return {
    popup_start: { message: 'Starten' },
    shared_hint: { message: '$MINUTES$ min totaal', placeholders: { MINUTES: { content: '$1' } } },
    shared_minutes_one: { message: '$COUNT$ min', placeholders: { COUNT: { content: '$1' } } },
    shared_minutes_other: { message: '$COUNT$ min', placeholders: { COUNT: { content: '$1' } } },
    ...overrides,
  };
}

describe('checkDefault', () => {
  it('accepts a clean catalogue', () => {
    expect(checkDefault(EN)).toEqual([]);
  });
  it('rejects forbidden punctuation, empty text, and placeholder drift', () => {
    const errors: string[] = checkDefault({
      a: { message: 'x; y', description: 'd' },
      b: { message: '', description: 'd' },
      c: { message: '$X$', description: 'd' },
      d: { message: 'plain', description: 'd', placeholders: { X: { content: '$1' } } },
      e_one: { message: '1', description: 'd' },
    });
    expect(errors).toHaveLength(5);
    expect(errors.some((e) => e.includes('punctuation'))).toBe(true);
    expect(errors.some((e) => e.includes('e lacks _other'))).toBe(true);
  });
});

describe('checkTranslation', () => {
  it('accepts a complete translation', () => {
    expect(checkTranslation('nl', EN, translated())).toEqual({ errors: [], warnings: [] });
  });
  it('flags missing, extra, and placeholder-broken keys', () => {
    const catalogue: Catalogue = translated({ shared_hint: { message: 'geen' } });
    delete catalogue.popup_start;
    catalogue.stray = { message: 'x' };
    const { errors } = checkTranslation('nl', EN, catalogue);
    expect(errors).toEqual(
      expect.arrayContaining([
        'nl: popup_start is missing',
        'nl: stray is not an en key',
        expect.stringContaining('shared_hint references []'),
      ]),
    );
  });
  it('requires the plural categories of the locale', () => {
    const { errors } = checkTranslation('ru', EN, translated());
    expect(errors).toEqual(
      expect.arrayContaining([
        'ru: plural family shared_minutes lacks _few',
        'ru: plural family shared_minutes lacks _many',
      ]),
    );
  });
  it('warns on a narrow-surface message that is both long and far longer than en', () => {
    const { warnings } = checkTranslation(
      'de',
      EN,
      translated({ popup_start: { message: 'Fokussitzung jetzt sofort starten und sperren' } }),
    );
    expect(warnings).toEqual([expect.stringContaining('popup_start is')]);
  });

  it('stays quiet about a short label that simply has a longer word', () => {
    const { warnings } = checkTranslation(
      'ca',
      EN,
      translated({ popup_start: { message: 'Comencar' } }),
    );
    expect(warnings).toEqual([]);
  });
});

describe('mergeSurfaces and generateLocales', () => {
  it('rejects a key defined on two surfaces', () => {
    expect(() =>
      mergeSurfaces([
        { surface: 'a', messages: { k: { message: '1' } } },
        { surface: 'b', messages: { k: { message: '2' } } },
      ]),
    ).toThrow('defined in both a and b');
  });
  it('writes one merged messages.json per locale and reports the whole set', () => {
    const root: string = mkdtempSync(join(tmpdir(), 'locales-'));
    const src: string = join(root, 'locales');
    mkdirSync(join(src, 'en'), { recursive: true });
    writeFileSync(join(src, 'en', 'popup.json'), JSON.stringify({ popup_start: EN.popup_start }));
    writeFileSync(join(src, 'en', 'shared.json'), JSON.stringify({ shared_hint: EN.shared_hint }));
    const out: string = join(root, '_locales');
    expect(generateLocales(src, out)).toEqual(['en']);
    const merged: Catalogue = JSON.parse(readFileSync(join(out, 'en', 'messages.json'), 'utf8'));
    expect(Object.keys(merged)).toEqual(['popup_start', 'shared_hint']);
    // A locale nobody has started is a gap, not a broken build, so it warns by default and only
    // fails under the release gate.
    expect(
      checkLocales(src).warnings.filter((warning: string): boolean =>
        warning.endsWith('not started'),
      ),
    ).toHaveLength(LOCALES.length - 1);
    expect(
      checkLocales(src, { complete: true }).errors.filter((error: string): boolean =>
        error.endsWith('not started'),
      ),
    ).toHaveLength(LOCALES.length - 1);
  });
});

describe('unusedKeys', () => {
  it('reports only the keys no source file names', () => {
    const root: string = mkdtempSync(join(tmpdir(), 'usage-'));
    const src: string = join(root, 'src');
    mkdirSync(join(src, 'nested'), { recursive: true });
    writeFileSync(join(src, 'a.tsx'), "t('popup_start');");
    writeFileSync(join(src, 'nested', 'b.ts'), "tPlural('shared_minutes', 2);");
    writeFileSync(join(src, 'ignored.css'), "t('shared_hint');");
    expect(unusedKeys(EN, [src])).toEqual(['shared_hint']);
  });

  it('counts a manifest __MSG__ reference and skips a missing root', () => {
    const root: string = mkdtempSync(join(tmpdir(), 'usage-'));
    const manifest: string = join(root, 'manifest.config.ts');
    writeFileSync(manifest, "name: '__MSG_popup_start__',");
    const unused: string[] = unusedKeys(EN, [manifest, join(root, 'absent')]);
    expect(unused).not.toContain('popup_start');
    expect(unused).toContain('shared_hint');
  });
});

describe('mergeTranslation', () => {
  function seeded(): string {
    const root: string = mkdtempSync(join(tmpdir(), 'merge-'));
    const src: string = join(root, 'locales');
    mkdirSync(join(src, 'en'), { recursive: true });
    writeFileSync(join(src, 'en', 'popup.json'), JSON.stringify({ popup_start: EN.popup_start }));
    writeFileSync(
      join(src, 'en', 'shared.json'),
      JSON.stringify({
        shared_hint: EN.shared_hint,
        shared_minutes_one: EN.shared_minutes_one,
        shared_minutes_other: EN.shared_minutes_other,
      }),
    );
    return src;
  }

  function merge(src: string, locale: string, flat: Record<string, string>): Catalogue {
    const written: Catalogue = {};
    const result = mergeTranslation(src, locale, flat, (surface: string, messages: Catalogue) => {
      mkdirSync(join(src, locale), { recursive: true });
      writeFileSync(join(src, locale, `${surface}.json`), JSON.stringify(messages));
      Object.assign(written, messages);
    });
    expect(result.unknown).toEqual([]);
    return written;
  }

  it('copies the placeholder block from en and keeps the translated text', () => {
    const src: string = seeded();
    const written: Catalogue = merge(src, 'nl', { shared_hint: '$MINUTES$ min totaal' });
    expect(written.shared_hint).toEqual({
      message: '$MINUTES$ min totaal',
      placeholders: { MINUTES: { content: '$1' } },
    });
  });

  it('stores a short label that reads the same in both languages', () => {
    const src: string = seeded();
    const written: Catalogue = merge(src, 'nl', {
      popup_start: 'Start',
      shared_hint: '$MINUTES$ min totaal',
    });
    // Start is Start in Dutch. A key that is never stored can never be complete, so a shared
    // short label is kept.
    expect(written.popup_start?.message).toBe('Start');
    expect(written.shared_hint).toBeDefined();
  });

  it('drops a whole sentence that is still the English text', () => {
    const root: string = mkdtempSync(join(tmpdir(), 'padding-'));
    const src: string = join(root, 'locales');
    const sentence: string = 'End the running session before deleting all data.';
    mkdirSync(join(src, 'en'), { recursive: true });
    writeFileSync(
      join(src, 'en', 'popup.json'),
      JSON.stringify({ popup_note: { message: sentence, description: 'A note.' } }),
    );
    const written: Catalogue = {};
    const result = mergeTranslation(
      src,
      'nl',
      { popup_note: sentence },
      (surface: string, messages: Catalogue): void => {
        mkdirSync(join(src, 'nl'), { recursive: true });
        writeFileSync(join(src, 'nl', `${surface}.json`), JSON.stringify(messages));
        Object.assign(written, messages);
      },
    );
    expect(written.popup_note).toBeUndefined();
    expect(result.untranslated).toBe(1);
  });

  it('keeps British English identical to the source', () => {
    const src: string = seeded();
    const written: Catalogue = merge(src, 'en_GB', { popup_start: 'Start' });
    expect(written.popup_start?.message).toBe('Start');
  });

  it('carries earlier work through a later partial submission', () => {
    const src: string = seeded();
    merge(src, 'nl', { popup_start: 'Starten' });
    const written: Catalogue = merge(src, 'nl', { shared_hint: '$MINUTES$ min totaal' });
    expect(written.popup_start?.message).toBe('Starten');
    expect(written.shared_hint?.message).toBe('$MINUTES$ min totaal');
  });

  it('reports a key that is not in the catalogue', () => {
    const src: string = seeded();
    const result = mergeTranslation(src, 'nl', { not_a_key: 'x' }, (): void => {});
    expect(result.unknown).toEqual(['not_a_key']);
  });
});

describe('translationProgress', () => {
  it('counts each surface and reports null for a locale with no catalogue', () => {
    const root: string = mkdtempSync(join(tmpdir(), 'progress-'));
    const src: string = join(root, 'locales');
    mkdirSync(join(src, 'en'), { recursive: true });
    writeFileSync(
      join(src, 'en', 'popup.json'),
      JSON.stringify({ popup_start: EN.popup_start, shared_hint: EN.shared_hint }),
    );
    expect(translationProgress(src, 'nl')).toBeNull();
    mkdirSync(join(src, 'nl'), { recursive: true });
    writeFileSync(
      join(src, 'nl', 'popup.json'),
      JSON.stringify({ popup_start: { message: 'Starten' } }),
    );
    const progress = translationProgress(src, 'nl');
    expect(progress).not.toBeNull();
    expect(progress?.done).toBe(1);
    expect(progress?.total).toBe(2);
    expect(progress?.rows[0]?.missing).toBe(1);
    expect(progress?.rows[0]?.sameAsEnglish).toBe(0);
  });
});

describe('mergeTranslation keeps earlier work', () => {
  it('refuses to overwrite a translation with the English sentence', () => {
    const root: string = mkdtempSync(join(tmpdir(), 'keep-'));
    const src: string = join(root, 'locales');
    const sentence: string = 'End the running session before deleting all data.';
    mkdirSync(join(src, 'en'), { recursive: true });
    writeFileSync(
      join(src, 'en', 'popup.json'),
      JSON.stringify({ popup_note: { message: sentence, description: 'A note.' } }),
    );
    const write = (locale: string, flat: Record<string, string>): Catalogue => {
      const written: Catalogue = {};
      mergeTranslation(src, locale, flat, (surface: string, messages: Catalogue): void => {
        mkdirSync(join(src, locale), { recursive: true });
        writeFileSync(join(src, locale, `${surface}.json`), JSON.stringify(messages));
        Object.assign(written, messages);
      });
      return written;
    };
    write('nl', { popup_note: 'Beeindig de lopende sessie voordat je alle gegevens verwijdert.' });
    const second: Catalogue = write('nl', { popup_note: sentence });
    expect(second.popup_note?.message).toBe(
      'Beeindig de lopende sessie voordat je alle gegevens verwijdert.',
    );
  });
});

describe('repairPlaceholders', () => {
  const source: { message: string; placeholders: Record<string, { content: string }> } = {
    message: 'Theme: $CURRENT$. Switch to $NEXT$',
    placeholders: { CURRENT: { content: '$1' }, NEXT: { content: '$2' } },
  };

  it('restores a closing dollar the translation dropped', () => {
    expect(repairPlaceholders(source, 'テーマ：$CURRENT$。$NEXTに切り替え')).toBe(
      'テーマ：$CURRENT$。$NEXT$に切り替え',
    );
  });

  it('leaves a correct translation alone', () => {
    expect(repairPlaceholders(source, 'Tema: $CURRENT$. Cambiar a $NEXT$')).toBe(
      'Tema: $CURRENT$. Cambiar a $NEXT$',
    );
  });

  it('does not invent a placeholder the translation never names', () => {
    expect(repairPlaceholders(source, 'Tema: $CURRENT$')).toBe('Tema: $CURRENT$');
  });

  it('ignores a message with no placeholders at all', () => {
    expect(repairPlaceholders({ message: 'Start' }, 'Comenca')).toBe('Comenca');
  });
});
