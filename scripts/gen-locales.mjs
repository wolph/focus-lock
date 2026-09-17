// Merge locales/<locale>/*.json into _locales/<locale>/messages.json for Chrome.
// Run from the repo root: node scripts/gen-locales.mjs
import { generateLocales } from './locales-lib.mjs';

const written = generateLocales('locales', '_locales');
console.log(`generated _locales for ${written.length} locales`);
