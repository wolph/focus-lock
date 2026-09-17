# Chrome Web Store release candidate 0.2.0

Candidate source: `HEAD` after the popup work, which is the tree the package was built from. Verified on 17 September
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
- The full browser suite passes outright: 116 passed, 20 skipped, nothing failed, exit status 0 in
  13.5 minutes. That includes all nine store-screenshot scenarios, which had been red for the whole
  of this release until the images were recaptured from this build.
- Two rounds of popup work sit between this candidate and 0.1.1, and the suite caught every
  regression rather than review. Making the session actions always visible broke 22 scenarios
  through one shared helper that clicked a disclosure that no longer exists. Moving the work tab
  chooser to the top left the popup with no enabled button in its core, so focus went nowhere when
  a gate closed. Two further scenarios still drove controls that had been deleted or renamed, one
  of them passing only against a stale pages build. All are fixed and pinned.
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

- **The locale layout spec does not run on this machine.** macOS takes the extension UI language
  from the operating system and ignores Chrome's `--lang` flag, so `locale-layout.spec.ts` skips
  with that reason instead of passing on a build that is still English underneath. That is 16 of
  the 20 skips in the run above, being the two layout scenarios across the eight stress locales.
  Long-word and right-to-left layout was checked against locale-pinned builds by hand, using
  `npm run locale-preview`. On a platform where `--lang` works, the spec runs the stress set
  unchanged.
- **Human review of all five screenshots is still the user's to give.** They were recaptured and
  read by the agent against the shipping interface, and all five are truthful, but
  [release gate step 5](../docs/release-candidate-gate.md#step-5-recapture-the-five-canonical-screenshots)
  asks for a person's eyes and that has not happened.
- **The detailed store description ships in English only.** See Languages below for why that one
  field cannot come from the package.
- Store review and publication remain pending. None of this represents approval by Google.

## Package

- Archive: `release/focus-lock-0.2.0.zip`
- SHA-256: `d00d4c0a7f468e648538fdb5662592710d760233aa1acf3f0df147e39bb1ec7a`
- Build tree SHA-256: `4ff505ffb345ffb821791ecae41ed256eb8a1a58372e14c9413c5621d28173e6`, over the 94
  files in `dist`, by the digest `store-screenshots.spec.ts` uses to decide whether a capture came
  from the build in front of it.
- The archive contains 94 files. That is 53 more than 0.1.1, and all 53 are message catalogues, so
  the shipped code is the same 41 files as the previous release.
- `name` and `description` ship as `__MSG_app_name__` and `__MSG_app_description__`. Chrome resolves
  both from the catalogue, and the package validator resolves them the same way before comparing the
  manifest against the submission manifest.
- The store manifest omits the development key.

## Icons

The toolbar icon is a green padlock drawn as large as the canvas allows, shut while a focus phase is
blocking sites and open the rest of the time. It replaces a line-art glyph that never got the green
treatment the store icon received in 0.1.1, so the product looked like two different things
depending on where you saw it.

The drawn icon and the static `idle-16.png` and `idle-32.png` now share one geometry, and the site's
mark in `docs/site/brand-icon.ts` opens its shackle the same way, so all three read as one lock. The
install and store icon at 48 and 128 keeps the brand tile from `brand.svg`, which is unchanged.

Two things the icon used to say and no longer does: the phase colour and the progress ring. Neither
survived at 16 pixels once the lock filled the frame, and both still exist on the badge, which shows
the phase colour and counts the session down. The shackle now follows whether sites are actually
blocked rather than whether a session exists, so a break and a pause draw it open. That matches
`isLocked` on the site, and it is the honest reading: nothing is blocked during a break.

## Screenshots

Recaptured from this build on 17 September 2026, at `2026-09-17T15:23:55.563Z`, against build
`4ff505ffb345`. `store-screenshots.spec.ts` checks that provenance on every run, so an
image that drifts behind the product fails the suite rather than reaching the listing quietly.

Only `04-stats.png` actually changed. The other four came back byte for byte identical, which is
the evidence that this release did not disturb the surfaces they show.

| Screenshot | SHA-256 |
| --- | --- |
| 01-start-session.png | `49c82ec940576348c37457bf90b99f39180ae65ac7b91e1af17c9a236e9fc324` |
| 02-blocked-page.png | `2b35d9536126a85c02a1ce16a799914d610e4bca1258a88833dc6636eed589af` |
| 03-onboarding.png | `673bc3b3d7f4c79fa3d00f839347675c5966971c7263f27d3f28a6a1895c2bfd` |
| 04-stats.png | `490a46d96f27c977f07280074da4a65e06fcdd5d5e436f7c8249ffe9e48b9f4c` |
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

Not yet submitted. The package is built and verified, and the upload is a dashboard action on the
publisher account that the agent cannot perform: see below.

- 0.1.1 is live. The dashboard shows it as Published, public, for both the draft and the published
  version. Uploading 0.2.0 replaces a published version rather than a pending draft.
- Upload `release/focus-lock-0.2.0.zip` on the package tab, then submit. Leave "Publish
  automatically after it has passed review" checked to match how 0.1.1 was submitted.
- Replace the five listing screenshots with the recaptured files in `store/assets/screenshots/`.
  The listing still carries the 0.1.0 images until someone uploads these.
- The store icon and both promo tiles are unchanged and need no action.
- Google's own dialog warns that review can take up to several weeks, so the published version stays
  0.1.1 until this passes. Nothing here represents approval by Google.

### Why the upload is not automated

Two routes were tried and both are closed, so this is a standing limitation rather than a one-off.

- The browser automation tool can drive the dashboard and the upload dialog, but its file-upload
  call refuses every path. It only accepts files inside a configured workspace root, and the
  persistent proxy in front of it never forwards any roots, so the allowed list is empty. Moving the
  file does not help.
- Chrome's own debugging endpoint on port 9222 answers 404 for every DevTools path, and macOS UI
  scripting through System Events times out without Accessibility permission, so neither the file
  chooser nor a synthetic drop can be driven.

Fixing the first of those, by giving the proxy a workspace root, would let a later release upload
itself. That is a change to the user's tooling and has not been made.
