# Product rules

Standing requirements the owner has asked for, in their words, with the date and what they mean
for the code. A change that breaks one of these is a defect, not a design decision to re-argue.
Add an entry the moment a new one is asked for, before the code changes.

Each rule has a test that fails when it is broken. A change that needs to violate one changes this
file first, with the owner's agreement recorded here, and the tests second.

## Log

| Date | Request, verbatim | Rule |
| --- | --- | --- |
| 2026-09-11 | "the session actions should be always visible in the popup when locked. just the unlock this site, unlock all sites and unlock. and add an extra button (still with the cooldown) to live exclude that site from the blocking" | 2, 7 |
| 2026-09-14 | "ik zie nogsteeds geen kleuren in de progressbar en ik zie ook een onnodige scrollbalk." | 1 |
| 2026-09-17 | "er zou geen scrollbalk nodig moeten zijn. [...] verberg die knoppen niet achter de Session actions dropdown en zorg ervoor dat alles direct zichtbaar is. Ik had dit eerder overigens ook al eens gevraagd. Daarnaast zie ik weer de tab dropdown in de popup, ook daar had ik om gevraagd om die weg te halen." | 1, 2, 3 |
| 2026-09-23 | "i want to make the changes to the settings live. it's confusing to have them apply only at a later time" | 4 |
| 2026-09-27 | "we're back at the tab-enforcement-failed error. also, it doesn't appear to remember which session length I selected previous" | 5 |
| 2026-09-27 | "when starting the session I want to be able to go from blacklist to whitelist mode as well" | 5, 6 |
| 2026-09-27 | "I don't want the option to choose the work tab in the popup before locking, it's not needed. Simply use the current tab as the work tab or none at all if it's not applicable. I do want the session type always visible. In fact, everything should be expanded and visible by default (after scrolling). make the popup wider too so the session type is easier to read." | 3, 6 |
| 2026-09-27 | "I don't see a button to exclude/unblock a website on the block page. We had that at some point..." | 7 |
| 2026-09-27 | "de unblock knoppen die credits kosten hebben geen wachttijd nodig" | 8 |

## Rule 1. The running-session popup needs no scrollbar

During a session, everything the popup shows fits the window Chrome gives it. No element inside
that view is a scroll container the person has to operate to reach a control. Content that does
not fit is cut or compacted, never scrolled.

The start form is the exception, by the 2026-09-27 request: it shows every setting in one column
and scrolls as a whole. Nothing inside it scrolls on its own except the rule list.

Tests: `tests/e2e/popup-visibility.spec.ts`, `tests/unit/popup/popup-layout.test.ts`.

## Rule 2. Session actions are always visible, in the popup and on the blocked page

The moment the popup opens during a session, the credit readout, Unlock this site, Unlock all
sites, the phase controls and End are on screen. The blocked page shows the same actions without
a click. No disclosure, no `<details>`, no summary, no toggle. An unavailable control is shown
disabled with its reason, never hidden.

Tests: `tests/e2e/popup-visibility.spec.ts`, `tests/unit/popup/work-tab.test.tsx`,
`tests/unit/content/overlay-v2.test.ts`.

## Rule 3. No work tab chooser anywhere in the popup

The start form takes the tab the popup opened on as the work tab when the draft's rules leave it
eligible, and otherwise none. It names that choice in one line and offers nothing to change it.
The running session offers "Make this my work tab" and "Change work tab" from the blocked page.
No `<select>` of open tabs appears in either view.

History: 2026-09-11 asked for the "use this tab" button to go and the dropdown to stay.
2026-09-17 removed the dropdown from the running session. 2026-09-27 removed it from the start
form too.

Tests: `tests/e2e/popup-visibility.spec.ts`, `tests/e2e/popup-work-tab.spec.ts`,
`tests/unit/popup/work-tab.test.tsx`.

## Rule 4. Settings changes are live

An edit in Settings reaches the running session as it is made. A Flexible or Friction session
takes it at once. A Hard session refuses an edit that would weaken it and queues it for the end of
the session, and says so where the edit was made. The start form says which of the two applies to
each session type.

Tests: `tests/unit/background/pending-policy-changes.test.ts`, `tests/e2e/qa-flows.spec.ts`.

## Rule 5. The start form remembers the last choices

The popup opens on the session length, session type and blocking mode chosen the previous time,
on this device. A remembered preset that Settings no longer offers is dropped and the rest kept.

Tests: `tests/unit/popup/remembered-choices.test.ts`, `tests/unit/popup/start-form.test.tsx`.

## Rule 6. Every start setting is on screen, in a 600 px popup

The start form shows session length, session type, blocking mode (with the allowed-domain field
when allowing selected sites only), intention, the work tab line, what will be blocked, and the
cycles row, in one scrolling column. Nothing is folded behind a disclosure. The popup is 600 px
wide so the three session types read as cards.

Tests: `tests/e2e/quiet-popup.spec.ts`, `tests/e2e/smoke.spec.ts`,
`tests/unit/popup/start-form.test.tsx`.

## Rule 7. The blocked page offers site access and exclusion without a click

The blocked page shows the site access credit, Unlock this site, Unlock all sites, Exclude this
site and End as soon as it renders. The popup's session actions carry the same Exclude this site.

Exclude this site stops blocking the current site for good: it opens the same deliberation gate as
an unlock (the same wait and, when Settings ask for it, a typed phrase), costs no credit, and on
confirmation edits the saved lists the way a Settings edit would. In block mode the block rule the
site matched goes, or the category that brought it records an exclusion. In allow mode the site
joins the allow list. A Hard session refuses it, and the button says so in place. A rule added for
the current session alone is not touched, so such a site stays blocked until the session ends.

Tests: `tests/unit/core/exclude-host.test.ts`, `tests/unit/background/session-controller-v2.test.ts`,
`tests/unit/content/overlay-v2.test.ts`, `tests/unit/popup/active-view.test.tsx`,
`tests/e2e/gates.spec.ts`.

## Rule 8. A spend that costs credit waits for nothing

Unlock this site and Unlock all sites already cost site access credit, so their gate is ready the
moment it opens: a confirm and a way back, no countdown. When Settings ask for a typed phrase, the
phrase still applies. The wait in Settings is for the gates that cost nothing: ending a Friction
session, and Exclude this site.

Tests: `tests/e2e/gates.spec.ts`, `tests/unit/background/session-controller-v2.test.ts`.
