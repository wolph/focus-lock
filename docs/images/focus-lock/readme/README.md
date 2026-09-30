# README product tour media

The README uses fresh captures from two sources. `focus-session.png`, `blocked-page.png` and `progress.png` come from the extension running in an isolated Playwright Chromium profile. `demo-poster.png` and `demo.gif` come from the interactive demo page at https://wolph.github.io/focus-lock/, which renders that same popup directly on the page and mounts that same lockscreen inside each fake browser tab's own iframe. The example task is "Finish the proposal". The work document and recorded history are demonstration data. Both sources render the product's own interface and handle the session and Back to work actions themselves.

| File | Capture |
| --- | --- |
| `focus-session.png` | The first 600 pixels of the 600-pixel-wide start form, ready to start a 25-minute session. The work tab line is further down the form. |
| `blocked-page.png` | The real blocking overlay on a locally served distracting page. |
| `progress.png` | The Stats overview with one completed hour yesterday and the live demonstration session. |
| `demo-poster.png` | A readable still of the lockscreen on the demo page's blocked Headlines tab. |
| `demo.gif` | A 10-second loop. Start locking the Headlines tab from the popup, the lockscreen, and Back to work returning to the draft. |

The blocked-page and animation frames are 960 by 640 pixels. Stats is 1280 pixels wide and ends after the first complete focus chart. Native Chrome browser chrome is outside every capture, though the animation frames do show the demo page's own drawn tab strip and toolbar, since that is the demo's content and not real browser chrome. Further Stats detail is below the captured viewport. Light theme comes from the extension's own settings for `focus-session.png`, `blocked-page.png` and `progress.png`, and from Playwright's `colorScheme` emulation for `demo-poster.png` and `demo.gif`, which run the demo page without touching the demo engine's own theme setting.

## Capture

Install the repository's locked dependencies and Playwright Chromium, with `ffmpeg` on `PATH`. Run from the repository root. A clean subprocess environment keeps unrelated account settings and credentials out of browser launch diagnostics:

```sh
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" node scripts/gen-icons.mjs
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" node node_modules/vite/bin/vite.js build
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" node node_modules/vite/bin/vite.js build --config vite.pages.config.ts
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" node scripts/build-pages.mjs
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" TZ=Europe/Amsterdam UPDATE_README_MEDIA=1 \
  node node_modules/@playwright/test/cli.js test tests/e2e/readme-media.spec.ts \
  -g 'captures the README product tour'
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  node node_modules/@playwright/test/cli.js test tests/e2e/readme-media.spec.ts \
  -g 'validates the README media inventory'
```

The first two build commands produce `dist/`, which `focus-session.png`, `blocked-page.png` and
`progress.png` capture from directly. The next two build `dist-pages/` (the same steps `npm run
pages:build` runs), which the capture test serves locally to record `demo-poster.png` and
`demo.gif` from the interactive demo page itself.

The capture test requires `UPDATE_README_MEDIA=1` before replacing tracked media. Without that flag it skips before creating a browser profile, and the inventory check still runs. It rejects `FOCUS_LOCK_E2E_DIST` overrides before launching a browser, so the recorded build is always the repository's `dist/`. Its fixture creates and closes its own extension profile. The store screenshot inventory is separate and unchanged.

The animation samples the interactive demo page eight times per second, not the extension inside real Chrome tabs. The demo opens idle on the Headlines tab with the popup open and the task typed. At two seconds it presses Start, which locks the tab the visitor is on: the real lockscreen mounts inside that tab's iframe. At six seconds it presses the lockscreen's own Back to work control and verifies that the demo page's fake tab strip switches to the draft, where it types a line, all inside one Chrome tab. `ffmpeg` encodes those frames with a 128-colour palette. Every output must stay below 5 MB.

`provenance.json` records the actual capture timestamp, source commit, extension version, tool versions, production build digest, package lock and capture script hashes, and each media file's byte count and SHA-256 hash. Its `reproductionInstructions` repeat the commands above as a recipe for a fresh run. Paths are repository-relative. The recorded history is one seeded completed hour and one blocked attempt yesterday. Session start, current blocking and return to the selected work tab use the running extension for `focus-session.png`, `blocked-page.png` and `progress.png`, and the interactive demo page embedding that same popup and lockscreen for `demo-poster.png` and `demo.gif`.

After capture, inspect each PNG at full size and inspect animation frames before and after the tab changes. Check text, clipping, spacing and the return destination. The fixture checks browser diagnostics. The inventory check validates file hashes and size limits, but visual inspection remains a separate step.
