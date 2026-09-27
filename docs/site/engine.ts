/**
 * The demo's stand-in for the background worker. It answers the popup and the lockscreen over the
 * real message types, drives the real session and matcher code from src/core, and builds the real
 * overlay views with the background's own builders. What it leaves out is everything that needs a
 * browser: storage, alarms, real tabs. A request outside the demo's subset throws, so an unhandled
 * type shows up as an error in the console rather than as a silent blank panel.
 */
import { endAuthorityV2 } from '../../src/background/lifecycle-projection-v2';
import { buildActiveOverlayView } from '../../src/background/overlay-view-v2';
import { accrue, msUntilAffordable, spend } from '../../src/core/budget';
import { ALL_CATEGORIES } from '../../src/core/categories';
import { excludedLists } from '../../src/core/exclude-host';
import {
  type CompiledMatcher,
  compileMatcher,
  compileSessionMatcher,
  evaluateUrl,
} from '../../src/core/matcher';
import {
  advanceSessionV2,
  assertCanStartNextFocusEarlyV2,
  beginPauseV2,
  commitResumeV2,
  focusedMsAtV2,
  type SessionAdvanceResultV2,
  startSessionV2,
} from '../../src/core/session-v2';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  GATE_EXPIRY_MS,
} from '../../src/shared/constants';
import type { DocumentContentCommand, DocumentOverlayView } from '../../src/shared/enforcement-v2';
import { CANONICAL_CLEAR_VERDICT } from '../../src/shared/enforcement-v2-validation';
import { CoreError } from '../../src/shared/errors';
import { exactDataEqual } from '../../src/shared/exact-data';
import type { Broadcast, Request, ResponseMap } from '../../src/shared/messages';
import type {
  BankState,
  GateState,
  ListsConfig,
  SessionConfigV2,
  SessionMode,
  SessionRuleSnapshot,
  SessionSnapshotV2,
  SessionStateV2,
  Settings,
  SetupState,
  SiteUnlock,
  Verdict,
} from '../../src/shared/types';
import type { WorkTab } from '../../src/shared/work-target';
import {
  activateTab,
  activeTab,
  createTabStrip,
  type DemoTab,
  hostnameOf,
  type TabStrip,
  tabById,
} from './tabs-model';

export type DemoEvent =
  | { type: 'sessionStarted' }
  | { type: 'blocked'; tabId: number }
  | { type: 'returnedToWork'; tabId: number }
  | { type: 'sessionEnded' };

export interface DemoEngine {
  handle<T extends Request['type']>(
    request: Extract<Request, { type: T }>,
  ): Promise<ResponseMap[T]>;
  strip(): TabStrip;
  activate(tabId: number): void;
  onBroadcast(listener: (message: Broadcast) => void): () => void;
  onEvent(listener: (event: DemoEvent) => void): () => void;
  tick(): void;
}

/** The overlay's economy row, computed fresh from the current bank and settings on every read. */
interface Economy {
  bankMs: number;
  bankAccrualPerMs: number;
  bankCapMs: number;
  pauseCostMs: number;
  unlockCostMs: number;
}

interface EngineState {
  strip: TabStrip;
  settings: Settings;
  lists: ListsConfig;
  session: SessionStateV2 | null;
  matcher: CompiledMatcher | null;
  gate: GateState | null;
  bank: BankState;
  /** focus ms already turned into bank credit, so settle() accrues only the elapsed remainder. */
  accruedFocusMs: number;
  /** when settle() last published for credit accrual alone, so that tick is throttled to 1/s. */
  lastCreditPublishAt: number;
  unlocks: SiteUnlock[];
  workTabId: number | null;
  enforcementEpoch: string;
  runtimeRevision: number;
  attemptsToday: number;
}

/** How often settle() may publish for credit accrual alone, with nothing else observable to report. */
const CREDIT_PUBLISH_INTERVAL_MS: number = 1_000;

const DEMO_LISTS: ListsConfig = {
  ...DEFAULT_LISTS,
  custom: [
    { kind: 'host', pattern: 'headlines.example' },
    { kind: 'host', pattern: 'videos.example' },
  ],
};

const DEMO_SETUP: SetupState = {
  ...DEFAULT_SETUP,
  completed: true,
  websiteAccess: 'granted',
  blockingRegistration: 'ready',
  storageMode: 'local',
};

const NOT_ACTIVE: { ok: false; code: 'no-active-session'; error: string } = {
  ok: false,
  code: 'no-active-session',
  error: 'No focus session is running.',
};

function uuid(): string {
  return crypto.randomUUID();
}

export function createDemoEngine(now: () => number): DemoEngine {
  const state: EngineState = {
    strip: createTabStrip(),
    settings: structuredClone(DEFAULT_SETTINGS),
    lists: structuredClone(DEMO_LISTS),
    session: null,
    matcher: null,
    gate: null,
    bank: { balanceMs: 0 },
    accruedFocusMs: 0,
    lastCreditPublishAt: 0,
    unlocks: [],
    workTabId: null,
    enforcementEpoch: uuid(),
    runtimeRevision: 0,
    attemptsToday: 0,
  };
  const broadcastListeners: Set<(message: Broadcast) => void> = new Set();
  const eventListeners: Set<(event: DemoEvent) => void> = new Set();

  const broadcast = (message: Broadcast): void => {
    for (const listener of broadcastListeners) listener(message);
  };
  const emit = (event: DemoEvent): void => {
    for (const listener of eventListeners) listener(event);
  };

  const economy = (): Economy => ({
    bankMs: state.bank.balanceMs,
    bankAccrualPerMs: state.session?.phase === 'focus' ? state.settings.pause.earnRatio : 0,
    bankCapMs: state.settings.pause.capMs,
    pauseCostMs: state.settings.pause.pauseMs,
    unlockCostMs: state.settings.pause.unlockMs,
  });

  const snapshot = (): SessionSnapshotV2 => {
    const at: number = now();
    const session: SessionStateV2 | null = state.session;
    const lifecycle: SessionSnapshotV2['lifecycle'] =
      session === null
        ? { kind: 'idle', endAuthority: { kind: 'hidden' } }
        : {
            kind: 'active',
            endAuthority: endAuthorityV2(
              session.config.strictness,
              session.config.duration,
              state.gate,
              session.config.intention,
            ),
          };
    return {
      at,
      theme: state.settings.theme,
      lifecycle,
      phase: session === null ? 'idle' : session.phase,
      config: session === null ? null : structuredClone(session.config),
      startedAt: session?.startedAt ?? null,
      phaseStartedAt: session?.phaseStartedAt ?? null,
      phaseEndsAt: session?.phaseEndsAt ?? null,
      sessionEndsAt: session?.sessionEndsAt ?? null,
      sessionFocusedMs: session === null ? 0 : focusedMsAtV2(session, at),
      cycleIndex: session?.cycleIndex ?? 0,
      ...economy(),
      activeUnlocks: state.unlocks.filter((unlock: SiteUnlock): boolean => unlock.until > at),
      gate: session === null ? null : structuredClone(state.gate),
      attemptsToday: state.attemptsToday,
      scheduleActive: false,
      nextSchedule: null,
    };
  };

  const publish = (): void => {
    state.runtimeRevision += 1;
    broadcast({ type: 'stateChanged', snapshot: snapshot() });
  };

  const endSession = (): void => {
    state.session = null;
    state.matcher = null;
    state.gate = null;
    state.unlocks = [];
    state.workTabId = null;
    state.accruedFocusMs = 0;
    state.enforcementEpoch = uuid();
    publish();
    broadcast({ type: 'reevaluate' });
    broadcast({ type: 'workTargetChanged' });
    emit({ type: 'sessionEnded' });
  };

  const accrueFocusCredit = (session: SessionStateV2, at: number): void => {
    const focusedMs: number = focusedMsAtV2(session, at);
    state.bank = accrue(state.bank, focusedMs - state.accruedFocusMs, state.settings.pause);
    state.accruedFocusMs = focusedMs;
  };

  /**
   * Settles the session through `now()`. `handle()` calls this on every request and a reevaluate
   * broadcast makes every open tab call `getBlockState`, which calls `handle()` again, so publishing
   * on every call would loop the demo tab forever. `advanceSessionV2` always hands back a fresh
   * clone even when nothing moved, so reference inequality cannot tell "changed" from "settled
   * again at the same instant": only a value comparison on the fields a viewer can actually observe
   * can. `exactDataEqual` on the whole session state stands in for that comparison in one call,
   * because every field the phase machine can move (phase, its boundaries, the cycle index, even
   * `focusedMs`) already lives on that object, and nothing else about a settle changes it.
   */
  const settle = (): void => {
    const session: SessionStateV2 | null = state.session;
    if (session === null) return;
    const at: number = now();
    const gateWasOpen: boolean = state.gate !== null;
    if (
      state.gate !== null &&
      state.gate.openedAt + GATE_EXPIRY_MS + state.settings.gate.delayMs <= at
    ) {
      state.gate = null;
    }
    accrueFocusCredit(session, at);
    const result: SessionAdvanceResultV2 = advanceSessionV2(session, at);
    if (result.kind === 'timer-completed') {
      endSession();
      return;
    }
    if (result.kind === 'resume-required') {
      state.session = commitResumeV2(result.state, at);
      publish();
      broadcast({ type: 'reevaluate' });
      return;
    }
    state.session = result.state;
    const gateIsOpen: boolean = state.gate !== null;
    if (gateWasOpen !== gateIsOpen || !exactDataEqual(session, result.state)) {
      publish();
      broadcast({ type: 'reevaluate' });
      return;
    }
    // Nothing a viewer can see moved, but the bank may have: publish that alone, throttled to once
    // a demo second, so the popup's credit line still advances without waking every open tab.
    if (at - state.lastCreditPublishAt >= CREDIT_PUBLISH_INTERVAL_MS) {
      state.lastCreditPublishAt = at;
      publish();
    }
  };

  const verdictFor = (url: string): Verdict => {
    if (state.matcher === null || state.session === null || state.session.phase !== 'focus')
      return CANONICAL_CLEAR_VERDICT;
    return evaluateUrl(state.matcher, url, state.unlocks, now());
  };

  const commandsFor = (url: string): DocumentContentCommand[] => {
    const tab: DemoTab | undefined = state.strip.tabs.find(
      (candidate: DemoTab): boolean => candidate.url === url,
    );
    const documentId: string = tab === undefined ? url : `demo-tab-${String(tab.tabId)}`;
    const verdict: Verdict = verdictFor(url);
    const session: SessionStateV2 | null = state.session;
    const reset: DocumentContentCommand = {
      version: 1,
      command: 'reset-enforcement-epoch',
      operationId: uuid(),
      enforcementEpoch: state.enforcementEpoch,
      documentId,
      expectedUrl: url,
    };
    if (session === null || !verdict.blocked) {
      return [
        reset,
        {
          version: 1,
          command: 'apply-enforcement',
          operationId: uuid(),
          enforcementEpoch: state.enforcementEpoch,
          sessionId: session?.sessionId ?? null,
          reservedSessionId: session === null ? uuid() : null,
          basePolicyRevision: 1,
          runtimeRevision: state.runtimeRevision,
          documentId,
          expectedUrl: url,
          presentation: 'clear',
          verdict: CANONICAL_CLEAR_VERDICT,
          overlay: null,
        },
      ];
    }
    const overlay: DocumentOverlayView = buildActiveOverlayView({
      targetUrl: url,
      capturedAt: now(),
      theme: state.settings.theme,
      session,
      economy: economy(),
      gate: state.gate,
      activeUnlocks: state.unlocks,
      attemptsToday: state.attemptsToday,
      stoppedPage: false,
      verdict,
    });
    if (tab !== undefined) {
      state.attemptsToday += 1;
      // Every open tab re-requests a verdict on every reevaluate broadcast, hidden ones included,
      // so a blocked distraction tab that never becomes active would otherwise fire this on session
      // start. The guide's beat is the visitor meeting the lockscreen, which only the active tab
      // shows, so this reports blocked only for the tab the visitor is actually looking at.
      if (tab.tabId === state.strip.activeTabId) emit({ type: 'blocked', tabId: tab.tabId });
    }
    return [
      reset,
      {
        version: 1,
        command: 'apply-enforcement',
        operationId: uuid(),
        enforcementEpoch: state.enforcementEpoch,
        sessionId: session.sessionId,
        reservedSessionId: null,
        basePolicyRevision: 1,
        runtimeRevision: state.runtimeRevision,
        documentId,
        expectedUrl: url,
        presentation: 'active',
        verdict,
        overlay,
      },
    ];
  };

  const eligibleWorkTabs = (): WorkTab[] =>
    state.strip.tabs
      .filter((tab: DemoTab): boolean => !verdictFor(tab.url).blocked)
      .map(
        (tab: DemoTab): WorkTab => ({
          tabId: tab.tabId,
          title: tab.title,
          hostname: hostnameOf(tab),
          lastAccessed: now(),
        }),
      );

  /**
   * The popup's pre-start listing: no session exists yet, so eligibility comes from the draft
   * policy the popup is about to start with, not from the live session's matcher (there is none).
   */
  const preStartWorkTabs = (
    mode: SessionMode,
    rules: SessionRuleSnapshot | undefined,
  ): WorkTab[] => {
    const matcher: CompiledMatcher =
      rules === undefined
        ? compileMatcher(state.lists, ALL_CATEGORIES, mode)
        : compileSessionMatcher(rules, ALL_CATEGORIES, mode);
    return state.strip.tabs
      .filter((tab: DemoTab): boolean => !evaluateUrl(matcher, tab.url, [], now()).blocked)
      .map(
        (tab: DemoTab): WorkTab => ({
          tabId: tab.tabId,
          title: tab.title,
          hostname: hostnameOf(tab),
          lastAccessed: now(),
        }),
      );
  };

  const openGate = (kind: GateState['kind'], host: string | null): void => {
    const at: number = now();
    // A spend costs credit and waits for nothing. The end and exclude gates keep the wait.
    const delayMs: number =
      kind === 'pause' || kind === 'unlockSite' ? 0 : state.settings.gate.delayMs;
    state.gate = {
      kind,
      host,
      openedAt: at,
      readyAt: at + delayMs,
      requiredPhrase: state.settings.gate.requireTypedPhrase ? 'end session' : null,
      forceEndAvailable: kind === 'cancel' && state.settings.gate.allowForceEnd,
    };
    publish();
    broadcast({ type: 'reevaluate' });
  };

  const gateReady = (expected: GateState): ResponseMap['confirmGate'] | null => {
    const gate: GateState | null = state.gate;
    if (gate === null) return { ok: false, code: 'no-active-gate', error: 'No gate is open.' };
    if (gate.openedAt !== expected.openedAt || gate.kind !== expected.kind)
      return { ok: false, code: 'no-active-gate', error: 'That gate is no longer open.' };
    if (now() < gate.readyAt)
      return {
        ok: false,
        code: 'gate-not-ready',
        error: 'Wait for the gate to finish counting down.',
      };
    return null;
  };

  const handle = async <T extends Request['type']>(
    request: Extract<Request, { type: T }>,
  ): Promise<ResponseMap[T]> => {
    settle();
    const answer: unknown = await answerRequest(request as Request);
    return answer as ResponseMap[T];
  };

  const answerRequest = async (request: Request): Promise<unknown> => {
    switch (request.type) {
      case 'getSetupState':
        return structuredClone(DEMO_SETUP);
      case 'getBootFailure':
        return { ok: true, failure: null };
      case 'getSettings':
        return structuredClone(state.settings);
      case 'getLists':
        return structuredClone(state.lists);
      case 'getSnapshot':
        return snapshot();
      case 'reconcileWebsiteAccess':
        return { ok: true, granted: true, registration: 'ready' };
      case 'dismissWebsiteAccessNotice':
      case 'openOnboarding':
        return { ok: true };
      case 'updateTheme':
        state.settings.theme = request.theme;
        publish();
        return { ok: true };
      case 'getWorkTabs':
        return 'sessionId' in request
          ? { ok: true, tabs: eligibleWorkTabs() }
          : { ok: true, tabs: preStartWorkTabs(request.mode, request.rules) };
      // The demo has no favicon service to ask, so every tab answers with no icon rather than
      // leaving the work tab picker's request unanswered and its throw silent.
      case 'getWorkTabIcon':
        return { ok: true, icon: null };
      case 'getWorkTarget': {
        const session: SessionStateV2 | null = state.session;
        if (session === null) return { ok: true, sessionId: null, state: 'missing', title: null };
        const tab: DemoTab | null =
          state.workTabId === null ? null : tabById(state.strip, state.workTabId);
        if (tab === null)
          return { ok: true, sessionId: session.sessionId, state: 'missing', title: null };
        if (verdictFor(tab.url).blocked)
          return { ok: true, sessionId: session.sessionId, state: 'unavailable', title: null };
        return {
          ok: true,
          sessionId: session.sessionId,
          state: 'ready',
          title: tab.title,
          hostname: hostnameOf(tab),
        };
      }
      case 'setWorkTarget': {
        if (state.session === null || state.session.sessionId !== request.sessionId)
          return { ok: false, error: 'The focus session has changed. Reopen the popup.' };
        if (tabById(state.strip, request.tabId) === null)
          return { ok: false, error: 'Choose an available work tab.' };
        state.workTabId = request.tabId;
        broadcast({ type: 'workTargetChanged' });
        return { ok: true };
      }
      case 'returnToWork': {
        if (state.session === null || state.session.sessionId !== request.sessionId)
          return { ok: false, error: 'The focus session has changed. Reopen the popup.' };
        if (state.workTabId === null) return { ok: false, error: 'Choose an available work tab.' };
        state.gate = null;
        state.strip = activateTab(state.strip, state.workTabId);
        publish();
        emit({ type: 'returnedToWork', tabId: state.workTabId });
        return { ok: true };
      }
      case 'getBlockState':
        return { commands: commandsFor(request.url) };
      case 'startSession': {
        if (state.session !== null)
          return { ok: false, code: 'invalid-request', error: 'A session is already running.' };
        const config: SessionConfigV2 = request.config;
        const session: SessionStateV2 = startSessionV2(config, now(), uuid());
        state.session = session;
        state.matcher = compileSessionMatcher(config.rules, ALL_CATEGORIES, config.mode);
        state.accruedFocusMs = 0;
        state.lastCreditPublishAt = now();
        state.workTabId = 'workTabId' in request ? request.workTabId : null;
        state.enforcementEpoch = uuid();
        publish();
        broadcast({ type: 'reevaluate' });
        broadcast({ type: 'workTargetChanged' });
        emit({ type: 'sessionStarted' });
        return { ok: true, code: 'ok' };
      }
      case 'requestSessionEnd': {
        if (state.session === null) return NOT_ACTIVE;
        if (state.session.config.strictness !== 'flexible')
          return {
            ok: false,
            code: 'end-not-allowed',
            error: 'This session ends through its gate.',
          };
        endSession();
        return { ok: true, code: 'ok' };
      }
      case 'openEndGate': {
        if (state.session === null) return NOT_ACTIVE;
        if (state.session.config.strictness !== 'friction')
          return { ok: false, code: 'end-not-allowed', error: 'This session has no end gate.' };
        openGate('cancel', null);
        return { ok: true, code: 'ok' };
      }
      case 'openGate': {
        if (state.session === null) return NOT_ACTIVE;
        // The lockscreen reports the document's own hostname, which in a demo tab is this
        // page's host, not the fictional one the tab is pretending to be. The document that
        // sent this request is always the active tab, so the demo trusts that instead of the
        // client-supplied host.
        const host: string | null =
          request.gate === 'unlockSite' || request.gate === 'excludeSite'
            ? hostnameOf(activeTab(state.strip))
            : null;
        openGate(request.gate, host);
        return { ok: true, code: 'ok' };
      }
      case 'abandonGate': {
        if (state.session === null) return NOT_ACTIVE;
        if (state.gate === null)
          return { ok: false, code: 'no-active-gate', error: 'No gate is open.' };
        state.gate = null;
        publish();
        broadcast({ type: 'reevaluate' });
        return { ok: true, code: 'ok' };
      }
      case 'confirmGate': {
        const session: SessionStateV2 | null = state.session;
        if (session === null) return NOT_ACTIVE;
        const refusal: ResponseMap['confirmGate'] | null = gateReady(request.expectedGate);
        if (refusal !== null) return refusal;
        const gate: GateState = state.gate as GateState;
        if (gate.requiredPhrase !== null && request.typedPhrase !== gate.requiredPhrase)
          return { ok: false, code: 'confirmation-mismatch', error: 'Type the phrase exactly.' };
        if (gate.kind === 'cancel') {
          endSession();
          return { ok: true, code: 'ok' };
        }
        if (gate.kind === 'excludeSite') {
          // The demo's exclusion is the real edit on the demo's own lists, mirrored from the
          // worker: the block rule goes, or the category records the host.
          if (gate.host !== null) {
            state.lists = excludedLists(
              state.lists,
              gate.host,
              session.config.mode,
              (candidate: ListsConfig): Verdict =>
                evaluateUrl(
                  compileMatcher(candidate, ALL_CATEGORIES, session.config.mode),
                  `https://${gate.host}/`,
                  [],
                  now(),
                ),
            );
          }
          state.gate = null;
          publish();
          broadcast({ type: 'reevaluate' });
          return { ok: true, code: 'ok' };
        }
        const cost: number =
          gate.kind === 'pause' ? state.settings.pause.pauseMs : state.settings.pause.unlockMs;
        if (msUntilAffordable(state.bank, cost, state.settings.pause) > 0) {
          return {
            ok: false,
            code: 'end-not-allowed',
            error: 'Not enough site access credit yet.',
          };
        }
        state.bank = spend(state.bank, cost);
        if (gate.kind === 'pause') {
          state.session = beginPauseV2(session, now(), state.settings.pause.pauseMs);
        } else if (gate.host !== null) {
          state.unlocks = [...state.unlocks, { host: gate.host, until: now() + cost }];
        }
        state.gate = null;
        publish();
        broadcast({ type: 'reevaluate' });
        return { ok: true, code: 'ok' };
      }
      case 'forceEndGate': {
        if (state.session === null) return NOT_ACTIVE;
        if (state.gate === null || !state.gate.forceEndAvailable)
          return { ok: false, code: 'no-active-gate', error: 'No gate is open.' };
        endSession();
        return { ok: true, code: 'ok' };
      }
      case 'resumeFromPause': {
        const session: SessionStateV2 | null = state.session;
        if (session === null) return NOT_ACTIVE;
        if (session.phase !== 'paused')
          return { ok: false, code: 'end-not-allowed', error: 'No pause is active.' };
        state.session = commitResumeV2(session, now());
        publish();
        broadcast({ type: 'reevaluate' });
        return { ok: true, code: 'ok' };
      }
      case 'startNextFocusEarly': {
        const session: SessionStateV2 | null = state.session;
        if (session === null) return NOT_ACTIVE;
        try {
          assertCanStartNextFocusEarlyV2(session, now());
        } catch (error: unknown) {
          const message: string =
            error instanceof CoreError ? error.message : 'That break cannot end early yet.';
          return { ok: false, code: 'end-not-allowed', error: message };
        }
        state.session = commitResumeV2(session, now());
        publish();
        broadcast({ type: 'reevaluate' });
        return { ok: true, code: 'ok' };
      }
      default:
        throw new Error(`demo engine does not handle ${request.type}`);
    }
  };

  return {
    handle,
    strip: (): TabStrip => state.strip,
    activate: (tabId: number): void => {
      state.strip = activateTab(state.strip, tabId);
      broadcast({ type: 'workTargetChanged' });
      // Clicking into a tab that is already blocked meets the lockscreen immediately, with no
      // further getBlockState round trip required to notice it, so the guide advances here too.
      const tab: DemoTab | null = tabById(state.strip, tabId);
      if (tab !== null && verdictFor(tab.url).blocked) emit({ type: 'blocked', tabId });
    },
    onBroadcast: (listener: (message: Broadcast) => void): (() => void) => {
      broadcastListeners.add(listener);
      return (): void => {
        broadcastListeners.delete(listener);
      };
    },
    onEvent: (listener: (event: DemoEvent) => void): (() => void) => {
      eventListeners.add(listener);
      return (): void => {
        eventListeners.delete(listener);
      };
    },
    tick: settle,
  };
}
