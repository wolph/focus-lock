import type { PendingPath, PendingPolicyChange } from '../background/pending-policy-changes';
import type { DocumentContentCommand } from './enforcement-v2';
import type {
  BootFailure,
  DailyAgg,
  EventRecord,
  GateState,
  ListsConfig,
  MonthlyAgg,
  OnboardingDraft,
  SessionConfigV2,
  SessionMode,
  SessionRuleSnapshot,
  SessionSnapshot,
  SessionSnapshotV2,
  Settings,
  SetupState,
  StorageMode,
  StreakState,
  ThemeMode,
} from './types';
import type { WorkTabIconResult, WorkTabsResult, WorkTargetResult } from './work-target';

/**
 * A type alias, not an interface, so callers can still pass it where a record is wanted. The
 * second member is the popup's start with a chosen work tab: `workTabId` is saved for the session
 * the start mints and `windowId` is the popup's own window, which fixes the privacy context. The
 * two extra keys come together or not at all.
 */
export type SessionStartRequestV2 =
  | { type: 'startSession'; config: SessionConfigV2 }
  | { type: 'startSession'; config: SessionConfigV2; workTabId: number; windowId: number };

export type TransitionFailureReasonV2 =
  | 'website-access-lost'
  | 'content-registration-failed'
  | 'alarm-failed'
  | 'tab-enforcement-failed';

export type StartSessionResultCodeV2 =
  | 'ok'
  | 'invalid-request'
  | TransitionFailureReasonV2
  | 'transition-cleanup-pending'
  | 'closure-cleanup-pending'
  | 'data-clear-pending'
  /** The session started. Only the work tab named in the start request was not saved. */
  | 'work-target-not-saved';

export type SessionCommandResultCodeV2 =
  | 'ok'
  | 'no-active-session'
  | 'end-not-allowed'
  | 'no-active-gate'
  | 'gate-not-ready'
  | 'confirmation-mismatch'
  | 'transition-cleanup-pending'
  | 'closure-cleanup-pending'
  | 'data-clear-pending';

export type RetryCleanupResultCodeV2 = 'ok' | 'retry-not-available';

export type CommandResultCodeV2 =
  | StartSessionResultCodeV2
  | SessionCommandResultCodeV2
  | RetryCleanupResultCodeV2;

export type CommandResponseV2<Code extends CommandResultCodeV2> =
  | { ok: true; code: Extract<Code, 'ok'> }
  | { ok: false; code: Exclude<Code, 'ok'>; error: string };

type StartRejectionWithoutCleanupV2 = {
  ok: false;
  code:
    | 'invalid-request'
    | 'transition-cleanup-pending'
    | 'closure-cleanup-pending'
    | 'data-clear-pending'
    | 'work-target-not-saved';
  error: string;
  cleanupPending?: never;
};

type TransitionFailureBeforeEffectsV2 = {
  ok: false;
  code: TransitionFailureReasonV2;
  error: string;
  cleanupPending?: never;
};

type TransitionFailureWithCleanupV2 = {
  ok: false;
  code: TransitionFailureReasonV2;
  error: string;
  cleanupPending: true;
};

export type StartSessionResponseV2 =
  | { ok: true; code: 'ok' }
  | StartRejectionWithoutCleanupV2
  | TransitionFailureBeforeEffectsV2
  | TransitionFailureWithCleanupV2;

export type SoundId = 'sessionComplete' | 'breakStart' | 'breakEnd' | 'scheduleStart';

/** Every request that is not a session command. The session members are the v2 union. */
export type NonSessionRequest =
  | { type: 'getSnapshot' }
  | { type: 'getSetupState' }
  | { type: 'openOnboarding' }
  | { type: 'getOnboardingDraft' }
  | { type: 'cleanupOnboardingDraft' }
  | { type: 'saveOnboardingDraft'; draft: OnboardingDraft }
  | { type: 'completeOnboarding'; revision: number; storageMode: StorageMode }
  | { type: 'reconcileWebsiteAccess' }
  | { type: 'dismissWebsiteAccessNotice' }
  | { type: 'completeSetup'; storageMode: StorageMode; settings: Settings; lists: ListsConfig }
  | { type: 'setStorageMode'; storageMode: StorageMode; deleteRemote: boolean }
  | { type: 'retrySync' }
  /** The failure that stopped the last boot, or null while the worker is running. */
  | { type: 'getBootFailure' }
  /** Runs the boot again after a failure, and answers once it has settled either way. */
  | { type: 'retryBoot' }
  /**
   * Parks the stored runtime and its migration checkpoint as a diagnostic, then boots again over
   * an empty runtime. Accepted only for a failure in the runtime stage.
   */
  | { type: 'resetLocalRuntime' }
  | {
      type: 'clearFocusLockData';
      scope: 'local-history' | 'synced-policy' | 'all';
    }
  /** docState fresh = document_start on a new navigation (worker records the tab as stopped when blocked), loaded = an already-rendered page */
  | { type: 'getBlockState'; url: string; docState: 'fresh' | 'loaded' }
  | { type: 'updateSettings'; settings: Settings }
  | { type: 'updateTheme'; theme: ThemeMode }
  | { type: 'updateLists'; lists: ListsConfig }
  | { type: 'getSettings' }
  | { type: 'getLists' }
  /** Settings only: the weakening edits a hard lock refused and still owes. */
  | { type: 'getPendingChanges' }
  | { type: 'cancelPendingChange'; path: PendingPath }
  | { type: 'getStats'; days: number }
  | { type: 'exportEvents' }
  | { type: 'previewSound'; sound: SoundId }
  /** Content only: the live session's eligible tabs, under the rules it captured at start. */
  | { type: 'getWorkTabs'; sessionId: string }
  /** Popup only, before a start: eligible tabs under the draft's rules, or the saved lists when omitted. */
  | { type: 'getWorkTabs'; mode: SessionMode; windowId: number; rules?: SessionRuleSnapshot }
  /** Content only: one eligible tab's favicon, read from Chrome's local favicon cache. */
  | { type: 'getWorkTabIcon'; sessionId: string; tabId: number }
  /** Popup (with its windowId) or content (without): where the chosen work tab stands now. */
  | { type: 'getWorkTarget'; windowId?: number }
  /** Popup (with its windowId) or content (without): choose the work tab for the live session. */
  | { type: 'setWorkTarget'; sessionId: string; tabId: number; windowId?: number }
  /** Popup (with its windowId) or content (without): close any open gate and switch to the work tab. */
  | { type: 'returnToWork'; sessionId: string; windowId?: number };

export type Request = NonSessionRequest | SessionRequestV2;

export interface Rejection {
  ok: false;
  error: string;
}
export type Ack = { ok: true } | Rejection;

export const STALE_SESSION_RULES_ERROR: string =
  'Your default blocking lists changed. Review this session and start again.';

export type OnboardingOperationalFailure = Rejection & {
  conflict?: never;
  completed?: never;
  draft?: never;
};

export type OnboardingDraftLoadResponse =
  | { ok: true; draft: OnboardingDraft | null; invalid: boolean }
  | OnboardingOperationalFailure;

export type OnboardingDraftConflict = Rejection & {
  conflict: true;
  completed: boolean;
  draft: OnboardingDraft | null;
};

export type OnboardingDraftWriteResponse =
  | { ok: true; draft: OnboardingDraft }
  | OnboardingOperationalFailure
  | OnboardingDraftConflict;

export type OnboardingCleanupResponse = { ok: true } | OnboardingOperationalFailure;
export type OnboardingCompletionResponse =
  | { ok: true }
  | OnboardingDraftConflict
  | OnboardingOperationalFailure;

export type WebsiteAccessReconciliation =
  | { ok: true; granted: true; registration: 'ready' }
  | { ok: true; granted: false; registration: 'unavailable' }
  | (Rejection & { granted?: never; registration?: never })
  | (Rejection & { granted: boolean; registration: 'error' })
  | (Rejection & { granted?: never; registration: 'error' });

export type ClearFocusLockDataResponse =
  | {
      ok: true;
      scope: 'local-history' | 'synced-policy' | 'all';
      status: 'cleared';
    }
  | (Rejection & {
      scope: 'local-history' | 'synced-policy' | 'all';
      status: 'pending' | 'cleared';
    });

export type RetrySyncResponse = { ok: true; syncWriteStatus: 'idle' } | Rejection;

/** Always `ok`: a failure is an answer here, not a rejection. */
export type BootFailureResponse = { ok: true; failure: BootFailure | null };

export interface StatsBundle {
  /** merged across devices, oldest first */
  days: DailyAgg[];
  months: MonthlyAgg[];
  streak: StreakState;
  /** local machine only, newest first, events for at most 50 session rows */
  recentSessions: EventRecord[];
  totals: {
    focusMsToday: number;
    focusMsLast7Days: number;
    attemptsToday: number;
    resistedToday: number;
  };
}

export interface NonSessionResponseMap {
  getSnapshot: SessionSnapshot;
  getSetupState: SetupState;
  openOnboarding: Ack;
  getOnboardingDraft: OnboardingDraftLoadResponse;
  cleanupOnboardingDraft: OnboardingCleanupResponse;
  saveOnboardingDraft: OnboardingDraftWriteResponse;
  completeOnboarding: OnboardingCompletionResponse;
  reconcileWebsiteAccess: WebsiteAccessReconciliation;
  dismissWebsiteAccessNotice: Ack;
  completeSetup: Ack;
  setStorageMode: Ack;
  retrySync: RetrySyncResponse;
  getBootFailure: BootFailureResponse;
  retryBoot: Ack;
  resetLocalRuntime: Ack;
  clearFocusLockData: ClearFocusLockDataResponse;
  updateSettings: Ack;
  updateTheme: Ack;
  updateLists: Ack;
  getSettings: Settings;
  getLists: ListsConfig;
  getPendingChanges: { changes: PendingPolicyChange[] };
  cancelPendingChange: Ack;
  getStats: StatsBundle;
  exportEvents: { json: string };
  previewSound: Ack;
  getWorkTabs: WorkTabsResult;
  getWorkTabIcon: WorkTabIconResult;
  getWorkTarget: WorkTargetResult;
  setWorkTarget: Ack;
  returnToWork: Ack;
}

export interface ResponseMap extends NonSessionResponseMap, SessionResponseMapV2 {
  /** The documents a content script must apply, newest persisted values only. */
  getBlockState: { commands: DocumentContentCommand[] };
}

export type Broadcast =
  | { type: 'stateChanged'; snapshot: SessionSnapshotV2 }
  /** content scripts must re-run getBlockState with their current URL */
  | { type: 'reevaluate' }
  /** the work tab pickers and the return control must re-read getWorkTarget or getWorkTabs */
  | { type: 'workTargetChanged' };

/** Worker-to-content-script push commands, sent via chrome.tabs.sendMessage. */
export type ContentCommand =
  | DocumentContentCommand
  | { type: 'reevaluate' }
  | { type: 'workTargetChanged' };

export async function sendRequest<T extends Request['type']>(
  req: Extract<Request, { type: T }>,
): Promise<ResponseMap[T]> {
  return (await chrome.runtime.sendMessage(req)) as ResponseMap[T];
}

/**
 * The v2 session command channel, merged into `Request` by the cutover. `startSession`
 * is the named request the worker parser returns, so the union carries that interface
 * rather than a second spelling of it.
 */
export type SessionRequestV2 =
  | SessionStartRequestV2
  | { type: 'requestSessionEnd' }
  | { type: 'openEndGate' }
  | { type: 'abandonGate'; expectedGate: GateState }
  | { type: 'confirmGate'; typedPhrase: string | null; expectedGate: GateState }
  | { type: 'openGate'; gate: 'pause' | 'unlockSite'; host: string | null }
  /** Ends a Friction session from its open cancel gate at once, when the worker minted the flag. */
  | { type: 'forceEndGate' }
  | { type: 'resumeFromPause' }
  | { type: 'startNextFocusEarly' }
  | { type: 'retryTransitionCleanup' }
  | { type: 'retryClosureCleanup' }
  | { type: 'retryDataClear' };

export interface SessionResponseMapV2 {
  startSession: StartSessionResponseV2;
  requestSessionEnd: CommandResponseV2<SessionCommandResultCodeV2>;
  openEndGate: CommandResponseV2<SessionCommandResultCodeV2>;
  abandonGate: CommandResponseV2<SessionCommandResultCodeV2>;
  confirmGate: CommandResponseV2<SessionCommandResultCodeV2>;
  openGate: CommandResponseV2<SessionCommandResultCodeV2>;
  forceEndGate: CommandResponseV2<SessionCommandResultCodeV2>;
  resumeFromPause: CommandResponseV2<SessionCommandResultCodeV2>;
  startNextFocusEarly: CommandResponseV2<SessionCommandResultCodeV2>;
  retryTransitionCleanup: CommandResponseV2<RetryCleanupResultCodeV2>;
  retryClosureCleanup: CommandResponseV2<RetryCleanupResultCodeV2>;
  retryDataClear: CommandResponseV2<RetryCleanupResultCodeV2>;
}
