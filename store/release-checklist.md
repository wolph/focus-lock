# Chrome Web Store release candidate 0.2.0

Candidate source: `43a4c98`, which is the tree the package was built from. Verified on 17 September
2026 with Node.js 24.18.0 and Chrome for Testing 151.0.7922.34.

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
- The full browser suite was run twice. The first run, before the fix below, was 109 passed, 20
  skipped and 4 failed in 14.7 minutes. One of those four was an assertion this release had made
  stale: the Stats count is now rendered through `Intl.NumberFormat`, so the page says `1,234,567`
  where the test still demanded `1234567`. The number was right and the test was old. `517e753`
  matches the digits with an optional group separator, so the assertion holds in every locale
  rather than in English only. The confirming run afterwards was 110 passed, 20 skipped and 3
  failed in 15.2 minutes, and all three failures are the screenshot gap described below.
- The five scenarios recorded as red against 0.1.1 all pass now. `indefinite-recovery.spec.ts` and
  `system.spec.ts` are green throughout, at 6 passed and 0 failed each, and the two `qa-flows`
  scenarios named there pass as well. Their recorded line numbers had drifted with this release, so
  they are named by file here rather than by line.
- The packaged-installation scenario passed against the archive recorded below. The release ZIP
  extracts under the archive safety rules and is the only loaded build, and the packaged artefact
  installs, onboards, blocks and survives a browser restart.
- The archive was rebuilt from a clean tree and came out byte-identical, which is what the recorded
  digest is worth: the same sources produce the same package.
- Right-to-left rendering was reviewed by hand in Arabic against a locale-pinned build, covering the
  popup, the options page, onboarding, stats and the block overlay.
- The store icon is the 128 pixel build output byte for byte, which the package validator enforces.

## What this candidate does not certify

- **Three scenarios still fail, all of them the screenshot gap.** `store-screenshots.spec.ts`
  refuses this build: the tracked images record build `4e99bfe76718` captured at
  `2026-09-12T12:38:33.853Z`, and this build is `93236ba8deab`. One scenario fails on that
  provenance check, one on `04-stats.png` differing from the tracked canonical PNG, and the third
  runs the same capture under a Pago Pago timezone and inherits the difference. The spec is correct
  to fail. Clearing it means recapturing the five images and having a person review them, which
  step 5 of the release gate requires and which has not been done.
- **The locale layout spec does not run on this machine.** macOS takes the extension UI language
  from the operating system and ignores Chrome's `--lang` flag, so `locale-layout.spec.ts` skips
  with that reason instead of passing on a build that is still English underneath. That is 16 of
  the 20 skips in the run above, being the two layout scenarios across the eight stress locales.
  Long-word and right-to-left layout was checked against locale-pinned builds by hand, using
  `npm run locale-preview`. On a platform where `--lang` works, the spec runs the stress set
  unchanged.
- **The five store screenshots were not recaptured.** They are still the 0.1.0 captures and their
  digests are unchanged, so the caveats recorded for 0.1.1 still stand: the popup summary in
  `01-start-session.png` is collapsed, and `03-onboarding.png` shows the permission step rather than
  the starting-lists step. They are also English, so nothing in the listing's images shows the new
  languages. For `04-stats.png` this is no longer a suspicion: a fresh capture from this build
  differs from the tracked file, so that image shows an interface the product no longer has.
- **Human review of all five screenshots remains outstanding**, as it was for 0.1.0 and 0.1.1.
  [Release gate step 5](../docs/release-candidate-gate.md#step-5-recapture-the-five-canonical-screenshots)
  requires a person to look at them.
- **The detailed store description ships in English only.** See Languages below for why that one
  field cannot come from the package.
- Store review and publication remain pending. None of this represents approval by Google.

## Package

- Archive: `release/focus-lock-0.2.0.zip`
- SHA-256: `1999f0734b943f5c4fc1e14fdb988c2fb1f4c46649f33a7b921391221dcfd4b3`
- Build tree SHA-256: `f0a2f1ac987e433981eeffdffd05bda254debd2de28d555bcf4bceb5e7807c47`, over the 94
  files in `dist`, by the digest `store-screenshots.spec.ts` uses to decide whether a capture came
  from the build in front of it.
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
