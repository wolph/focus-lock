# Focus Lock

Chrome MV3 extension: Preact, TypeScript, Vite, Vitest, Playwright, Biome. Locales live in
`locales/` and are generated into `_locales/` by `npm run gen-locales`. `npm run check` is the
gate. It ends with `build:store`, which leaves an unkeyed manifest in `dist/`, so run `npm run
build` afterwards to get the keyed development build back.

## Product rules

`docs/product-rules.md` logs every behaviour the owner has asked for, verbatim and dated, with the
rule it became and the test that guards it. Read it before changing the popup, the blocked page,
Settings or the start flow. When the owner asks for a behaviour change, add the request to that
log in the same commit as the code, before the code changes. A change that breaks a logged rule is
a defect.

## Working here

- Never write into `.private-backups` without asking. `release/`, `dist-pages/` and
  `node_modules/` are symlinks into it.
- Keep `dist/` as the keyed development build the owner loads unpacked.
- British spelling, no semicolons, no em dashes in prose, comments and commit messages.
- Commit or push only when asked. Default branch is `master`.
