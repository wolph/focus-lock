import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createReleasePackage, validatePackageManifest } from './store-package/archive.mjs';
import { forbiddenDistPath, readJson, walkRegularFiles } from './store-package/files.mjs';
import {
  validateAssets,
  validateBuiltManifest,
  validateSubmissionManifest,
} from './store-package/submission.mjs';
import {
  validateManifestExecutablePaths,
  validateTransportPolicy,
} from './store-package/transport.mjs';

function loadBaseInputs(rootDirectory) {
  const submission = validateSubmissionManifest(
    readJson(rootDirectory, 'store/submission-manifest.json', 'submission manifest'),
  );
  const manifest = readJson(rootDirectory, 'dist/manifest.json', 'built manifest');
  const distFiles = walkRegularFiles(rootDirectory, 'dist', forbiddenDistPath);
  validateBuiltManifest(manifest, submission, rootDirectory);
  validateManifestExecutablePaths(manifest);
  validateAssets(rootDirectory, manifest, submission);
  validateTransportPolicy(rootDirectory, submission);
  return { manifest, distFiles };
}

async function validateAll(rootDirectory, includePackageManifest) {
  const inputs = loadBaseInputs(rootDirectory);
  const packageManifestPath = join(rootDirectory, 'release', 'package-manifest.json');
  const currentZipPath = join(
    rootDirectory,
    'release',
    `focus-lock-${inputs.manifest.version}.zip`,
  );
  if (includePackageManifest && (existsSync(packageManifestPath) || existsSync(currentZipPath))) {
    await validatePackageManifest(rootDirectory, inputs.manifest, inputs.distFiles);
  }
  return inputs;
}

function parseArguments(argumentsList) {
  if (argumentsList.length === 0) return { createZip: false };
  if (argumentsList.length === 1 && argumentsList[0] === '--zip') return { createZip: true };
  throw new Error('Unknown CLI argument. Usage: node scripts/validate-store-package.mjs [--zip]');
}

async function main() {
  const { createZip } = parseArguments(process.argv.slice(2));
  const rootDirectory = process.cwd();
  if (!createZip) {
    await validateAll(rootDirectory, true);
    console.log('Chrome Web Store package inputs are valid.');
    return;
  }
  const { manifest, distFiles } = await validateAll(rootDirectory, false);
  const { zipRelativePath, checksum } = await createReleasePackage(
    rootDirectory,
    manifest,
    distFiles,
  );
  await validateAll(rootDirectory, true);
  console.log(`Created ${zipRelativePath} (${checksum}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
