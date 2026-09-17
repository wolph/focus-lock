import { CATEGORY_IDS } from './constants';
import type {
  ActiveOverlayCopy,
  ContentEnforcementResponse,
  ContentEnforcementTuple,
  DocumentContentCommand,
  DocumentEnforcementCommand,
  DocumentOverlayView,
  EnforcementPresentation,
  ResetEnforcementEpochCommand,
  StartingOverlayCopy,
} from './enforcement-v2';
import { exactDataEqual, isDenseArray, snapshotExactData } from './exact-data';
import { t } from './i18n';
import { isRelativeMillisecondDuration } from './numeric-validation';
import type { SessionDuration, Strictness, ThemeMode, Verdict } from './types';
import {
  exactRecord,
  isNonBlankString,
  isNonNegativeInteger,
  isRecord,
  isSafeTimestamp,
  isUuid,
  validateDetachedGateState,
  validateDetachedSessionDuration,
  validateDetachedSiteUnlock,
} from './v2-domain-intrinsics';

type UnknownRecord = Record<string, unknown>;

const STARTING_OVERLAY_KEYS: readonly string[] = [
  'version',
  'presentation',
  'capturedAt',
  'theme',
  'stoppedPage',
  'copy',
  'actions',
];
const STARTING_COPY_KEYS: readonly string[] = [
  'title',
  'detail',
  'verdictProvenance',
  'stoppedPage',
];
const ACTIVE_OVERLAY_KEYS: readonly string[] = [
  'version',
  'presentation',
  'theme',
  'sessionId',
  'phase',
  'mode',
  'strictness',
  'duration',
  'timing',
  'economy',
  'gate',
  'activeUnlocks',
  'attemptsToday',
  'stoppedPage',
  'actions',
  'copy',
];
const ACTIVE_TIMING_KEYS: readonly string[] = [
  'capturedAt',
  'phaseStartedAt',
  'phaseEndsAt',
  'sessionEndsAt',
];
const ACTIVE_ECONOMY_KEYS: readonly string[] = [
  'bankMs',
  'bankAccrualPerMs',
  'bankCapMs',
  'pauseCostMs',
  'unlockCostMs',
];
const ACTIVE_ACTION_KEYS: readonly string[] = ['state', 'end', 'pause', 'unlock'];
const ACTIVE_COPY_KEYS: readonly string[] = [
  'nextStep',
  'status',
  'lockedUntil',
  'remainingSuffix',
  'minuteLabel',
  'underMinuteLabel',
  'updatingLabel',
  'intention',
  'verdictProvenance',
  'stoppedPage',
  'backToWork',
  'chooseWorkTab',
  'changeWorkTab',
  'accessSummary',
  'bankUnit',
  'pauseAction',
  'unlockAction',
  'endAction',
  'bankWaitPrefix',
  'costAboveLimit',
  'earningOff',
  'notEnoughFocus',
  'accessNote',
  'gateTitle',
  'gateSaid',
  'gateBack',
  'gatePhraseLabel',
  'gateForceEnd',
  'gateConfirm',
  'transportError',
];
const STATUS_COPY_KEYS: readonly string[] = ['kind', 'text'];
const VERDICT_KEYS: readonly string[] = ['blocked', 'reason', 'categoryId', 'matchedPattern'];
const COMMAND_KEYS: readonly string[] = [
  'version',
  'command',
  'operationId',
  'enforcementEpoch',
  'sessionId',
  'reservedSessionId',
  'basePolicyRevision',
  'runtimeRevision',
  'documentId',
  'expectedUrl',
  'presentation',
  'verdict',
  'overlay',
];
const RESET_COMMAND_KEYS: readonly string[] = [
  'version',
  'command',
  'operationId',
  'enforcementEpoch',
  'documentId',
  'expectedUrl',
];
const CONTENT_TUPLE_KEYS: readonly string[] = [
  'enforcementEpoch',
  'sessionId',
  'reservedSessionId',
  'basePolicyRevision',
  'runtimeRevision',
];
const APPLIED_RESPONSE_KEYS: readonly string[] = [
  'version',
  'disposition',
  'operationId',
  'enforcementEpoch',
  'sessionId',
  'reservedSessionId',
  'basePolicyRevision',
  'runtimeRevision',
  'documentId',
  'observedUrl',
  'presentation',
  'verdict',
  'overlay',
  'handledAt',
];
const STALE_COMMAND_RESPONSE_KEYS: readonly string[] = [
  'version',
  'disposition',
  'operationId',
  'enforcementEpoch',
  'documentId',
  'observedUrl',
  'requested',
  'current',
  'handledAt',
];
const RESET_REQUIRED_RESPONSE_KEYS: readonly string[] = [
  'version',
  'disposition',
  'operationId',
  'enforcementEpoch',
  'documentId',
  'observedUrl',
  'requestedEpoch',
  'currentEpoch',
  'handledAt',
];
const EPOCH_RESET_RESPONSE_KEYS: readonly string[] = [
  'version',
  'disposition',
  'operationId',
  'enforcementEpoch',
  'documentId',
  'observedUrl',
  'handledAt',
];
const EPOCH_RESET_REJECTED_RESPONSE_KEYS: readonly string[] = [
  'version',
  'disposition',
  'operationId',
  'enforcementEpoch',
  'currentEpoch',
  'reason',
  'documentId',
  'observedUrl',
  'handledAt',
];
const STARTING_TITLE: StartingOverlayCopy['title'] = 'Focus Lock is starting';
const STARTING_DETAIL: StartingOverlayCopy['detail'] = 'Applying your selected rules.';
const STOPPED_PAGE_COPY: NonNullable<StartingOverlayCopy['stoppedPage']> =
  'This page did not load. It will load by itself when the session ends.';
const UNTIL_STOPPED_STATUS_TEXT: Extract<
  ActiveOverlayCopy['status'],
  { kind: 'until-stopped' }
>['text'] = 'Until stopped';
const REMAINING_SUFFIXES: ReadonlySet<string> = new Set<string>([
  'until your break',
  'left in this session',
]);
/** The two End labels the worker may publish, pinned to the copy type. */
const END_ACTION_LABEL: ActiveOverlayCopy['endAction'] = 'End session';
const UNLOCK_ACTION_LABEL: ActiveOverlayCopy['endAction'] = 'Unlock';
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
/** The one verdict every clear command carries. Producers import it so no copy can drift. */
export const CANONICAL_CLEAR_VERDICT: Verdict = {
  blocked: false,
  reason: 'no-session',
  categoryId: null,
  matchedPattern: null,
};
const VERDICT_REASONS: ReadonlySet<string> = new Set<string>([
  'no-session',
  'always-allow',
  'unlock',
  'excluded',
  'category',
  'custom',
  'whitelist',
  'whitelist-miss',
  'default',
]);
const CATEGORY_ID_VALUES: ReadonlySet<string> = new Set<string>(CATEGORY_IDS);

export function parseDocumentOverlayView(value: unknown): DocumentOverlayView | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedDocumentOverlayView(snapshot) ? snapshot : null;
}

export function parseDocumentEnforcementCommand(value: unknown): DocumentEnforcementCommand | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedDocumentEnforcementCommand(snapshot) ? snapshot : null;
}

export function parseResetEnforcementEpochCommand(
  value: unknown,
): ResetEnforcementEpochCommand | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedResetEnforcementEpochCommand(snapshot) ? snapshot : null;
}

export function parseDocumentContentCommand(value: unknown): DocumentContentCommand | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  if (validateDetachedResetEnforcementEpochCommand(snapshot)) return snapshot;
  return validateDetachedDocumentEnforcementCommand(snapshot) ? snapshot : null;
}

export function parseContentEnforcementResponse(value: unknown): ContentEnforcementResponse | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedContentEnforcementResponse(snapshot) ? snapshot : null;
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedDocumentOverlayView(value: unknown): value is DocumentOverlayView {
  const starting: UnknownRecord | null = exactRecord(value, STARTING_OVERLAY_KEYS);
  if (starting !== null) return validateDetachedStartingOverlay(starting);
  const active: UnknownRecord | null = exactRecord(value, ACTIVE_OVERLAY_KEYS);
  return active !== null && validateDetachedActiveOverlay(active);
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedVerdict(value: unknown): value is Verdict {
  const candidate: UnknownRecord | null = exactRecord(value, VERDICT_KEYS);
  return (
    candidate !== null &&
    typeof candidate.blocked === 'boolean' &&
    typeof candidate.reason === 'string' &&
    VERDICT_REASONS.has(candidate.reason) &&
    (candidate.categoryId === null ||
      (typeof candidate.categoryId === 'string' && CATEGORY_ID_VALUES.has(candidate.categoryId))) &&
    (candidate.matchedPattern === null || typeof candidate.matchedPattern === 'string')
  );
}

/**
 * The only two top-frame prefixes where Chrome forbids the registered content script. Every other
 * scheme is outside the HTTP(S) target set, and an ordinary HTTP(S) page is never downgraded. The
 * enumerator classifies with it and the stored exclusion contract is bounded by it, so it is one
 * definition rather than a rule the producer keeps and the parser trusts.
 */
const KNOWN_UNSUPPORTED_PREFIXES: readonly string[] = [
  'https://chromewebstore.google.com/',
  'https://chrome.google.com/webstore/',
];

export function isKnownUnsupportedUrlV2(url: string): boolean {
  return KNOWN_UNSUPPORTED_PREFIXES.some((prefix: string): boolean => url.startsWith(prefix));
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedDocumentEnforcementCommand(
  value: unknown,
): value is DocumentEnforcementCommand {
  return validateDetachedDocumentEnforcementCommandFields(value);
}

/**
 * Validates command fields on an already-detached record that carries the wire command's keys plus
 * the ones its caller owns, such as a background frozen command that adds `tabId`. The owned keys
 * are named by the caller rather than assumed, so the key set is checked here instead of being
 * promised in prose: a record carrying a key nobody declared is refused.
 */
export function validateDetachedDocumentEnforcementCommandFields(
  value: unknown,
  ownedKeys: readonly string[] = [],
): boolean {
  const candidate: UnknownRecord | null = exactRecord(value, [...COMMAND_KEYS, ...ownedKeys]);
  if (candidate === null) return false;
  const verdict: unknown = candidate.verdict;
  if (
    candidate.version !== 1 ||
    candidate.command !== 'apply-enforcement' ||
    !isUuid(candidate.operationId) ||
    !isUuid(candidate.enforcementEpoch) ||
    canonicalSessionIdentity(candidate.sessionId, candidate.reservedSessionId) === null ||
    !isNonNegativeInteger(candidate.basePolicyRevision) ||
    !isNonNegativeInteger(candidate.runtimeRevision) ||
    !isNonBlankString(candidate.documentId) ||
    !isNonBlankString(candidate.expectedUrl) ||
    !isEnforcementPresentation(candidate.presentation) ||
    !validateDetachedVerdict(verdict)
  ) {
    return false;
  }
  return validateDetachedCommandPresentation(
    candidate.presentation,
    verdict,
    candidate.overlay,
    candidate.sessionId,
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedContentEnforcementResponse(
  value: unknown,
): value is ContentEnforcementResponse {
  if (!isRecord(value)) return false;
  switch (value.disposition) {
    case 'applied':
      return validateDetachedAppliedResponse(value);
    case 'stale-command':
      return validateDetachedStaleCommandResponse(value);
    case 'reset-required':
      return validateDetachedResetRequiredResponse(value);
    case 'epoch-reset':
      return validateDetachedResponseEnvelope(value, EPOCH_RESET_RESPONSE_KEYS) !== null;
    case 'epoch-reset-rejected':
      return validateDetachedEpochResetRejectedResponse(value);
    default:
      return false;
  }
}

/**
 * Returns the single non-null session identity, or null unless exactly one of the pair is a UUID.
 * Provisional rows carry the reserved identity and durable rows carry the session identity.
 */
export function canonicalSessionIdentity(
  sessionId: unknown,
  reservedSessionId: unknown,
): string | null {
  if (sessionId === null) return isUuid(reservedSessionId) ? reservedSessionId : null;
  return isUuid(sessionId) && reservedSessionId === null ? sessionId : null;
}

function validateDetachedResetEnforcementEpochCommand(
  value: unknown,
): value is ResetEnforcementEpochCommand {
  const candidate: UnknownRecord | null = exactRecord(value, RESET_COMMAND_KEYS);
  return (
    candidate !== null &&
    candidate.version === 1 &&
    candidate.command === 'reset-enforcement-epoch' &&
    isUuid(candidate.operationId) &&
    isUuid(candidate.enforcementEpoch) &&
    isNonBlankString(candidate.documentId) &&
    isNonBlankString(candidate.expectedUrl)
  );
}

/** Returns the response record when every field shared by all dispositions is valid. */
function validateDetachedResponseEnvelope(
  value: unknown,
  keys: readonly string[],
): UnknownRecord | null {
  const candidate: UnknownRecord | null = exactRecord(value, keys);
  if (
    candidate === null ||
    candidate.version !== 1 ||
    !isUuid(candidate.operationId) ||
    !isUuid(candidate.enforcementEpoch) ||
    !isNonBlankString(candidate.documentId) ||
    !isNonBlankString(candidate.observedUrl) ||
    !isSafeTimestamp(candidate.handledAt)
  ) {
    return null;
  }
  return candidate;
}

function validateDetachedAppliedResponse(value: unknown): boolean {
  const candidate: UnknownRecord | null = validateDetachedResponseEnvelope(
    value,
    APPLIED_RESPONSE_KEYS,
  );
  if (candidate === null) return false;
  const presentation: unknown = candidate.presentation;
  const verdict: unknown = candidate.verdict;
  if (
    canonicalSessionIdentity(candidate.sessionId, candidate.reservedSessionId) === null ||
    !isNonNegativeInteger(candidate.basePolicyRevision) ||
    !isNonNegativeInteger(candidate.runtimeRevision) ||
    !isEnforcementPresentation(presentation) ||
    !validateDetachedVerdict(verdict)
  ) {
    return false;
  }
  return validateDetachedCommandPresentation(
    presentation,
    verdict,
    candidate.overlay,
    candidate.sessionId,
  );
}

function validateDetachedStaleCommandResponse(value: unknown): boolean {
  const candidate: UnknownRecord | null = validateDetachedResponseEnvelope(
    value,
    STALE_COMMAND_RESPONSE_KEYS,
  );
  if (candidate === null) return false;
  const requested: unknown = candidate.requested;
  const current: unknown = candidate.current;
  if (
    !validateDetachedContentTuple(requested) ||
    !validateDetachedContentTuple(current) ||
    requested.enforcementEpoch !== candidate.enforcementEpoch ||
    current.enforcementEpoch !== candidate.enforcementEpoch
  ) {
    return false;
  }
  return isStrictlyLowerTuple(requested, current);
}

function validateDetachedResetRequiredResponse(value: unknown): boolean {
  const candidate: UnknownRecord | null = validateDetachedResponseEnvelope(
    value,
    RESET_REQUIRED_RESPONSE_KEYS,
  );
  if (candidate === null || candidate.requestedEpoch !== candidate.enforcementEpoch) return false;
  const currentEpoch: unknown = candidate.currentEpoch;
  if (currentEpoch === null) return true;
  return isUuid(currentEpoch) && currentEpoch !== candidate.requestedEpoch;
}

function validateDetachedEpochResetRejectedResponse(value: unknown): boolean {
  const candidate: UnknownRecord | null = validateDetachedResponseEnvelope(
    value,
    EPOCH_RESET_REJECTED_RESPONSE_KEYS,
  );
  return (
    candidate !== null &&
    candidate.reason === 'retired-epoch' &&
    isUuid(candidate.currentEpoch) &&
    candidate.currentEpoch !== candidate.enforcementEpoch
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedContentTuple(value: unknown): value is ContentEnforcementTuple {
  const candidate: UnknownRecord | null = exactRecord(value, CONTENT_TUPLE_KEYS);
  return (
    candidate !== null &&
    isUuid(candidate.enforcementEpoch) &&
    canonicalSessionIdentity(candidate.sessionId, candidate.reservedSessionId) !== null &&
    isNonNegativeInteger(candidate.basePolicyRevision) &&
    isNonNegativeInteger(candidate.runtimeRevision)
  );
}

/**
 * Orders two same-epoch tuples by (basePolicyRevision, runtimeRevision). A lower base revision
 * names an earlier base policy, which always began with its own reserved session, so its identity
 * may differ. An equal base revision is the same session and only its runtime revision may differ.
 */
function isStrictlyLowerTuple(
  requested: ContentEnforcementTuple,
  current: ContentEnforcementTuple,
): boolean {
  if (requested.basePolicyRevision !== current.basePolicyRevision) {
    return requested.basePolicyRevision < current.basePolicyRevision;
  }
  return (
    canonicalSessionIdentity(requested.sessionId, requested.reservedSessionId) ===
      canonicalSessionIdentity(current.sessionId, current.reservedSessionId) &&
    requested.runtimeRevision < current.runtimeRevision
  );
}

function validateDetachedCommandPresentation(
  presentation: EnforcementPresentation,
  verdict: Verdict,
  overlay: unknown,
  sessionId: unknown,
): boolean {
  if (presentation === 'clear') {
    return overlay === null && exactDataEqual(verdict, CANONICAL_CLEAR_VERDICT);
  }
  if (!verdict.blocked) return overlay === null;
  if (!validateDetachedDocumentOverlayView(overlay) || overlay.presentation !== presentation) {
    return false;
  }
  return overlay.presentation === 'starting' || overlay.sessionId === sessionId;
}

function validateDetachedStartingOverlay(value: UnknownRecord): boolean {
  const copy: UnknownRecord | null = exactRecord(value.copy, STARTING_COPY_KEYS);
  const actions: UnknownRecord | null = exactRecord(value.actions, ['end']);
  return (
    value.version === 1 &&
    value.presentation === 'starting' &&
    isSafeTimestamp(value.capturedAt) &&
    isThemeMode(value.theme) &&
    typeof value.stoppedPage === 'boolean' &&
    copy !== null &&
    copy.title === STARTING_TITLE &&
    copy.detail === STARTING_DETAIL &&
    isNonBlankString(copy.verdictProvenance) &&
    hasStoppedPageCopy(value.stoppedPage, copy.stoppedPage) &&
    actions !== null &&
    actions.end === 'hidden'
  );
}

function validateDetachedActiveOverlay(value: UnknownRecord): boolean {
  const duration: unknown = value.duration;
  const strictness: unknown = value.strictness;
  const stoppedPage: unknown = value.stoppedPage;
  if (
    value.version !== 1 ||
    value.presentation !== 'active' ||
    !isThemeMode(value.theme) ||
    !isUuid(value.sessionId) ||
    value.phase !== 'focus' ||
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    !isStrictness(strictness) ||
    !validateDetachedSessionDuration(duration) ||
    !hasDurationCompatibleStrictness(duration, strictness) ||
    !isNonNegativeInteger(value.attemptsToday) ||
    typeof stoppedPage !== 'boolean'
  ) {
    return false;
  }

  const timing: UnknownRecord | null = exactRecord(value.timing, ACTIVE_TIMING_KEYS);
  const capturedAt: number | null =
    timing === null ? null : activeTimingCapturedAt(timing, duration);
  if (capturedAt === null) return false;

  const gate: unknown = value.gate;
  if (gate !== null && !validateDetachedGateState(gate)) return false;

  const gated: boolean = gate !== null;
  return (
    validateDetachedActiveEconomy(value.economy) &&
    validateDetachedActiveUnlocks(value.activeUnlocks, capturedAt) &&
    validateDetachedActiveActions(value.actions, gated, expectedEndAction(strictness, gated)) &&
    validateDetachedActiveCopy(value.copy, duration, strictness, gated, stoppedPage)
  );
}

/** Until-stopped sessions are never Hard, matching the SessionConfigV2 duration invariant. */
function hasDurationCompatibleStrictness(
  duration: SessionDuration,
  strictness: Strictness,
): boolean {
  return duration.kind === 'timed' || strictness !== 'hard';
}

/** Mirrors `overlayEndActionV2`: the End action follows strictness alone once no gate is open. */
function expectedEndAction(
  strictness: Strictness,
  gated: boolean,
): 'hidden' | 'request-end' | 'open-end-gate' {
  if (gated || strictness === 'hard') return 'hidden';
  return strictness === 'friction' ? 'open-end-gate' : 'request-end';
}

/** Mirrors `overlayEndActionLabelV2`: a Friction until-stopped page unlocks, the rest end. */
function expectedEndActionLabel(
  duration: SessionDuration,
  strictness: Strictness,
): ActiveOverlayCopy['endAction'] {
  return strictness === 'friction' && duration.kind === 'until-stopped'
    ? UNLOCK_ACTION_LABEL
    : END_ACTION_LABEL;
}

/** Returns capturedAt when the whole active timing row is valid, otherwise null. */
/**
 * The overlay stores what a phase is, so a phase whose end equals its start is accepted: a boundary
 * instant genuinely produces one, and a view that refused it could not describe what happened. The
 * schedule window is the stricter of the two on purpose, and for the opposite reason: a window whose
 * end equals its start offers no time in which to run a session, so `windowStartsAt < windowEndsAt`
 * refuses it at creation rather than storing a session nothing could have run.
 */
function activeTimingCapturedAt(timing: UnknownRecord, duration: SessionDuration): number | null {
  const capturedAt: unknown = timing.capturedAt;
  const phaseStartedAt: unknown = timing.phaseStartedAt;
  if (
    !isSafeTimestamp(capturedAt) ||
    !isSafeTimestamp(phaseStartedAt) ||
    phaseStartedAt > capturedAt
  ) {
    return null;
  }
  if (duration.kind === 'until-stopped') {
    return timing.phaseEndsAt === null && timing.sessionEndsAt === null ? capturedAt : null;
  }
  const phaseEndsAt: unknown = timing.phaseEndsAt;
  const sessionEndsAt: unknown = timing.sessionEndsAt;
  if (!isSafeTimestamp(phaseEndsAt) || !isSafeTimestamp(sessionEndsAt)) return null;
  return capturedAt <= phaseEndsAt && phaseEndsAt <= sessionEndsAt ? capturedAt : null;
}

function validateDetachedActiveEconomy(value: unknown): boolean {
  const economy: UnknownRecord | null = exactRecord(value, ACTIVE_ECONOMY_KEYS);
  if (economy === null) return false;
  const bankMs: unknown = economy.bankMs;
  const bankCapMs: unknown = economy.bankCapMs;
  return (
    isFiniteNonNegativeNumber(bankMs) &&
    isFiniteNonNegativeNumber(economy.bankAccrualPerMs) &&
    isNonNegativeInteger(bankCapMs) &&
    bankMs <= bankCapMs &&
    isRelativeMillisecondDuration(economy.pauseCostMs, true) &&
    isRelativeMillisecondDuration(economy.unlockCostMs, true)
  );
}

function validateDetachedActiveUnlocks(value: unknown, capturedAt: number): boolean {
  if (!isDenseArray(value)) return false;
  return value.every(
    (unlock: unknown): boolean => validateDetachedSiteUnlock(unlock) && unlock.until > capturedAt,
  );
}

function validateDetachedActiveActions(
  value: unknown,
  gated: boolean,
  end: 'hidden' | 'request-end' | 'open-end-gate',
): boolean {
  const actions: UnknownRecord | null = exactRecord(value, ACTIVE_ACTION_KEYS);
  if (actions === null || actions.end !== end) return false;
  return gated
    ? actions.state === 'gate' && actions.pause === 'hidden' && actions.unlock === 'hidden'
    : actions.state === 'ready' &&
        actions.pause === 'request-gate' &&
        actions.unlock === 'request-gate';
}

function validateDetachedActiveCopy(
  value: unknown,
  duration: SessionDuration,
  strictness: Strictness,
  gated: boolean,
  stoppedPage: boolean,
): boolean {
  const copy: UnknownRecord | null = exactRecord(value, ACTIVE_COPY_KEYS);
  if (
    copy === null ||
    !hasFixedActiveCopy(copy) ||
    copy.endAction !== expectedEndActionLabel(duration, strictness) ||
    !isNonBlankString(copy.pauseAction) ||
    !isNonBlankString(copy.unlockAction) ||
    !isNonBlankString(copy.verdictProvenance) ||
    !isNonBlankString(copy.intention) ||
    !hasStoppedPageCopy(stoppedPage, copy.stoppedPage)
  ) {
    return false;
  }
  if (!validateDetachedStatusCopy(copy.status, copy.lockedUntil, duration)) return false;
  if (!hasRemainingSuffix(copy.remainingSuffix, duration)) return false;
  if (!gated) {
    return copy.gateTitle === null && copy.gateConfirm === null && copy.gateSaid === null;
  }
  return (
    isNonBlankString(copy.gateTitle) &&
    isNonBlankString(copy.gateConfirm) &&
    hasGateSaidCopy(copy.gateSaid, copy.intention)
  );
}

/** An open gate quotes the intention word for word, or quotes nothing at all. */
function hasGateSaidCopy(value: unknown, intention: unknown): boolean {
  if (value === null) return true;
  if (!isNonBlankString(intention)) return false;
  return value === t('shared_overlay_gate_said', { INTENTION: intention });
}

function hasFixedActiveCopy(copy: UnknownRecord): boolean {
  return Object.entries(FIXED_ACTIVE_COPY).every(
    ([key, text]: [string, string]): boolean => copy[key] === text,
  );
}

function validateDetachedStatusCopy(
  value: unknown,
  lockedUntil: unknown,
  duration: SessionDuration,
): boolean {
  const status: UnknownRecord | null = exactRecord(value, STATUS_COPY_KEYS);
  if (status === null) return false;
  if (duration.kind === 'until-stopped') {
    return (
      status.kind === 'until-stopped' &&
      status.text === UNTIL_STOPPED_STATUS_TEXT &&
      lockedUntil === null
    );
  }
  return status.kind === 'timed' && isNonBlankString(status.text) && isNonBlankString(lockedUntil);
}

/** A timed page counts to a break or to the end. An until-stopped page counts to nothing. */
function hasRemainingSuffix(value: unknown, duration: SessionDuration): boolean {
  if (duration.kind === 'until-stopped') return value === null;
  return typeof value === 'string' && REMAINING_SUFFIXES.has(value);
}

function hasStoppedPageCopy(stoppedPage: boolean, copy: unknown): boolean {
  return stoppedPage ? copy === STOPPED_PAGE_COPY : copy === null;
}

function isEnforcementPresentation(value: unknown): value is EnforcementPresentation {
  return value === 'starting' || value === 'active' || value === 'clear';
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'auto' || value === 'light' || value === 'dark';
}

function isStrictness(value: unknown): value is Strictness {
  return value === 'flexible' || value === 'friction' || value === 'hard';
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
