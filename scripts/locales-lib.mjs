// Shared logic for the locale scripts. The source catalogues live in locales/<locale>/<surface>.json
// and merge into _locales/<locale>/messages.json, the file Chrome reads.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Every locale the Chrome Web Store accepts, which is also the set the extension ships. */
export const LOCALES = [
  'am',
  'ar',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'en_GB',
  'es',
  'es_419',
  'et',
  'fa',
  'fi',
  'fil',
  'fr',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'kn',
  'ko',
  'lt',
  'lv',
  'ml',
  'mr',
  'ms',
  'nl',
  'no',
  'pl',
  'pt_BR',
  'pt_PT',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'vi',
  'zh_CN',
  'zh_TW',
];

export const DEFAULT_LOCALE = 'en';

/** Surfaces whose strings sit inside a fixed-width layout and get a length warning. */
const NARROW_PREFIXES = ['popup_', 'overlay_', 'shared_'];
const LENGTH_WARN_RATIO = 2.0;
/**
 * Below this many characters a ratio says nothing: a six-letter English button word translates to
 * a fourteen-letter one in Catalan without ever threatening the layout. Only a translation that is
 * both long in its own right and much longer than the English is worth looking at. Romance and
 * Slavic languages sit around 1.3 to 1.6 times the English length as a matter of course, so the
 * ratio is set well above that: this is a pointer for the layout run, not a style rule.
 */
const LENGTH_WARN_MIN_CHARS = 25;

/** Characters the en catalogue never uses, per the project's punctuation rules. */
const FORBIDDEN_EN = /[;—–‘’“”…]/;

const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Chrome locale code to a BCP 47 tag for Intl. */
export function toBcp47(locale) {
  return locale.replace('_', '-');
}

export function readSurfaceFiles(root, locale) {
  const dir = join(root, locale);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  return files.map((name) => ({
    surface: name.slice(0, -'.json'.length),
    messages: JSON.parse(readFileSync(join(dir, name), 'utf8')),
  }));
}

/** Merge the surface files of one locale. Throws on a key defined twice. */
export function mergeSurfaces(surfaces) {
  const merged = {};
  const owner = new Map();
  for (const { surface, messages } of surfaces) {
    for (const [key, value] of Object.entries(messages)) {
      if (owner.has(key)) {
        throw new Error(`key ${key} is defined in both ${owner.get(key)} and ${surface}`);
      }
      owner.set(key, surface);
      merged[key] = value;
    }
  }
  return merged;
}

export function readCatalogue(root, locale) {
  const surfaces = readSurfaceFiles(root, locale);
  return surfaces === null ? null : mergeSurfaces(surfaces);
}

function placeholderNames(entry) {
  return Object.keys(entry.placeholders ?? {}).sort();
}

/** `$NAME$` references inside a message, upper-cased the way Chrome matches them. */
function referencedPlaceholders(message) {
  const names = new Set();
  for (const match of message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)) names.add(match[1].toUpperCase());
  return [...names].sort();
}

function pluralFamilies(keys) {
  const families = new Map();
  for (const key of keys) {
    const match = PLURAL_SUFFIX.exec(key);
    if (match === null) continue;
    const base = key.slice(0, -match[0].length);
    if (!families.has(base)) families.set(base, new Set());
    families.get(base).add(match[1]);
  }
  return families;
}

function requiredCategories(locale) {
  return new Intl.PluralRules(toBcp47(locale)).resolvedOptions().pluralCategories;
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Validate the en catalogue on its own: forbidden punctuation, empty messages, placeholder
 * declarations that match the references in the text, and complete plural families.
 */
export function checkDefault(en) {
  const errors = [];
  for (const [key, entry] of Object.entries(en)) {
    if (typeof entry.message !== 'string' || entry.message.trim() === '') {
      errors.push(`en: ${key} has an empty message`);
      continue;
    }
    if (typeof entry.description !== 'string' || entry.description.trim() === '') {
      errors.push(`en: ${key} has no description for translators`);
    }
    if (FORBIDDEN_EN.test(entry.message)) {
      errors.push(`en: ${key} uses punctuation the style rules forbid`);
    }
    const declared = placeholderNames(entry);
    const referenced = referencedPlaceholders(entry.message);
    if (!sameList(declared, referenced)) {
      errors.push(`en: ${key} declares placeholders [${declared}] but references [${referenced}]`);
    }
  }
  for (const [base, categories] of pluralFamilies(Object.keys(en))) {
    for (const category of requiredCategories(DEFAULT_LOCALE)) {
      if (!categories.has(category)) errors.push(`en: plural family ${base} lacks _${category}`);
    }
  }
  return errors;
}

/**
 * Locales whose text is expected to match en closely. en_GB differs only where British usage
 * differs, so an identical string there is the right answer rather than an untranslated one.
 */
const NEAR_EN_LOCALES = new Set(['en_GB']);
/** Above this share of byte-identical messages, a catalogue is untranslated rather than translated. */
const MAX_IDENTICAL_SHARE = 0.1;

/** Validate one translated catalogue against en. */
export function checkTranslation(locale, en, catalogue) {
  const errors = [];
  const warnings = [];
  const enKeys = new Set(Object.keys(en));
  const enFamilies = pluralFamilies(Object.keys(en));
  const localeFamilies = pluralFamilies(Object.keys(catalogue));
  for (const key of Object.keys(catalogue)) {
    const match = PLURAL_SUFFIX.exec(key);
    const knownPlural = match !== null && enFamilies.has(key.slice(0, -match[0].length));
    if (!enKeys.has(key) && !knownPlural) errors.push(`${locale}: ${key} is not an en key`);
  }
  for (const [key, source] of Object.entries(en)) {
    const match = PLURAL_SUFFIX.exec(key);
    if (match !== null) continue;
    const entry = catalogue[key];
    if (entry === undefined) {
      errors.push(`${locale}: ${key} is missing`);
      continue;
    }
    checkEntry(locale, key, source, entry, errors, warnings);
  }
  for (const [base, enCategories] of enFamilies) {
    const have = localeFamilies.get(base) ?? new Set();
    for (const category of requiredCategories(locale)) {
      if (!have.has(category)) errors.push(`${locale}: plural family ${base} lacks _${category}`);
    }
    const source = en[`${base}_other`] ?? en[`${base}_${[...enCategories][0]}`];
    for (const category of PLURAL_CATEGORIES) {
      const entry = catalogue[`${base}_${category}`];
      if (entry !== undefined) {
        checkEntry(locale, `${base}_${category}`, source, entry, errors, warnings);
      }
    }
  }
  if (!NEAR_EN_LOCALES.has(locale)) {
    const comparable = Object.entries(en).filter(
      ([key, source]) =>
        PLURAL_SUFFIX.exec(key) === null &&
        catalogue[key] !== undefined &&
        // A product name, a glyph or a bare number is the same in every language.
        source.message.length > 3 &&
        /[a-z]{2}/.test(source.message),
    );
    const identical = comparable.filter(
      ([key, source]) => catalogue[key].message === source.message,
    );
    if (comparable.length > 0 && identical.length / comparable.length > MAX_IDENTICAL_SHARE) {
      errors.push(
        `${locale}: ${identical.length} of ${comparable.length} messages are still the English text, ` +
          `for example ${identical
            .slice(0, 3)
            .map(([key]) => key)
            .join(', ')}`,
      );
    }
  }
  return { errors, warnings };
}

function checkEntry(locale, key, source, entry, errors, warnings) {
  if (typeof entry.message !== 'string' || entry.message.trim() === '') {
    errors.push(`${locale}: ${key} has an empty message`);
    return;
  }
  const expected = placeholderNames(source);
  const declared = placeholderNames(entry);
  const referenced = referencedPlaceholders(entry.message);
  if (!sameList(expected, referenced)) {
    errors.push(`${locale}: ${key} references [${referenced}] but en has [${expected}]`);
  }
  if (!sameList(expected, declared)) {
    errors.push(`${locale}: ${key} declares [${declared}] but en has [${expected}]`);
  }
  for (const name of expected) {
    const content = entry.placeholders?.[name]?.content;
    if (content !== source.placeholders[name].content) {
      errors.push(
        `${locale}: ${key} placeholder ${name} must keep content ${source.placeholders[name].content}`,
      );
    }
  }
  if (NARROW_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    const length = [...entry.message].length;
    const ratio = length / [...source.message].length;
    if (length >= LENGTH_WARN_MIN_CHARS && ratio > LENGTH_WARN_RATIO) {
      warnings.push(`${locale}: ${key} is ${ratio.toFixed(2)}x the en length (${length} characters)`);
    }
  }
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.html']);

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) found.push(path);
  }
  return found;
}

/**
 * Keys the source never names. Every key costs a translation in each locale, so a key left behind
 * by a rewrite is an error rather than a warning. A plural family is referenced by its base name
 * through `tPlural`, so a form counts as used when the base is named.
 */
export function unusedKeys(en, roots) {
  const present = roots.filter((root) => existsSync(root));
  const text = present
    .flatMap((root) => (statSync(root).isDirectory() ? sourceFiles(root) : [root]))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  const unused = [];
  for (const key of Object.keys(en)) {
    if (text.includes(key)) continue;
    const match = PLURAL_SUFFIX.exec(key);
    if (match !== null && text.includes(key.slice(0, -match[0].length))) continue;
    unused.push(key);
  }
  return unused;
}

/** Run every check over a source root. Returns { errors, warnings }. */
export function checkLocales(root) {
  const errors = [];
  const warnings = [];
  const present = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  for (const locale of present) {
    if (!LOCALES.includes(locale)) errors.push(`${locale}: not in the locale set`);
  }
  let en;
  try {
    en = readCatalogue(root, DEFAULT_LOCALE);
  } catch (error) {
    return { errors: [String(error.message)], warnings };
  }
  if (en === null) return { errors: ['en: catalogue missing'], warnings };
  errors.push(...checkDefault(en));
  for (const key of unusedKeys(en, ['src', 'manifest.config.ts'])) {
    errors.push(`en: ${key} is never used in src`);
  }
  for (const locale of LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    let catalogue;
    try {
      catalogue = readCatalogue(root, locale);
    } catch (error) {
      errors.push(String(error.message));
      continue;
    }
    if (catalogue === null) {
      errors.push(`${locale}: catalogue missing`);
      continue;
    }
    const result = checkTranslation(locale, en, catalogue);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  return { errors, warnings };
}

/** en_GB differs from en only where British usage differs, so identical text is the right answer. */
export const NEAR_EN = NEAR_EN_LOCALES;

function pluralBaseOf(key) {
  const match = PLURAL_SUFFIX.exec(key);
  return match === null ? null : key.slice(0, -match[0].length);
}

function translatedEntry(source, text) {
  return source.placeholders === undefined
    ? { message: text }
    : { message: text, placeholders: source.placeholders };
}

/**
 * Merge a flat {key: message} map into one locale's surface files. A partial map is welcome: keys
 * it does not carry keep whatever the locale already had, so a locale can be translated one
 * surface at a time.
 *
 * A message identical to the English source is stored, because some words genuinely are the same
 * in both languages and a key that is never stored can never be complete. What it may not do is
 * replace a translation the locale already had: that is how a later pass of padding used to undo
 * earlier work. Wholesale padding is caught by share, in `checkTranslation`, rather than per key.
 */
export function mergeTranslation(root, locale, flat, write) {
  const english = readSurfaceFiles(root, 'en');
  if (english === null) throw new Error('en catalogue missing');
  const existing = new Map(
    (readSurfaceFiles(root, locale) ?? []).map(({ surface, messages }) => [surface, messages]),
  );
  const unknown = new Set(Object.keys(flat));
  const result = { fresh: 0, carried: 0, untranslated: 0, missing: 0, unknown: [] };

  for (const { surface, messages } of english) {
    const previous = existing.get(surface) ?? {};
    const out = {};
    for (const [key, source] of Object.entries(messages)) {
      unknown.delete(key);
      const text = flat[key];
      let added = null;
      if (typeof text === 'string' && text.trim() !== '') added = 'fresh';
      else if (previous[key] !== undefined) added = 'carried';
      if (added === null) {
        result.missing += 1;
        continue;
      }
      let candidate = added === 'fresh' ? translatedEntry(source, text) : previous[key];
      const isEnglish = (value) =>
        !NEAR_EN_LOCALES.has(locale) &&
        value.message === source.message &&
        source.message.length > 3;
      // A later submission that re-sends the English text must never overwrite a translation the
      // locale already had: the earlier work wins, and only a genuinely new translation replaces it.
      if (added === 'fresh' && isEnglish(candidate) && previous[key] !== undefined) {
        candidate = previous[key];
        added = 'carried';
      }
      if (isEnglish(candidate)) result.untranslated += 1;
      out[key] = candidate;
      result[added] += 1;
    }
    for (const key of [...unknown]) {
      const base = pluralBaseOf(key);
      if (base === null || messages[`${base}_other`] === undefined) continue;
      unknown.delete(key);
      const text = flat[key];
      if (typeof text !== 'string' || text.trim() === '') continue;
      out[key] = translatedEntry(messages[`${base}_other`], text);
      result.fresh += 1;
    }
    for (const [key, value] of Object.entries(previous)) {
      const base = pluralBaseOf(key);
      if (out[key] === undefined && base !== null && messages[`${base}_other`] !== undefined) {
        out[key] = value;
        result.carried += 1;
      }
    }
    write(surface, out);
  }
  result.unknown = [...unknown];
  return result;
}

/** Per-surface translation counts for one locale, and the totals across them. */
export function translationProgress(root, locale) {
  const english = readSurfaceFiles(root, 'en');
  if (english === null) throw new Error('en catalogue missing');
  const translated = readSurfaceFiles(root, locale);
  if (translated === null) return null;
  const byFile = new Map(translated.map(({ surface, messages }) => [surface, messages]));
  const rows = [];
  let done = 0;
  let comparableTotal = 0;
  for (const { surface, messages } of english) {
    const theirs = byFile.get(surface) ?? {};
    const comparable = Object.keys(messages).filter(
      (key) => messages[key].message.length > 3 && /[a-z]{2}/.test(messages[key].message),
    );
    const translatedKeys = comparable.filter((key) =>
      NEAR_EN_LOCALES.has(locale)
        ? theirs[key] !== undefined
        : theirs[key] !== undefined && theirs[key].message !== messages[key].message,
    );
    done += translatedKeys.length;
    comparableTotal += comparable.length;
    rows.push({
      surface,
      translated: `${translatedKeys.length}/${comparable.length}`,
      missing: comparable.filter((key) => theirs[key] === undefined).length,
      sameAsEnglish: comparable.filter(
        (key) => theirs[key] !== undefined && theirs[key].message === messages[key].message,
      ).length,
    });
  }
  return { rows, done, total: comparableTotal };
}

/** Write _locales/<locale>/messages.json for every source locale. Returns the locales written. */
export function generateLocales(root, out) {
  const written = [];
  const present = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const locale of present) {
    const catalogue = readCatalogue(root, locale);
    const dir = join(out, locale);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'messages.json');
    const next = `${JSON.stringify(catalogue, null, 2)}\n`;
    if (!existsSync(path) || readFileSync(path, 'utf8') !== next) writeFileSync(path, next);
    written.push(locale);
  }
  return written;
}
