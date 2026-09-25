import type { DocumentContentCommand } from '../shared/enforcement-v2';
import type { EnforcementTargetPortsV2 } from './enforcement-targets-v2';
import type { BlockingSweepLease, Engine, LiveTabState } from './engine';
import type { CleanupTabClaim } from './runtime-v2-types';

export interface TabState {
  /** the tab's current mute state */
  muted: boolean;
  /** Chrome attributes the current mute to this extension */
  mutedByExtension?: boolean;
  /** the worker muted this tab and recorded its prior state */
  wasMutedByUs: boolean;
  /** the recorded mute state to restore on unblock */
  priorMuted: boolean;
  /** the tab was window.stop()ed before loading, reload on unblock */
  wasStopped: boolean;
}

/** The browser effects one target needs beside the command the controller sends it. */
export interface TabAction {
  /** mute state to set, null for no change */
  mute: boolean | null;
  reload: boolean;
}

type TabReadResult = { ok: true; tab: chrome.tabs.Tab } | { ok: false; error: unknown };

type DocumentReadResult = { ok: true; documentId: string | null } | { ok: false; error: unknown };

async function readTab(tabId: number): Promise<TabReadResult> {
  try {
    return { ok: true, tab: await chrome.tabs.get(tabId) };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  const result: TabReadResult = await readTab(tabId);
  return result.ok ? result.tab : null;
}

async function readDocumentId(tabId: number): Promise<DocumentReadResult> {
  if (chrome.webNavigation?.getFrame === undefined) return { ok: true, documentId: null };
  try {
    const frame: chrome.webNavigation.GetFrameResultDetails | null =
      await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    return { ok: true, documentId: frame?.documentId ?? null };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

async function getDocumentId(tabId: number): Promise<string | null> {
  const result: DocumentReadResult = await readDocumentId(tabId);
  return result.ok ? result.documentId : null;
}

async function tabStillAt(tabId: number, url: string): Promise<boolean> {
  const tab: chrome.tabs.Tab | null = await getTab(tabId);
  return tab?.url === url;
}

/** Pure per-tab decision: the mute and reload effects a blocked or cleared target needs. */
export function planTabAction(blocked: boolean, tabState: TabState): TabAction {
  const ownsTabEffects: boolean = tabState.wasMutedByUs && tabState.mutedByExtension === true;
  if (blocked) return { mute: ownsTabEffects && tabState.muted ? null : true, reload: false };
  return { mute: ownsTabEffects ? tabState.priorMuted : null, reload: tabState.wasStopped };
}

/**
 * The commands one target must apply, from the controller that owns them. It freezes and persists
 * the command, records the blocked attempt when a kind is given, and answers what it froze, which
 * is how this file learns whether the page ends up blocked.
 */
async function blockedForTarget(
  engine: Engine,
  tabId: number,
  input: TabApplyInput,
  attemptKind: 'navigation' | 'existing' | null,
): Promise<boolean> {
  // A sweep often carries no document id, because it starts from a tab query. The live one is read
  // here so the mute and reload effects still know whether the page ends up blocked.
  const documentId: string | null = input.documentId ?? (await getDocumentId(tabId));
  if (documentId === null) return false;
  // This file reads the answer and drops it, so it asks as a reader, which is the default: the
  // epoch reset a document has not acknowledged belongs to the push that follows, not to this call.
  const commands: DocumentContentCommand[] = await engine.documentCommandsFor(
    { tabId, documentId, url: input.url },
    attemptKind,
  );
  return commands.some(
    (command: DocumentContentCommand): boolean =>
      command.command === 'apply-enforcement' && command.verdict.blocked,
  );
}

const tabTaskTails: Map<number, Promise<void>> = new Map();
const tabTaskVersions: Map<number, number> = new Map();
let tabTaskSequence: number = 0;
const tabOperationVersions: Map<number, number> = new Map();
const tabOperationUrls: Map<number, string | null> = new Map();
interface TabOperationLeaseState {
  count: number;
}

interface RemovedTabClaim {
  cleanupPromise: Promise<void> | null;
  engine: Engine;
  url: string;
}

const activeTabOperationLeases: Map<number, TabOperationLeaseState> = new Map();
const pendingTabReadinessLeases: Map<number, TabOperationLeaseState> = new Map();
let tabOperationSequence: number = 0;

function acquireTabOperationLease(tabId: number): () => void {
  let leaseState: TabOperationLeaseState | undefined = activeTabOperationLeases.get(tabId);
  if (leaseState === undefined) {
    leaseState = { count: 0 };
    activeTabOperationLeases.set(tabId, leaseState);
  }
  leaseState.count += 1;
  let released: boolean = false;
  return (): void => {
    if (released) return;
    released = true;
    leaseState.count -= 1;
    if (leaseState.count === 0 && activeTabOperationLeases.get(tabId) === leaseState) {
      activeTabOperationLeases.delete(tabId);
    }
  };
}

function acquireTabReadinessLease(tabId: number): () => void {
  let leaseState: TabOperationLeaseState | undefined = pendingTabReadinessLeases.get(tabId);
  if (leaseState === undefined) {
    leaseState = { count: 0 };
    pendingTabReadinessLeases.set(tabId, leaseState);
  }
  leaseState.count += 1;
  let released: boolean = false;
  return (): void => {
    if (released) return;
    released = true;
    leaseState.count -= 1;
    if (leaseState.count === 0 && pendingTabReadinessLeases.get(tabId) === leaseState) {
      pendingTabReadinessLeases.delete(tabId);
    }
  };
}

function releaseRemovedTabClaim(tabId: number, claim: RemovedTabClaim): Promise<void> {
  const cleanup: Promise<void> =
    claim.cleanupPromise ??
    Promise.resolve().then((): Promise<void> => claim.engine.releaseMuteClaim(tabId, claim.url));
  return cleanup.catch((error: unknown): void => claim.engine.reportError(error));
}

export function invalidateRemovedTab(tabId: number): Promise<void> {
  beginTabOperation(tabId, null);
  tabTaskVersions.delete(tabId);
  tabTaskTails.delete(tabId);

  const continuation: MuteContinuation | undefined = muteContinuations.get(tabId);
  if (continuation !== undefined) {
    continuation.cancelled = true;
    if (continuation.timer !== null) {
      clearTimeout(continuation.timer);
      continuation.timer = null;
    }
    muteContinuations.delete(tabId);
  }
  const inherited: InheritedMuteClaim | undefined = inheritedMuteClaims.get(tabId);
  inheritedMuteClaims.delete(tabId);
  activeTabOperationLeases.delete(tabId);
  pendingTabReadinessLeases.delete(tabId);

  const claims: RemovedTabClaim[] = [];
  if (continuation !== undefined) {
    claims.push({
      cleanupPromise: continuation.cleanupPromise,
      engine: continuation.engine,
      url: continuation.ownedUrl,
    });
  }
  if (
    inherited !== undefined &&
    !claims.some(
      (claim: RemovedTabClaim): boolean =>
        claim.engine === inherited.engine && claim.url === inherited.url,
    )
  ) {
    claims.push(inherited);
  }
  const cleanups: Promise<void>[] = claims.map((claim: RemovedTabClaim): Promise<void> => {
    const cleanup: Promise<void> = releaseRemovedTabClaim(tabId, claim);
    if (continuation?.engine === claim.engine && continuation.ownedUrl === claim.url) {
      continuation.cleanupPromise = cleanup;
    }
    if (inherited?.engine === claim.engine && inherited.url === claim.url) {
      inherited.cleanupPromise = cleanup;
    }
    return cleanup;
  });
  return Promise.all(cleanups).then((): void => undefined);
}

function nextTabOperationVersion(): number {
  tabOperationSequence += 1;
  return tabOperationSequence;
}

function acceptTabOperation(
  tabId: number,
  operationVersion: number,
  operationUrl: string | null = null,
): boolean {
  const currentVersion: number | undefined = tabOperationVersions.get(tabId);
  if (currentVersion !== undefined && currentVersion > operationVersion) return false;
  tabOperationVersions.set(tabId, operationVersion);
  tabOperationUrls.set(tabId, operationUrl);
  return true;
}

function beginTabOperation(tabId: number, operationUrl: string | null = null): number {
  const operationVersion: number = nextTabOperationVersion();
  acceptTabOperation(tabId, operationVersion, operationUrl);
  return operationVersion;
}

function enqueueTabTask<T>(tabId: number, task: (taskVersion: number) => Promise<T>): Promise<T> {
  tabTaskSequence += 1;
  const taskVersion: number = tabTaskSequence;
  tabTaskVersions.set(tabId, taskVersion);
  const previous: Promise<void> = tabTaskTails.get(tabId) ?? Promise.resolve();
  const result: Promise<T> = previous.then((): Promise<T> => task(taskVersion));
  const tail: Promise<void> = result.then(
    (): void => undefined,
    (): void => undefined,
  );
  tabTaskTails.set(tabId, tail);
  void tail.then((): void => {
    if (tabTaskTails.get(tabId) === tail) tabTaskTails.delete(tabId);
  });
  return result;
}

interface TabApplyInput {
  url: string;
  mutedNow: boolean;
  mutedByExtension: boolean;
  documentId: string | null;
}

interface ResolvedTabApplyOptions {
  beforeEffects?(input: TabApplyInput, taskVersion: number): void;
  afterEffects?(input: TabApplyInput): Promise<void>;
  isCurrent?: () => boolean;
  lease?: BlockingSweepLease;
  requireCurrentTask?: boolean;
  validateDocument?: boolean;
}

function _recordAttemptWithLease(
  engine: Engine,
  url: string,
  tabId: number,
  kind: 'navigation' | 'existing',
  lease?: BlockingSweepLease,
): Promise<void> {
  return lease === undefined
    ? engine.recordAttempt(url, tabId, kind)
    : engine.recordAttempt(url, tabId, kind, lease);
}

function releaseMuteClaimWithLease(
  engine: Engine,
  tabId: number,
  url: string,
  lease?: BlockingSweepLease,
): Promise<void> {
  return lease === undefined
    ? engine.releaseMuteClaim(tabId, url)
    : engine.releaseMuteClaim(tabId, url, lease);
}

function claimMuteWithLease(
  engine: Engine,
  tabId: number,
  url: string,
  priorMuted: boolean,
  lease?: BlockingSweepLease,
): Promise<boolean> {
  return lease === undefined
    ? engine.claimMute(tabId, url, priorMuted)
    : engine.claimMute(tabId, url, priorMuted, lease);
}

function settleMuteClaimWithLease(
  engine: Engine,
  tabId: number,
  finalUrl: string | null,
  lease?: BlockingSweepLease,
): Promise<void> {
  return lease === undefined
    ? engine.settleMuteClaim(tabId, finalUrl)
    : engine.settleMuteClaim(tabId, finalUrl, lease);
}

function reconcileTabsWithLease(
  engine: Engine,
  liveTabs: ReadonlyMap<number, LiveTabState>,
  protectedTabIds: ReadonlySet<number>,
  lease?: BlockingSweepLease,
): void {
  if (lease === undefined) engine.reconcileTabs(liveTabs, protectedTabIds);
  else engine.reconcileTabs(liveTabs, protectedTabIds, lease);
}

function flushRuntimeWithLease(engine: Engine, lease?: BlockingSweepLease): Promise<void> {
  return lease === undefined ? engine.flushRuntime() : engine.flushRuntime(lease);
}

async function applyTabEffectsNow(
  engine: Engine,
  tabId: number,
  input: TabApplyInput,
  blocked: boolean,
  beforeEffects: () => void = (): void => undefined,
  shouldContinue: () => boolean = (): boolean => true,
  validateDocument: boolean = false,
  lease?: BlockingSweepLease,
): Promise<void> {
  const { url, mutedNow, mutedByExtension, documentId }: TabApplyInput = input;
  if (!(await tabStillAt(tabId, url)) || !shouldContinue()) return;
  if (validateDocument && documentId !== null) {
    const liveDocumentId: string | null = await getDocumentId(tabId);
    if (liveDocumentId !== documentId || !shouldContinue()) return;
  }
  beforeEffects();
  const facts: { wasMutedByUs: boolean; priorMuted: boolean; wasStopped: boolean } =
    engine.tabFacts(tabId, url, documentId);
  const action: TabAction = planTabAction(blocked, {
    muted: mutedNow,
    mutedByExtension,
    ...facts,
  });
  if (!(await tabStillAt(tabId, url)) || !shouldContinue()) return;
  // The controller routes this target to whichever authority owns it and sends what it owes,
  // reset first for a document that has not acknowledged the epoch.
  const liveDocumentId: string | null = documentId ?? (await getDocumentId(tabId));
  if (liveDocumentId !== null) {
    await engine.handleNavigation({ tabId, documentId: liveDocumentId, url }, null);
  }
  if (!shouldContinue()) return;
  if (validateDocument && documentId !== null) {
    const liveDocumentId: string | null = await getDocumentId(tabId);
    if (liveDocumentId !== documentId || !shouldContinue()) return;
  }
  if (blocked) {
    await applyMute(
      engine,
      tabId,
      url,
      facts,
      mutedNow,
      mutedByExtension,
      documentId,
      shouldContinue,
      lease,
    );
  } else if (facts.wasMutedByUs) {
    await restoreMute(
      engine,
      tabId,
      url,
      facts.priorMuted,
      mutedNow,
      mutedByExtension,
      documentId,
      shouldContinue,
      lease,
    );
  }
  if (action.reload) {
    if (documentId === null || !(await tabStillAt(tabId, url)) || !shouldContinue()) return;
    const liveDocumentId: string | null = await getDocumentId(tabId);
    if (liveDocumentId !== documentId || !shouldContinue()) return;
    try {
      await chrome.tabs.reload(tabId);
      if (lease === undefined) engine.noteReloaded(tabId, documentId);
      else engine.noteReloaded(tabId, documentId, lease);
    } catch {
      // the tab may be gone already
    }
  }
}

async function queueResolvedTabApply(
  engine: Engine,
  tabId: number,
  attemptKind: 'navigation' | 'existing' | null,
  resolveInput: (taskVersion: number) => Promise<TabApplyInput | null>,
  options: ResolvedTabApplyOptions = {},
  operationVersion: number = beginTabOperation(tabId),
  operationUrl: string | null = null,
): Promise<void> {
  if (!acceptTabOperation(tabId, operationVersion, operationUrl)) return;
  const operationIsCurrent: () => boolean = (): boolean =>
    tabOperationVersions.get(tabId) === operationVersion && (options.isCurrent?.() ?? true);
  let recordedAttemptUrl: string | null = null;
  while (true) {
    const preparation: {
      input: TabApplyInput;
      persistence: Promise<boolean> | null;
    } | null = await enqueueTabTask(
      tabId,
      async (
        taskVersion: number,
      ): Promise<{ input: TabApplyInput; persistence: Promise<boolean> | null } | null> => {
        if (!operationIsCurrent()) return null;
        await cancelMuteContinuation(tabId, options.lease);
        const input: TabApplyInput | null = await resolveInput(taskVersion);
        if (input === null || !operationIsCurrent()) return null;
        if (options.requireCurrentTask && tabTaskVersions.get(tabId) !== taskVersion) return null;
        const kind: 'navigation' | 'existing' | null =
          recordedAttemptUrl === input.url ? null : attemptKind;
        // The controller records the attempt as it freezes the command, and that write commits,
        // which starts a blocking sweep that re-enters this tab's queue. So the call is started
        // here and settled after the task releases: a sweep must never wait for the task that
        // asked for it. Nothing is recorded without a kind, so that case still settles in place.
        if (kind === null) {
          await blockedForTarget(engine, tabId, input, null);
          return { input, persistence: null };
        }
        const frozen: Promise<boolean> = blockedForTarget(engine, tabId, input, kind);
        // The rejection is delivered to the awaiting caller below, not to the process.
        void frozen.catch((): void => undefined);
        return { input, persistence: frozen };
      },
    );
    if (preparation === null) return;
    if (preparation.persistence !== null) {
      const blocked: boolean = await preparation.persistence;
      if (!operationIsCurrent()) return;
      if (blocked) recordedAttemptUrl = preparation.input.url;
    }

    const completed: boolean = await enqueueTabTask(
      tabId,
      async (taskVersion: number): Promise<boolean> => {
        if (!operationIsCurrent()) return true;
        await cancelMuteContinuation(tabId, options.lease);
        const input: TabApplyInput | null = await resolveInput(taskVersion);
        if (input === null || !operationIsCurrent()) return true;
        if (options.requireCurrentTask && tabTaskVersions.get(tabId) !== taskVersion) return true;
        const blocked: boolean = await blockedForTarget(engine, tabId, input, null);
        if (attemptKind !== null && blocked && recordedAttemptUrl !== input.url) return false;
        let effectsAccepted: boolean = false;
        await applyTabEffectsNow(
          engine,
          tabId,
          input,
          blocked,
          (): void => {
            effectsAccepted = true;
            options.beforeEffects?.(input, taskVersion);
          },
          operationIsCurrent,
          options.validateDocument ?? false,
          options.lease,
        );
        if (effectsAccepted && options.afterEffects !== undefined) {
          await options.afterEffects(input);
        }
        return true;
      },
    );
    if (completed) return;
  }
}

function queueTabApply(
  engine: Engine,
  tabId: number,
  url: string,
  mutedNow: boolean,
  attemptKind: 'navigation' | 'existing' = 'existing',
  mutedByExtension: boolean = false,
  documentId: string | null = null,
  operationVersion: number = beginTabOperation(tabId, url),
): Promise<void> {
  return queueResolvedTabApply(
    engine,
    tabId,
    attemptKind,
    async (): Promise<TabApplyInput | null> => {
      if (!(await tabStillAt(tabId, url))) return null;
      return { url, mutedNow, mutedByExtension, documentId };
    },
    {},
    operationVersion,
    url,
  );
}

export function applyToTab(
  engine: Engine,
  tabId: number,
  url: string,
  mutedNow: boolean,
  attemptKind: 'navigation' | 'existing' = 'existing',
  mutedByExtension: boolean = false,
  documentId: string | null = null,
): Promise<void> {
  const releaseOperationLease: () => void = acquireTabOperationLease(tabId);
  const operationVersion: number = beginTabOperation(tabId, url);
  void cancelMuteContinuation(tabId);
  try {
    return queueTabApply(
      engine,
      tabId,
      url,
      mutedNow,
      attemptKind,
      mutedByExtension,
      documentId,
      operationVersion,
    ).finally(releaseOperationLease);
  } catch (error: unknown) {
    releaseOperationLease();
    throw error;
  }
}

function muteState(
  tab: chrome.tabs.Tab,
  fallbackMuted: boolean,
  fallbackOwned: boolean,
): { muted: boolean; owned: boolean } {
  if (tab.mutedInfo === undefined) {
    return { muted: fallbackMuted, owned: fallbackOwned };
  }
  return {
    muted: tab.mutedInfo.muted,
    owned: tab.mutedInfo.muted && tab.mutedInfo.extensionId === chrome.runtime.id,
  };
}

interface TabIdentity {
  url: string;
  documentId: string | null;
}

interface LiveTabIdentity {
  tab: chrome.tabs.Tab;
  identity: TabIdentity;
}

const MUTE_CORRECTION_LIMIT: number = 3;

interface MuteContinuation {
  cancelled: boolean;
  cleanupPromise: Promise<void> | null;
  engine: Engine;
  ownedUrl: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const muteContinuations: Map<number, MuteContinuation> = new Map();

interface InheritedMuteClaim {
  cleanupPromise: Promise<void> | null;
  engine: Engine;
  url: string;
}

const inheritedMuteClaims: Map<number, InheritedMuteClaim> = new Map();

function retainInheritedMuteClaim(tabId: number, engine: Engine, url: string): void {
  const inherited: InheritedMuteClaim | undefined = inheritedMuteClaims.get(tabId);
  if (inherited?.engine === engine && inherited.url === url) return;
  inheritedMuteClaims.set(tabId, { cleanupPromise: null, engine, url });
}

function moveInheritedMuteClaim(
  tabId: number,
  engine: Engine,
  fromUrl: string,
  toUrl: string,
): void {
  const inherited: InheritedMuteClaim | undefined = inheritedMuteClaims.get(tabId);
  if (inherited?.engine !== engine || inherited.url !== fromUrl) return;
  inherited.url = toUrl;
  inherited.cleanupPromise = null;
}

function dropInheritedMuteClaim(tabId: number, engine: Engine, url: string): void {
  const inherited: InheritedMuteClaim | undefined = inheritedMuteClaims.get(tabId);
  if (inherited?.engine === engine && inherited.url === url) inheritedMuteClaims.delete(tabId);
}

function releaseInheritedMuteClaim(
  tabId: number,
  skipUrl: string | null = null,
  lease?: BlockingSweepLease,
): Promise<void> {
  const inherited: InheritedMuteClaim | undefined = inheritedMuteClaims.get(tabId);
  if (
    inherited === undefined ||
    inherited.url === skipUrl ||
    tabOperationUrls.get(tabId) === inherited.url
  ) {
    return Promise.resolve();
  }
  if (inherited.cleanupPromise === null) {
    inherited.cleanupPromise = releaseMuteClaimWithLease(
      inherited.engine,
      tabId,
      inherited.url,
      lease,
    ).catch((error: unknown): void => inherited.engine.reportError(error));
  }
  const cleanup: Promise<void> = inherited.cleanupPromise;
  void cleanup.then((): void => {
    if (inheritedMuteClaims.get(tabId) === inherited) inheritedMuteClaims.delete(tabId);
  });
  return cleanup;
}

async function retainOrReleaseStaleMuteClaim(
  engine: Engine,
  tabId: number,
  url: string,
  lease?: BlockingSweepLease,
): Promise<void> {
  if (tabOperationUrls.get(tabId) === url) {
    retainInheritedMuteClaim(tabId, engine, url);
    return;
  }
  await releaseMuteClaimWithLease(engine, tabId, url, lease);
  dropInheritedMuteClaim(tabId, engine, url);
}

function releaseMuteContinuationClaim(
  tabId: number,
  continuation: MuteContinuation,
  lease?: BlockingSweepLease,
): Promise<void> {
  if (tabOperationUrls.get(tabId) === continuation.ownedUrl) {
    retainInheritedMuteClaim(tabId, continuation.engine, continuation.ownedUrl);
    return Promise.resolve();
  }
  if (continuation.cleanupPromise === null) {
    continuation.cleanupPromise = releaseMuteClaimWithLease(
      continuation.engine,
      tabId,
      continuation.ownedUrl,
      lease,
    ).catch((error: unknown): void => continuation.engine.reportError(error));
  }
  return continuation.cleanupPromise;
}

function cancelMuteContinuation(tabId: number, lease?: BlockingSweepLease): Promise<void> {
  const continuation: MuteContinuation | undefined = muteContinuations.get(tabId);
  if (continuation === undefined) return releaseInheritedMuteClaim(tabId, null, lease);
  continuation.cancelled = true;
  if (continuation.timer !== null) {
    clearTimeout(continuation.timer);
    continuation.timer = null;
  }
  const cleanup: Promise<void> = releaseMuteContinuationClaim(tabId, continuation, lease);
  const inheritedCleanup: Promise<void> = releaseInheritedMuteClaim(
    tabId,
    continuation.ownedUrl,
    lease,
  );
  void cleanup.then((): void => {
    if (continuation.cleanupPromise !== null && muteContinuations.get(tabId) === continuation) {
      muteContinuations.delete(tabId);
    }
  });
  return Promise.all([cleanup, inheritedCleanup]).then((): void => undefined);
}

function discardMuteContinuation(tabId: number): void {
  const continuation: MuteContinuation | undefined = muteContinuations.get(tabId);
  if (continuation === undefined) return;
  continuation.cancelled = true;
  if (continuation.timer !== null) clearTimeout(continuation.timer);
  muteContinuations.delete(tabId);
}

function muteContinuationCancelled(continuation: MuteContinuation | null): boolean {
  return continuation?.cancelled === true;
}

function missingUrlAfterMuteUpdate(tabId: number): Error {
  return new Error(`Tab ${tabId} has no URL after a mute update`);
}

function muteCorrectionLimitError(tabId: number): Error {
  return new Error(`Tab ${tabId} exceeded the mute correction limit`);
}

async function readLiveTabIdentity(engine: Engine, tabId: number): Promise<LiveTabIdentity | null> {
  const tabRead: TabReadResult = await readTab(tabId);
  if (!tabRead.ok) {
    engine.reportError(tabRead.error);
    return null;
  }
  const url: string | undefined = tabRead.tab.url;
  if (url === undefined || url === '') {
    engine.reportError(missingUrlAfterMuteUpdate(tabId));
    return null;
  }
  const documentRead: DocumentReadResult = await readDocumentId(tabId);
  if (!documentRead.ok) {
    engine.reportError(documentRead.error);
    return null;
  }
  return {
    tab: tabRead.tab,
    identity: { url, documentId: documentRead.documentId },
  };
}

function identityChanged(previous: TabIdentity, current: TabIdentity): boolean {
  if (previous.url !== current.url) return true;
  return (
    previous.documentId !== null &&
    current.documentId !== null &&
    previous.documentId !== current.documentId
  );
}

async function readStableLiveTabIdentity(
  engine: Engine,
  tabId: number,
): Promise<LiveTabIdentity | null> {
  let previous: LiveTabIdentity | null = await readLiveTabIdentity(engine, tabId);
  if (previous === null) return null;
  for (let validation: number = 0; validation < 1; validation += 1) {
    const current: LiveTabIdentity | null = await readLiveTabIdentity(engine, tabId);
    if (current === null) return null;
    if (
      previous.identity.url !== current.identity.url ||
      previous.identity.documentId !== current.identity.documentId
    ) {
      return null;
    }
    previous = current;
  }
  return previous;
}

async function settleMuteUpdate(
  engine: Engine,
  tabId: number,
  sourceIdentity: TabIdentity,
  priorMuted: boolean,
  initiallyBlocked: boolean,
  ownedUrl: string,
  initialLiveTab: LiveTabIdentity | null = null,
  continuation: MuteContinuation | null = null,
  shouldContinue: () => boolean = (): boolean => true,
  lease?: BlockingSweepLease,
): Promise<void> {
  const settlementCancelled: () => boolean = (): boolean =>
    muteContinuationCancelled(continuation) || !shouldContinue();
  let ownedClaimUrl: string = ownedUrl;
  const releaseClaimIfCancelled: () => Promise<boolean> = async (): Promise<boolean> => {
    if (!settlementCancelled()) return false;
    if (tabOperationUrls.get(tabId) === ownedClaimUrl) {
      retainInheritedMuteClaim(tabId, engine, ownedClaimUrl);
      return true;
    }
    if (continuation === null) {
      await releaseMuteClaimWithLease(engine, tabId, ownedClaimUrl, lease);
      dropInheritedMuteClaim(tabId, engine, ownedClaimUrl);
    } else {
      continuation.ownedUrl = ownedClaimUrl;
      await releaseMuteContinuationClaim(tabId, continuation, lease);
    }
    return true;
  };
  let updateIdentity: TabIdentity = sourceIdentity;
  let desiredBlocked: boolean = initiallyBlocked;
  let desiredMuted: boolean = initiallyBlocked ? true : priorMuted;
  let correctionsRemaining: number = MUTE_CORRECTION_LIMIT;
  let pendingLiveTab: LiveTabIdentity | null = initialLiveTab;
  let lastUpdateRejected: boolean = false;

  while (true) {
    if (await releaseClaimIfCancelled()) return;
    const liveTab: LiveTabIdentity | null =
      pendingLiveTab ?? (await readLiveTabIdentity(engine, tabId));
    pendingLiveTab = null;
    if (await releaseClaimIfCancelled()) return;
    if (liveTab === null) return;
    const liveIdentity: TabIdentity = liveTab.identity;
    const liveUrl: string = liveIdentity.url;
    const changedIdentity: boolean = identityChanged(updateIdentity, liveIdentity);
    if (changedIdentity) {
      desiredBlocked = await blockedForTarget(
        engine,
        tabId,
        {
          url: liveUrl,
          mutedNow: desiredMuted,
          mutedByExtension: false,
          documentId: liveIdentity.documentId,
        },
        null,
      );
      desiredMuted = desiredBlocked ? true : priorMuted;
    }
    const liveMute: { muted: boolean; owned: boolean } = muteState(
      liveTab.tab,
      desiredMuted,
      desiredMuted,
    );
    if (liveMute.muted && !liveMute.owned) {
      await settleMuteClaimWithLease(engine, tabId, null, lease);
      dropInheritedMuteClaim(tabId, engine, ownedClaimUrl);
      return;
    }
    if (lastUpdateRejected && !changedIdentity && liveMute.muted !== desiredMuted) return;
    lastUpdateRejected = false;
    if (liveMute.muted === desiredMuted) {
      if (desiredBlocked && liveMute.owned) {
        const previousOwnedClaimUrl: string = ownedClaimUrl;
        const settlement: Promise<void> = settleMuteClaimWithLease(engine, tabId, liveUrl, lease);
        ownedClaimUrl = liveUrl;
        moveInheritedMuteClaim(tabId, engine, previousOwnedClaimUrl, liveUrl);
        if (continuation !== null) {
          continuation.ownedUrl = liveUrl;
          continuation.cleanupPromise = null;
        }
        await settlement;
        await releaseClaimIfCancelled();
      } else {
        await settleMuteClaimWithLease(engine, tabId, null, lease);
        dropInheritedMuteClaim(tabId, engine, ownedClaimUrl);
      }
      return;
    }

    if (correctionsRemaining === 0) {
      engine.reportError(muteCorrectionLimitError(tabId));
      scheduleMuteContinuation(
        engine,
        tabId,
        liveIdentity,
        priorMuted,
        desiredBlocked,
        ownedClaimUrl,
      );
      return;
    }

    if (await releaseClaimIfCancelled()) return;
    try {
      await chrome.tabs.update(tabId, { muted: desiredMuted });
    } catch (error: unknown) {
      engine.reportError(error);
      lastUpdateRejected = true;
    }
    if (await releaseClaimIfCancelled()) return;
    correctionsRemaining -= 1;
    updateIdentity = liveIdentity;
  }
}

function scheduleMuteContinuation(
  engine: Engine,
  tabId: number,
  sourceIdentity: TabIdentity,
  priorMuted: boolean,
  initiallyBlocked: boolean,
  ownedUrl: string,
): void {
  discardMuteContinuation(tabId);
  const continuation: MuteContinuation = {
    cancelled: false,
    cleanupPromise: null,
    engine,
    ownedUrl,
    timer: null,
  };
  continuation.timer = setTimeout((): void => {
    continuation.timer = null;
    if (continuation.cancelled || muteContinuations.get(tabId) !== continuation) {
      void releaseMuteContinuationClaim(tabId, continuation);
      return;
    }
    const queued: Promise<void> = enqueueTabTask(tabId, async (): Promise<void> => {
      if (continuation.cancelled || muteContinuations.get(tabId) !== continuation) {
        await releaseMuteContinuationClaim(tabId, continuation);
        return;
      }
      await settleMuteUpdate(
        engine,
        tabId,
        sourceIdentity,
        priorMuted,
        initiallyBlocked,
        ownedUrl,
        null,
        continuation,
      );
    });
    void queued
      .catch((error: unknown): void => {
        engine.reportError(error);
      })
      .finally((): void => {
        if (
          muteContinuations.get(tabId) === continuation &&
          (!continuation.cancelled || continuation.cleanupPromise !== null)
        ) {
          muteContinuations.delete(tabId);
        }
      });
  }, 0);
  muteContinuations.set(tabId, continuation);
}

async function applyMute(
  engine: Engine,
  tabId: number,
  url: string,
  facts: { wasMutedByUs: boolean; priorMuted: boolean },
  fallbackMuted: boolean,
  fallbackOwned: boolean,
  documentId: string | null,
  shouldContinue: () => boolean,
  lease?: BlockingSweepLease,
): Promise<void> {
  let liveTab: chrome.tabs.Tab | null = await getTab(tabId);
  if (liveTab === null) return;
  if (liveTab.url !== url || !shouldContinue()) {
    if (facts.wasMutedByUs) await retainOrReleaseStaleMuteClaim(engine, tabId, url, lease);
    return;
  }
  let liveMute: { muted: boolean; owned: boolean } = muteState(
    liveTab,
    fallbackMuted,
    fallbackOwned,
  );
  if (liveMute.muted && !liveMute.owned) {
    if (facts.wasMutedByUs && shouldContinue()) {
      await releaseMuteClaimWithLease(engine, tabId, url, lease);
    }
    return;
  }

  const newClaim: boolean = !facts.wasMutedByUs;
  if (newClaim) {
    if (
      !shouldContinue() ||
      !(await claimMuteWithLease(engine, tabId, url, liveMute.muted, lease))
    ) {
      return;
    }
    if (!shouldContinue()) {
      await releaseMuteClaimWithLease(engine, tabId, url, lease);
      return;
    }
  }

  liveTab = await getTab(tabId);
  if (liveTab === null) {
    if (newClaim) await releaseMuteClaimWithLease(engine, tabId, url, lease);
    return;
  }
  if (liveTab.url !== url || !shouldContinue()) {
    await retainOrReleaseStaleMuteClaim(engine, tabId, url, lease);
    return;
  }
  liveMute = muteState(liveTab, fallbackMuted, fallbackOwned);
  if (liveMute.muted) {
    if (!liveMute.owned && shouldContinue()) {
      await releaseMuteClaimWithLease(engine, tabId, url, lease);
    }
    return;
  }

  if (!shouldContinue()) return;
  try {
    await chrome.tabs.update(tabId, { muted: true });
  } catch (error: unknown) {
    engine.reportError(error);
    if (!shouldContinue()) {
      await retainOrReleaseStaleMuteClaim(engine, tabId, url, lease);
      return;
    }
    const failedTab: LiveTabIdentity | null = await readLiveTabIdentity(engine, tabId);
    if (!shouldContinue()) {
      await retainOrReleaseStaleMuteClaim(engine, tabId, url, lease);
      return;
    }
    if (failedTab === null) return;
    const sourceIdentity: TabIdentity = { url, documentId };
    if (identityChanged(sourceIdentity, failedTab.identity)) {
      await settleMuteUpdate(
        engine,
        tabId,
        sourceIdentity,
        facts.priorMuted,
        true,
        url,
        failedTab,
        null,
        shouldContinue,
        lease,
      );
      return;
    }
    const failedMute: { muted: boolean; owned: boolean } = muteState(failedTab.tab, false, false);
    if (!failedMute.owned) {
      await releaseMuteClaimWithLease(engine, tabId, url, lease);
    }
    return;
  }
  if (!shouldContinue()) {
    await retainOrReleaseStaleMuteClaim(engine, tabId, url, lease);
    return;
  }
  await settleMuteUpdate(
    engine,
    tabId,
    { url, documentId },
    facts.priorMuted,
    true,
    url,
    null,
    null,
    shouldContinue,
    lease,
  );
}

async function restoreMute(
  engine: Engine,
  tabId: number,
  url: string,
  priorMuted: boolean,
  fallbackMuted: boolean,
  fallbackOwned: boolean,
  documentId: string | null,
  shouldContinue: () => boolean,
  lease?: BlockingSweepLease,
): Promise<void> {
  const liveTab: chrome.tabs.Tab | null = await getTab(tabId);
  if (liveTab === null) return;
  if (liveTab.url !== url || !shouldContinue()) {
    await retainOrReleaseStaleMuteClaim(engine, tabId, url, lease);
    return;
  }
  const liveMute: { muted: boolean; owned: boolean } = muteState(
    liveTab,
    fallbackMuted,
    fallbackOwned,
  );
  if (!liveMute.owned) {
    if (shouldContinue()) await releaseMuteClaimWithLease(engine, tabId, url, lease);
    return;
  }
  if (!shouldContinue()) return;
  try {
    await chrome.tabs.update(tabId, { muted: priorMuted });
  } catch (error: unknown) {
    engine.reportError(error);
    if (!shouldContinue()) {
      await retainOrReleaseStaleMuteClaim(engine, tabId, url, lease);
      return;
    }
    const failedTab: LiveTabIdentity | null = await readLiveTabIdentity(engine, tabId);
    if (!shouldContinue()) {
      await retainOrReleaseStaleMuteClaim(engine, tabId, url, lease);
      return;
    }
    if (failedTab === null) return;
    const sourceIdentity: TabIdentity = { url, documentId };
    if (identityChanged(sourceIdentity, failedTab.identity)) {
      await settleMuteUpdate(
        engine,
        tabId,
        sourceIdentity,
        priorMuted,
        false,
        url,
        failedTab,
        null,
        shouldContinue,
        lease,
      );
    }
    return;
  }
  if (!shouldContinue()) {
    await retainOrReleaseStaleMuteClaim(engine, tabId, url, lease);
    return;
  }
  await settleMuteUpdate(
    engine,
    tabId,
    { url, documentId },
    priorMuted,
    false,
    url,
    null,
    null,
    shouldContinue,
    lease,
  );
}

/**
 * Builds EnginePorts.applyBlocking: sweep every tab, block or clear.
 * Reentrancy-guarded because a sweep can advance the engine, whose
 * commit would start a second sweep.
 */
export function applyBlockingFactory(
  engine: () => Engine,
): (lease?: BlockingSweepLease) => Promise<void> {
  let running: boolean = false;
  let rerunRequested: boolean = false;
  let requestRevision: number = 0;
  return async (lease?: BlockingSweepLease): Promise<void> => {
    requestRevision += 1;
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    let hasDeferredError: boolean = false;
    let deferredError: unknown;
    try {
      do {
        rerunRequested = false;
        try {
          const sweepRequestRevision: number = requestRevision;
          const sweepIsCurrent: () => boolean = (): boolean =>
            sweepRequestRevision === requestRevision;
          const sweepOperationVersion: number = nextTabOperationVersion();
          const e: Engine = engine();
          const sweepStartTaskSequence: number = tabTaskSequence;
          const activeTabIdsAtStart: Set<number> = new Set(tabTaskTails.keys());
          const activeOperationTabIdsAtStart: Set<number> = new Set(
            activeTabOperationLeases.keys(),
          );
          const pendingReadinessTabIdsAtStart: Set<number> = new Set(
            pendingTabReadinessLeases.keys(),
          );
          const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({});
          const queriedTabIds: number[] = [
            ...new Set(
              tabs.flatMap((tab: chrome.tabs.Tab): number[] =>
                tab.id === undefined ? [] : [tab.id],
              ),
            ),
          ];
          const queriedTabUrls: Map<number, string | null> = new Map(
            tabs.flatMap((tab: chrome.tabs.Tab): [number, string | null][] =>
              tab.id === undefined ? [] : [[tab.id, tab.url ?? null]],
            ),
          );
          const observedTabIds: Set<number> = new Set(queriedTabIds);
          const protectedTabIds: (currentTabId?: number | null) => Set<number> = (
            currentTabId: number | null = null,
          ): Set<number> => {
            const protectedIds: Set<number> = new Set([
              ...activeTabIdsAtStart,
              ...activeOperationTabIdsAtStart,
              ...observedTabIds,
              ...activeTabOperationLeases.keys(),
              ...muteContinuations.keys(),
              ...inheritedMuteClaims.keys(),
            ]);
            for (const [tabId, version] of tabTaskVersions) {
              if (version > sweepStartTaskSequence) protectedIds.add(tabId);
            }
            if (currentTabId !== null) protectedIds.delete(currentTabId);
            return protectedIds;
          };
          reconcileTabsWithLease(e, new Map(), protectedTabIds(), lease);

          const applyTasks: Promise<void>[] = queriedTabIds
            .filter((tabId: number): boolean => !pendingReadinessTabIdsAtStart.has(tabId))
            .map((tabId: number): Promise<void> => {
              const releaseOperationLease: () => void = acquireTabOperationLease(tabId);
              try {
                return queueResolvedTabApply(
                  e,
                  tabId,
                  null,
                  async (taskVersion: number): Promise<TabApplyInput | null> => {
                    const liveTab: LiveTabIdentity | null = await readStableLiveTabIdentity(
                      e,
                      tabId,
                    );
                    if (liveTab === null || tabTaskVersions.get(tabId) !== taskVersion) return null;
                    return {
                      url: liveTab.identity.url,
                      mutedNow: liveTab.tab.mutedInfo?.muted ?? false,
                      mutedByExtension: liveTab.tab.mutedInfo?.extensionId === chrome.runtime.id,
                      documentId: liveTab.identity.documentId,
                    };
                  },
                  {
                    beforeEffects: (input: TabApplyInput): void => {
                      const liveState: LiveTabState = {
                        url: input.url,
                        mutedByExtension: input.mutedByExtension,
                        documentId: input.documentId,
                      };
                      reconcileTabsWithLease(
                        e,
                        new Map([[tabId, liveState]]),
                        protectedTabIds(tabId),
                        lease,
                      );
                    },
                    isCurrent: sweepIsCurrent,
                    lease,
                    requireCurrentTask: true,
                    validateDocument: true,
                  },
                  sweepOperationVersion,
                  queriedTabUrls.get(tabId) ?? null,
                ).finally(releaseOperationLease);
              } catch (error: unknown) {
                releaseOperationLease();
                throw error;
              }
            });
          await Promise.all(applyTasks);
          if (!sweepIsCurrent()) continue;
          const cleanupVersions: Map<number, number> = new Map(tabTaskVersions);
          await flushRuntimeWithLease(e, lease);
          if (!sweepIsCurrent()) continue;

          for (const [tabId, version] of cleanupVersions) {
            if (!tabTaskTails.has(tabId) && tabTaskVersions.get(tabId) === version) {
              tabTaskVersions.delete(tabId);
            }
          }
        } catch (error: unknown) {
          if (!rerunRequested) throw error;
          if (!hasDeferredError) {
            hasDeferredError = true;
            deferredError = error;
          }
        }
      } while (rerunRequested);
      if (hasDeferredError) throw deferredError;
    } finally {
      running = false;
    }
  };
}

/**
 * SPA and normal navigation: push a fresh verdict to just that tab.
 * Catches YouTube-style pushState navigation that never reloads.
 */
export function registerTabListeners(
  ready: () => Promise<Engine>,
  reportError: (error: unknown) => void,
): void {
  const onNav: (
    details: { tabId: number; url: string; frameId: number; documentId?: string },
    attemptKind: 'navigation' | 'existing',
  ) => void = (
    details: { tabId: number; url: string; frameId: number; documentId?: string },
    attemptKind: 'navigation' | 'existing',
  ): void => {
    if (details.frameId !== 0) return;
    const releaseOperationLease: () => void = acquireTabOperationLease(details.tabId);
    const releaseReadinessLease: () => void = acquireTabReadinessLease(details.tabId);
    const operationVersion: number = beginTabOperation(details.tabId, details.url);
    let readiness: Promise<Engine>;
    try {
      readiness = ready();
    } catch (error: unknown) {
      releaseReadinessLease();
      releaseOperationLease();
      reportError(error);
      return;
    }
    void readiness
      .then((engine: Engine): Promise<void> => {
        releaseReadinessLease();
        return engine.runWithRuntimeMutationLeaseOrBlockingSweep(
          async (lease: BlockingSweepLease): Promise<void> => {
            await cancelMuteContinuation(details.tabId, lease);
            await queueResolvedTabApply(
              engine,
              details.tabId,
              attemptKind,
              async (): Promise<TabApplyInput | null> => {
                const liveTab: LiveTabIdentity | null = await readStableLiveTabIdentity(
                  engine,
                  details.tabId,
                );
                if (liveTab === null || liveTab.identity.url !== details.url) return null;
                const eventDocumentId: string | null = details.documentId ?? null;
                if (eventDocumentId !== null && liveTab.identity.documentId !== eventDocumentId) {
                  return null;
                }
                return {
                  url: liveTab.identity.url,
                  mutedNow: liveTab.tab.mutedInfo?.muted ?? false,
                  mutedByExtension: liveTab.tab.mutedInfo?.extensionId === chrome.runtime.id,
                  documentId: liveTab.identity.documentId,
                };
              },
              {
                beforeEffects: (input: TabApplyInput): void => {
                  if (input.mutedByExtension) {
                    engine.rebindTab(details.tabId, input.url, lease);
                  }
                },
                afterEffects: async (): Promise<void> => engine.flushRuntime(lease),
                lease,
                validateDocument: true,
              },
              operationVersion,
              details.url,
            );
          },
        );
      })
      .catch(reportError)
      .finally((): void => {
        releaseReadinessLease();
        releaseOperationLease();
      });
  };

  chrome.webNavigation.onCommitted.addListener(
    (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void =>
      onNav(details, 'navigation'),
  );
  chrome.webNavigation.onHistoryStateUpdated.addListener(
    (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void =>
      onNav(details, 'existing'),
  );
}

/**
 * The generation the enforcement sweep reads. Every tab operation advances it, so a sweep that
 * finished under an older generation knows the target set moved under it.
 */
/**
 * The live enforceable targets, read from the browser rather than from any stored view. The
 * content script's path is passed in rather than imported: this module is loaded by the worker
 * and by unit tests, and importing the script entry would run it in both.
 */
export function enforcementTargetPortsV2(contentScriptFile: string): EnforcementTargetPortsV2 {
  return {
    queryTopFrameTabs: async (): Promise<Array<{ tabId: number; url: string | null }>> => {
      const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({});
      return tabs.flatMap(
        (tab: chrome.tabs.Tab): Array<{ tabId: number; url: string | null }> =>
          tab.id === undefined ? [] : [{ tabId: tab.id, url: tab.url ?? null }],
      );
    },
    topFrameDocumentId: (tabId: number): Promise<string | null> => getDocumentId(tabId),
    readTargetGeneration: (): number => tabOperationSequence,
    now: (): number => Date.now(),
    ensureDocumentScript: async (tabId: number): Promise<'ready' | 'unscriptable'> => {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: [contentScriptFile] });
        return 'ready';
      } catch (error: unknown) {
        // The refusals Chrome names for a frame that cannot hold a script are the ones this
        // answers `unscriptable` for. Anything else is an injection that failed for a reason
        // nobody has accounted for, and a page this extension cannot explain is reported as
        // ready so the sweep keeps treating its silence as the failure it has always been.
        return isIgnorableInjectionFailure(error) ? 'unscriptable' : 'ready';
      }
    },
  };
}

/**
 * Restores the mute state every claimed tab had before the session and reports the tabs that no
 * longer need the claim. A tab that is present and refuses the update keeps its claim for the next
 * attempt. A claim nothing in the browser carries is finished, not pending.
 */
export async function restoreClaimedTabs(claims: readonly CleanupTabClaim[]): Promise<number[]> {
  const settled: number[] = [];
  for (const claim of claims) {
    const read: TabReadResult = await readTab(claim.tabId);
    const tab: chrome.tabs.Tab | null = read.ok ? read.tab : await restoredClaimTab(claim);
    // The identifier is gone and nothing in the browser carries this claim's effect. Waiting for a
    // lazily restored tab was the earlier reading, and it is wrong: Chrome discards an extension's
    // mute and its attribution across a relaunch, measured on the tab we had muted ourselves, which
    // came back `muted: false` with no `extensionId` and a new identifier. So a tab that arrives a
    // moment later arrives carrying nothing, `restoredClaimTab` cannot match it either, and the
    // wait can only ever end in the retry budget expiring hours later with every session start
    // refused behind it. The state this claim exists to reach is the state the browser is already
    // in, so it is settled. Re-applying a mute to a tab we cannot identify would be guessing, not
    // restoring.
    if (tab === null || tab.id === undefined) {
      settled.push(claim.tabId);
      continue;
    }
    const ownsMute: boolean = tab.mutedInfo?.extensionId === chrome.runtime.id;
    const priorMuted: boolean = claim.state.priorMuted ?? false;
    try {
      if (ownsMute && (tab.mutedInfo?.muted ?? false) !== priorMuted) {
        await chrome.tabs.update(tab.id, { muted: priorMuted });
      }
      settled.push(claim.tabId);
    } catch {
      // The tab refused the update. The claim survives for the next attempt.
    }
  }
  return settled;
}

/**
 * The tab a restored claim belongs to, matched by the effect rather than by the identifier.
 *
 * Chrome renumbers every tab it restores, so a claim taken before a relaunch names an identifier
 * that can never exist again. What survives the restart is the mute this extension applied and the
 * URL it applied it to, so the claim is matched on those, and the restore then runs against the tab
 * that is actually carrying the effect.
 */
async function restoredClaimTab(claim: CleanupTabClaim): Promise<chrome.tabs.Tab | null> {
  const muteUrl: string | null = claim.state.muteUrl;
  if (muteUrl === null) return null;
  try {
    const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({});
    return (
      tabs.find(
        (candidate: chrome.tabs.Tab): boolean =>
          candidate.id !== undefined &&
          candidate.url === muteUrl &&
          candidate.mutedInfo?.extensionId === chrome.runtime.id,
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Reloads the documents this session stopped, so a page left blank comes back on its own. */
export async function reloadClaimedDocuments(claims: readonly CleanupTabClaim[]): Promise<void> {
  for (const claim of claims) {
    const stopped: string | null = claim.state.stoppedDocumentId;
    if (stopped === null) continue;
    try {
      if ((await getDocumentId(claim.tabId)) !== stopped) continue;
      await chrome.tabs.reload(claim.tabId);
    } catch {
      // A tab that is gone needs no reload.
    }
  }
}

/**
 * Refusals Chrome gives for a tab nobody can act on. They are dropped without a report so a sweep
 * over many open tabs stays quiet. Any other refusal is reported with the tab URL, so the next
 * unknown one is diagnosable from the console instead of from a store review.
 */
function isIgnorableInjectionFailure(error: unknown): boolean {
  const message: string = error instanceof Error ? error.message : String(error);
  return (
    message.includes('The extensions gallery cannot be scripted') ||
    message.includes('Cannot access a chrome:// URL') ||
    message.includes('No tab with id') ||
    message.includes('The tab was closed') ||
    // A main frame that failed to load has no document to script, and it stays that way until the
    // user navigates again, which the registered script covers.
    message.includes('is showing error page') ||
    // With the tabs permission Chrome names the URL in every host-permission denial. This URL-less
    // variant comes only from a main frame with no committed URL and no pending navigation: a
    // discarded or not-yet-loaded restored tab. There is no document to script, and the registered
    // script covers the tab once it loads.
    message.includes('Cannot access contents of the page.')
  );
}

class ExistingTabInjectionError extends Error {
  constructor(tab: chrome.tabs.Tab, cause: unknown) {
    const reason: string = cause instanceof Error ? cause.message : String(cause);
    super(`could not inject into open tab ${tab.url ?? '(unknown url)'}: ${reason}`, { cause });
    this.name = 'ExistingTabInjectionError';
  }
}

/**
 * Inject the registered content asset into eligible documents already open.
 *
 * This is best-effort coverage of tabs that were open before registration. Registration itself is
 * what enables blocking, and every tab the sweep cannot reach is covered by the registered script
 * on its next navigation. A refusal for one tab therefore never fails the sweep: a production
 * release did exactly that for a tab Chrome had unloaded, and Retry could not clear it because the
 * tab stayed unloaded. Chrome also refuses policy-blocked hosts and other states it never documents,
 * so no list of known messages is complete. Unknown refusals are reported, not fatal.
 *
 * Only a failure to enumerate tabs at all is fatal: without the tabs API the extension cannot block.
 */
export async function injectIntoExistingTabs(
  file: string,
  reportError: (error: unknown) => void,
): Promise<boolean> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({
      url: ['http://*/*', 'https://*/*'],
    });
  } catch (error: unknown) {
    reportError(error);
    return false;
  }
  const injectedTabIds: Set<number> = new Set<number>();
  for (const tab of tabs) {
    if (tab.id === undefined || injectedTabIds.has(tab.id)) continue;
    injectedTabIds.add(tab.id);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [file],
      });
    } catch (error: unknown) {
      if (!isIgnorableInjectionFailure(error)) {
        reportError(new ExistingTabInjectionError(tab, error));
      }
    }
  }
  return true;
}
