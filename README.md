<div align="center">

<img src="https://github.com/wolph/focus-lock/raw/refs/heads/master/assets/icons/idle-128.png" width="48" height="48" alt="">

# Focus Lock

### Stay with the task you chose.

Block distracting websites, keep your next step in view, and get back to work with one click.

<a href="https://chromewebstore.google.com/detail/focus-lock/lfhgncahaaenflajfdolbkgiglppdgjm"><img src="https://img.shields.io/chrome-web-store/v/lfhgncahaaenflajfdolbkgiglppdgjm?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Install Focus Lock from the Chrome Web Store"></a>

**[Try the interactive demo](https://wolph.github.io/focus-lock/)**

**[Get started](#get-started)** | [Take the tour](#a-little-help-staying-on-track) | [Your privacy](#your-browsing-stays-yours)

</div>

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="https://github.com/wolph/focus-lock/raw/refs/heads/master/docs/images/focus-lock/readme/demo-poster.png">
  <img src="https://github.com/wolph/focus-lock/raw/refs/heads/master/docs/images/focus-lock/readme/demo.gif" width="960" alt="A distracting page is blocked. Back to work returns to the chosen proposal tab.">
</picture>

*A short detour, then back to the task. [View the still image](https://github.com/wolph/focus-lock/raw/refs/heads/master/docs/images/focus-lock/readme/demo-poster.png).* Screenshots and demo use an isolated browser profile with demonstration data.

## A little help staying on track

### Choose what gets your attention

Name the task you want to finish, choose a duration, and select the sites to put aside. Start with a 15, 25 or 50-minute session, enter your own duration, or keep focusing until you choose to stop.

Block distracting categories and individual sites, or allow only the sites you need. Choose a Flexible session, add Friction before ending early, or commit to a timed Hard lock.

<p align="center">
  <img src="https://github.com/wolph/focus-lock/raw/refs/heads/master/docs/images/focus-lock/readme/focus-session.png" width="480" alt="Focus Lock session controls with the task Finish the proposal, a focus duration and a chosen work tab.">
</p>

### Catch the detour and return to work

Open a blocked site and Focus Lock puts your task back in front of you. **Back to work** takes you straight to your chosen tab. Choose another work tab from the lockscreen whenever you need to.

Search open tabs by title or website when the right one is buried. Selecting a work tab does not exempt it from your blocking rules.

Pages you already had open are covered and muted in place. When blocking ends, their forms, scroll position and page state remain. A freshly blocked navigation reloads when access returns.

![A blocked page keeps Finish the proposal visible, with a Back to work button pointing to the work tab.](https://github.com/wolph/focus-lock/raw/refs/heads/master/docs/images/focus-lock/readme/blocked-page.png)

### Find a rhythm that fits your day

Schedule focus sessions, alternate work with breaks, or earn site access credit for a temporary unlock. You can always step away from the screen without spending credit.

See focused time, session history and patterns in Statistics. Use the record to adjust your routine, whether that means a shorter session or fewer distractions next time.

![Focus statistics with a modest demonstration history, showing focused time and completed sessions.](https://github.com/wolph/focus-lock/raw/refs/heads/master/docs/images/focus-lock/readme/progress.png)

## Get started

Install from source with **Node.js 24.15+ (24.x)**, npm and Google Chrome:

```sh
git clone https://github.com/wolph/focus-lock.git
cd focus-lock
npm ci
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked**, then select the generated `dist` directory.
3. Pin Focus Lock from Chrome's Extensions menu and open it to complete setup.
4. Enter your task, choose what to block, and start your first session.

For incognito blocking, enable **Allow in Incognito** on the extension's details page. After rebuilding, click **Reload** there to use the updated files.

## Your browsing stays yours

Focus Lock sends no extension data to a developer-controlled server. Full URLs, focus intentions, detailed events and live sessions stay in your local Chrome profile.

Chrome Sync is optional. If you enable it during setup, it shares settings, lists, site access credit, streaks and aggregate statistics. Live sessions do not move between devices.

**[Read the privacy disclosures](https://github.com/wolph/focus-lock/blob/master/store/privacy-disclosures.md)** | [Report a problem](https://github.com/wolph/focus-lock/issues)

## What to know before you start

Focus Lock blocks websites in Chrome, not other apps or devices. It cannot block Chrome's internal pages or the Chrome Web Store, and you can disable the extension yourself. A page can load before blocking applies if Chrome has not woken the blocking worker.

Blocking covers whole tabs. It does not block embedded widgets on otherwise allowed pages.

Hard lock prevents ending a timed session through Focus Lock's controls. It cannot stop you disabling the extension. The defaults draw on published research. Its findings and limits are collected below.

Focus Lock speaks the language Chrome itself is set to. It ships every language the Chrome Web Store supports, so the popup, the block page, settings and stats all follow your browser without a setting to change. A language Chrome does not have a translation for falls back to English.

## More details

<details>
<summary><strong>Privacy, storage and deleting your data</strong></summary>

The stats page reports focus time, blocked attempts, resisted gates, site access credit spending, recent sessions, hourly and daily activity, streaks, and freeze tokens. The options page can export the detailed local event log as JSON.

Full URLs, focus intentions, detailed events, and live sessions remain in the local Chrome profile. Chrome Sync receives settings, lists, site access credit, streak state, and per-device daily and monthly session totals with domain-level blocked-attempt counts only after setup is confirmed with sync enabled. An active session therefore resumes in the same Chrome profile, but it does not move live to another machine. Aggregate sync is eventually consistent and can briefly show different totals across machines.

Focus Lock reads, writes, and deletes the disclosed Chrome Sync data through Chrome's extension APIs. The developer does not receive or retain a separate copy. Chrome and Google handle Chrome Sync under their own terms.

Focus Lock sends no extension data to a developer-controlled server. Settings > Privacy and data can export the local event log, disable sync, and separately delete remote Focus Lock data from Chrome Sync. Delete local history removes historical full URLs, focus intentions, and detailed session events from the local event log. In local-only mode, it also removes local aggregate statistics. It does not clear the current live-session runtime, which holds the focus intention and the address of each tab the session is blocking. A session set to run until stopped holds that runtime until the person ends it. Ending the session clears the intention and starts a cleanup that sends one clear instruction to each website tab open at the time, whether or not that tab was blocked. Each instruction holds that tab's address while the cleanup runs, and the cleanup removes every stored address when it completes.

The same page can also delete all Focus Lock data. Delete all Focus Lock data removes every Focus Lock record from this device and any Focus Lock copies left in Chrome Sync, then returns the extension to setup. It is available while no session is running.


</details>

<details>
<summary><strong>Research behind the defaults</strong></summary>

The defaults are evidence-informed, not a treatment claim. A short deliberation gate is based on the [one sec field experiment in PNAS](https://www.pnas.org/doi/abs/10.1073/pnas.2213114120) and its [longitudinal CHI follow-up](https://dl.acm.org/doi/10.1145/3613904.3642370). Scheduled breaks are supported by the [Biwer et al. comparison of systematic and self-regulated breaks](https://bpspsychub.onlinelibrary.wiley.com/doi/abs/10.1111/bjep.12593), while the [Albulescu et al. meta-analysis](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0272460) supports short breaks for vigour and fatigue more clearly than for performance. Visible time follows the adult ADHD time-perception evidence summarised in this [peer-reviewed review](https://pmc.ncbi.nlm.nih.gov/articles/PMC9962130/). Precommitted strictness follows the drift documented by [Not Now, Ask Later](https://dl.acm.org/doi/fullHtml/10.1145/3411764.3445695). No published trial establishes Focus Lock itself, a 25/5 optimum for adults with ADHD, a 52/17 rule, a 90-minute biological work cycle, a 23-minute refocus time, or a benefit from completion sounds. Those claims are deliberately absent from the UI.


</details>

<details>
<summary><strong>Development and media capture</strong></summary>

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite development mode |
| `npm run build` | Build the unpacked extension into `dist` with a stable local extension ID |
| `npm run build:store` | Build the Chrome Web Store extension into `dist` without a manifest key |
| `npm run typecheck` | Run strict TypeScript checks |
| `npm run lint` | Check formatting and lint rules with Biome |
| `npm run format` | Apply Biome formatting fixes |
| `npm test` | Run the Vitest unit and component suite |
| `npm run e2e` | Build and run Playwright against an isolated Chromium profile |
| `npm run check` | Run Biome, TypeScript, Vitest, and a Chrome Web Store build |

The end-to-end suite uses local test pages and an isolated browser profile. It does not need your normal Chrome profile.

Before adding tests, read [docs/testing-rules.md](docs/testing-rules.md). It is six rules with the evidence that earned them, and the first one is the one that catches everybody.

Before preparing a Chrome Web Store submission, read [docs/release-candidate-gate.md](docs/release-candidate-gate.md). It is ten ordered steps with the symptom each failure presents, because most of them fail in more than one way and several look like product defects while being the opposite.


`npm run dev` and `npm run build` include a fixed public key so unpacked builds keep the same extension ID. `npm run build:store` omits that key for Chrome Web Store submissions. `npm run store:package` uses the store build and rejects packages containing a manifest key. Chrome Sync requires profiles signed into the same Google account with extension sync enabled. Keep the corresponding private signing key untracked and backed up outside Git.

To regenerate the README screenshots and demo, see [the media capture instructions](docs/images/focus-lock/readme/README.md).

</details>
