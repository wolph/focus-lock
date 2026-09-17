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
/**
 * The longest English message that may legitimately read the same in another language. A label
 * like Notifications, Intention or Date is genuinely shared by many languages, and so are product
 * names and the example domains inside placeholders. A whole sentence is not: an identical
 * sentence is padding, whatever it claims to be.
 */
const MAX_SHARED_MESSAGE_CHARS = 25;

/** A message with nothing to translate: placeholders, punctuation and spacing only. */
function hasNoWords(message) {
  return !/\p{Letter}/u.test(message.replace(/\$[A-Za-z0-9_]+\$/g, ''));
}

/** True when a translation reading exactly like the English cannot be an honest translation. */
export function isPadding(locale, sourceMessage, translatedMessage) {
  if (NEAR_EN_LOCALES.has(locale)) return false;
  if (translatedMessage !== sourceMessage) return false;
  // `$ACTION$: $DESTINATION$ ($HOSTNAME$)` has no words in it, so every language writes it the
  // same way however long it is. Only a message with something to translate can be padding.
  if (hasNoWords(sourceMessage)) return false;
  return [...sourceMessage].length > MAX_SHARED_MESSAGE_CHARS;
}

/**
 * Locales written in a script other than Latin. A message in one of these should carry no Latin
 * words of its own, so a run of Latin letters that is not a placeholder, a brand, a domain or a
 * regular expression is either untranslated English or the wreckage of a find and replace.
 */
const NON_LATIN_LOCALES = new Set([
  'am',
  'ar',
  'bg',
  'bn',
  'el',
  'fa',
  'gu',
  'he',
  'hi',
  'ja',
  'kn',
  'ko',
  'ml',
  'mr',
  'ru',
  'sr',
  'ta',
  'te',
  'th',
  'uk',
  'zh_CN',
  'zh_TW',
]);

/**
 * Latin text that belongs in any locale, whatever its script: placeholders, the product name,
 * brands, unit symbols, domains and the regular expressions the rule examples show. The domain
 * pattern allows the escaped dot a regular expression writes, so `/youtube\.com\/shorts/` is
 * consumed whole rather than leaving `com` behind.
 */
const ALLOWED_LATIN = [
  /\$[A-Za-z0-9_]+\$/g,
  /\/[^\s]*\//g,
  /(?:[A-Za-z0-9-]+\\?\.)+[A-Za-z]{2,}(?:\/[^\s]*)?/g,
  /Focus Lock/g,
  /Chrome/g,
  /Sync/g,
  /PNAS/g,
  /URL/g,
  /regex/gi,
  /HH:MM/g,
  /(?:[KMG]i?B|kB)/g,
  /\bON\b/g,
];

/**
 * Latin words left in a message whose language is not written in Latin script. This is the one
 * defect the other checks cannot see: a message half-translated by substituting words, or wrecked
 * by a find and replace that spliced letters into the middle of English words, differs from the
 * English source and so passes every byte comparison while still reading as English on screen.
 */
export function strayLatin(locale, message) {
  if (!NON_LATIN_LOCALES.has(locale)) return [];
  let rest = message;
  for (const pattern of ALLOWED_LATIN) rest = rest.replace(pattern, ' ');
  return [...rest.matchAll(/[A-Za-z]{2,}/g)].map((match) => match[0]);
}

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
    // A family nobody has touched yet is a gap like any other untranslated key: Chrome falls back
    // to the default locale for the whole family. A family that exists but lacks a form the
    // language needs is a defect, because that one count would render in the wrong form.
    if (have.size === 0) {
      errors.push(`${locale}: plural family ${base} is missing`);
    } else {
      for (const category of requiredCategories(locale)) {
        if (!have.has(category)) errors.push(`${locale}: plural family ${base} lacks _${category}`);
      }
    }
    const source = en[`${base}_other`] ?? en[`${base}_${[...enCategories][0]}`];
    for (const category of PLURAL_CATEGORIES) {
      const entry = catalogue[`${base}_${category}`];
      if (entry !== undefined) {
        checkEntry(locale, `${base}_${category}`, source, entry, errors, warnings);
      }
    }
  }
  for (const [key, entry] of Object.entries(catalogue)) {
    if (typeof entry.message !== 'string') continue;
    const stray = strayLatin(locale, entry.message);
    if (stray.length > 0) {
      errors.push(
        `${locale}: ${key} still carries Latin text in a non-Latin script: ${stray.slice(0, 4).join(', ')}`,
      );
    }
  }
  if (!NEAR_EN_LOCALES.has(locale)) {
    const comparable = Object.entries(en).filter(
      ([key, source]) =>
        PLURAL_SUFFIX.exec(key) === null &&
        catalogue[key] !== undefined &&
        // A short label, a product name, a glyph or a bare number can be the same in every
        // language, so only messages long enough to make sameness implausible are counted.
        [...source.message].length > MAX_SHARED_MESSAGE_CHARS &&
        !hasNoWords(source.message) &&
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
      warnings.push(
        `${locale}: ${key} is ${ratio.toFixed(2)}x the en length (${length} characters)`,
      );
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

/**
 * Run every check over a source root.
 *
 * A locale that is still being translated is not a broken build: Chrome falls back to the default
 * locale for a key the catalogue does not carry, so a half-finished language shows English for the
 * rest and nothing else changes. Those gaps are therefore counted and reported rather than failed.
 * What is always an error is a catalogue that would render wrongly: a placeholder the translation
 * drops or invents, a key that belongs to no message, a plural family missing a form the language
 * needs, or a catalogue that is almost entirely the English text. Pass `complete` for the release
 * gate, which additionally requires every locale to be finished.
 */
export function checkLocales(root, { complete = false } = {}) {
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
      (complete ? errors : warnings).push(`${locale}: not started`);
      continue;
    }
    const result = checkTranslation(locale, en, catalogue);
    const missing = result.errors.filter((error) => error.endsWith(' is missing'));
    const broken = result.errors.filter((error) => !error.endsWith(' is missing'));
    errors.push(...broken);
    if (missing.length > 0) {
      (complete ? errors : warnings).push(
        `${locale}: ${missing.length} message(s) not translated yet, falling back to ${DEFAULT_LOCALE}`,
      );
    }
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

/**
 * Restore a placeholder's closing dollar. Writing `$TIME` for `$TIME$` is the mistake translators
 * make most often, and it is unambiguous to repair: the name has to be one the English message
 * declares, and the text has to be missing that exact reference. Anything else is left alone.
 */
export function repairPlaceholders(source, text) {
  const declared = Object.keys(source.placeholders ?? {});
  if (declared.length === 0) return text;
  let repaired = text;
  for (const name of declared) {
    if (repaired.includes(`$${name}$`)) continue;
    repaired = repaired.replace(new RegExp(`\\$${name}(?!\\$)`, 'g'), `$${name}$`);
  }

  // A translator running a find and replace over the whole file can rewrite the inside of a
  // placeholder name, turning $ACTION$ into $ACTIBUKAS$ when the word ON was being replaced. The
  // repair is only attempted when the references left over and the names still unaccounted for
  // line up one for one, and then they are matched in the order they appear, which is the order
  // the names were written in.
  const referenced = [...repaired.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((match) => match[1]);
  const unknown = referenced.filter((name) => !declared.includes(name));
  const absent = declared.filter((name) => !referenced.includes(name));
  if (unknown.length > 0 && unknown.length === absent.length) {
    const seen = [];
    for (const name of unknown) if (!seen.includes(name)) seen.push(name);
    if (seen.length === absent.length) {
      seen.forEach((wrong, index) => {
        repaired = repaired.split(`$${wrong}$`).join(`$${absent[index]}$`);
      });
    }
  }
  return repaired;
}

function translatedEntry(source, text) {
  const message = repairPlaceholders(source, text);
  return source.placeholders === undefined
    ? { message }
    : { message, placeholders: source.placeholders };
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
      // A carried value is repaired too: a name a global find and replace rewrote was stored
      // before the repair existed, and nothing else would ever come back to it.
      let candidate =
        added === 'fresh'
          ? translatedEntry(source, text)
          : translatedEntry(source, previous[key].message);
      const isEnglish = (value) => isPadding(locale, source.message, value.message);
      const readsAsEnglish = (value) =>
        !NEAR_EN_LOCALES.has(locale) && value.message === source.message;
      // A later submission that re-sends the English text must never overwrite a translation the
      // locale already had, however short the message is: the earlier work wins, and only a
      // genuinely different translation replaces it.
      if (
        added === 'fresh' &&
        readsAsEnglish(candidate) &&
        previous[key] !== undefined &&
        !readsAsEnglish(previous[key])
      ) {
        candidate = previous[key];
        added = 'carried';
      }
      // Padding is not stored. Chrome falls back to the default locale for a key the catalogue
      // does not carry, which renders the same words without claiming they were translated.
      if (isEnglish(candidate)) {
        result.untranslated += 1;
        continue;
      }
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
