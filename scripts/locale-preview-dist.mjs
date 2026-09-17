// Copy a built extension and repoint its default locale, so the UI renders in that language on a
// browser whose own UI language cannot be changed (macOS ignores --lang for extensions).
// Run from the repo root: node scripts/locale-preview-dist.mjs <locale> <output directory>
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LOCALE, LOCALES } from './locales-lib.mjs';

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
const messagesPath = (which) => join(localesDirectory, which, 'messages.json');
const preview = JSON.parse(readFileSync(messagesPath(locale), 'utf8'));
const english = JSON.parse(readFileSync(messagesPath(DEFAULT_LOCALE), 'utf8'));

// With only one catalogue in the build there is nothing left to fall back to, so a key this
// locale has not translated yet would render as its own name. Filling the gaps from English keeps
// a half-finished locale reviewable: the direction and the layout are what this build is for.
let filled = 0;
for (const [key, entry] of Object.entries(english)) {
  if (preview[key] !== undefined) continue;
  preview[key] = entry;
  filled += 1;
}
writeFileSync(messagesPath(locale), `${JSON.stringify(preview, null, 2)}\n`);

for (const present of readdirSync(localesDirectory)) {
  if (present !== locale) rmSync(join(localesDirectory, present), { recursive: true, force: true });
}
if (filled > 0) console.log(`${filled} message(s) filled in from ${DEFAULT_LOCALE} for the preview`);
console.log(`${output}: ${locale} is now the only catalogue, and the default locale`);
