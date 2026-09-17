// Merge a flat {key: message} translation into locales/<locale>/<surface>.json.
// The surface split and every placeholder block are copied from the en catalogue, so a translator
// only writes message text and cannot break the placeholder contract. A partial file is welcome:
// keys it does not carry keep whatever the locale already had, which lets one locale be translated
// one surface at a time instead of in a single pass.
// Run from the repo root: node scripts/expand-translation.mjs <locale> <flat.json>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES, mergeTranslation } from './locales-lib.mjs';

const [locale, flatPath] = process.argv.slice(2);
if (locale === undefined || flatPath === undefined) {
  console.error('usage: node scripts/expand-translation.mjs <locale> <flat.json>');
  process.exit(2);
}
if (!LOCALES.includes(locale)) {
  console.error(`${locale} is not in the locale set`);
  process.exit(2);
}

const flat = JSON.parse(readFileSync(flatPath, 'utf8'));
const directory = join('locales', locale);
const result = mergeTranslation('locales', locale, flat, (surface, messages) => {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${surface}.json`), `${JSON.stringify(messages, null, 2)}\n`);
});

console.log(
  `${locale}: ${result.fresh} new, ${result.carried} kept, ${result.untranslated} still untranslated`,
);
if (result.unknown.length > 0) {
  console.error(
    `${result.unknown.length} key(s) are not in the catalogue: ${result.unknown.slice(0, 10).join(', ')}`,
  );
  process.exit(1);
}
