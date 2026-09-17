// Per-surface translation progress for one locale, so a translator can check a chunk before moving
// to the next one instead of discovering at the end that most of a catalogue is still English.
// Run from the repo root: node scripts/translation-progress.mjs <locale>
import { translationProgress } from './locales-lib.mjs';

const [locale] = process.argv.slice(2);
if (locale === undefined) {
  console.error('usage: node scripts/translation-progress.mjs <locale>');
  process.exit(2);
}

const progress = translationProgress('locales', locale);
if (progress === null) {
  console.error(`${locale}: no catalogue yet`);
  process.exit(1);
}

console.table(progress.rows);
const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
console.log(`${locale}: ${progress.done}/${progress.total} translated (${percent}%)`);
const missing = progress.rows.reduce((total, row) => total + row.missing, 0);
const same = progress.rows.reduce((total, row) => total + row.sameAsEnglish, 0);
if (missing > 0) console.log(`${missing} messages are not written yet.`);
if (same > 0) {
  console.log(
    `${same} messages read the same as the English. That is right for a word your language shares, ` +
      'and wrong for one left untranslated.',
  );
}
if (progress.done < progress.total) process.exit(1);
