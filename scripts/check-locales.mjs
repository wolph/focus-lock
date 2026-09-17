// Validate every source catalogue under locales/ against en and the locale set.
// Run from the repo root: node scripts/check-locales.mjs
import { checkLocales } from './locales-lib.mjs';

const { errors, warnings } = checkLocales('locales');
for (const warning of warnings) console.warn(`warning: ${warning}`);
for (const error of errors) console.error(`error: ${error}`);
if (errors.length > 0) {
  console.error(`${errors.length} locale error(s)`);
  process.exit(1);
}
console.log(`locales ok, ${warnings.length} warning(s)`);
