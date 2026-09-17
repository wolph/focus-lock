# Chrome Web Store release candidate 0.2.0

Candidate source: `33e4933f5a10a2f2fd55bc7c86d9da657e8c84f9`. Verified on 17 September 2026 with
Node.js 24.18.0 and Chrome for Testing 151.0.7922.34.

This candidate ships the interface in 53 languages. Chrome selects the catalogue from the browser's
UI language, so there is no picker and nothing for the user to configure. English stays the default
locale, and any key a catalogue lacks falls back to English rather than rendering empty.

## Verification

- The full release gate passed end to end, exit status 0: Biome, TypeScript, the catalogue check,
  the unit suite and the keyless store build. 184 unit files passed, with 4,952 tests passed and
  eight skipped.
- `node scripts/check-locales.mjs --complete` passed, exit status 0. The `--complete` form is the
  stricter release check: it refuses a catalogue that leaves too many keys sitting at their English
  text, so a locale that was never really translated cannot ship quietly.
- The catalogue check reports 11 warnings and no failures. Each one names a message more than twice
  its English length in Catalan, Greek, Filipino, Croatian, European Portuguese or Slovenian. A
  length warning is a layout hint, not a defect.
- The 53 catalogues carry 36,778 messages against 686 English keys.
- The packaged-installation scenario passed against the archive recorded below. The release ZIP
  extracts under the archive safety rules and is the only loaded build, and the packaged artefact
  installs, onboards, blocks and survives a browser restart.
- Right-to-left rendering was reviewed by hand in Arabic against a locale-pinned build, covering the
  popup, the options page, onboarding, stats and the block overlay.
- The store icon is the 128 pixel build output byte for byte, which the package validator enforces.

## What this candidate does not certify

- **The full browser suite was not run.** The five scenarios recorded against 0.1.1 failed on a
  clean baseline build of committed master at that time: `indefinite-recovery.spec.ts` at lines 297
  and 538, `qa-flows.spec.ts` at lines 1392 and 1942, and `system.spec.ts` at line 319. They were
  not re-run for this candidate, so their current state is unknown rather than known good.
- **The locale layout spec does not run on this machine.** macOS takes the extension UI language
  from the operating system and ignores Chrome's `--lang` flag, so `locale-layout.spec.ts` skips
  with that reason instead of passing on a build that is still English underneath. Long-word and
  right-to-left layout was checked against locale-pinned builds by hand, using
  `npm run locale-preview`. On a platform where `--lang` works, the spec runs the stress set
  unchanged.
- **The five store screenshots were not recaptured.** They are still the 0.1.0 captures and their
  digests are unchanged, so the caveats recorded for 0.1.1 still stand: the popup summary in
  `01-start-session.png` is collapsed, and `03-onboarding.png` shows the permission step rather than
  the starting-lists step. They are also English, so nothing in the listing's images shows the new
  languages.
- **Human review of all five screenshots remains outstanding**, as it was for 0.1.0 and 0.1.1.
  [Release gate step 5](../docs/release-candidate-gate.md#step-5-recapture-the-five-canonical-screenshots)
  requires a person to look at them.
- **The detailed store description ships in English only.** See Languages below for why that one
  field cannot come from the package.
- Store review and publication remain pending. None of this represents approval by Google.

## Package

- Archive: `release/focus-lock-0.2.0.zip`
- SHA-256: `484f8c0c9b0d1827f8dd9f41733537998411b84fd91cade2098f4c62261c3d29`
- The archive contains 94 files. That is 53 more than 0.1.1, and all 53 are message catalogues, so
  the shipped code is the same 41 files as the previous release.
- `name` and `description` ship as `__MSG_app_name__` and `__MSG_app_description__`. Chrome resolves
  both from the catalogue, and the package validator resolves them the same way before comparing the
  manifest against the submission manifest.
- The store manifest omits the development key.

## Screenshots

Unchanged from 0.1.0, captured at `2026-09-12T12:38:33.853Z`.

| Screenshot | SHA-256 |
| --- | --- |
| 01-start-session.png | `49c82ec940576348c37457bf90b99f39180ae65ac7b91e1af17c9a236e9fc324` |
| 02-blocked-page.png | `2b35d9536126a85c02a1ce16a799914d610e4bca1258a88833dc6636eed589af` |
| 03-onboarding.png | `673bc3b3d7f4c79fa3d00f839347675c5966971c7263f27d3f28a6a1895c2bfd` |
| 04-stats.png | `4bcb2e4a9661269b00a86f1d6d2c30be7b644d3a99d21d05ac6cd9f1722da5e4` |
| 05-privacy-data.png | `fb9bbf2970dca94e03df8edeb74467c002a26ec6bb2fddbc07760c2c61e99589` |

## Languages

The extension name and the short description come from the message catalogue in the package, so the
Web Store shows them in the shopper's own language with no dashboard work. Every locale the store
supports has a catalogue, and a locale the store resolves to nothing falls back to English.

The detailed description is dashboard-only: the Web Store does not read it from the package, so a
translated listing has to be pasted per language under Store listing, Localised listings. That is
manual work and it is not part of the build. The listing text lives in `store/listing.md`.

Filipino carries one documented allowance in the catalogue check. The detector that flags a
catalogue for reusing English vocabulary lets Filipino reach a quarter of its messages instead of
the usual 15 per cent, because the register Filipino software actually ships in borrows English
terms rather than coining native ones. The allowance is narrow: the separate limit on messages left
as the English text verbatim still holds Filipino to the same 10 per cent as every other locale,
and every other check applies unchanged.

## Submission

Not yet submitted. This candidate is built and verified, and the upload itself is a dashboard action
on the publisher account.

- 0.1.1 was submitted for review on 15 September 2026 and recorded as Pending review against
  published version 0.1.0. Uploading 0.2.0 replaces that pending draft rather than queueing behind
  it, so 0.1.1 will not reach the store.
- Upload `release/focus-lock-0.2.0.zip` on the package tab, then submit. Leave "Publish
  automatically after it has passed review" checked to match how 0.1.1 was submitted.
- The store icon in the listing is already the 128 pixel build output from the 0.1.1 submission and
  does not need replacing.
- Google's own dialog warns that review can take up to several weeks, so the published version stays
  0.1.0 until this passes. Nothing here represents approval by Google.
