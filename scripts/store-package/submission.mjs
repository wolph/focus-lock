import { isDeepStrictEqual } from 'node:util';
import { PNG } from 'pngjs';
import {
  assert,
  assertString,
  assertStringArray,
  isObject,
  objectKeysAre,
  readJson,
  readRequiredFile,
  walkRegularFiles,
} from './files.mjs';
import { validateExtensionOriginFetch, validateTransportAllowlist } from './transport.mjs';

const PRIVACY_URL = 'https://wolph.github.io/focus-lock/privacy/';
const SCREENSHOTS = [
  'store/assets/screenshots/01-start-session.png',
  'store/assets/screenshots/02-blocked-page.png',
  'store/assets/screenshots/03-onboarding.png',
  'store/assets/screenshots/04-stats.png',
  'store/assets/screenshots/05-privacy-data.png',
];
const REQUIRED_SUBMISSION_KEYS = [
  'schemaVersion',
  'version',
  'shortDescription',
  'privacyPolicyUrl',
  'permissions',
  'optionalHostPermissions',
  'screenshots',
  'smallPromo',
  'icon128',
  'transportAllowlist',
];
const OPTIONAL_SUBMISSION_KEYS = ['marquee', 'extensionOriginFetch'];
const ALL_SITES_MATCHES = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validatePngStructure(buffer, relativePath) {
  assert(
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
    `Invalid PNG asset: ${relativePath}`,
  );
  let offset = PNG_SIGNATURE.length;
  let foundEnd = false;
  while (offset < buffer.length) {
    assert(buffer.length - offset >= 12, `Truncated PNG asset: ${relativePath}`);
    const dataLength = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + dataLength;
    assert(chunkEnd <= buffer.length, `Truncated PNG asset: ${relativePath}`);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    offset = chunkEnd;
    if (chunkType === 'IEND') {
      assert(dataLength === 0, `Invalid PNG IEND chunk: ${relativePath}`);
      foundEnd = true;
      break;
    }
  }
  assert(foundEnd, `Truncated PNG asset without IEND: ${relativePath}`);
  assert(offset === buffer.length, `PNG asset has trailing data: ${relativePath}`);
}

function validatePng(rootDirectory, relativePath, width, height) {
  const buffer = readRequiredFile(rootDirectory, relativePath, 'PNG asset');
  validatePngStructure(buffer, relativePath);
  let png;
  try {
    png = PNG.sync.read(buffer, { checkCRC: true });
  } catch (error) {
    throw new Error(
      `Invalid PNG asset ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(
    png.width === width && png.height === height,
    `PNG asset ${relativePath} has dimensions ${png.width}x${png.height}, expected ${width}x${height}`,
  );
  return buffer;
}

export function validateSubmissionManifest(value) {
  objectKeysAre(value, REQUIRED_SUBMISSION_KEYS, OPTIONAL_SUBMISSION_KEYS, 'Submission manifest');
  assert(Number.isInteger(value.schemaVersion), 'schemaVersion must be an integer');
  assert(value.schemaVersion === 1, 'schemaVersion must be exactly 1');
  for (const key of ['version', 'shortDescription', 'privacyPolicyUrl', 'smallPromo', 'icon128']) {
    assertString(value[key], key);
  }
  if (value.marquee !== undefined) assertString(value.marquee, 'marquee');
  assertStringArray(value.permissions, 'permissions');
  assertStringArray(value.optionalHostPermissions, 'optionalHostPermissions');
  assertStringArray(value.screenshots, 'screenshots');
  validateTransportAllowlist(value.transportAllowlist);
  validateExtensionOriginFetch(value.extensionOriginFetch);
  return value;
}

function containsAllSitesMatch(matches) {
  return Array.isArray(matches) && matches.some((match) => ALL_SITES_MATCHES.has(match));
}

function validateChromeVersion(version) {
  const components = version.split('.');
  assert(
    components.length >= 1 &&
      components.length <= 4 &&
      components.every(
        (component) => /^(0|[1-9][0-9]*)$/u.test(component) && Number(component) <= 65_535,
      ) &&
      components.some((component) => Number(component) > 0),
    'Built manifest version must contain one to four numeric Chrome version components',
  );
}

const MESSAGE_REFERENCE = /^__MSG_([A-Za-z0-9_@]+)__$/u;

/**
 * The manifest declares its name and description as message keys so the store listing is localised
 * with the rest of the UI. The store compares its own English text against what the default locale
 * says, so a key is resolved through that catalogue before the comparison rather than skipped.
 */
export function resolveManifestMessage(rootDirectory, manifest, value, label) {
  const reference = MESSAGE_REFERENCE.exec(value);
  if (reference === null) return value;
  const key = reference[1];
  assertString(manifest.default_locale, 'Built manifest default_locale');
  const messages = readJson(
    rootDirectory,
    `dist/_locales/${manifest.default_locale}/messages.json`,
    'default locale catalogue',
  );
  const entry = messages[key];
  assert(
    isObject(entry) && typeof entry.message === 'string' && entry.message !== '',
    `${label} names ${key}, which the ${manifest.default_locale} catalogue does not define`,
  );
  return entry.message;
}

export function validateBuiltManifest(manifest, submission, rootDirectory) {
  assert(isObject(manifest), 'Built manifest must be an object');
  assert(
    !Object.hasOwn(manifest, 'key'),
    'Built manifest key is forbidden in Chrome Web Store submissions',
  );
  assertString(manifest.version, 'Built manifest version');
  validateChromeVersion(manifest.version);
  assertString(manifest.description, 'Built manifest description');
  assert(isObject(manifest.icons), 'Built manifest icons must be an object');
  if (manifest.host_permissions !== undefined) {
    assertStringArray(manifest.host_permissions, 'Built manifest host_permissions');
  }
  if (manifest.content_scripts !== undefined) {
    assert(
      Array.isArray(manifest.content_scripts),
      'Built manifest content_scripts must be an array',
    );
    for (const contentScript of manifest.content_scripts) {
      assert(isObject(contentScript), 'Built manifest content_scripts entry must be an object');
      assertStringArray(contentScript.matches, 'Built manifest content_scripts matches');
      assertStringArray(contentScript.js, 'Built manifest content_scripts js');
    }
  }
  assert(
    submission.version === manifest.version,
    'Submission version must match built manifest version',
  );
  assert(
    submission.shortDescription ===
      resolveManifestMessage(
        rootDirectory,
        manifest,
        manifest.description,
        'Built manifest description',
      ),
    'Submission shortDescription must match built manifest description',
  );
  assert(
    submission.privacyPolicyUrl === PRIVACY_URL,
    `privacyPolicyUrl must be exactly ${PRIVACY_URL}`,
  );
  assertStringArray(manifest.permissions, 'Built manifest permissions');
  assertStringArray(manifest.optional_host_permissions, 'Built manifest optional_host_permissions');
  assert(
    isDeepStrictEqual(submission.permissions, manifest.permissions),
    'Submission permissions must exactly match built manifest permissions',
  );
  assert(
    isDeepStrictEqual(submission.optionalHostPermissions, manifest.optional_host_permissions),
    'Submission optionalHostPermissions must exactly match built manifest optional_host_permissions',
  );
  assert(
    !containsAllSitesMatch(manifest.host_permissions),
    'Required all-sites host_permissions are forbidden. Use optional host permissions',
  );
  for (const contentScript of manifest.content_scripts ?? []) {
    assert(
      !containsAllSitesMatch(contentScript?.matches),
      'Static content_scripts with required all-sites access are forbidden',
    );
  }
  assert(
    manifest.icons?.['128'] === submission.icon128,
    'Submission icon128 must match the built manifest 128 icon path',
  );
}

function validateScreenshotInventory(rootDirectory) {
  const screenshotDirectory = 'store/assets/screenshots';
  const files = walkRegularFiles(rootDirectory, screenshotDirectory);
  const paths = [...files.keys()].map((path) => `${screenshotDirectory}/${path}`);
  assert(
    isDeepStrictEqual(paths, SCREENSHOTS),
    `Store screenshots must be exactly: ${SCREENSHOTS.join(', ')}. Found: ${paths.join(', ')}`,
  );
}

export function validateAssets(rootDirectory, manifest, submission) {
  assert(
    isDeepStrictEqual(submission.screenshots, SCREENSHOTS),
    `screenshots must be the exact ordered five: ${SCREENSHOTS.join(', ')}`,
  );
  validateScreenshotInventory(rootDirectory);
  for (const screenshot of SCREENSHOTS) validatePng(rootDirectory, screenshot, 1280, 800);
  validatePng(rootDirectory, submission.smallPromo, 440, 280);
  if (submission.marquee !== undefined) validatePng(rootDirectory, submission.marquee, 1400, 560);
  const sourceIcon = validatePng(rootDirectory, submission.icon128, 128, 128);
  const builtIcon = validatePng(rootDirectory, `dist/${manifest.icons['128']}`, 128, 128);
  assert(sourceIcon.equals(builtIcon), 'Store icon128 must byte-match the built extension icon');
}
