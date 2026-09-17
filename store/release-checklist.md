# Chrome Web Store release candidate 0.1.1

Candidate source: `2c6f6f6f0638c300c80698b6bb83a92667da659c`. Verified on 15 September 2026 with
Node.js 24.18.0 and Chrome for Testing 151.0.7922.34.

This candidate fixes the defect that made 0.1.0 unusable for anyone with a discarded or
not-yet-loaded tab open: Chrome refuses the content-script injection for such a tab without naming
a URL, the registration sweep treated that refusal as fatal, and Retry could not clear it because
the tab stayed unloaded.

## Verification

This candidate was gated on the fast path rather than the full release gate, at the request of the
person releasing it. What that covers, and what it does not, is recorded below rather than implied.

- Biome and TypeScript passed. All 178 unit files passed, with 4,843 tests passed and eight
  skipped.
- `npm run chrome:messages` passed, so every Chrome refusal message the sweep matches by text still
  exists verbatim in Chromium main.
- The keyless store build, package validation, QA inventory and privacy-page validation passed.
- The packaged-installation scenario passed against the archive recorded below.
- The store icon is the 128 pixel build output byte for byte, which the package validator enforces.

## What this candidate does not certify

- **The full browser suite was not run.** Five scenarios fail on a clean baseline build of
  committed master and are expected to fail on this branch too: `indefinite-recovery.spec.ts` at
  lines 297 and 538, `qa-flows.spec.ts` at lines 1392 and 1942, and `system.spec.ts` at line 319.
  Three of them wait on the popup after a worker or browser restart. The first CI browser job on
  this branch will be red on them, and that redness predates this release.
- **The five store screenshots were not recaptured.** They are the 0.1.0 captures, and their
  recorded provenance digest no longer matches this build. They were read against the shipping
  interface before being kept: the popup summary in `01-start-session.png` is collapsed, so the
  larger category membership does not appear in it, and `03-onboarding.png` shows the permission
  step rather than the starting-lists step. The blocklist growth in this release is therefore not
  visible in any of the five.
- **Human review of all five screenshots remains outstanding**, as it was for 0.1.0.
  [Release gate step 5](../docs/release-candidate-gate.md#step-5-recapture-the-five-canonical-screenshots)
  requires a person to look at them.
- Store review and publication remain pending. None of this represents approval by Google.

## Package

- Archive: `release/focus-lock-0.1.1.zip`
- SHA-256: `557bedc7af2322b44ee501d8e31e109b8886207cc0364649943b994798683a93`
- Build tree SHA-256: `91afe4f4b647837ff423e32f37e9cfcdd51530097e6b1ac55d4dca9a400ff7de`
- The archive contains 41 files, one more than 0.1.0, which is the added host-search module.
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

The extension name and the short description come from the message catalogue in the package, so
the Web Store shows them in the shopper's own language with no dashboard work. Every locale the
store supports has a catalogue, and a locale the store resolves to nothing falls back to English.

The detailed description is dashboard-only: the Web Store does not read it from the package, so a
translated listing has to be pasted per language under Store listing, Localised listings. That is
manual work and it is not part of the build. The listing text lives in `store/listing.md`.

## Submission

Submitted for review on 15 September 2026. The item status is Pending review, and
"Publish automatically after it has passed review" was left checked, so publication follows
approval without another visit to the dashboard.

- The listing store icon was replaced with the 128 pixel build output and the draft was saved.
- `release/focus-lock-0.1.1.zip` was uploaded on the package tab. The dashboard reports draft
  version 0.1.1 against published version 0.1.0.
- Google's own dialog warns that review can take up to several weeks, so the published version stays
  0.1.0 until it passes. Nothing here represents approval by Google.
