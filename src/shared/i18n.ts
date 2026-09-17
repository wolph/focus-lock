import app from '../../locales/en/app.json' with { type: 'json' };
import notify from '../../locales/en/notify.json' with { type: 'json' };
import onboarding from '../../locales/en/onboarding.json' with { type: 'json' };
import options from '../../locales/en/options.json' with { type: 'json' };
import overlay from '../../locales/en/overlay.json' with { type: 'json' };
import popup from '../../locales/en/popup.json' with { type: 'json' };
import shared from '../../locales/en/shared.json' with { type: 'json' };
import stats from '../../locales/en/stats.json' with { type: 'json' };

/**
 * The en catalogue, merged from its surface files. Chrome reads the same keys from
 * _locales/<locale>/messages.json, which scripts/gen-locales.mjs builds from these files.
 */
const EN = {
  ...app,
  ...shared,
  ...popup,
  ...overlay,
  ...options,
  ...onboarding,
  ...stats,
  ...notify,
};

type Catalogue = typeof EN;
export type MessageKey = keyof Catalogue;

interface PlaceholderSpec {
  readonly content: string;
  readonly example?: string;
}

interface MessageEntry {
  readonly message: string;
  readonly description?: string;
  readonly placeholders?: Readonly<Record<string, PlaceholderSpec>>;
}

/** The named values a key needs, or nothing when its message has no placeholders. */
export type Params<K extends MessageKey> = Catalogue[K] extends { placeholders: infer P }
  ? [params: { readonly [N in keyof P]: string }]
  : [];

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
/** Base names whose `_other` form exists in the catalogue. */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer B}_other` ? B : never;
}[MessageKey];
type PluralForm<B extends PluralKey, S extends PluralSuffix> = `${B}_${S}` & MessageKey;
type WithoutCount<P> = { readonly [N in keyof P as N extends 'COUNT' ? never : N]: string };
/** The named values of a plural family besides `COUNT`, which `tPlural` fills itself. */
type PluralParams<K extends MessageKey> = Catalogue[K] extends { placeholders: infer P }
  ? keyof WithoutCount<P> extends never
    ? []
    : [params: WithoutCount<P>]
  : [];

const ENTRIES: Readonly<Record<string, MessageEntry>> = EN;

interface I18nApi {
  getMessage(key: string, substitutions?: string[]): string;
  getUILanguage(): string;
}

function chromeI18n(): I18nApi | null {
  const api: unknown = (globalThis as { chrome?: { i18n?: unknown } }).chrome?.i18n;
  if (typeof api !== 'object' || api === null) return null;
  if (typeof (api as I18nApi).getMessage !== 'function') return null;
  return api as I18nApi;
}

/** Positional substitutions in `$1`, `$2` order, built from the en placeholder declarations. */
function positional(entry: MessageEntry, params: Readonly<Record<string, string>>): string[] {
  const values: string[] = [];
  for (const [name, spec] of Object.entries(entry.placeholders ?? {})) {
    const index: number = Number(spec.content.slice(1)) - 1;
    values[index] = params[name] ?? '';
  }
  return values;
}

function substituteEn(entry: MessageEntry, params: Readonly<Record<string, string>>): string {
  return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (whole: string, name: string): string => {
    const value: string | undefined = params[name.toUpperCase()];
    return value === undefined ? whole : value;
  });
}

/** The browser's text for `key`, or null when the locale has no such message. */
function translated(
  key: string,
  entry: MessageEntry,
  params: Readonly<Record<string, string>>,
): string | null {
  const api: I18nApi | null = chromeI18n();
  if (api === null) return null;
  const text: string = api.getMessage(key, positional(entry, params));
  return text === '' ? null : text;
}

function lookup(key: string, params: Readonly<Record<string, string>>): string {
  const entry: MessageEntry | undefined = ENTRIES[key];
  if (entry === undefined) return key;
  return translated(key, entry, params) ?? substituteEn(entry, params);
}

/**
 * The message for `key` in the browser's UI language, with named placeholder values. Falls back
 * to the en text outside the extension, so vitest and the pages harness render real copy.
 */
export function t<K extends MessageKey>(key: K, ...params: Params<K>): string {
  return lookup(key, (params as readonly [Record<string, string>?])[0] ?? {});
}

/**
 * The BCP 47 tag to format numbers and choose plural forms with.
 *
 * `@@ui_locale` is the browser's own interface locale, which is also what Chrome picks the message
 * catalogue by, so it is the tag the words on screen were written for. `getUILanguage` reports the
 * language preference instead, and the two can disagree: a profile can prefer French while the
 * interface, and therefore the catalogue, stays English. Formatting has to agree with the words
 * around it, so the interface locale wins and the preference is only a fallback.
 */
export function uiLanguage(): string {
  const api: I18nApi | null = chromeI18n();
  if (api !== null) {
    const messageLocale: string = api.getMessage('@@ui_locale');
    if (messageLocale !== '') return messageLocale.replace('_', '-');
    if (typeof api.getUILanguage === 'function') {
      const preference: string = api.getUILanguage();
      if (preference !== '') return preference;
    }
  }
  const navigatorLanguage: unknown = (globalThis as { navigator?: { language?: unknown } })
    .navigator?.language;
  return typeof navigatorLanguage === 'string' && navigatorLanguage !== ''
    ? navigatorLanguage
    : 'en';
}

function pluralCategory(count: number): PluralSuffix {
  try {
    return new Intl.PluralRules(uiLanguage()).select(count) as PluralSuffix;
  } catch {
    return count === 1 ? 'one' : 'other';
  }
}

/**
 * The plural form of `base` for `count`. The catalogue carries `base_one`, `base_other`, and the
 * categories a locale needs. `COUNT` is substituted with the formatted number.
 */
export function tPlural<B extends PluralKey>(
  base: B,
  count: number,
  ...params: PluralParams<PluralForm<B, 'other'>>
): string {
  const extra: Readonly<Record<string, string>> =
    (params as readonly [Record<string, string>?])[0] ?? {};
  const values: Readonly<Record<string, string>> = { COUNT: formatNumber(count), ...extra };
  const other: MessageEntry | undefined = ENTRIES[`${base}_other`];
  if (other === undefined) return base;
  const candidate: string = `${base}_${pluralCategory(count)}`;
  // The locale may carry forms en lacks, so the browser is asked before the en fallback.
  const fromLocale: string | null =
    translated(candidate, other, values) ?? translated(`${base}_other`, other, values);
  if (fromLocale !== null) return fromLocale;
  const fallback: MessageEntry | undefined = ENTRIES[candidate];
  return substituteEn(fallback ?? other, values);
}

/** A number in the UI language's digits and grouping. */
export function formatNumber(value: number): string {
  try {
    return new Intl.NumberFormat(uiLanguage()).format(value);
  } catch {
    return String(value);
  }
}

/** Text direction of the UI language: Chrome's `@@bidi_dir`, and `ltr` outside the extension. */
export function bidiDir(): 'ltr' | 'rtl' {
  const api: I18nApi | null = chromeI18n();
  if (api === null) return 'ltr';
  return api.getMessage('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
}

/** Stamp `lang` and `dir` on the document before the first render. */
export function applyDocumentLocale(doc: Document): void {
  doc.documentElement.lang = uiLanguage();
  doc.documentElement.dir = bidiDir();
}
