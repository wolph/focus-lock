// Copy a built extension and repoint its default locale, so the UI renders in that language on a
// browser whose own UI language cannot be changed (macOS ignores --lang for extensions).
// Run from the repo root: node scripts/locale-preview-dist.mjs <locale> <output directory>
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES } from './locales-lib.mjs';

const [locale, output] = process.argv.slice(2);
if (locale === undefined || output === undefined) {
  console.error('usage: node scripts/locale-preview-dist.mjs <locale> <output directory>');
  process.exit(2);
}
if (!LOCALES.includes(locale)) {
  console.error(`${locale} is not in the locale set`);
  process.exit(2);
}

rmSync(output, { recursive: true, force: true });
cpSync('dist', output, { recursive: true, dereference: true });
const manifestPath = join(output, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.default_locale = locale;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// Chrome picks the catalogue for its own UI locale and only falls back to the default one when
// that locale has no catalogue at all. Leaving en in place would therefore keep the UI English on
// an English browser, so the preview build ships this locale and nothing else.
const localesDirectory = join(output, '_locales');
for (const present of readdirSync(localesDirectory)) {
  if (present !== locale) rmSync(join(localesDirectory, present), { recursive: true, force: true });
}
console.log(`${output}: ${locale} is now the only catalogue, and the default locale`);
