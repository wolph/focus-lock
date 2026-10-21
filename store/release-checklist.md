# Chrome Web Store release 0.2.1

Verified on 21 October 2026 with Node.js 26.8.2 and Chrome for Testing 151.0.7922.34.
The verified source is `b484a90ef97b7e9ed4a3c47a1f36032771d93d6c`. The release tag adds this
record and corrects the reviewer instructions for the current start form.

## Verification

- `NO_COLOR=1 npm run check` passed with exit status 0: Biome, TypeScript, catalogue checks,
  189 unit files, 5,021 passed tests, eight skipped tests and the store build.
- `npm run chrome:messages` passed. All seven injection messages match Chromium main.
- `npm run qa:validate` passed. The checklist inventory matches the suites.
- `npm run check-locales:complete` passed for all 53 catalogues, with 11 length warnings.
- `npm run store:package`, `npm run store:validate` and `npm run pages:validate` passed.
- `NO_COLOR=1 TZ=Europe/Amsterdam npm run e2e` passed with exit status 0: 122 passed,
  20 skipped, no failures, in 14.1 minutes.
- The browser run included installation from the exact ZIP, onboarding, blocking, browser restart,
  responsive surfaces, all nine store screenshot checks and the system scenarios.
- The worker bundle hash stayed unchanged across the full browser run.
- [CI run 39523119636](https://github.com/wolph/focus-lock/actions/runs/39523119636) passed its
  quality gate and all four Linux browser shards against the verified source.
- The migration scenario failed in a Honolulu timezone before its fixture correction and passed
  afterwards. The picker scenarios passed ten repeated runs and the Options scenario passed five
  repeated runs after their timing corrections. These changes affect the tests only.

## Package

- Archive: `release/focus-lock-0.2.1.zip`
- SHA-256: `0ece3e39d36acb5db1a66a391eef4ac521c9f8bf1688db1e81e99709a3e5e86c`
- Size: 1,250,305 bytes, containing 96 files.
- Build tree SHA-256: `92bb3e3ffe3f963f706dce9835e021bac89bdf2309f152fcc89ed289fea141e5`.
- Every archive entry matches its counterpart in `dist/` byte for byte. Packaged HTML references
  resolve to archive entries. The manifest is at the root and omits the development key.
- Packaging during the final browser gate reproduced the archive uploaded to the store exactly.
- The package validator accepted the manifest, assets and transport policy. The local favicon cache
  remains the only allowed fetch source.

## Screenshots

Captured from version 0.2.1 at `2026-10-21T00:27:45.778Z`. The popup capture now
starts at the blocking-mode controls and the blocked-page capture includes all session actions.
All five images are opaque 1280 by 800 PNGs. The timezone comparison and final capture matched
these canonical bytes.

| Screenshot | SHA-256 |
| --- | --- |
| 01-start-session.png | `491928d402dffbd773a11df5fb3cad4e250308aa5254df43243fc72e8667986e` |
| 02-blocked-page.png | `4963bfabd479dbba6e2137a2a53513d7b0409f6fd9994a55f39fede73cfaaa84` |
| 03-onboarding.png | `673bc3b3d7f4c79fa3d00f839347675c5966971c7263f27d3f28a6a1895c2bfd` |
| 04-stats.png | `135ac937619df8477455f6007ae750a6ceb112ea28007f75ec7656d6d893271e` |
| 05-privacy-data.png | `fb9bbf2970dca94e03df8edeb74467c002a26ec6bb2fddbc07760c2c61e99589` |

The user reviewed all five on 21 October 2026 and confirmed: "Reviewed, all five look correct".
The uploaded screenshots match those reviewed files. The existing description and promotional
assets remain in use. Reviewer instructions link to the current repository.

## Coverage limits

Sixteen locale-layout scenarios skip on macOS because Chrome uses the operating system's UI
language there. The Linux CI suite runs those scenarios. The other four local skips are the
explicitly disabled registration-failure scenario and the opt-in indefinite, locale and README
capture scenarios. The unit suite retains its eight declared skips.

## Submission

Version 0.2.1 was submitted at `2026-10-21T01:00:29Z` for extension
`lfhgncahaaenflajfdolbkgiglppdgjm`. The dashboard confirmed "Your extension was submitted for
review" and shows "Pending review". Automatic publication after approval is enabled.

Google approval remains pending. The public version remains 0.2.0 until Google publishes the update.
The privacy policy at <https://wolph.github.io/focus-lock/privacy/> returned HTTP 200 before
submission. No permissions were added compared with 0.2.0.
