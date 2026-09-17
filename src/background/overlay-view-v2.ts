/**
 * Pure builders for the worker's frozen content payloads: the two `DocumentOverlayView` shapes and
 * the document commands that carry them. Every builder validates what it produces with the landed
 * detached validators and raises `CoreError('invalid-rule', ...)` instead of returning a value the
 * content parser would reject, so a command that leaves this module is a command a document can
 * apply. Nothing here reads storage, a browser API, or a clock.
 */

import type {
  ActiveOverlayCopy,
  DocumentOverlayView,
  EnforcementPresentation,
  RemainingSuffix,
  StartingOverlayCopy,
} from '../shared/enforcement-v2';
import {
  canonicalSessionIdentity,
  validateDetachedDocumentOverlayView,
} from '../shared/enforcement-v2-validation';
import { CoreError } from '../shared/errors';
import { snapshotExactData } from '../shared/exact-data';
import { t } from '../shared/i18n';
import { formatClock, minToMs } from '../shared/time';
import type {
  CycleConfig,
  EndActionLabelV2,
  GateKind,
  GateState,
  SessionDuration,
  SessionStateV2,
  SiteUnlock,
  Strictness,
  ThemeMode,
  Verdict,
} from '../shared/types';
import { unlockHostMatchesUrl } from '../shared/unlock-host';
import { isNonBlankString, isSafeTimestamp } from '../shared/v2-domain-intrinsics';
import { verdictLabel } from '../shared/verdict-label';
import type { FrozenDocumentCommand, FrozenEpochResetCommand } from './enforcement-persistence-v2';
import {
  validateDetachedFrozenDocumentCommand,
  validateDetachedFrozenEpochResetCommand,
} from './enforcement-persistence-v2-validation';

type ActiveOverlayView = Extract<DocumentOverlayView, { presentation: 'active' }>;
type ActiveStatusCopy = ActiveOverlayCopy['status'];

/** The status sentence and the bare wall clock behind it always travel together. */
interface ActiveLeadCopy {
  status: ActiveStatusCopy;
  lockedUntil: string | null;
}

const STARTING_TITLE: StartingOverlayCopy['title'] = 'Focus Lock is starting';
const STARTING_DETAIL: StartingOverlayCopy['detail'] = 'Applying your selected rules.';
const STOPPED_PAGE_COPY: NonNullable<StartingOverlayCopy['stoppedPage']> =
  'This page did not load. It will load by itself when the session ends.';
const UNTIL_STOPPED_STATUS: Extract<ActiveStatusCopy, { kind: 'until-stopped' }>['text'] =
  'Until stopped';
/** What the intention line says when the session was started without one. */
const NEXT_STEP_FALLBACK: string = t('shared_overlay_next_step_fallback');
/** The End control and the cancel gate's confirm on a timed page. */
const END_ACTION_LABEL: EndActionLabelV2 = 'End session';
const END_GATE_CONFIRM: string = t('shared_end_the_session');
/** The same control and confirm on a Friction until-stopped page, which the popup also uses. */
const UNLOCK_ACTION_LABEL: EndActionLabelV2 = 'Unlock';

/** The copy every active view repeats word for word. The view type pins each literal. */
const FIXED_ACTIVE_COPY: Readonly<
  Pick<
    ActiveOverlayCopy,
    | 'nextStep'
    | 'minuteLabel'
    | 'underMinuteLabel'
    | 'updatingLabel'
    | 'backToWork'
    | 'chooseWorkTab'
    | 'changeWorkTab'
    | 'accessSummary'
    | 'bankUnit'
    | 'bankWaitPrefix'
    | 'costAboveLimit'
    | 'earningOff'
    | 'notEnoughFocus'
    | 'accessNote'
    | 'gateBack'
    | 'gatePhraseLabel'
    | 'gateForceEnd'
    | 'transportError'
  >
> = {
  nextStep: 'Your next step',
  minuteLabel: 'min',
  underMinuteLabel: 'Less than a minute',
  updatingLabel: 'Updating session',
  backToWork: 'Back to work',
  chooseWorkTab: 'Choose a work tab',
  changeWorkTab: 'Change work tab',
  accessSummary: 'Need a break or site access?',
  bankUnit: 'site access credit',
  bankWaitPrefix: 'Ready in',
  costAboveLimit: 'Cost exceeds the credit limit',
  earningOff: 'Credit earning is turned off',
  notEnoughFocus: 'Not enough time in this focus block',
  accessNote: 'You can step away at any time. Site access uses credit.',
  gateBack: 'Keep focusing',
  gatePhraseLabel: 'Type this to confirm:',
  gateForceEnd: 'Ignore timeout and end anyway',
  transportError: 'Focus Lock could not update this action. Try again.',
};

/** The two spend actions, and the confirm each one's gate ends with. */
const PAUSE_ACTION_LABEL: string = t('shared_overlay_pause_action');
const UNLOCK_ACTION_LABEL_PREFIX: string = 'Unlock';
const UNLOCK_SITE_ACTION_LABEL: string = t('shared_overlay_unlock_site_action');
const GATE_CONFIRM_COPY: Readonly<Record<Exclude<GateKind, 'cancel'>, string>> = {
  pause: PAUSE_ACTION_LABEL,
  unlockSite: UNLOCK_SITE_ACTION_LABEL,
};

export interface StartingViewInputV2 {
  capturedAt: number;
  theme: ThemeMode;
  stoppedPage: boolean;
  verdict: Verdict;
}

export interface ActiveViewInputV2 {
  targetUrl: string;
  capturedAt: number;
  theme: ThemeMode;
  /** phase must be focus: pause and break are non-blocking and receive no active view */
  session: SessionStateV2;
  economy: {
    bankMs: number;
    bankAccrualPerMs: number;
    bankCapMs: number;
    pauseCostMs: number;
    unlockCostMs: number;
  };
  gate: GateState | null;
  activeUnlocks: SiteUnlock[];
  attemptsToday: number;
  stoppedPage: boolean;
  verdict: Verdict;
}

export interface DocumentCommandInputV2 {
  tabId: number;
  documentId: string;
  expectedUrl: string;
  operationId: string;
  enforcementEpoch: string;
  sessionId: string | null;
  reservedSessionId: string | null;
  basePolicyRevision: number;
  runtimeRevision: number;
  verdict: Verdict;
  presentation: EnforcementPresentation;
  overlay: DocumentOverlayView | null;
}

export interface EpochResetCommandInputV2 {
  tabId: number;
  documentId: string;
  expectedUrl: string;
  operationId: string;
  enforcementEpoch: string;
}

/** The starting page states what is happening and offers nothing to press. */
export function buildStartingOverlayView(input: StartingViewInputV2): DocumentOverlayView {
  return validatedView({
    version: 1,
    presentation: 'starting',
    capturedAt: input.capturedAt,
    theme: input.theme,
    stoppedPage: input.stoppedPage,
    copy: {
      title: STARTING_TITLE,
      detail: STARTING_DETAIL,
      verdictProvenance: verdictLabel(input.verdict),
      stoppedPage: stoppedPageCopy(input.stoppedPage),
    },
    actions: { end: 'hidden' },
  });
}

/**
 * The active page for one focus phase. A timed session counts down to its own end, an indefinite
 * session says in words that it runs until stopped, and both offer whatever End their strictness
 * allows.
 */
export function buildActiveOverlayView(input: ActiveViewInputV2): DocumentOverlayView {
  const session: SessionStateV2 = input.session;
  if (session.phase !== 'focus') {
    invalidView(`an active overlay view needs a focus phase, not ${session.phase}`);
  }
  const duration: SessionDuration = session.config.duration;
  if (input.gate?.kind === 'unlockSite' && !isNonBlankString(input.gate.host)) {
    invalidView('an unlock gate names the host it unlocks');
  }
  const gate: GateState | null =
    input.gate?.kind === 'unlockSite' && !unlockHostMatchesUrl(input.gate.host, input.targetUrl)
      ? null
      : input.gate;
  return validatedView({
    version: 1,
    presentation: 'active',
    theme: input.theme,
    sessionId: session.sessionId,
    phase: 'focus',
    mode: session.config.mode,
    strictness: session.config.strictness,
    duration,
    timing: {
      capturedAt: input.capturedAt,
      phaseStartedAt: session.phaseStartedAt,
      phaseEndsAt: session.phaseEndsAt,
      sessionEndsAt: session.sessionEndsAt,
    },
    economy: { ...input.economy },
    gate,
    activeUnlocks: input.activeUnlocks,
    attemptsToday: input.attemptsToday,
    stoppedPage: input.stoppedPage,
    actions: activeActions(session.config.strictness, gate),
    copy: activeCopy(input, duration, gate),
  });
}

/**
 * The local wall clock a timed session is locked until, such as `14:35`, and `9:05` before ten.
 *
 * The hour is deliberately unpadded: this is a sentence on a blocked page, where a wall-clock time
 * reads the way it is spoken, and a leading zero adds nothing. The minute is padded, which is the
 * half that changes how the time reads.
 */
export function formatLockedUntilV2(sessionEndsAt: number): string {
  if (!isSafeTimestamp(sessionEndsAt)) {
    invalidView('a locked-until time must be a safe timestamp');
  }
  const at: Date = new Date(sessionEndsAt);
  return `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * The End action belongs to Flexible and Friction sessions, timed or not. Hard sessions refuse it,
 * so they answer `hidden` on the blocked page.
 *
 * The two that show it do not send the same command, which is spec 1771's "keeps existing end
 * behavior for its session type": Flexible ends immediately, and Friction has to pass its cancel
 * gate first. `requestSessionEnd` is refused outright for any strictness but Flexible, so a
 * Friction overlay that sent it would render a control the worker answers with an error every
 * time. This is the same split `endCommandOf` makes for the popup.
 */
export function overlayEndActionV2(
  strictness: Strictness,
): 'hidden' | 'request-end' | 'open-end-gate' {
  if (strictness === 'hard') return 'hidden';
  return strictness === 'friction' ? 'open-end-gate' : 'request-end';
}

/**
 * The label on the End control, and on the cancel gate's confirm. A Friction session with no timer
 * has nothing to end early, so it unlocks. The popup publishes the same word with its authority.
 */
export function overlayEndActionLabelV2(
  strictness: Strictness,
  duration: SessionDuration,
): EndActionLabelV2 {
  return strictness === 'friction' && duration.kind === 'until-stopped'
    ? UNLOCK_ACTION_LABEL
    : END_ACTION_LABEL;
}

/** One frozen command for one document. The worker owns the tab, so the command carries it. */
export function buildFrozenDocumentCommandV2(input: DocumentCommandInputV2): FrozenDocumentCommand {
  if (canonicalSessionIdentity(input.sessionId, input.reservedSessionId) === null) {
    invalidView('a document command carries exactly one of sessionId and reservedSessionId');
  }
  const command: FrozenDocumentCommand = {
    version: 1,
    command: 'apply-enforcement',
    operationId: input.operationId,
    enforcementEpoch: input.enforcementEpoch,
    sessionId: input.sessionId,
    reservedSessionId: input.reservedSessionId,
    basePolicyRevision: input.basePolicyRevision,
    runtimeRevision: input.runtimeRevision,
    documentId: input.documentId,
    expectedUrl: input.expectedUrl,
    presentation: input.presentation,
    verdict: input.verdict,
    overlay: input.overlay,
    tabId: input.tabId,
  };
  const detached: unknown = snapshotExactData(command)?.value;
  if (!validateDetachedFrozenDocumentCommand(detached)) {
    invalidView(
      `a ${input.presentation} document command does not satisfy the frozen command contract`,
    );
  }
  return detached;
}

/** The epoch handshake one document answers before it accepts any enforcement command. */
export function buildFrozenEpochResetCommandV2(
  input: EpochResetCommandInputV2,
): FrozenEpochResetCommand {
  const command: FrozenEpochResetCommand = {
    version: 1,
    command: 'reset-enforcement-epoch',
    operationId: input.operationId,
    enforcementEpoch: input.enforcementEpoch,
    documentId: input.documentId,
    expectedUrl: input.expectedUrl,
    tabId: input.tabId,
  };
  const detached: unknown = snapshotExactData(command)?.value;
  if (!validateDetachedFrozenEpochResetCommand(detached)) {
    invalidView('an epoch reset command does not satisfy the frozen command contract');
  }
  return detached;
}

function activeActions(
  strictness: Strictness,
  gate: GateState | null,
): ActiveOverlayView['actions'] {
  if (gate !== null) return { state: 'gate', end: 'hidden', pause: 'hidden', unlock: 'hidden' };
  return {
    state: 'ready',
    end: overlayEndActionV2(strictness),
    pause: 'request-gate',
    unlock: 'request-gate',
  };
}

function activeCopy(
  input: ActiveViewInputV2,
  duration: SessionDuration,
  gate: GateState | null,
): ActiveOverlayCopy {
  const lead: ActiveLeadCopy = leadCopy(duration, input.session.sessionEndsAt);
  const strictness: Strictness = input.session.config.strictness;
  const endAction: EndActionLabelV2 = overlayEndActionLabelV2(strictness, duration);
  const goal: string = input.session.config.intention.trim();
  return {
    ...FIXED_ACTIVE_COPY,
    endAction,
    status: lead.status,
    lockedUntil: lead.lockedUntil,
    remainingSuffix: remainingSuffixCopy(input.session),
    intention: goal === '' ? NEXT_STEP_FALLBACK : goal,
    verdictProvenance: verdictLabel(input.verdict),
    stoppedPage: stoppedPageCopy(input.stoppedPage),
    pauseAction: spendActionCopy(PAUSE_ACTION_LABEL, input.economy.pauseCostMs),
    unlockAction: spendActionCopy(UNLOCK_SITE_ACTION_LABEL, input.economy.unlockCostMs),
    gateTitle: gate === null ? null : gateTitleCopy(gate, input.economy, endAction),
    gateSaid:
      gate === null || goal === '' ? null : t('shared_overlay_gate_said', { INTENTION: goal }),
    gateConfirm: gate === null ? null : gateConfirmCopy(gate.kind, endAction),
  };
}

/** `Unlock all sites 5:00 - costs 5:00 credit`: the length and the cost are the same clock. */
function spendActionCopy(label: string, costMs: number): string {
  const clock: string = formatClock(costMs);
  return t('shared_overlay_spend_action', { LABEL: label, LENGTH: clock, COST: clock });
}

/** The cancel gate confirms with the End label's own word, so Unlock stays Unlock inside the gate. */
function gateConfirmCopy(kind: GateKind, endAction: EndActionLabelV2): string {
  if (kind !== 'cancel') return GATE_CONFIRM_COPY[kind];
  return endAction === UNLOCK_ACTION_LABEL ? t('shared_unlock') : END_GATE_CONFIRM;
}

/**
 * The status sentence the page leads with, and the bare wall clock behind a timed one. A timed
 * session with no end has no honest sentence, so it raises instead of borrowing the indefinite one.
 */
function leadCopy(duration: SessionDuration, sessionEndsAt: number | null): ActiveLeadCopy {
  if (duration.kind === 'until-stopped') {
    return { status: { kind: 'until-stopped', text: UNTIL_STOPPED_STATUS }, lockedUntil: null };
  }
  const lockedUntil: string = formatLockedUntilV2(sessionEndsAt ?? Number.NaN);
  return {
    status: { kind: 'timed', text: t('shared_overlay_locked_until', { TIME: lockedUntil }) },
    lockedUntil,
  };
}

/** A spend gate repeats its action's own sentence, a cancel gate names what it ends. */
function gateTitleCopy(
  gate: GateState,
  economy: ActiveViewInputV2['economy'],
  endAction: EndActionLabelV2,
): string {
  if (gate.kind === 'pause') return spendActionCopy(PAUSE_ACTION_LABEL, economy.pauseCostMs);
  if (gate.kind === 'unlockSite') {
    // The gate contract already binds a non-blank host to this kind, in `isGate` and in the
    // detached predicate the runtime uses, so borrowing "this site" would paper over a gate no
    // validator produced. This module raises for an unrenderable input rather than inventing copy.
    if (!isNonBlankString(gate.host)) invalidView('an unlock gate names the host it unlocks');
    return t('shared_overlay_unlock_host', {
      HOST: gate.host,
      CLOCK: formatClock(economy.unlockCostMs),
    });
  }
  return endAction === UNLOCK_ACTION_LABEL
    ? t('shared_unlock')
    : t('shared_gate_end_title');
}

/**
 * The page counts down to the next break only when that break fits before the session end. The
 * session machine completes early when its final break would leave no focus time behind it, so
 * a break that ends at or past the end is not a break the person will get.
 */
function remainingSuffixCopy(session: SessionStateV2): RemainingSuffix | null {
  if (session.config.duration.kind === 'until-stopped') return null;
  const phaseEndsAt: number | null = session.phaseEndsAt;
  const sessionEndsAt: number | null = session.sessionEndsAt;
  if (phaseEndsAt === null || sessionEndsAt === null) return 'left in this session';
  return hasUpcomingBreak(session.config.cycling, session.cycleIndex, phaseEndsAt, sessionEndsAt)
    ? 'until your break'
    : 'left in this session';
}

function hasUpcomingBreak(
  cycling: CycleConfig | null,
  cycleIndex: number,
  phaseEndsAt: number,
  sessionEndsAt: number,
): boolean {
  if (cycling === null || phaseEndsAt >= sessionEndsAt) return false;
  const isLong: boolean = (cycleIndex + 1) % cycling.longEvery === 0;
  const breakMs: number = minToMs(isLong ? cycling.longBreakMin : cycling.shortBreakMin);
  return breakMs > 0 && phaseEndsAt + breakMs < sessionEndsAt - 1;
}

function stoppedPageCopy(stoppedPage: boolean): StartingOverlayCopy['stoppedPage'] {
  return stoppedPage ? STOPPED_PAGE_COPY : null;
}

/** Detaches the built view and refuses anything the content parser would reject. */
function validatedView(view: DocumentOverlayView): DocumentOverlayView {
  const detached: unknown = snapshotExactData(view)?.value;
  if (!validateDetachedDocumentOverlayView(detached)) {
    invalidView(`a ${view.presentation} overlay view does not satisfy the render contract`);
  }
  return detached;
}

function invalidView(message: string): never {
  throw new CoreError('invalid-rule', message);
}
