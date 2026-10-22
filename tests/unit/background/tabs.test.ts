import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BlockingSweepLease,
  Engine,
  type EnginePorts,
  type LiveTabState,
} from '../../../src/background/engine';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import type { CleanupTabClaim, RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import {
  applyBlockingFactory,
  applyToTab,
  injectIntoExistingTabs,
  invalidateRemovedTab,
  planTabAction,
  registerTabListeners,
  restoreClaimedTabs,
} from '../../../src/background/tabs';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  emptySnapshot,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import type { EventRecord, ListsConfig, SessionStateV2, Verdict } from '../../../src/shared/types';
import { type EngineSeamPortsV2, engineSeamPortsV2 } from './engine-ports-fake';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = (): void => {
    throw new Error('deferred resolver was not initialized');
  };
  const promise: Promise<T> = new Promise((done: (value: T) => void): void => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Holds the worker at the point where it used to send the content message: after it has planned
 * the tab's effects and before it applies them. A test that raced that message races this.
 */
function gateBeforeEffects(engine: Engine): { started: Promise<void>; release(): void } {
  const gate: Deferred<void> = deferred();
  const started: Deferred<void> = deferred();
  vi.mocked(engine.handleNavigation).mockImplementationOnce(async (): Promise<void> => {
    started.resolve(undefined);
    await gate.promise;
  });
  return {
    started: started.promise,
    release: (): void => gate.resolve(undefined),
  };
}

/**
 * Runs `impl` on the worker's nth command freeze for a tab. The freezes bracket the two phases of
 * one apply, so a test orders its intents around them the way it used to order them around the
 * content message it sent itself.
 */
function onCommandFreeze(engine: Engine, nth: number, impl: () => Promise<void> | void): void {
  const seam: ReturnType<typeof vi.mocked<Engine['documentCommandsFor']>> = vi.mocked(
    engine.documentCommandsFor,
  );
  const original: Engine['documentCommandsFor'] | undefined = seam.getMockImplementation();
  if (original === undefined) throw new Error('the fake engine has no command seam');
  let freezes: number = 0;
  seam.mockImplementation(
    async (
      target: { tabId: number; documentId: string; url: string },
      kind: 'navigation' | 'existing' | null,
    ): Promise<DocumentContentCommand[]> => {
      freezes += 1;
      if (freezes === nth) await impl();
      return await original(target, kind);
    },
  );
}

/**
 * Runs `impl` the first time the worker routes a document to the controller, which is where it
 * used to send the content message itself. A test that anchored its timing on that message gates
 * here instead.
 */
function onFirstDocumentDispatch(engine: Engine, impl: () => void): void {
  vi.mocked(engine.handleNavigation).mockImplementationOnce(async (): Promise<void> => {
    impl();
  });
}

/** The urls the worker asked the controller to freeze commands for, in call order. */
function commandedUrls(engine: Engine): string[] {
  return vi
    .mocked(engine.documentCommandsFor)
    .mock.calls.map((call: [{ url: string }, ...unknown[]]): string => call[0].url);
}

const LIVE_DOCUMENT_ID: string = 'document-1';

/**
 * The frozen command the controller writes for one document. The worker learns whether a page is
 * blocked from these commands now, so a fake engine answers its verdict through the same seam.
 */
function enforcementCommandFor(
  target: { tabId: number; documentId: string; url: string },
  verdict: Verdict,
): DocumentContentCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: '50000000-0000-4000-8000-000000000001',
    enforcementEpoch: '30000000-0000-4000-8000-000000000001',
    sessionId: verdict.blocked ? '10000000-0000-4000-8000-000000000001' : null,
    reservedSessionId: null,
    basePolicyRevision: 0,
    runtimeRevision: 0,
    documentId: target.documentId,
    expectedUrl: target.url,
    presentation: verdict.blocked ? 'active' : 'clear',
    verdict,
    overlay: null,
  };
}

const TEST_EPOCH: string = '30000000-0000-4000-8000-0000000000ee';
const TEST_SESSION_ID: string = '10000000-0000-4000-8000-0000000000ac';

/**
 * The runtime a worker holds while a focus session is live. A v2 session is only published while a
 * checkpoint attests the same session, epoch, and policy revision, so the seed carries one.
 */
function liveFocusRuntime(now: number, lists: ListsConfig): RuntimeStateV2 {
  const base: RuntimeStateV2 = emptyRuntimeV2(now, TEST_EPOCH);
  const session: SessionStateV2 = {
    version: 2,
    sessionId: TEST_SESSION_ID,
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      duration: { kind: 'timed', minutes: 25 },
      cycling: null,
      intention: 'test navigation admission',
      source: 'manual',
      scheduleOccurrence: null,
      rules: rulesFromLists(lists),
    },
    startedAt: now,
    sessionEndsAt: now + 1_500_000,
    phase: 'focus',
    phaseStartedAt: now,
    phaseEndsAt: now + 1_500_000,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 0,
  };
  return {
    ...base,
    session,
    enforcementCheckpoint: {
      version: 1,
      operationId: '50000000-0000-4000-8000-0000000000ac',
      enforcementEpoch: base.enforcementEpoch,
      sessionId: session.sessionId,
      basePolicyRevision: base.basePolicyRevision,
      kind: 'activation',
      registrationAuditedAt: now,
      completedAt: now,
      targetGeneration: 1,
      documents: [],
      exclusions: [],
    },
  };
}

/** The enforcement seams a real engine needs, with the cooperative document these tests drive. */
function enforcementSeamPorts(
  now: () => number,
  onCommand: (command: DocumentContentCommand, tabId: number) => void = (): void => undefined,
): EngineSeamPortsV2 {
  return engineSeamPortsV2({ now, transport: 'cooperative', onCommand });
}

/** One document handed to the controller: what it was told, and which document was told it. */
interface DispatchedNavigation {
  kind: 'applyBlock' | 'clearBlock';
  target: { tabId: number; documentId: string; url: string };
}

const dispatchLog: WeakMap<Engine, DispatchedNavigation[]> = new WeakMap<
  Engine,
  DispatchedNavigation[]
>();

/**
 * Gives a fake engine the command seam the worker reads. It answers the fake's own verdict and
 * records the blocked attempt, which is what the real `documentCommandsFor` does with the kind it
 * is handed.
 */
function withCommandSeam(engine: Engine): Engine {
  const fake: {
    verdictFor(url: string): Verdict;
    recordAttempt(url: string, tabId: number, kind: 'navigation' | 'existing'): Promise<void>;
    documentCommandsFor?: unknown;
    handleNavigation?: unknown;
    recordDocumentAck?: unknown;
  } = engine as unknown as {
    verdictFor(url: string): Verdict;
    recordAttempt(url: string, tabId: number, kind: 'navigation' | 'existing'): Promise<void>;
  };
  fake.documentCommandsFor = vi.fn(
    async (
      target: { tabId: number; documentId: string; url: string },
      attemptKind: 'navigation' | 'existing' | null,
    ): Promise<DocumentContentCommand[]> => {
      const verdict: Verdict = fake.verdictFor(target.url);
      if (verdict.blocked && attemptKind !== null) {
        await fake.recordAttempt(target.url, target.tabId, attemptKind);
      }
      return [enforcementCommandFor(target, verdict)];
    },
  );
  const dispatched: DispatchedNavigation[] = [];
  dispatchLog.set(engine, dispatched);
  fake.handleNavigation = vi.fn(
    async (target: { tabId: number; documentId: string; url: string }): Promise<void> => {
      // The target is kept beside the verdict. A navigation race is only visible in which document
      // was handed over, so a seam that dropped it could not answer the question its tests ask.
      dispatched.push({
        kind: fake.verdictFor(target.url).blocked ? 'applyBlock' : 'clearBlock',
        target: { ...target },
      });
    },
  );
  fake.recordDocumentAck = vi.fn().mockResolvedValue(undefined);
  return engine;
}

/** The fake's own verdict function, which the engine type no longer declares. */
function fakeVerdict(engine: Engine): ReturnType<typeof vi.fn> {
  return (engine as unknown as { verdictFor: ReturnType<typeof vi.fn> }).verdictFor;
}

/** Forgets the dispatches recorded so far, the way a test used to clear its message mock. */
function clearDispatchLog(engine: Engine): void {
  dispatchLog.get(engine)?.splice(0);
}

/**
 * The enforcement each routed document would carry, in order. The worker hands the document to
 * the controller instead of messaging the page itself, so this is what a tab was told.
 */
function dispatchedCommands(engine: Engine): string[] {
  return (dispatchLog.get(engine) ?? []).map(
    (dispatch: DispatchedNavigation): string => dispatch.kind,
  );
}

/** The documents the worker handed to the controller, in order, for a test that races them. */
function dispatchedTargets(engine: Engine): Array<{
  tabId: number;
  documentId: string;
  url: string;
}> {
  return (dispatchLog.get(engine) ?? []).map(
    (dispatch: DispatchedNavigation): { tabId: number; documentId: string; url: string } =>
      dispatch.target,
  );
}

const blocked: Verdict = {
  blocked: true,
  reason: 'custom',
  categoryId: null,
  matchedPattern: 'facebook.com',
};
const allowed: Verdict = {
  blocked: false,
  reason: 'default',
  categoryId: null,
  matchedPattern: null,
};

describe('planTabAction', () => {
  it('blocks a fresh tab: applyBlock plus mute, recording the prior state', () => {
    expect(
      planTabAction(true, {
        muted: false,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ mute: true, reload: false });
  });

  it('blocks a tab the user muted themselves: still records and mutes once', () => {
    expect(
      planTabAction(true, {
        muted: true,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ mute: true, reload: false });
  });

  it('does not re-mute a tab already muted by us', () => {
    expect(
      planTabAction(true, {
        muted: true,
        mutedByExtension: true,
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ mute: null, reload: false });
  });

  it('re-mutes a persisted worker-muted tab that is live-unmuted', () => {
    expect(
      planTabAction(true, {
        muted: false,
        wasMutedByUs: true,
        priorMuted: true,
        wasStopped: false,
      }),
    ).toEqual({ mute: true, reload: false });
  });

  it('reloads the exact stopped document without requiring mute ownership', () => {
    expect(
      planTabAction(false, {
        muted: false,
        mutedByExtension: false,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: true,
      }),
    ).toEqual({ mute: null, reload: true });
  });

  it('clears with mute restore: puts the recorded prior state back', () => {
    expect(
      planTabAction(false, {
        muted: true,
        mutedByExtension: true,
        wasMutedByUs: true,
        priorMuted: true,
        wasStopped: false,
      }),
    ).toEqual({ mute: true, reload: false });
  });

  it('clears a stopped tab with a reload', () => {
    expect(
      planTabAction(false, {
        muted: true,
        mutedByExtension: true,
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: true,
      }),
    ).toEqual({ mute: false, reload: true });
  });

  it('does not restore mute without attribution but still reloads the stopped document', () => {
    const foreignMutedState = {
      muted: true,
      mutedByExtension: false,
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: true,
    };

    expect(planTabAction(false, foreignMutedState)).toEqual({
      mute: null,
      reload: true,
    });
  });

  it('clears a tab we never touched without side effects', () => {
    expect(
      planTabAction(false, {
        muted: false,
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      }),
    ).toEqual({ mute: null, reload: false });
  });
});

describe('injectIntoExistingTabs', () => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it('injects the emitted file once into each eligible existing tab', async (): Promise<void> => {
    const executeScript = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7 }, { id: 7 }, { id: 8 }, {}]),
      },
      scripting: { executeScript },
    });

    await expect(injectIntoExistingTabs('assets/content.js', vi.fn())).resolves.toBe(true);

    expect(chrome.tabs.query).toHaveBeenCalledWith({
      url: ['http://*/*', 'https://*/*'],
    });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 7 },
      files: ['assets/content.js'],
    });
    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 8 },
      files: ['assets/content.js'],
    });
  });

  it('ignores an explicit protected-page failure and reports an unexpected one with its tab URL without failing the sweep', async (): Promise<void> => {
    // A refusal for one open tab is never a registration failure. Registration is what enables
    // blocking, and the tab is covered on its next navigation. The refusal is still reported, with
    // the URL, so an unknown Chrome message is diagnosable from the console.
    const protectedFailure: Error = new Error('The extensions gallery cannot be scripted.');
    const unexpectedFailure: Error = new Error('service worker unavailable');
    const reportError = vi.fn();
    const executeScript = vi
      .fn()
      .mockRejectedValueOnce(protectedFailure)
      .mockRejectedValueOnce(unexpectedFailure);
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7 }, { id: 8, url: 'https://example.com/a' }]),
      },
      scripting: { executeScript },
    });

    await expect(injectIntoExistingTabs('assets/content.js', reportError)).resolves.toBe(true);

    expect(reportError).toHaveBeenCalledOnce();
    const reported: unknown = reportError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe(
      'could not inject into open tab https://example.com/a: service worker unavailable',
    );
    expect((reported as Error).cause).toBe(unexpectedFailure);
  });

  it('treats only protected-page and vanished-tab failures as a complete injection sweep', async (): Promise<void> => {
    const reportError = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 7 }, { id: 8 }]) },
      scripting: {
        executeScript: vi
          .fn()
          .mockRejectedValueOnce(new Error('The extensions gallery cannot be scripted.'))
          .mockRejectedValueOnce(new Error('No tab with id: 8.')),
      },
    });

    await expect(injectIntoExistingTabs('assets/content.js', reportError)).resolves.toBe(true);

    expect(reportError).not.toHaveBeenCalled();
  });

  it('treats a tab showing an error page as nothing to inject into', async (): Promise<void> => {
    // A main frame that failed to load carries no document a content script could inhabit, and no
    // retry changes that while the error page is on screen. The next successful navigation gets
    // the registered script, so reporting this failure only fills the log with a fact about the
    // browser: the sweep is complete, and there is nothing to enforce on an error page.
    const reportError = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 7 }]) },
      scripting: {
        executeScript: vi
          .fn()
          .mockRejectedValueOnce(new Error('Frame with ID 0 is showing error page.')),
      },
    });

    await expect(injectIntoExistingTabs('assets/content.js', reportError)).resolves.toBe(true);

    expect(reportError).not.toHaveBeenCalled();
  });

  it('reports an existing-tab query failure without rejecting worker boot', async (): Promise<void> => {
    const failure: Error = new Error('tab query failed');
    const reportError = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn().mockRejectedValue(failure) },
      scripting: { executeScript: vi.fn() },
    });

    await expect(injectIntoExistingTabs('assets/content.js', reportError)).resolves.toBe(false);

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('reports a missing host permission without failing the sweep and ignores a vanished tab', async (): Promise<void> => {
    const missingPermission: Error = new Error('Missing host permission for the tab');
    const vanishedTab: Error = new Error('No tab with id: 8.');
    const reportError = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 7 }, { id: 8 }]) },
      scripting: {
        executeScript: vi
          .fn()
          .mockRejectedValueOnce(missingPermission)
          .mockRejectedValueOnce(vanishedTab),
      },
    });

    await expect(injectIntoExistingTabs('assets/content.js', reportError)).resolves.toBe(true);

    expect(reportError).toHaveBeenCalledOnce();
    const reported: Error = reportError.mock.calls[0]?.[0] as Error;
    expect(reported.cause).toBe(missingPermission);
  });

  it('treats a tab with no committed document as nothing to inject into', async (): Promise<void> => {
    // Chrome names the URL in every host-permission denial once the extension holds the tabs
    // permission. The URL-less variant comes only from a main frame with no committed URL and no
    // pending navigation: a discarded or not-yet-loaded restored tab. The registered script covers
    // it once it loads, so it must not fail setup.
    const emptyFrame: Error = new Error(
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
    );
    const reportError = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 7 }, { id: 8 }]) },
      scripting: {
        executeScript: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(emptyFrame),
      },
    });

    await expect(injectIntoExistingTabs('assets/content.js', reportError)).resolves.toBe(true);

    expect(reportError).not.toHaveBeenCalled();
  });

  it('reports a URL-naming access denial instead of assuming it is protected, without failing the sweep', async (): Promise<void> => {
    const failure: Error = new Error(
      'Cannot access contents of url "https://example.com/". Extension manifest must request permission to access this host.',
    );
    const reportError = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 7 }]) },
      scripting: { executeScript: vi.fn().mockRejectedValue(failure) },
    });

    await expect(injectIntoExistingTabs('assets/content.js', reportError)).resolves.toBe(true);

    expect(reportError).toHaveBeenCalledOnce();
    const reported: Error = reportError.mock.calls[0]?.[0] as Error;
    expect(reported.cause).toBe(failure);
  });
});

describe('applyToTab', () => {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const reload = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn();
  type MutableTabState = {
    url: string;
    mutedInfo: { muted: boolean; extensionId?: string };
  };
  let liveUrl: string;
  let liveDocumentId: string | null;
  const getFrame = vi.fn();

  beforeEach((): void => {
    sendMessage.mockReset().mockResolvedValue(undefined);
    update.mockReset().mockResolvedValue(undefined);
    reload.mockReset().mockResolvedValue(undefined);
    get.mockReset();
    liveUrl = 'https://facebook.com/feed';
    liveDocumentId = LIVE_DOCUMENT_ID;
    get.mockImplementation(async (): Promise<{ url: string }> => ({ url: liveUrl }));
    // The worker validates the document it is acting on, so the live tab now has an identity.
    getFrame.mockReset();
    getFrame.mockImplementation(
      async (): Promise<{ documentId: string | null }> => ({ documentId: liveDocumentId }),
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: { getFrame },
    });
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout: Promise<never> = new Promise(
      (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
        timer = setTimeout((): void => reject(new Error(`${label} timed out`)), 1_000);
      },
    );
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  function nextMacrotask(): Promise<void> {
    return new Promise((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });
  }

  function engineFor(verdict: Verdict, stopped = false): Engine {
    return withCommandSeam({
      verdictFor: vi.fn(() => verdict),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: !verdict.blocked,
        priorMuted: false,
        wasStopped: stopped,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      noteMuted: vi.fn(),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
  }

  function durableEngineFor(
    verdictForUrl: (url: string) => Verdict,
    initialClaim: { url: string; priorMuted: boolean } | null = null,
  ): Engine {
    let claim: { url: string; priorMuted: boolean } | null = initialClaim;
    return withCommandSeam({
      verdictFor: vi.fn(verdictForUrl),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claim?.url === url,
        priorMuted: claim?.url === url ? claim.priorMuted : false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn(
        async (_tabId: number, url: string, priorMuted: boolean): Promise<boolean> => {
          claim = { url, priorMuted };
          return true;
        },
      ),
      releaseMuteClaim: vi.fn(async (_tabId: number, url: string): Promise<void> => {
        if (claim?.url === url) claim = null;
      }),
      transferMuteClaim: vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claim?.url === fromUrl) claim = { ...claim, url: toUrl };
        },
      ),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (finalUrl === null) {
          claim = null;
        } else if (claim !== null) {
          claim = { ...claim, url: finalUrl };
        }
      }),
      rebindTab: vi.fn((_tabId: number, url: string): void => {
        if (claim !== null) claim = { ...claim, url };
      }),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
  }

  function hasDurableMuteClaim(engine: Engine, url: string): boolean {
    return engine.tabFacts(7, url, null).wasMutedByUs;
  }

  it('records a blocked SPA verdict as an existing-tab attempt', async () => {
    const engine: Engine = engineFor(blocked);

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(engine.recordAttempt).toHaveBeenCalledWith('https://facebook.com/feed', 7, 'existing');
    expect(engine.tabFacts).toHaveBeenCalledWith(7, 'https://facebook.com/feed', LIVE_DOCUMENT_ID);
    expect(engine.claimMute).toHaveBeenCalledWith(7, 'https://facebook.com/feed', false);
  });

  it('does not apply an older same-tab operation after its persistence resolves', async () => {
    const url = 'https://facebook.com/same-tab-intent';
    const persistenceGate: Deferred<void> = deferred();
    const persistenceStarted: Deferred<void> = deferred();
    const engine: Engine = engineFor(blocked);
    vi.mocked(engine.recordAttempt)
      .mockImplementationOnce(async (): Promise<void> => {
        persistenceStarted.resolve(undefined);
        await persistenceGate.promise;
      })
      .mockResolvedValueOnce(undefined);
    liveUrl = url;

    const older: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await withTimeout(persistenceStarted.promise, 'older operation persistence');
    // The attempt is written while the controller freezes the command, so the newer intent is
    // registered here and settles behind the write rather than in front of it.
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    // Mid-flight, which is the half of this the ordering claim lives in. The older operation is
    // parked inside its command freeze, which is where the attempt is written and which runs before
    // any dispatch, so the one document that reaches the controller here is the newer intent. The
    // v1 test read the same count off `sendMessage` at this point, and again after the gate opened.
    await vi.waitFor((): void => {
      expect(engine.handleNavigation).toHaveBeenCalledTimes(1);
    });

    persistenceGate.resolve(undefined);
    await withTimeout(Promise.all([older, newer]), 'same-tab intent replacement');

    // Only the newer intent reaches the controller: the superseded one stops before its effects.
    expect(engine.handleNavigation).toHaveBeenCalledTimes(1);
  });

  it('does not send an older operation after a newer intent arrives during final validation', async () => {
    const url = 'https://facebook.com/final-validation';
    liveUrl = url;
    const effectsGate: Deferred<void> = deferred();
    const effectsStarted: Deferred<void> = deferred();
    const engine: Engine = engineFor(blocked);
    onCommandFreeze(engine, 2, async (): Promise<void> => {
      effectsStarted.resolve(undefined);
      await effectsGate.promise;
    });

    const older: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await withTimeout(effectsStarted.promise, 'older final URL validation');
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    effectsGate.resolve(undefined);
    await withTimeout(Promise.all([older, newer]), 'same-tab intent replacement');

    // Only the newer intent reaches the controller: the superseded one stops before its effects.
    expect(engine.handleNavigation).toHaveBeenCalledTimes(1);
  });

  it('does not mute from an older operation after a newer intent arrives', async () => {
    const url = 'https://facebook.com/mute-intent';
    let currentVerdict: Verdict = blocked;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({ url, mutedInfo: { muted: false } }),
    );
    const engine: Engine = durableEngineFor((): Verdict => currentVerdict);
    const effects: { started: Promise<void>; release(): void } = gateBeforeEffects(engine);

    const older: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await withTimeout(effects.started, 'older mute-state read');
    currentVerdict = allowed;
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    effects.release();
    await withTimeout(Promise.all([older, newer]), 'mute intent replacement');

    expect(update).not.toHaveBeenCalled();
  });

  it('stops stale mute settlement when a newer same-document intent arrives', async () => {
    const url = 'https://facebook.com/settlement-intent';
    const settlementReadGate: Deferred<MutableTabState> = deferred();
    const settlementReadStarted: Deferred<void> = deferred();
    let reads = 0;
    let muted = false;
    let currentVerdict: Verdict = blocked;
    get.mockImplementation(async (): Promise<MutableTabState> => {
      reads += 1;
      const state: MutableTabState = {
        url,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      };
      if (reads === 7) {
        settlementReadStarted.resolve(undefined);
        return settlementReadGate.promise;
      }
      return state;
    });
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );
    const engine: Engine = durableEngineFor((): Verdict => currentVerdict);

    const older: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await withTimeout(settlementReadStarted.promise, 'older settlement identity read');
    currentVerdict = allowed;
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      url,
      true,
      'existing',
      true,
      LIVE_DOCUMENT_ID,
    );
    settlementReadGate.resolve({
      url,
      mutedInfo: { muted: true, extensionId: 'focus-lock' },
    });
    await withTimeout(Promise.all([older, newer]), 'settlement intent replacement');

    expect(engine.settleMuteClaim).toHaveBeenCalledTimes(1);
  });

  it.each(['apply', 'restore'] as const)(
    'releases old ownership when the initial %s tab read resolves on a newer URL',
    async (path: 'apply' | 'restore'): Promise<void> => {
      const oldUrl =
        path === 'apply'
          ? 'https://facebook.com/initial-read-apply-old'
          : 'https://allowed.example/initial-read-restore-old';
      const newUrl = 'https://facebook.com/initial-read-new';
      const initialReadStarted: Deferred<void> = deferred();
      const releaseInitialRead: Deferred<void> = deferred();
      let gateNextRead = false;
      let liveUrl = oldUrl;
      let muted = path === 'restore';
      let claim: { priorMuted: boolean; url: string } | null = { priorMuted: false, url: oldUrl };
      const claimMute = vi.fn(
        async (_tabId: number, inputUrl: string, priorMuted: boolean): Promise<boolean> => {
          if (claim !== null && claim.url !== inputUrl) return false;
          claim = { priorMuted, url: inputUrl };
          return true;
        },
      );
      const releaseMuteClaim = vi.fn(async (_tabId: number, inputUrl: string): Promise<void> => {
        if (claim?.url === inputUrl) claim = null;
      });
      const engine: Engine = withCommandSeam({
        verdictFor: vi.fn((inputUrl: string): Verdict => {
          if (inputUrl === oldUrl && path === 'restore') return allowed;
          return blocked;
        }),
        snapshot: vi.fn(() => emptySnapshot(0)),
        tabFacts: vi.fn((_tabId: number, inputUrl: string) => ({
          wasMutedByUs: claim?.url === inputUrl,
          priorMuted: claim?.url === inputUrl ? claim.priorMuted : false,
          wasStopped: false,
        })),
        recordAttempt: vi.fn().mockResolvedValue(undefined),
        claimMute,
        releaseMuteClaim,
        transferMuteClaim: vi.fn().mockResolvedValue(undefined),
        settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
          if (finalUrl === null) {
            claim = null;
          } else if (claim !== null) {
            claim = { ...claim, url: finalUrl };
          }
        }),
        rebindTab: vi.fn(),
        reportError: vi.fn(),
        noteMuteRestored: vi.fn(),
        noteReloaded: vi.fn(),
      } as unknown as Engine);
      onFirstDocumentDispatch(engine, (): void => {
        gateNextRead = true;
      });
      get.mockImplementation(async (): Promise<MutableTabState> => {
        if (gateNextRead) {
          gateNextRead = false;
          initialReadStarted.resolve(undefined);
          await releaseInitialRead.promise;
        }
        return {
          url: liveUrl,
          mutedInfo: {
            muted,
            extensionId: muted ? 'focus-lock' : undefined,
          },
        };
      });
      update.mockImplementation(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
        },
      );

      const older: Promise<void> = applyToTab(
        engine,
        7,
        oldUrl,
        muted,
        'existing',
        muted,
        LIVE_DOCUMENT_ID,
      );
      await initialReadStarted.promise;
      liveUrl = newUrl;
      muted = false;
      const newer: Promise<void> = applyToTab(
        engine,
        7,
        newUrl,
        false,
        'navigation',
        false,
        LIVE_DOCUMENT_ID,
      );
      releaseInitialRead.resolve(undefined);
      await Promise.all([older, newer]);

      expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
      expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
      expect(claim).toEqual({ priorMuted: false, url: newUrl });
      expect(muted).toBe(true);
      expect(update).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledWith(7, { muted: true });
    },
  );

  it('releases existing ownership when apply second read resolves on newer URL', async () => {
    const oldUrl = 'https://facebook.com/second-read-existing-old';
    const newUrl = 'https://facebook.com/second-read-existing-new';
    const secondReadStarted: Deferred<void> = deferred();
    const releaseSecondRead: Deferred<void> = deferred();
    let liveUrl = oldUrl;
    let muted = false;
    let effectsStarted = false;
    let effectReadCount = 0;
    const engine: Engine = durableEngineFor((): Verdict => blocked, {
      priorMuted: false,
      url: oldUrl,
    });
    onFirstDocumentDispatch(engine, (): void => {
      effectsStarted = true;
    });
    get.mockImplementation(async (): Promise<MutableTabState> => {
      if (effectsStarted) {
        effectReadCount += 1;
        if (effectReadCount === 2) {
          secondReadStarted.resolve(undefined);
          await releaseSecondRead.promise;
        }
      }
      return {
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      };
    });
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    const older: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    await withTimeout(secondReadStarted.promise, 'existing claim second apply read');
    liveUrl = newUrl;
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      newUrl,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    releaseSecondRead.resolve(undefined);
    await withTimeout(Promise.all([older, newer]), 'existing claim second-read handoff');

    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(engine.claimMute).toHaveBeenCalledWith(7, newUrl, false);
    expect(hasDurableMuteClaim(engine, oldUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, newUrl)).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(7, { muted: true });
    expect(muted).toBe(true);
  });

  it('protects old ownership from an omitted sweep during attempt durability', async () => {
    const url = 'https://facebook.com/durability-protection';
    const persistenceStarted: Deferred<void> = deferred();
    const releasePersistence: Deferred<void> = deferred();
    let claimUrl: string | null = url;
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, inputUrl: string) => ({
        wasMutedByUs: claimUrl === inputUrl,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn(async (): Promise<void> => {
        persistenceStarted.resolve(undefined);
        await releasePersistence.promise;
      }),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn(async (_tabId: number, inputUrl: string): Promise<void> => {
        if (claimUrl === inputUrl) claimUrl = null;
      }),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(
        (
          liveTabs: ReadonlyMap<number, LiveTabState>,
          protectedTabIds: ReadonlySet<number> = new Set(),
        ): void => {
          if (!liveTabs.has(7) && !protectedTabIds.has(7)) claimUrl = null;
        },
      ),
      flushRuntime: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    get.mockResolvedValue({ url, mutedInfo: { muted: false } });
    Object.assign(chrome.tabs, { query: vi.fn().mockResolvedValue([]) });

    const pending: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await persistenceStarted.promise;
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });
    await applyBlockingFactory((): Engine => engine)();

    expect(claimUrl).toBe(url);
    releasePersistence.resolve(undefined);
    await pending;
  });

  it('releases inherited ownership when a same-URL successor is superseded before effects', async () => {
    const oldUrl = 'https://facebook.com/settlement-handoff-old';
    const newUrl = 'https://facebook.com/settlement-handoff-new';
    const oldSettlementReadStarted: Deferred<void> = deferred();
    const releaseOldSettlementRead: Deferred<void> = deferred();
    const successorReadStarted: Deferred<void> = deferred();
    const releaseSuccessorRead: Deferred<void> = deferred();
    let gateOldSettlementRead = false;
    let gateSuccessorRead = false;
    let liveUrl = oldUrl;
    let muted = false;
    let claimUrl: string | null = null;
    const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
      if (claimUrl !== null && claimUrl !== url) return false;
      claimUrl = url;
      return true;
    });
    const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
      if (claimUrl === url) claimUrl = null;
    });
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim,
      transferMuteClaim: vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claimUrl === fromUrl) claimUrl = toUrl;
        },
      ),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (finalUrl === null) {
          claimUrl = null;
        } else if (claimUrl !== null) {
          claimUrl = finalUrl;
        }
      }),
      rebindTab: vi.fn(),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    get.mockImplementation(async (): Promise<MutableTabState> => {
      if (gateOldSettlementRead) {
        gateOldSettlementRead = false;
        oldSettlementReadStarted.resolve(undefined);
        await releaseOldSettlementRead.promise;
      } else if (gateSuccessorRead) {
        gateSuccessorRead = false;
        successorReadStarted.resolve(undefined);
        await releaseSuccessorRead.promise;
      }
      return {
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      };
    });
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        gateOldSettlementRead = true;
      },
    );

    const oldest: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await oldSettlementReadStarted.promise;
    gateSuccessorRead = true;
    const sameUrlSuccessor: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      true,
      'existing',
      true,
      LIVE_DOCUMENT_ID,
    );
    releaseOldSettlementRead.resolve(undefined);
    await successorReadStarted.promise;
    liveUrl = newUrl;
    muted = false;
    const newest: Promise<void> = applyToTab(
      engine,
      7,
      newUrl,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    releaseSuccessorRead.resolve(undefined);
    await Promise.all([oldest, sameUrlSuccessor, newest]);

    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
    expect(claimUrl).toBe(newUrl);
    expect(muted).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('releases stale restore ownership so a newer blocked URL can claim mute', async () => {
    const oldUrl = 'https://allowed.example/restore-old';
    const newUrl = 'https://facebook.com/restore-new';
    const restoreGate: Deferred<void> = deferred();
    const restoreStarted: Deferred<void> = deferred();
    let liveUrl = oldUrl;
    let muted = true;
    let claimUrl: string | null = oldUrl;
    const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
      if (claimUrl !== null && claimUrl !== url) return false;
      claimUrl = url;
      return true;
    });
    const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
      if (claimUrl === url) claimUrl = null;
    });
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((url: string): Verdict => (url === newUrl ? blocked : allowed)),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim,
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
      rebindTab: vi.fn(),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        if (properties.muted === false) {
          restoreStarted.resolve(undefined);
          await restoreGate.promise;
        }
      },
    );

    const older: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      true,
      'existing',
      true,
      LIVE_DOCUMENT_ID,
    );
    await withTimeout(restoreStarted.promise, 'older restore update');
    liveUrl = newUrl;
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      newUrl,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    restoreGate.resolve(undefined);
    await withTimeout(Promise.all([older, newer]), 'restore ownership handoff');

    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
    expect(claimUrl).toBe(newUrl);
    expect(muted).toBe(true);
  });

  it('releases stale restore ownership when the old unmute rejects', async () => {
    const oldUrl = 'https://allowed.example/rejected-restore-old';
    const newUrl = 'https://facebook.com/rejected-restore-new';
    const restoreError = new Error('old restore rejected');
    let rejectRestore: (error: unknown) => void = (): void => {
      throw new Error('restore rejection was not initialized');
    };
    const restoreStarted: Deferred<void> = deferred();
    const restoreGate: Promise<void> = new Promise(
      (_resolve: () => void, reject: (error: unknown) => void): void => {
        rejectRestore = reject;
      },
    );
    let liveUrl = oldUrl;
    let muted = true;
    let claimUrl: string | null = oldUrl;
    const reportError = vi.fn();
    const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
      if (claimUrl !== null && claimUrl !== url) return false;
      claimUrl = url;
      return true;
    });
    const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
      if (claimUrl === url) claimUrl = null;
    });
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((url: string): Verdict => (url === newUrl ? blocked : allowed)),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim,
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
      rebindTab: vi.fn(),
      reportError,
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted === false) {
          restoreStarted.resolve(undefined);
          await restoreGate;
          return;
        }
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    const older: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      true,
      'existing',
      true,
      LIVE_DOCUMENT_ID,
    );
    await withTimeout(restoreStarted.promise, 'rejected older restore update');
    liveUrl = newUrl;
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      newUrl,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    rejectRestore(restoreError);
    await withTimeout(Promise.all([older, newer]), 'rejected restore ownership handoff');

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(restoreError);
    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
    expect(claimUrl).toBe(newUrl);
    expect(muted).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('records an unclaimed extension-owned mute as an unmuted prior state', async () => {
    const url = 'https://facebook.com/reclaimed-own-mute';
    let claimUrl: string | null = null;
    const claimMute = vi.fn(async (_tabId: number, claimedUrl: string): Promise<boolean> => {
      claimUrl = claimedUrl;
      return true;
    });
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, factUrl: string) => ({
        wasMutedByUs: claimUrl === factUrl,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url,
        mutedInfo: { muted: true, extensionId: 'focus-lock' },
      }),
    );

    await applyToTab(engine, 7, url, true, 'navigation', true, LIVE_DOCUMENT_ID);

    expect(claimMute).toHaveBeenCalledWith(7, url, false);
  });

  it('releases stale mute ownership when the old mute rejects', async () => {
    const oldUrl = 'https://facebook.com/rejected-mute-old';
    const newUrl = 'https://facebook.com/rejected-mute-new';
    const muteError = new Error('old mute rejected');
    let rejectMute: (error: unknown) => void = (): void => {
      throw new Error('mute rejection was not initialized');
    };
    const muteStarted: Deferred<void> = deferred();
    const muteGate: Promise<void> = new Promise(
      (_resolve: () => void, reject: (error: unknown) => void): void => {
        rejectMute = reject;
      },
    );
    let liveUrl = oldUrl;
    let muted = false;
    let claimUrl: string | null = null;
    const reportError = vi.fn();
    const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
      if (claimUrl !== null && claimUrl !== url) return false;
      claimUrl = url;
      return true;
    });
    const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
      if (claimUrl === url) claimUrl = null;
    });
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim,
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
      rebindTab: vi.fn(),
      reportError,
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    let updateCalls = 0;
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        updateCalls += 1;
        if (updateCalls === 1) {
          muteStarted.resolve(undefined);
          await muteGate;
          return;
        }
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    const older: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await withTimeout(muteStarted.promise, 'rejected older mute update');
    liveUrl = newUrl;
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      newUrl,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    rejectMute(muteError);
    await withTimeout(Promise.all([older, newer]), 'rejected mute ownership handoff');

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(muteError);
    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
    expect(claimUrl).toBe(newUrl);
    expect(muted).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it.each(['resolves', 'applies-then-rejects'] as const)(
    'preserves prior mute through a same-URL successor when the initial mute %s',
    async (initialOutcome: 'resolves' | 'applies-then-rejects'): Promise<void> => {
      const url = 'https://facebook.com/same-url-initial-mute';
      const updateError = new Error('initial mute rejected after applying');
      const initialUpdateStarted: Deferred<void> = deferred();
      const releaseInitialUpdate: Deferred<void> = deferred();
      let currentVerdict: Verdict = blocked;
      let muted = false;
      let claim: { priorMuted: boolean; url: string } | null = null;
      const reportError = vi.fn();
      const engine: Engine = withCommandSeam({
        verdictFor: vi.fn((): Verdict => currentVerdict),
        snapshot: vi.fn(() => emptySnapshot(0)),
        tabFacts: vi.fn((_tabId: number, inputUrl: string) => ({
          wasMutedByUs: claim?.url === inputUrl,
          priorMuted: claim?.url === inputUrl ? claim.priorMuted : false,
          wasStopped: false,
        })),
        recordAttempt: vi.fn().mockResolvedValue(undefined),
        claimMute: vi.fn(
          async (_tabId: number, inputUrl: string, priorMuted: boolean): Promise<boolean> => {
            if (claim !== null && claim.url !== inputUrl) return false;
            claim = { priorMuted, url: inputUrl };
            return true;
          },
        ),
        releaseMuteClaim: vi.fn(async (_tabId: number, inputUrl: string): Promise<void> => {
          if (claim?.url === inputUrl) claim = null;
        }),
        transferMuteClaim: vi.fn().mockResolvedValue(undefined),
        settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
          if (finalUrl === null) {
            claim = null;
          } else if (claim !== null) {
            claim = { ...claim, url: finalUrl };
          }
        }),
        rebindTab: vi.fn(),
        reportError,
        noteMuteRestored: vi.fn(),
        noteReloaded: vi.fn(),
      } as unknown as Engine);
      get.mockImplementation(
        async (): Promise<MutableTabState> => ({
          url,
          mutedInfo: {
            muted,
            extensionId: muted ? 'focus-lock' : undefined,
          },
        }),
      );
      let updateCalls = 0;
      update.mockImplementation(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          updateCalls += 1;
          if (updateCalls === 1) {
            muted = true;
            initialUpdateStarted.resolve(undefined);
            await releaseInitialUpdate.promise;
            if (initialOutcome === 'applies-then-rejects') throw updateError;
            return;
          }
          if (properties.muted !== undefined) muted = properties.muted;
        },
      );

      const older: Promise<void> = applyToTab(
        engine,
        7,
        url,
        false,
        'navigation',
        false,
        LIVE_DOCUMENT_ID,
      );
      await initialUpdateStarted.promise;
      const newer: Promise<void> = applyToTab(
        engine,
        7,
        url,
        false,
        'navigation',
        false,
        LIVE_DOCUMENT_ID,
      );
      releaseInitialUpdate.resolve(undefined);
      await Promise.all([older, newer]);
      expect(claim).toEqual({ priorMuted: false, url });

      currentVerdict = allowed;
      await applyToTab(engine, 7, url, true, 'existing', true, LIVE_DOCUMENT_ID);

      expect(muted).toBe(false);
      expect(claim).toBe(null);
      expect(update).toHaveBeenCalledTimes(2);
      if (initialOutcome === 'applies-then-rejects') {
        expect(reportError).toHaveBeenCalledOnce();
        expect(reportError).toHaveBeenCalledWith(updateError);
      } else {
        expect(reportError).not.toHaveBeenCalled();
      }
    },
  );

  it('restores mute through a same-URL successor when the initial restore rejects', async () => {
    const url = 'https://allowed.example/same-url-initial-restore';
    const restoreError = new Error('initial restore rejected');
    const initialRestoreStarted: Deferred<void> = deferred();
    const releaseInitialRestore: Deferred<void> = deferred();
    let muted = true;
    let claim: { priorMuted: boolean; url: string } | null = { priorMuted: false, url };
    const reportError = vi.fn();
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((): Verdict => allowed),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, inputUrl: string) => ({
        wasMutedByUs: claim?.url === inputUrl,
        priorMuted: claim?.url === inputUrl ? claim.priorMuted : false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn(async (_tabId: number, inputUrl: string): Promise<void> => {
        if (claim?.url === inputUrl) claim = null;
      }),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (finalUrl === null) claim = null;
      }),
      rebindTab: vi.fn(),
      reportError,
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }),
    );
    let updateCalls = 0;
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        updateCalls += 1;
        if (updateCalls === 1) {
          initialRestoreStarted.resolve(undefined);
          await releaseInitialRestore.promise;
          throw restoreError;
        }
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    const older: Promise<void> = applyToTab(
      engine,
      7,
      url,
      true,
      'existing',
      true,
      LIVE_DOCUMENT_ID,
    );
    await initialRestoreStarted.promise;
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      url,
      true,
      'existing',
      true,
      LIVE_DOCUMENT_ID,
    );
    releaseInitialRestore.resolve(undefined);
    await Promise.all([older, newer]);

    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(restoreError);
    expect(muted).toBe(false);
    expect(claim).toBe(null);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it.each(['correction-update', 'post-rejection-read'] as const)(
    'releases stale restore ownership when a rejected %s is superseded',
    async (staleBoundary: 'correction-update' | 'post-rejection-read'): Promise<void> => {
      const oldUrl = 'https://allowed.example/corrective-restore-old';
      const correctionUrl = 'https://facebook.com/corrective-restore-race';
      const newUrl = 'https://facebook.com/corrective-restore-new';
      const correctionError = new Error('corrective mute rejected');
      let rejectCorrection: (error: unknown) => void = (): void => {
        throw new Error('correction rejection was not initialized');
      };
      const correctionGate: Promise<void> = new Promise(
        (_resolve: () => void, reject: (error: unknown) => void): void => {
          rejectCorrection = reject;
        },
      );
      const correctionStarted: Deferred<void> = deferred();
      const identityReadStarted: Deferred<void> = deferred();
      const releaseIdentityRead: Deferred<void> = deferred();
      let gateIdentityRead = false;
      let liveUrl = oldUrl;
      let muted = true;
      let claimUrl: string | null = oldUrl;
      const reportError = vi.fn();
      const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        if (claimUrl !== null && claimUrl !== url) return false;
        claimUrl = url;
        return true;
      });
      const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
        if (claimUrl === url) claimUrl = null;
      });
      const transferMuteClaim = vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claimUrl === fromUrl) claimUrl = toUrl;
        },
      );
      const settleMuteClaim = vi.fn(
        async (_tabId: number, finalUrl: string | null): Promise<void> => {
          if (finalUrl === null) {
            claimUrl = null;
          } else if (claimUrl !== null) {
            claimUrl = finalUrl;
          }
        },
      );
      const recordAttempt = vi.fn().mockResolvedValue(undefined);
      const engine: Engine = withCommandSeam({
        verdictFor: vi.fn((url: string): Verdict => (url === oldUrl ? allowed : blocked)),
        snapshot: vi.fn(() => emptySnapshot(0)),
        tabFacts: vi.fn((_tabId: number, url: string) => ({
          wasMutedByUs: claimUrl === url,
          priorMuted: false,
          wasStopped: false,
        })),
        recordAttempt,
        claimMute,
        releaseMuteClaim,
        transferMuteClaim,
        settleMuteClaim,
        rebindTab: vi.fn(),
        reportError,
        noteMuteRestored: vi.fn(),
        noteReloaded: vi.fn(),
      } as unknown as Engine);
      get.mockImplementation(async (): Promise<MutableTabState> => {
        if (gateIdentityRead) {
          gateIdentityRead = false;
          identityReadStarted.resolve(undefined);
          await releaseIdentityRead.promise;
        }
        return {
          url: liveUrl,
          mutedInfo: {
            muted,
            extensionId: muted ? 'focus-lock' : undefined,
          },
        };
      });
      let updateCalls = 0;
      update.mockImplementation(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          updateCalls += 1;
          if (updateCalls === 1) {
            if (properties.muted !== undefined) muted = properties.muted;
            liveUrl = correctionUrl;
            return;
          }
          if (updateCalls === 2) {
            correctionStarted.resolve(undefined);
            if (staleBoundary === 'post-rejection-read') {
              gateIdentityRead = true;
              throw correctionError;
            }
            await correctionGate;
            return;
          }
          if (properties.muted !== undefined) muted = properties.muted;
        },
      );

      const older: Promise<void> = applyToTab(
        engine,
        7,
        oldUrl,
        true,
        'existing',
        true,
        LIVE_DOCUMENT_ID,
      );
      await withTimeout(correctionStarted.promise, 'corrective restore update');
      let newer: Promise<void>;
      if (staleBoundary === 'correction-update') {
        liveUrl = newUrl;
        newer = applyToTab(engine, 7, newUrl, false, 'navigation', false, LIVE_DOCUMENT_ID);
        rejectCorrection(correctionError);
      } else {
        await withTimeout(identityReadStarted.promise, 'post-rejection identity read');
        liveUrl = newUrl;
        newer = applyToTab(engine, 7, newUrl, false, 'navigation', false, LIVE_DOCUMENT_ID);
        releaseIdentityRead.resolve(undefined);
      }
      await withTimeout(
        Promise.all([older, newer]),
        `corrective restore ownership handoff at ${staleBoundary}`,
      );

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(correctionError);
      expect(releaseMuteClaim).toHaveBeenCalledTimes(1);
      expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
      expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
      expect(claimUrl).toBe(newUrl);
      expect(muted).toBe(true);
      expect(recordAttempt).toHaveBeenCalledWith(newUrl, 7, 'navigation');
      expect(update).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    'direct',
    'after-same-url-handoff',
    'after-same-url-migration',
    'after-rejected-same-url-migration',
    'after-omitted-sweep',
  ] as const)(
    'releases stale ownership when a pending correction continuation is cancelled %s',
    async (handoff:
      | 'direct'
      | 'after-same-url-handoff'
      | 'after-same-url-migration'
      | 'after-rejected-same-url-migration'
      | 'after-omitted-sweep'): Promise<void> => {
      vi.useFakeTimers();
      const oldUrl = 'https://facebook.com/pending-continuation-old';
      const newUrl = 'https://facebook.com/pending-continuation-new';
      const migratedUrl = 'https://facebook.com/pending-continuation-migrated';
      const migrationError = new Error('migrated claim persistence rejected');
      const racedUrls: string[] = [
        'https://example.com/pending-race-one',
        'https://facebook.com/pending-race-two',
        'https://example.com/pending-race-three',
        'https://facebook.com/pending-race-four',
      ];
      let liveUrl = oldUrl;
      let muted = false;
      let claimUrl: string | null = null;
      const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        if (claimUrl !== null && claimUrl !== url) return false;
        claimUrl = url;
        return true;
      });
      const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
        if (claimUrl === url) claimUrl = null;
      });
      const reportError = vi.fn();
      const engine: Engine = withCommandSeam({
        verdictFor: vi.fn(
          (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
        ),
        snapshot: vi.fn(() => emptySnapshot(0)),
        tabFacts: vi.fn((_tabId: number, url: string) => ({
          wasMutedByUs: claimUrl === url,
          priorMuted: false,
          wasStopped: false,
        })),
        recordAttempt: vi.fn().mockResolvedValue(undefined),
        claimMute,
        releaseMuteClaim,
        transferMuteClaim: vi.fn(
          async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
            if (claimUrl === fromUrl) claimUrl = toUrl;
          },
        ),
        settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
          if (finalUrl === null) {
            claimUrl = null;
          } else if (claimUrl !== null) {
            claimUrl = finalUrl;
            if (handoff === 'after-rejected-same-url-migration' && finalUrl === migratedUrl) {
              throw migrationError;
            }
          }
        }),
        rebindTab: vi.fn(),
        reconcileTabs: vi.fn(
          (
            liveTabs: ReadonlyMap<number, LiveTabState>,
            protectedTabIds: ReadonlySet<number> = new Set(),
          ): void => {
            if (!liveTabs.has(7) && !protectedTabIds.has(7)) claimUrl = null;
          },
        ),
        flushRuntime: vi.fn().mockResolvedValue(undefined),
        reportError,
        noteMuteRestored: vi.fn(),
        noteReloaded: vi.fn(),
      } as unknown as Engine);
      const sameUrlReadStarted: Deferred<void> = deferred();
      const releaseSameUrlRead: Deferred<void> = deferred();
      let gateSameUrlRead = false;
      get.mockImplementation(async (): Promise<MutableTabState> => {
        if (gateSameUrlRead) {
          gateSameUrlRead = false;
          sameUrlReadStarted.resolve(undefined);
          await releaseSameUrlRead.promise;
        }
        return {
          url: liveUrl,
          mutedInfo: {
            muted,
            extensionId: muted ? 'focus-lock' : undefined,
          },
        };
      });
      let updateCalls = 0;
      update.mockImplementation(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
          const racedUrl: string | undefined = racedUrls[updateCalls];
          updateCalls += 1;
          if (racedUrl !== undefined) liveUrl = racedUrl;
          if (
            (handoff === 'after-same-url-migration' ||
              handoff === 'after-rejected-same-url-migration') &&
            updateCalls === 5
          ) {
            liveUrl = migratedUrl;
          }
        },
      );

      await applyToTab(engine, 7, oldUrl, false, 'navigation', false, LIVE_DOCUMENT_ID);
      expect(reportError).toHaveBeenCalledOnce();
      if (handoff === 'after-omitted-sweep') {
        Object.assign(chrome.tabs, { query: vi.fn().mockResolvedValue([]) });
        await applyBlockingFactory((): Engine => engine)();
        expect(claimUrl).toBe(oldUrl);
      }
      let sameUrlHandoff: Promise<void> = Promise.resolve();
      if (
        handoff === 'after-same-url-handoff' ||
        handoff === 'after-same-url-migration' ||
        handoff === 'after-rejected-same-url-migration'
      ) {
        liveUrl = oldUrl;
        muted = handoff === 'after-same-url-handoff';
        if (handoff === 'after-same-url-handoff') gateSameUrlRead = true;
        sameUrlHandoff = applyToTab(engine, 7, oldUrl, muted, 'existing', muted, LIVE_DOCUMENT_ID);
        if (handoff === 'after-same-url-handoff') {
          await sameUrlReadStarted.promise;
        } else {
          const outcome: { error: unknown; ok: boolean } = await sameUrlHandoff.then(
            (): { error: unknown; ok: boolean } => ({ error: null, ok: true }),
            (error: unknown): { error: unknown; ok: boolean } => ({ error, ok: false }),
          );
          if (handoff === 'after-rejected-same-url-migration') {
            expect(outcome).toEqual({ error: migrationError, ok: false });
          } else {
            expect(outcome.ok).toBe(true);
          }
          sameUrlHandoff = Promise.resolve();
          expect(claimUrl).toBe(migratedUrl);
        }
      }
      liveUrl = newUrl;
      muted = false;
      const newer: Promise<void> = applyToTab(
        engine,
        7,
        newUrl,
        false,
        'navigation',
        false,
        LIVE_DOCUMENT_ID,
      );
      releaseSameUrlRead.resolve(undefined);

      await Promise.all([sameUrlHandoff, newer]);

      expect(releaseMuteClaim).toHaveBeenCalledWith(
        7,
        handoff === 'after-same-url-migration' || handoff === 'after-rejected-same-url-migration'
          ? migratedUrl
          : oldUrl,
      );
      expect(claimMute).toHaveBeenCalledWith(7, newUrl, false);
      expect(claimUrl).toBe(newUrl);
      expect(muted).toBe(true);
      const expectedUpdateCalls =
        handoff === 'after-same-url-migration' || handoff === 'after-rejected-same-url-migration'
          ? 6
          : 5;
      expect(update).toHaveBeenCalledTimes(expectedUpdateCalls);
      await vi.runAllTimersAsync();
      expect(update).toHaveBeenCalledTimes(expectedUpdateCalls);
    },
  );

  it('waits for durable mute ownership before muting the tab', async () => {
    const engine: Engine = engineFor(blocked);
    let releaseClaim: (claimed: boolean) => void = (): void => {};
    let signalClaim: () => void = (): void => {};
    const claimStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalClaim = resolve;
    });
    vi.mocked(engine.claimMute).mockImplementationOnce(
      (): Promise<boolean> =>
        new Promise((resolve: (claimed: boolean) => void): void => {
          releaseClaim = resolve;
          signalClaim();
        }),
    );

    const pending: Promise<void> = applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    await claimStarted;

    expect(update).not.toHaveBeenCalled();
    releaseClaim(true);
    await pending;
    expect(update).toHaveBeenCalledWith(7, { muted: true });
  });

  it('durably releases mute ownership when Chrome rejects the mute', async () => {
    const engine: Engine = engineFor(blocked);
    let releaseRollback: () => void = (): void => {};
    let signalRollback: () => void = (): void => {};
    const rollbackStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalRollback = resolve;
    });
    update.mockRejectedValueOnce(new Error('mute failed'));
    vi.mocked(engine.releaseMuteClaim).mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseRollback = resolve;
          signalRollback();
        }),
    );

    const pending: Promise<void> = applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    const firstCompletion: 'rollback' | 'done' = await Promise.race([
      rollbackStarted.then((): 'rollback' => 'rollback'),
      pending.then((): 'done' => 'done'),
    ]);

    expect(firstCompletion).toBe('rollback');
    releaseRollback();
    await pending;
    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, 'https://facebook.com/feed');
  });

  it('releases new ownership when a foreign mute appears after Chrome rejects the mute', async () => {
    const engine: Engine = engineFor(blocked);
    update.mockImplementationOnce(async (): Promise<void> => {
      get.mockResolvedValue({
        url: liveUrl,
        mutedInfo: { muted: true, extensionId: 'another-extension' },
      });
      throw new Error('mute failed');
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, 'https://facebook.com/feed');
    expect(engine.transferMuteClaim).not.toHaveBeenCalled();
  });

  it('releases new ownership when a successful mute remains foreign-attributed', async () => {
    const engine: Engine = engineFor(blocked);
    update.mockImplementationOnce(async (): Promise<void> => {
      get.mockResolvedValue({
        url: liveUrl,
        mutedInfo: { muted: true, extensionId: 'another-extension' },
      });
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(engine.settleMuteClaim).toHaveBeenCalledWith(7, null);
  });

  it('does not overwrite a user mute that appears while ownership is persisted', async () => {
    const engine: Engine = engineFor(blocked);
    vi.mocked(engine.claimMute).mockImplementationOnce(async (): Promise<boolean> => {
      get.mockResolvedValue({ url: liveUrl, mutedInfo: { muted: true } });
      return true;
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(update).not.toHaveBeenCalled();
    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, 'https://facebook.com/feed');
  });

  it('does not restore over a foreign mute that appears while content clears', async () => {
    const engine: Engine = engineFor(allowed);
    onFirstDocumentDispatch(engine, (): void => {
      get.mockResolvedValue({
        url: liveUrl,
        mutedInfo: { muted: true, extensionId: 'another-extension' },
      });
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      true,
      'existing',
      true,
      LIVE_DOCUMENT_ID,
    );

    expect(update).not.toHaveBeenCalled();
    expect(engine.releaseMuteClaim).toHaveBeenCalledWith(7, 'https://facebook.com/feed');
  });

  it('does not reload a reused tab id when the replacement has the same URL', async () => {
    const engine: Engine = engineFor(allowed, true);
    vi.mocked(engine.tabFacts).mockReturnValue({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: true,
    });
    let getCalls = 0;
    let currentDocumentId = 'document-one';
    get.mockImplementation(async (): Promise<{ url: string }> => {
      getCalls += 1;
      if (getCalls === 3) currentDocumentId = 'document-two';
      return { url: liveUrl };
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: {
        getFrame: vi.fn(
          async (): Promise<{ documentId: string }> => ({
            documentId: currentDocumentId,
          }),
        ),
      },
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      'document-one',
    );

    expect(reload).not.toHaveBeenCalled();
  });

  it('preserves a user mute when Chrome does not attribute it to the extension', async () => {
    const engine: Engine = engineFor(blocked);
    get.mockResolvedValue({ url: liveUrl, mutedInfo: { muted: true } });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      true,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(engine.claimMute).not.toHaveBeenCalled();
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('transfers durable mute ownership when navigation completes during muting', async () => {
    const engine: Engine = engineFor(blocked);
    update.mockImplementationOnce(async (): Promise<void> => {
      liveUrl = 'https://blocked.example/new';
      get.mockResolvedValue({
        url: liveUrl,
        mutedInfo: { muted: true, extensionId: 'focus-lock' },
      });
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(engine.settleMuteClaim).toHaveBeenCalledWith(7, 'https://blocked.example/new');
  });

  it('restores prior mute after a transient post-mute tab read failure', async () => {
    let currentVerdict: Verdict = blocked;
    let muted = false;
    let rejectPostMuteRead = true;
    const transientError = new Error('transient tab read failure');
    const engine: Engine = durableEngineFor((): Verdict => currentVerdict);
    get.mockImplementation(async (): Promise<MutableTabState> => {
      if (muted && rejectPostMuteRead) {
        rejectPostMuteRead = false;
        throw transientError;
      }
      return {
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      };
    });
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    await applyToTab(engine, 7, liveUrl, false, 'existing', false, LIVE_DOCUMENT_ID);
    currentVerdict = allowed;
    await applyToTab(engine, 7, liveUrl, muted, 'existing', true, LIVE_DOCUMENT_ID);

    expect(engine.reportError).toHaveBeenCalledOnce();
    expect(engine.reportError).toHaveBeenCalledWith(transientError);
    expect(muted).toBe(false);
    expect(update).toHaveBeenNthCalledWith(2, 7, { muted: false });
    expect(hasDurableMuteClaim(engine, liveUrl)).toBe(false);
  });

  it('preserves ownership when the post-mute tab read has no URL', async () => {
    let muted = false;
    const engine: Engine = durableEngineFor((): Verdict => blocked);
    get.mockImplementation(
      async (): Promise<{ url?: string; mutedInfo: { muted: boolean; extensionId?: string } }> => ({
        ...(muted ? {} : { url: liveUrl }),
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );

    await applyToTab(engine, 7, liveUrl, false, 'existing', false, LIVE_DOCUMENT_ID);

    expect(engine.reportError).toHaveBeenCalledOnce();
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
  });

  it('restores prior mute when successful muting lands on an allowed URL', async () => {
    const allowedUrl = 'https://example.com/after-mute';
    let muted = false;
    let navigateOnMute = true;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === allowedUrl ? allowed : blocked),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        if (properties.muted === true && navigateOnMute) {
          navigateOnMute = false;
          liveUrl = allowedUrl;
        }
      },
    );

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(commandedUrls(engine)).toContain(allowedUrl);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(false);
  });

  it('clears ownership after a concurrent navigation rebind during restoration', async () => {
    const sourceUrl = 'https://facebook.com/rebind-source';
    const allowedUrl = 'https://example.com/rebind-allowed';
    liveUrl = sourceUrl;
    let muted = false;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === allowedUrl ? allowed : blocked),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        if (properties.muted === true) {
          liveUrl = allowedUrl;
          engine.rebindTab(7, allowedUrl);
        }
      },
    );

    await applyToTab(engine, 7, sourceUrl, false, 'existing', false, LIVE_DOCUMENT_ID);

    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, sourceUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(false);
  });

  it('reports a rejected corrective mute update without releasing ownership', async () => {
    const sourceUrl = 'https://facebook.com/feed';
    const allowedUrl = 'https://example.com/correction-fails';
    const correctionError = new Error('corrective update failed');
    let muted = false;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === allowedUrl ? allowed : blocked),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted === false) throw correctionError;
        if (properties.muted !== undefined) muted = properties.muted;
        liveUrl = allowedUrl;
      },
    );

    await applyToTab(engine, 7, sourceUrl, false, 'existing', false, LIVE_DOCUMENT_ID);

    expect(engine.reportError).toHaveBeenCalledWith(correctionError);
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
    expect(hasDurableMuteClaim(engine, sourceUrl)).toBe(true);
  });

  it('continues settlement when corrective unmute rejects after reaching a blocked URL', async () => {
    const sourceUrl = 'https://facebook.com/correction-source';
    const firstAllowedUrl = 'https://example.com/correction-first';
    const finalBlockedUrl = 'https://facebook.com/correction-final';
    const correctionError = new Error('corrective unmute rejected after apply');
    liveUrl = sourceUrl;
    let muted = false;
    let updateCount = 0;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === firstAllowedUrl ? allowed : blocked),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        updateCount += 1;
        if (properties.muted !== undefined) muted = properties.muted;
        if (updateCount === 1) liveUrl = firstAllowedUrl;
        if (updateCount === 2) {
          liveUrl = finalBlockedUrl;
          throw correctionError;
        }
      },
    );

    await applyToTab(engine, 7, sourceUrl, false, 'existing', false, LIVE_DOCUMENT_ID);

    expect(engine.reportError).toHaveBeenCalledWith(correctionError);
    expect(commandedUrls(engine)).toContain(finalBlockedUrl);
    expect(update).toHaveBeenNthCalledWith(3, 7, { muted: true });
    expect(muted).toBe(true);
    expect(hasDurableMuteClaim(engine, firstAllowedUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, finalBlockedUrl)).toBe(true);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
  });

  it('continues settlement when corrective remute rejects after reaching an allowed URL', async () => {
    const sourceUrl = 'https://example.com/restore-source';
    const firstBlockedUrl = 'https://facebook.com/restore-first';
    const finalAllowedUrl = 'https://example.com/restore-final';
    const correctionError = new Error('corrective remute rejected after apply');
    liveUrl = sourceUrl;
    let muted = true;
    let updateCount = 0;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === firstBlockedUrl ? blocked : allowed),
      { url: sourceUrl, priorMuted: false },
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        updateCount += 1;
        if (properties.muted !== undefined) muted = properties.muted;
        if (updateCount === 1) liveUrl = firstBlockedUrl;
        if (updateCount === 2) {
          liveUrl = finalAllowedUrl;
          throw correctionError;
        }
      },
    );

    await applyToTab(engine, 7, sourceUrl, true, 'existing', true, LIVE_DOCUMENT_ID);

    expect(engine.reportError).toHaveBeenCalledWith(correctionError);
    expect(commandedUrls(engine)).toContain(finalAllowedUrl);
    expect(update).toHaveBeenNthCalledWith(3, 7, { muted: false });
    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, firstBlockedUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, finalAllowedUrl)).toBe(false);
    expect(engine.recordAttempt).not.toHaveBeenCalled();
  });

  it('corrects an applied mute when the initial update rejects after allowed navigation', async () => {
    const sourceUrl = 'https://facebook.com/before-rejected-mute';
    const allowedUrl = 'https://example.com/after-rejected-mute';
    const updateError = new Error('initial mute update rejected');
    liveUrl = sourceUrl;
    let muted = false;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === allowedUrl ? allowed : blocked),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update
      .mockImplementationOnce(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
          liveUrl = allowedUrl;
          throw updateError;
        },
      )
      .mockImplementationOnce(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
        },
      );

    await applyToTab(engine, 7, sourceUrl, false, 'existing', false, LIVE_DOCUMENT_ID);

    expect(engine.reportError).toHaveBeenCalledWith(updateError);
    expect(commandedUrls(engine)).toContain(allowedUrl);
    expect(update).toHaveBeenNthCalledWith(2, 7, { muted: false });
    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(false);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
  });

  it('reapplies mute when successful restoration lands on a blocked URL', async () => {
    const allowedUrl = 'https://example.com/before-restore';
    const blockedUrl = 'https://facebook.com/after-restore';
    liveUrl = allowedUrl;
    let muted = true;
    let navigateOnRestore = true;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === blockedUrl ? blocked : allowed),
      { url: allowedUrl, priorMuted: false },
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        if (properties.muted === false && navigateOnRestore) {
          navigateOnRestore = false;
          liveUrl = blockedUrl;
        }
      },
    );

    await applyToTab(engine, 7, allowedUrl, true, 'existing', true, LIVE_DOCUMENT_ID);

    expect(commandedUrls(engine)).toContain(blockedUrl);
    expect(muted).toBe(true);
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, blockedUrl)).toBe(true);
  });

  it('reapplies mute when the initial restore rejects after blocked navigation', async () => {
    const allowedUrl = 'https://example.com/before-rejected-restore';
    const blockedUrl = 'https://facebook.com/after-rejected-restore';
    const updateError = new Error('initial restore update rejected');
    liveUrl = allowedUrl;
    let muted = true;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === blockedUrl ? blocked : allowed),
      { url: allowedUrl, priorMuted: false },
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update
      .mockImplementationOnce(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
          liveUrl = blockedUrl;
          throw updateError;
        },
      )
      .mockImplementationOnce(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
        },
      );

    await applyToTab(engine, 7, allowedUrl, true, 'existing', true, LIVE_DOCUMENT_ID);

    expect(engine.reportError).toHaveBeenCalledWith(updateError);
    expect(commandedUrls(engine)).toContain(blockedUrl);
    expect(update).toHaveBeenNthCalledWith(2, 7, { muted: true });
    expect(muted).toBe(true);
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, blockedUrl)).toBe(true);
  });

  it('preserves ownership when replacement-document lookup rejects after restore', async () => {
    const allowedUrl = 'https://example.com/same-url-replacement';
    const frameError = new Error('transient frame read failure');
    liveUrl = allowedUrl;
    let muted = true;
    let documentId = 'document-one';
    const engine: Engine = durableEngineFor((): Verdict => allowed, {
      url: allowedUrl,
      priorMuted: false,
    });
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        documentId = 'document-two';
      },
    );
    const getFrame = vi.fn().mockImplementation(async (): Promise<{ documentId: string }> => {
      if (documentId === 'document-two') throw frameError;
      return { documentId };
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: { getFrame },
    });

    await applyToTab(engine, 7, allowedUrl, true, 'existing', true, 'document-one');

    expect(engine.reportError).toHaveBeenCalledWith(frameError);
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
    expect(hasDurableMuteClaim(engine, allowedUrl)).toBe(true);
  });

  it('settles a second identity change during bounded mute correction', async () => {
    const firstAllowedUrl = 'https://example.com/first-race';
    const secondBlockedUrl = 'https://facebook.com/second-race';
    let muted = false;
    let updateCount = 0;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url === firstAllowedUrl ? allowed : blocked),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        updateCount += 1;
        if (properties.muted !== undefined) muted = properties.muted;
        if (updateCount === 1) liveUrl = firstAllowedUrl;
        if (updateCount === 2) liveUrl = secondBlockedUrl;
      },
    );

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(muted).toBe(true);
    expect(update).toHaveBeenCalledTimes(3);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
    expect(hasDurableMuteClaim(engine, secondBlockedUrl)).toBe(true);
  });

  it('reports bounded correction exhaustion without releasing ownership', async () => {
    vi.useFakeTimers();
    const terminalError = new Error('terminal mute update rejected after apply');
    const racedUrls = [
      'https://example.com/race-one',
      'https://facebook.com/race-two',
      'https://example.com/race-three',
      'https://facebook.com/race-four',
    ];
    let muted = false;
    let updateCount = 0;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        const racedUrl: string | undefined = racedUrls[updateCount];
        updateCount += 1;
        if (racedUrl !== undefined) liveUrl = racedUrl;
        if (updateCount === 5) throw terminalError;
      },
    );

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(update).toHaveBeenCalledTimes(4);
    expect(engine.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Tab 7 exceeded the mute correction limit' }),
    );
    expect(engine.reportError).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(engine.reportError).toHaveBeenCalledWith(terminalError);
    expect(engine.reportError).toHaveBeenCalledTimes(2);
    expect(engine.releaseMuteClaim).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(5);
    expect(muted).toBe(true);
    expect(hasDurableMuteClaim(engine, 'https://facebook.com/race-four')).toBe(true);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
    expect(engine.settleMuteClaim).toHaveBeenCalledTimes(1);
    const settlementOrder: number | undefined = vi
      .mocked(engine.settleMuteClaim)
      .mock.invocationCallOrder.at(-1);
    const finalUpdateOrder: number | undefined = update.mock.invocationCallOrder[4];
    if (settlementOrder === undefined || finalUpdateOrder === undefined) {
      throw new Error('final mute settlement calls were not observed');
    }
    expect(settlementOrder).toBeGreaterThan(finalUpdateOrder);
  });

  it('restores prior mute on an allowed destination observed at correction exhaustion', async () => {
    vi.useFakeTimers();
    const sourceUrl = 'https://example.com/exhaustion-source';
    const racedUrls = [
      'https://facebook.com/exhaustion-one',
      'https://example.com/exhaustion-two',
      'https://facebook.com/exhaustion-three',
      'https://example.com/exhaustion-four',
    ];
    liveUrl = sourceUrl;
    let muted = true;
    let updateCount = 0;
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
      { url: sourceUrl, priorMuted: false },
    );
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        const racedUrl: string | undefined = racedUrls[updateCount];
        updateCount += 1;
        if (racedUrl !== undefined) liveUrl = racedUrl;
      },
    );

    await applyToTab(engine, 7, sourceUrl, true, 'existing', true, LIVE_DOCUMENT_ID);

    expect(update).toHaveBeenCalledTimes(4);
    expect(engine.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Tab 7 exceeded the mute correction limit' }),
    );
    expect(engine.reportError).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledTimes(5);
    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, 'https://example.com/exhaustion-four')).toBe(false);
    expect(engine.recordAttempt).not.toHaveBeenCalled();
    expect(engine.transferMuteClaim).not.toHaveBeenCalled();
    expect(engine.settleMuteClaim).toHaveBeenCalledTimes(1);
  });

  it('reschedules endless identity churn without holding the blocking pass open', async () => {
    vi.useFakeTimers();
    try {
      const sourceUrl = 'https://facebook.com/yield-source';
      const racedUrls = [
        'https://example.com/yield-one',
        'https://facebook.com/yield-two',
        'https://example.com/yield-three',
        'https://facebook.com/yield-four',
        'https://example.com/yield-five',
        'https://facebook.com/yield-six',
        'https://example.com/yield-seven',
      ];
      liveUrl = sourceUrl;
      let muted = false;
      let updateCount = 0;
      const engine: Engine = durableEngineFor(
        (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
      );
      get.mockImplementation(
        async (): Promise<MutableTabState> => ({
          url: liveUrl,
          mutedInfo: {
            muted,
            extensionId: muted ? 'focus-lock' : undefined,
          },
        }),
      );
      update.mockImplementation(
        async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
          if (properties.muted !== undefined) muted = properties.muted;
          const racedUrl: string | undefined = racedUrls[updateCount];
          updateCount += 1;
          if (racedUrl !== undefined) liveUrl = racedUrl;
        },
      );

      await applyToTab(engine, 7, sourceUrl, false, 'existing', false, LIVE_DOCUMENT_ID);

      expect(updateCount).toBe(4);
      expect(engine.recordAttempt).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync();
      expect(updateCount).toBe(8);
      expect(muted).toBe(false);
      expect(hasDurableMuteClaim(engine, racedUrls.at(-1) ?? '')).toBe(false);
      expect(engine.recordAttempt).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-evaluates the same URL when muting completes in a replacement document', async () => {
    let muted = false;
    let documentId = 'document-one';
    const engine: Engine = durableEngineFor((): Verdict => blocked);
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: {
          muted,
          extensionId: muted ? 'focus-lock' : undefined,
        },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        if (properties.muted === true) documentId = 'document-two';
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: {
        getFrame: vi.fn(
          async (): Promise<{ documentId: string }> => ({
            documentId,
          }),
        ),
      },
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      'document-one',
    );

    expect(commandedUrls(engine)).toHaveLength(3);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
  });

  it('records a committed navigation as fresh and preserves persisted restore state', async () => {
    const engine: Engine = engineFor(blocked);
    vi.mocked(engine.tabFacts).mockReturnValue({
      wasMutedByUs: true,
      priorMuted: true,
      wasStopped: false,
    });

    get.mockResolvedValue({
      url: liveUrl,
      mutedInfo: { muted: true, extensionId: 'focus-lock' },
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'navigation',
      true,
      LIVE_DOCUMENT_ID,
    );

    expect(engine.recordAttempt).toHaveBeenCalledWith('https://facebook.com/feed', 7, 'navigation');
    expect(update).not.toHaveBeenCalled();
    expect(engine.claimMute).not.toHaveBeenCalled();
  });

  it('keeps mute bookkeeping when Chrome fails to restore mute state', async () => {
    const engine: Engine = engineFor(allowed);
    liveUrl = 'https://example.com';
    update.mockRejectedValueOnce(new Error('tab closed'));

    await applyToTab(engine, 7, 'https://example.com', true, 'existing', true, LIVE_DOCUMENT_ID);

    expect(engine.noteMuteRestored).not.toHaveBeenCalled();
  });

  it('keeps stopped bookkeeping when Chrome fails to reload the tab', async () => {
    const engine: Engine = engineFor(allowed, true);
    liveUrl = 'https://example.com';
    reload.mockRejectedValueOnce(new Error('tab closed'));

    await applyToTab(engine, 7, 'https://example.com', true, 'existing', true, LIVE_DOCUMENT_ID);

    expect(engine.noteReloaded).not.toHaveBeenCalled();
  });

  it('skips mute side effects when the tab navigates during messaging', async () => {
    const engine: Engine = engineFor(blocked);
    onFirstDocumentDispatch(engine, (): void => {
      liveUrl = 'https://allowed.example/new';
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(update).not.toHaveBeenCalled();
    expect(engine.claimMute).not.toHaveBeenCalled();
  });

  it('skips the content command when the tab already navigated', async () => {
    const engine: Engine = engineFor(blocked);
    liveUrl = 'https://allowed.example/new';

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(engine.recordAttempt).not.toHaveBeenCalled();
    expect(engine.tabFacts).not.toHaveBeenCalled();
    expect(dispatchedCommands(engine)).toEqual([]);
  });

  it('skips tab state lookup when the tab navigates during attempt recording', async () => {
    const engine: Engine = engineFor(blocked);
    vi.mocked(engine.recordAttempt).mockImplementationOnce(async (): Promise<void> => {
      liveUrl = 'https://allowed.example/new';
    });

    await applyToTab(
      engine,
      7,
      'https://facebook.com/feed',
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );

    expect(engine.tabFacts).not.toHaveBeenCalled();
    expect(dispatchedCommands(engine)).toEqual([]);
  });

  it('serializes same-tab navigation settlement through document identity reads', async () => {
    const oldUrl = 'https://facebook.com/serialized-old';
    const newUrl = 'https://facebook.com/serialized-new';
    const frameGate: Deferred<{ documentId: string }> = deferred();
    const frameStarted: Deferred<void> = deferred();
    const getFrame = vi
      .fn()
      .mockImplementationOnce(async (): Promise<{ documentId: string }> => {
        frameStarted.resolve(undefined);
        return frameGate.promise;
      })
      .mockResolvedValue({ documentId: 'document-new' });
    const engine: Engine = durableEngineFor((): Verdict => blocked);
    liveUrl = oldUrl;
    let muted = false;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: { getFrame },
    });

    const first: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      false,
      'navigation',
      false,
      'document-old',
    );
    await withTimeout(frameStarted.promise, 'first identity read');
    liveUrl = newUrl;
    muted = false;
    engine.rebindTab(7, newUrl);
    const readsBeforeSecond: number = get.mock.calls.length;
    const frameReadsBeforeSecond: number = getFrame.mock.calls.length;
    const verdictsBeforeSecond: number = commandedUrls(engine).length;
    const settlementsBeforeSecond: number = vi.mocked(engine.settleMuteClaim).mock.calls.length;

    const second: Promise<void> = applyToTab(
      engine,
      7,
      newUrl,
      false,
      'navigation',
      false,
      'document-new',
    );
    await nextMacrotask();
    const readsWhileFirstPending: number = get.mock.calls.length;
    const frameReadsWhileFirstPending: number = getFrame.mock.calls.length;
    const verdictsWhileFirstPending: number = commandedUrls(engine).length;
    const settlementsWhileFirstPending: number = vi.mocked(engine.settleMuteClaim).mock.calls
      .length;

    frameGate.resolve({ documentId: 'document-old' });
    await withTimeout(
      Promise.all([first, second]).then((): void => undefined),
      'same-tab applies',
    );

    expect(readsWhileFirstPending).toBe(readsBeforeSecond);
    expect(frameReadsWhileFirstPending).toBe(frameReadsBeforeSecond);
    expect(verdictsWhileFirstPending).toBe(verdictsBeforeSecond);
    expect(settlementsWhileFirstPending).toBe(settlementsBeforeSecond);
    expect(muted).toBe(true);
    expect(commandedUrls(engine).at(-1)).toBe(newUrl);
    expect(hasDurableMuteClaim(engine, oldUrl)).toBe(false);
    expect(hasDurableMuteClaim(engine, newUrl)).toBe(true);
    expect(engine.recordAttempt).toHaveBeenCalledTimes(2);
    expect(engine.recordAttempt).toHaveBeenNthCalledWith(1, oldUrl, 7, 'navigation');
    expect(engine.recordAttempt).toHaveBeenNthCalledWith(2, newUrl, 7, 'navigation');
  });

  it('allows different tab IDs to settle while another tab identity read is pending', async () => {
    const states: Map<number, MutableTabState> = new Map([
      [7, { url: 'https://facebook.com/tab-seven', mutedInfo: { muted: false } }],
      [8, { url: 'https://facebook.com/tab-eight', mutedInfo: { muted: false } }],
    ]);
    const frameGate: Deferred<{ documentId: string }> = deferred();
    const frameStarted: Deferred<void> = deferred();
    const getFrame = vi.fn(async (details: { tabId: number }): Promise<{ documentId: string }> => {
      if (details.tabId === 7) {
        frameStarted.resolve(undefined);
        return frameGate.promise;
      }
      return { documentId: `document-${details.tabId}` };
    });
    const engine: Engine = engineFor(blocked);
    get.mockImplementation(async (tabId: number): Promise<MutableTabState> => {
      const state: MutableTabState | undefined = states.get(tabId);
      if (state === undefined) throw new Error(`missing tab ${tabId}`);
      return { url: state.url, mutedInfo: { ...state.mutedInfo } };
    });
    update.mockImplementation(
      async (tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        const state: MutableTabState | undefined = states.get(tabId);
        if (state === undefined) throw new Error(`missing tab ${tabId}`);
        if (properties.muted !== undefined) {
          state.mutedInfo = {
            muted: properties.muted,
            extensionId: properties.muted ? 'focus-lock' : undefined,
          };
        }
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: { getFrame },
    });

    let firstFinished = false;
    const first: Promise<void> = applyToTab(
      engine,
      7,
      'https://facebook.com/tab-seven',
      false,
      'navigation',
      false,
      'document-seven',
    ).then((): void => {
      firstFinished = true;
    });
    await withTimeout(frameStarted.promise, 'tab seven identity read');

    await withTimeout(
      applyToTab(
        engine,
        8,
        'https://facebook.com/tab-eight',
        false,
        'navigation',
        false,
        'document-eight',
      ),
      'tab eight apply',
    );

    expect(firstFinished).toBe(false);
    expect(update).toHaveBeenCalledWith(8, { muted: true });
    expect(engine.recordAttempt).toHaveBeenCalledWith(
      'https://facebook.com/tab-eight',
      8,
      'navigation',
    );
    frameGate.resolve({ documentId: 'document-seven' });
    await withTimeout(first, 'tab seven apply');
  });

  it('continues same-tab queued work after an earlier queued apply rejects', async () => {
    const url = 'https://facebook.com/queue-recovery';
    const queuedError = new Error('queued attempt persistence failed');
    let rejectAttempt: (error: unknown) => void = (): void => {
      throw new Error('attempt rejection was not initialized');
    };
    const attemptStarted: Deferred<void> = deferred();
    const engine: Engine = durableEngineFor((): Verdict => blocked);
    vi.mocked(engine.recordAttempt)
      .mockImplementationOnce(
        (): Promise<void> =>
          new Promise((_resolve: () => void, reject: (error: unknown) => void): void => {
            rejectAttempt = reject;
            attemptStarted.resolve(undefined);
          }),
      )
      .mockResolvedValue(undefined);
    liveUrl = url;
    let muted = false;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
    });

    const rejectedOutcome: Promise<{ error: unknown; ok: boolean }> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    ).then(
      (): { error: unknown; ok: boolean } => ({ error: null, ok: true }),
      (error: unknown): { error: unknown; ok: boolean } => ({ error, ok: false }),
    );
    await withTimeout(attemptStarted.promise, 'rejected queued attempt');
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    rejectAttempt(queuedError);
    const rejected: { error: unknown; ok: boolean } = await withTimeout(
      rejectedOutcome,
      'rejected queued apply',
    );
    await withTimeout(newer, 'queued apply after rejection');

    expect(rejected).toEqual({ error: queuedError, ok: false });
    expect(commandedUrls(engine).at(-1)).toBe(url);
    expect(hasDurableMuteClaim(engine, url)).toBe(true);
    expect(engine.recordAttempt).toHaveBeenCalledTimes(2);
  });

  it('serializes a scheduled no-attempt continuation with newer same-tab work', async () => {
    const sourceUrl = 'https://facebook.com/continuation-source';
    const newUrl = 'https://facebook.com/continuation-new';
    const racedUrls = [
      'https://example.com/continuation-one',
      'https://facebook.com/continuation-two',
      'https://example.com/continuation-three',
      'https://facebook.com/continuation-four',
    ];
    const continuationFrameGate: Deferred<{ documentId: string }> = deferred();
    const continuationFrameStarted: Deferred<void> = deferred();
    let frameReadCount = 0;
    const getFrame = vi.fn(async (): Promise<{ documentId: string }> => {
      frameReadCount += 1;
      if (frameReadCount === 5) {
        continuationFrameStarted.resolve(undefined);
        return continuationFrameGate.promise;
      }
      return { documentId: `document-${frameReadCount}` };
    });
    const engine: Engine = durableEngineFor(
      (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
    );
    liveUrl = sourceUrl;
    let muted = false;
    let updateCount = 0;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        const racedUrl: string | undefined = racedUrls[updateCount];
        updateCount += 1;
        if (racedUrl !== undefined) liveUrl = racedUrl;
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { sendMessage, update, reload, get },
      webNavigation: { getFrame },
    });

    await applyToTab(engine, 7, sourceUrl, false, 'navigation', false, 'document-source');
    expect(updateCount).toBe(4);
    await withTimeout(continuationFrameStarted.promise, 'scheduled continuation identity read');
    liveUrl = newUrl;
    muted = false;
    engine.rebindTab(7, newUrl);
    const readsBeforeNewApply: number = get.mock.calls.length;
    const verdictsBeforeNewApply: number = commandedUrls(engine).length;

    const newer: Promise<void> = applyToTab(
      engine,
      7,
      newUrl,
      false,
      'navigation',
      false,
      'document-new',
    );
    await nextMacrotask();
    const readsWhileContinuationPending: number = get.mock.calls.length;
    const verdictsWhileContinuationPending: number = commandedUrls(engine).length;

    continuationFrameGate.resolve({ documentId: 'document-continuation' });
    await withTimeout(newer, 'newer apply after continuation');
    await nextMacrotask();

    expect(readsWhileContinuationPending).toBe(readsBeforeNewApply);
    expect(verdictsWhileContinuationPending).toBe(verdictsBeforeNewApply);
    expect(muted).toBe(true);
    expect(hasDurableMuteClaim(engine, newUrl)).toBe(true);
    expect(engine.recordAttempt).toHaveBeenCalledTimes(2);
    expect(engine.recordAttempt).toHaveBeenNthCalledWith(1, sourceUrl, 7, 'navigation');
    expect(engine.recordAttempt).toHaveBeenNthCalledWith(2, newUrl, 7, 'navigation');
  });

  it('does not revive a stale continuation scheduled after newer work cancels its token', async () => {
    vi.useFakeTimers();
    const sourceUrl = 'https://facebook.com/stale-token-source';
    const finalUrl = 'https://facebook.com/stale-token-final';
    const racedUrls = [
      'https://example.com/stale-token-one',
      'https://facebook.com/stale-token-two',
      'https://example.com/stale-token-three',
      finalUrl,
    ];
    const fourthUpdateGate: Deferred<void> = deferred();
    const fourthUpdateStarted: Deferred<void> = deferred();
    const engine: Engine = durableEngineFor((url: string): Verdict => {
      if (url === finalUrl) return allowed;
      return url.includes('facebook.com') ? blocked : allowed;
    });
    liveUrl = sourceUrl;
    let muted = false;
    let updateCount = 0;
    get.mockImplementation(
      async (): Promise<MutableTabState> => ({
        url: liveUrl,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }),
    );
    update.mockImplementation(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        const racedUrl: string | undefined = racedUrls[updateCount];
        updateCount += 1;
        if (racedUrl !== undefined) liveUrl = racedUrl;
        if (updateCount === 4) {
          fourthUpdateStarted.resolve(undefined);
          await fourthUpdateGate.promise;
        }
      },
    );

    const older: Promise<void> = applyToTab(
      engine,
      7,
      sourceUrl,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await fourthUpdateStarted.promise;
    const newer: Promise<void> = applyToTab(
      engine,
      7,
      finalUrl,
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    fourthUpdateGate.resolve(undefined);
    await Promise.all([older, newer]);

    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, finalUrl)).toBe(false);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();

    await vi.runAllTimersAsync();

    expect(muted).toBe(false);
    expect(hasDurableMuteClaim(engine, finalUrl)).toBe(false);
    expect(engine.recordAttempt).toHaveBeenCalledOnce();
  });
});

describe('invalidateRemovedTab', () => {
  interface InvalidationDeferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
  }

  function invalidationDeferred<T>(): InvalidationDeferred<T> {
    let resolve: (value: T) => void = (): void => {
      throw new Error('deferred resolver was not initialized');
    };
    const promise: Promise<T> = new Promise((done: (value: T) => void): void => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function invalidationNextMacrotask(): Promise<void> {
    return new Promise((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });
  }

  async function invalidationBounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout: Promise<never> = new Promise(
      (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
        timer = setTimeout((): void => reject(new Error(`${label} timed out`)), 1_000);
      },
    );
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  function invalidationEngine(
    verdictFor: (url: string) => Verdict = (): Verdict => allowed,
  ): Engine {
    return withCommandSeam({
      verdictFor: vi.fn(verdictFor),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(),
      flushRuntime: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
  }

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('invalidates navigation waiting for engine readiness', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const url = 'https://facebook.com/removed-before-ready';
    const readyGate: InvalidationDeferred<Engine> = invalidationDeferred();
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: true,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(),
      flushRuntime,
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url,
          mutedInfo: { muted: false },
        }),
        sendMessage,
        update,
        reload,
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'removed-document' }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => readyGate.promise, vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({
      tabId: 7,
      url,
      frameId: 0,
      documentId: 'removed-document',
    });
    await invalidateRemovedTab(7);
    readyGate.resolve(engine);
    await invalidationNextMacrotask();

    expect(engine.recordAttempt).not.toHaveBeenCalled();
    expect(dispatchedCommands(engine)).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(flushRuntime).not.toHaveBeenCalled();
  });

  it('detaches removed work so a reused tab id starts immediately', async () => {
    const oldUrl = 'https://allowed.example/removed-queue';
    const replacementUrl = 'https://allowed.example/replacement-queue';
    const oldReadStarted: InvalidationDeferred<void> = invalidationDeferred();
    const oldReadGate: InvalidationDeferred<chrome.tabs.Tab> = invalidationDeferred();
    let readCount = 0;
    const get = vi.fn(async (): Promise<chrome.tabs.Tab> => {
      readCount += 1;
      if (readCount === 1) {
        oldReadStarted.resolve(undefined);
        return oldReadGate.promise;
      }
      return { id: 7, url: replacementUrl, mutedInfo: { muted: false } } as chrome.tabs.Tab;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = invalidationEngine();
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
    });

    const oldApply: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    await invalidationBounded(oldReadStarted.promise, 'old detached read');
    await invalidateRemovedTab(7);
    const replacementApply: Promise<void> = applyToTab(
      engine,
      7,
      replacementUrl,
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    await vi.waitFor((): void => {
      expect(engine.handleNavigation).toHaveBeenCalledTimes(1);
    });

    oldReadGate.resolve({ id: 7, url: oldUrl, mutedInfo: { muted: false } } as chrome.tabs.Tab);
    await invalidationBounded(
      Promise.all([oldApply, replacementApply]),
      'detached and replacement queue completion',
    );

    expect(engine.handleNavigation).toHaveBeenCalledTimes(1);
    expect(engine.recordAttempt).not.toHaveBeenCalled();
  });

  it('keeps replacement tail after detached old tail settles', async () => {
    const oldUrl = 'https://allowed.example/detached-tail';
    const replacementUrl = 'https://allowed.example/replacement-tail';
    const thirdUrl = 'https://allowed.example/third-tail';
    const oldReadStarted: InvalidationDeferred<void> = invalidationDeferred();
    const oldReadGate: InvalidationDeferred<chrome.tabs.Tab> = invalidationDeferred();
    const replacementReadStarted: InvalidationDeferred<void> = invalidationDeferred();
    const replacementReadGate: InvalidationDeferred<chrome.tabs.Tab> = invalidationDeferred();
    let readCount = 0;
    const get = vi.fn(async (): Promise<chrome.tabs.Tab> => {
      readCount += 1;
      if (readCount === 1) {
        oldReadStarted.resolve(undefined);
        return oldReadGate.promise;
      }
      if (readCount === 2) {
        replacementReadStarted.resolve(undefined);
        return replacementReadGate.promise;
      }
      return { id: 7, url: thirdUrl, mutedInfo: { muted: false } } as chrome.tabs.Tab;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = invalidationEngine();
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
    });

    const oldApply: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    await invalidationBounded(oldReadStarted.promise, 'old tail read');
    await invalidateRemovedTab(7);
    const replacementApply: Promise<void> = applyToTab(
      engine,
      7,
      replacementUrl,
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    await invalidationBounded(replacementReadStarted.promise, 'replacement tail read');
    oldReadGate.resolve({ id: 7, url: oldUrl, mutedInfo: { muted: false } } as chrome.tabs.Tab);
    await invalidationBounded(oldApply, 'detached old tail completion');

    const thirdApply: Promise<void> = applyToTab(
      engine,
      7,
      thirdUrl,
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(2);

    replacementReadGate.resolve({
      id: 7,
      url: replacementUrl,
      mutedInfo: { muted: false },
    } as chrome.tabs.Tab);
    await invalidationBounded(
      Promise.all([replacementApply, thirdApply]),
      'replacement and third tail completion',
    );

    expect(engine.handleNavigation).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending removed-tab continuation and releases its exact claim', async () => {
    vi.useFakeTimers();
    const oldUrl = 'https://facebook.com/removed-continuation';
    const replacementUrl = 'https://allowed.example/reused-after-continuation';
    let currentUrl = oldUrl;
    let muted = false;
    let persistUpdates = false;
    let claimUrl: string | null = null;
    const cleanupError = new Error('removed claim cleanup rejected');
    const releaseMuteClaim = vi.fn(async (): Promise<void> => {
      throw cleanupError;
    });
    const engine: Engine = withCommandSeam({
      ...invalidationEngine((url: string): Verdict => (url === oldUrl ? blocked : allowed)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      claimMute: vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        claimUrl = url;
        return true;
      }),
      releaseMuteClaim,
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
    } as unknown as Engine);
    const get = vi.fn(
      async (): Promise<chrome.tabs.Tab> =>
        ({
          id: 7,
          url: currentUrl,
          mutedInfo: {
            muted,
            extensionId: muted ? 'focus-lock' : undefined,
          },
        }) as chrome.tabs.Tab,
    );
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (persistUpdates && properties.muted !== undefined) muted = properties.muted;
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage,
        update,
        reload: vi.fn().mockResolvedValue(undefined),
      },
    });

    await applyToTab(engine, 7, oldUrl, false, 'navigation', false, LIVE_DOCUMENT_ID);
    const readsBeforeRemoval: number = get.mock.calls.length;
    const messagesBeforeRemoval: number = vi.mocked(engine.handleNavigation).mock.calls.length;
    const updatesBeforeRemoval: number = update.mock.calls.length;

    const supersedingApply: Promise<void> = applyToTab(
      engine,
      7,
      oldUrl,
      false,
      'existing',
      false,
      LIVE_DOCUMENT_ID,
    );
    await invalidateRemovedTab(7);
    await supersedingApply;

    expect(releaseMuteClaim).toHaveBeenCalledTimes(1);
    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(engine.reportError).toHaveBeenCalledWith(cleanupError);
    expect(
      vi.mocked(engine.reportError).mock.calls.filter(([error]): boolean => error === cleanupError),
    ).toHaveLength(1);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(readsBeforeRemoval);
    expect(engine.handleNavigation).toHaveBeenCalledTimes(messagesBeforeRemoval);
    expect(update).toHaveBeenCalledTimes(updatesBeforeRemoval);

    currentUrl = replacementUrl;
    persistUpdates = true;
    await applyToTab(engine, 7, replacementUrl, false, 'existing', false, LIVE_DOCUMENT_ID);

    expect(engine.handleNavigation).toHaveBeenCalledTimes(messagesBeforeRemoval + 1);
    expect(releaseMuteClaim).toHaveBeenCalledTimes(1);
  });

  it('shares removed-tab cleanup with an in-flight continuation', async () => {
    vi.useFakeTimers();
    const oldUrl = 'https://facebook.com/removed-in-flight-continuation';
    const cleanupError = new Error('in-flight removed claim cleanup rejected');
    const continuationReadStarted: InvalidationDeferred<void> = invalidationDeferred();
    const continuationReadGate: InvalidationDeferred<void> = invalidationDeferred();
    let gateContinuationRead = false;
    let claimUrl: string | null = null;
    const releaseMuteClaim = vi.fn(async (): Promise<void> => {
      throw cleanupError;
    });
    const engine: Engine = withCommandSeam({
      ...invalidationEngine((): Verdict => blocked),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      claimMute: vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        claimUrl = url;
        return true;
      }),
      releaseMuteClaim,
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
    } as unknown as Engine);
    const get = vi.fn(async (): Promise<chrome.tabs.Tab> => {
      if (gateContinuationRead) {
        gateContinuationRead = false;
        continuationReadStarted.resolve(undefined);
        await continuationReadGate.promise;
      }
      return {
        id: 7,
        url: oldUrl,
        mutedInfo: { muted: false },
      } as chrome.tabs.Tab;
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
    });

    await applyToTab(engine, 7, oldUrl, false, 'navigation', false, LIVE_DOCUMENT_ID);
    gateContinuationRead = true;
    const timerRun: Promise<unknown> = vi.runOnlyPendingTimersAsync();
    await continuationReadStarted.promise;

    await invalidateRemovedTab(7);
    continuationReadGate.resolve(undefined);
    await timerRun;
    await vi.runAllTimersAsync();

    expect(releaseMuteClaim).toHaveBeenCalledTimes(1);
    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl);
    expect(
      vi.mocked(engine.reportError).mock.calls.filter(([error]): boolean => error === cleanupError),
    ).toHaveLength(1);
  });

  it('keeps a replacement readiness lease when stale removed work releases', async () => {
    type NavigationDetails = { tabId: number; url: string; frameId: number };
    const oldUrl = 'https://allowed.example/removed-readiness-lease';
    const replacementUrl = 'https://allowed.example/replacement-readiness-lease';
    const oldReady: InvalidationDeferred<Engine> = invalidationDeferred();
    const replacementReady: InvalidationDeferred<Engine> = invalidationDeferred();
    let readyCalls = 0;
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let ownedUrl: string | null = replacementUrl;
    const engine: Engine = withCommandSeam({
      ...invalidationEngine(),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: ownedUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      reconcileTabs: vi.fn(
        (
          liveTabs: ReadonlyMap<number, LiveTabState>,
          protectedTabIds: ReadonlySet<number> = new Set(),
        ): void => {
          if (!liveTabs.has(7) && !protectedTabIds.has(7)) ownedUrl = null;
        },
      ),
    } as unknown as Engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: replacementUrl,
          mutedInfo: { muted: false },
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'swept-document' }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => {
      readyCalls += 1;
      return readyCalls === 1 ? oldReady.promise : replacementReady.promise;
    }, vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url: oldUrl, frameId: 0 });
    await invalidateRemovedTab(7);
    committedListener({ tabId: 7, url: replacementUrl, frameId: 0 });
    oldReady.resolve(engine);
    await invalidationNextMacrotask();

    await applyBlockingFactory((): Engine => engine)();

    expect(ownedUrl).toBe(replacementUrl);
    replacementReady.resolve(engine);
    await invalidationNextMacrotask();
  });
});

describe('registerTabListeners', () => {
  /**
   * A real engine, with the two seams the fake engines get from `withCommandSeam`: what each
   * routed document was actually told, read off the transport, and a spy on the command seam the
   * worker asks. Nothing else about the engine is faked, because these tests drive its barrier.
   */
  async function blockedNavigationEngine(reportError: (error: unknown) => void): Promise<Engine> {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const applyBlocking = vi.fn().mockResolvedValue(undefined);
    const dispatched: DispatchedNavigation[] = [];
    const ports: EnginePorts = {
      now: vi.fn((): number => now),
      newId: vi.fn((): string => '60000000-0000-4000-8000-000000000001'),
      rehydrateAfterDataClear: vi.fn().mockResolvedValue('navigation-device'),
      saveRuntime: vi.fn().mockResolvedValue(undefined),
      saveMatcherCache: vi.fn().mockResolvedValue(undefined),
      hasPendingSync: vi.fn((): boolean => false),
      queueSync: vi.fn(),
      supersedeSync: vi.fn(),
      removeSync: vi.fn(),
      persistSyncJournal: vi.fn().mockResolvedValue(undefined),
      appendEvents: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn(),
      applyBlocking,
      playSound: vi.fn(),
      notify: vi.fn(),
      updateIcon: vi.fn(),
      prune: vi.fn().mockResolvedValue(undefined),
      reportError,
      websiteBlockingReady: vi.fn((): boolean => true),
      ...enforcementSeamPorts(
        (): number => now,
        (command: DocumentContentCommand, tabId: number): void => {
          if (command.command !== 'apply-enforcement') return;
          dispatched.push({
            kind: command.verdict.blocked ? 'applyBlock' : 'clearBlock',
            target: { tabId, documentId: command.documentId, url: command.expectedUrl },
          });
        },
      ),
    };
    const lists = {
      ...DEFAULT_LISTS,
      custom: [...DEFAULT_LISTS.custom, { kind: 'host' as const, pattern: 'facebook.com' }],
    };
    const engine: Engine = new Engine(
      ports,
      DEFAULT_SETTINGS,
      lists,
      { balanceMs: 0 },
      null,
      liveFocusRuntime(now, lists),
      'navigation-device',
    );
    dispatchLog.set(engine, dispatched);
    vi.spyOn(engine, 'documentCommandsFor');
    applyBlocking.mockImplementation(applyBlockingFactory((): Engine => engine));
    return engine;
  }

  function runMockRuntimeMutation<T>(
    operation: (lease: BlockingSweepLease) => Promise<T>,
  ): Promise<T> {
    return operation({} as BlockingSweepLease);
  }

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The engine answers no document commands while the barrier is not open, and the deferred
  // reconciliation sweep runs before the barrier reopens, so an admitted or deferred navigation
  // now enforces nothing. The assertions are kept whole. See task-1-piece-A-report.md.
  it('keeps SPA navigation admitted while an aggregate barrier drains', async (): Promise<void> => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const url = 'https://facebook.com/admitted-spa';
    const reportError = vi.fn();
    const engine: Engine = await blockedNavigationEngine(reportError);
    let historyListener: ((details: NavigationDetails) => void) | undefined;
    let releaseIdentityRead: () => void = (): void => {
      throw new Error('identity read release was not initialized');
    };
    let signalIdentityRead: () => void = (): void => {
      throw new Error('identity read signal was not initialized');
    };
    const identityReadBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseIdentityRead = resolve;
    });
    const identityReadStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalIdentityRead = resolve;
    });
    let releaseBarrier: () => void = (): void => {
      throw new Error('barrier release was not initialized');
    };
    let signalBarrierEntered: () => void = (): void => {
      throw new Error('barrier signal was not initialized');
    };
    const barrierBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const barrierEntered: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalBarrierEntered = resolve;
    });
    let muted: boolean = false;
    let tabReads: number = 0;
    const get = vi.fn(async (): Promise<chrome.tabs.Tab> => {
      tabReads += 1;
      if (tabReads === 1) {
        signalIdentityRead();
        await identityReadBlocked;
      }
      return {
        id: 71,
        url,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      } as chrome.tabs.Tab;
    });
    const update = vi.fn(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update,
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'spa-document' }),
        onCommitted: { addListener: vi.fn() },
        onHistoryStateUpdated: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            historyListener = listener;
          }),
        },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), reportError);
    if (historyListener === undefined) throw new Error('history listener was not registered');

    historyListener({ tabId: 71, url, frameId: 0, documentId: 'spa-document' });
    await identityReadStarted;
    let barrierOwnsStorage: boolean = false;
    const transitioning: Promise<void> = engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        barrierOwnsStorage = true;
        signalBarrierEntered();
        await barrierBlocked;
      },
    );
    await Promise.resolve();

    expect(barrierOwnsStorage).toBe(false);
    releaseIdentityRead();
    await barrierEntered;
    expect(muted).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
    releaseBarrier();
    await transitioning;
  });

  // The engine answers no document commands while the barrier is not open, and the deferred
  // reconciliation sweep runs before the barrier reopens, so an admitted or deferred navigation
  // now enforces nothing. The assertions are kept whole. See task-1-piece-A-report.md.
  it('reconciles SPA navigation that arrives after an aggregate barrier owns storage', async (): Promise<void> => {
    type NavigationDetails = { tabId: number; url: string; frameId: number; documentId?: string };
    const url = 'https://facebook.com/quiesced-spa';
    const reportError = vi.fn();
    const engine: Engine = await blockedNavigationEngine(reportError);
    let historyListener: ((details: NavigationDetails) => void) | undefined;
    let releaseBarrier: () => void = (): void => {
      throw new Error('barrier release was not initialized');
    };
    let signalBarrierEntered: () => void = (): void => {
      throw new Error('barrier signal was not initialized');
    };
    const barrierBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const barrierEntered: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalBarrierEntered = resolve;
    });
    let muted: boolean = false;
    const liveTab = (): chrome.tabs.Tab =>
      ({
        id: 73,
        url,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }) as chrome.tabs.Tab;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn(async (): Promise<chrome.tabs.Tab[]> => [liveTab()]),
        get: vi.fn(async (): Promise<chrome.tabs.Tab> => liveTab()),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'quiesced-document' }),
        onCommitted: { addListener: vi.fn() },
        onHistoryStateUpdated: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            historyListener = listener;
          }),
        },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), reportError);
    if (historyListener === undefined) throw new Error('history listener was not registered');
    const transitioning: Promise<void> = engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        signalBarrierEntered();
        await barrierBlocked;
      },
    );
    await barrierEntered;

    historyListener({ tabId: 73, url, frameId: 0, documentId: 'quiesced-document' });
    await Promise.resolve();
    expect(muted).toBe(false);
    releaseBarrier();
    await transitioning;

    expect(muted).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  // The engine answers no document commands while the barrier is not open, and the deferred
  // reconciliation sweep runs before the barrier reopens, so an admitted or deferred navigation
  // now enforces nothing. The assertions are kept whole. See task-1-piece-A-report.md.
  it('coalesces quiesced navigation and retries one failed reconciliation sweep', async (): Promise<void> => {
    type NavigationDetails = { tabId: number; url: string; frameId: number; documentId?: string };
    const firstUrl = 'https://facebook.com/quiesced-first';
    const latestUrl = 'https://facebook.com/quiesced-latest';
    const replayError: Error = new Error('tab query temporarily unavailable');
    const reportError = vi.fn();
    const engine: Engine = await blockedNavigationEngine(reportError);
    let historyListener: ((details: NavigationDetails) => void) | undefined;
    let releaseBarrier: () => void = (): void => {
      throw new Error('barrier release was not initialized');
    };
    let signalBarrierEntered: () => void = (): void => {
      throw new Error('barrier signal was not initialized');
    };
    const barrierBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const barrierEntered: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalBarrierEntered = resolve;
    });
    let liveUrl: string = firstUrl;
    let muted: boolean = false;
    const liveTab = (): chrome.tabs.Tab =>
      ({
        id: 74,
        url: liveUrl,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }) as chrome.tabs.Tab;
    const query = vi
      .fn<() => Promise<chrome.tabs.Tab[]>>()
      .mockRejectedValueOnce(replayError)
      .mockImplementation(async (): Promise<chrome.tabs.Tab[]> => [liveTab()]);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query,
        get: vi.fn(async (): Promise<chrome.tabs.Tab> => liveTab()),
        sendMessage,
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'latest-document' }),
        onCommitted: { addListener: vi.fn() },
        onHistoryStateUpdated: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            historyListener = listener;
          }),
        },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), reportError);
    if (historyListener === undefined) throw new Error('history listener was not registered');
    const transitioning: Promise<void> = engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        signalBarrierEntered();
        await barrierBlocked;
      },
    );
    await barrierEntered;

    historyListener({ tabId: 74, url: firstUrl, frameId: 0, documentId: 'first-document' });
    liveUrl = latestUrl;
    historyListener({ tabId: 74, url: latestUrl, frameId: 0, documentId: 'latest-document' });
    releaseBarrier();
    await transitioning;

    expect(query).toHaveBeenCalledTimes(2);
    expect(dispatchedCommands(engine)).toHaveLength(1);
    // Only the latest document is routed, and it is routed as blocked.
    // A sweep names no attempt kind: it reports what a target already holds.
    expect(engine.documentCommandsFor).toHaveBeenLastCalledWith(
      { tabId: 74, documentId: 'latest-document', url: latestUrl },
      null,
    );
    expect(dispatchedCommands(engine)).toEqual(['applyBlock']);
    expect(engine.tabFacts(74, firstUrl).wasMutedByUs).toBe(false);
    expect(engine.tabFacts(74, latestUrl).wasMutedByUs).toBe(true);
    expect(muted).toBe(true);
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(replayError);
  });

  it('lets a tab close supersede quiesced navigation reconciliation', async (): Promise<void> => {
    type NavigationDetails = { tabId: number; url: string; frameId: number };
    const url = 'https://facebook.com/quiesced-closed';
    const reportError = vi.fn();
    const engine: Engine = await blockedNavigationEngine(reportError);
    let historyListener: ((details: NavigationDetails) => void) | undefined;
    let releaseBarrier: () => void = (): void => {
      throw new Error('barrier release was not initialized');
    };
    let signalBarrierEntered: () => void = (): void => {
      throw new Error('barrier signal was not initialized');
    };
    const barrierBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const barrierEntered: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalBarrierEntered = resolve;
    });
    let closed: boolean = false;
    const update = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn(
          async (): Promise<chrome.tabs.Tab[]> =>
            closed ? [] : ([{ id: 75, url, mutedInfo: { muted: false } }] as chrome.tabs.Tab[]),
        ),
        get: vi.fn().mockRejectedValue(new Error('tab closed')),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update,
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn(),
        onCommitted: { addListener: vi.fn() },
        onHistoryStateUpdated: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            historyListener = listener;
          }),
        },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), reportError);
    if (historyListener === undefined) throw new Error('history listener was not registered');
    const transitioning: Promise<void> = engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        signalBarrierEntered();
        await barrierBlocked;
      },
    );
    await barrierEntered;

    historyListener({ tabId: 75, url, frameId: 0 });
    closed = true;
    await Promise.all([invalidateRemovedTab(75), engine.dropTab(75)]);
    releaseBarrier();
    await transitioning;

    expect(update).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('admits navigation dispatched from final sweep settlement before the barrier continuation', async (): Promise<void> => {
    type NavigationDetails = { tabId: number; url: string; frameId: number; documentId?: string };
    const firstUrl = 'https://facebook.com/final-sweep-first';
    const nextUrl = firstUrl;
    const reportError = vi.fn();
    const engine: Engine = await blockedNavigationEngine(reportError);
    let historyListener: ((details: NavigationDetails) => void) | undefined;
    let releaseBarrier: () => void = (): void => {
      throw new Error('barrier release was not initialized');
    };
    let signalBarrierEntered: () => void = (): void => {
      throw new Error('barrier signal was not initialized');
    };
    const barrierBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const barrierEntered: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalBarrierEntered = resolve;
    });
    let liveUrl: string = firstUrl;
    let liveDocumentId: string = 'first-document';
    let muted: boolean = false;
    const liveTab = (): chrome.tabs.Tab =>
      ({
        id: 76,
        url: liveUrl,
        mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
      }) as chrome.tabs.Tab;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn(async (): Promise<chrome.tabs.Tab[]> => [liveTab()]),
        get: vi.fn(async (): Promise<chrome.tabs.Tab> => liveTab()),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockImplementation(
          async (): Promise<{ documentId: string }> => ({
            documentId: liveDocumentId,
          }),
        ),
        onCommitted: { addListener: vi.fn() },
        onHistoryStateUpdated: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            historyListener = listener;
          }),
        },
      },
    });
    const originalAdmission = engine.runWithRuntimeMutationLeaseOrBlockingSweep.bind(engine);
    let admissionCalls: number = 0;
    let nextOperation: Promise<void> | null = null;
    let nextOperationSettled: boolean = false;
    vi.spyOn(engine, 'runWithRuntimeMutationLeaseOrBlockingSweep').mockImplementation(
      (operation: (lease: BlockingSweepLease) => Promise<void>): Promise<void> => {
        admissionCalls += 1;
        const admitted: Promise<void> = originalAdmission(operation);
        if (admissionCalls === 1) {
          void admitted.then((): void => {
            liveUrl = nextUrl;
            liveDocumentId = 'next-document';
            muted = false;
            historyListener?.({
              tabId: 76,
              url: nextUrl,
              frameId: 0,
              documentId: 'next-document',
            });
          });
        } else if (admissionCalls === 2) {
          nextOperation = admitted;
          void admitted.then((): void => {
            nextOperationSettled = true;
          });
        }
        return admitted;
      },
    );
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), reportError);
    if (historyListener === undefined) throw new Error('history listener was not registered');
    const transitioning: Promise<void> = engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        signalBarrierEntered();
        await barrierBlocked;
      },
    );
    await barrierEntered;

    historyListener({ tabId: 76, url: firstUrl, frameId: 0, documentId: 'first-document' });
    releaseBarrier();
    await transitioning;
    const settledOperation: Promise<void> | null = nextOperation;
    if (settledOperation === null) throw new Error('next navigation operation was not admitted');
    await settledOperation;
    await Promise.resolve();

    expect(muted).toBe(true);
    expect(nextOperationSettled).toBe(true);
    expect(reportError).not.toHaveBeenCalled();

    const activeLeases: Set<BlockingSweepLease> = Reflect.get(
      engine,
      'activeRuntimeMutationLeases',
    ) as Set<BlockingSweepLease>;
    expect(activeLeases).toHaveLength(0);
  });

  it('releases tracked navigation admission after an identity-read error', async (): Promise<void> => {
    type NavigationDetails = { tabId: number; url: string; frameId: number };
    const error: Error = new Error('tab identity unavailable');
    let signalReported: () => void = (): void => {
      throw new Error('error report signal was not initialized');
    };
    const reported: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalReported = resolve;
    });
    const reportError = vi.fn((_error: unknown): void => signalReported());
    const engine: Engine = await blockedNavigationEngine(reportError);
    let historyListener: ((details: NavigationDetails) => void) | undefined;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: { get: vi.fn().mockRejectedValue(error) },
      webNavigation: {
        getFrame: vi.fn(),
        onCommitted: { addListener: vi.fn() },
        onHistoryStateUpdated: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            historyListener = listener;
          }),
        },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), reportError);
    if (historyListener === undefined) throw new Error('history listener was not registered');

    historyListener({ tabId: 72, url: 'https://facebook.com/error', frameId: 0 });
    await reported;

    await expect(
      engine.runWithAggregateStorageBarrier((): Promise<void> => Promise.resolve()),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(error);
  });

  it('protects omitted ownership while navigation waits for engine readiness', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const url = 'https://allowed.example/pre-ready-navigation';
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let resolveReady: (engine: Engine) => void = (): void => {
      throw new Error('ready resolver was not initialized');
    };
    let signalNavigationFlush: () => void = (): void => {
      throw new Error('navigation flush signal was not initialized');
    };
    const ready: Promise<Engine> = new Promise((resolve: (engine: Engine) => void): void => {
      resolveReady = resolve;
    });
    const navigationFlushed: Promise<void> = new Promise((resolve: () => void): void => {
      signalNavigationFlush = resolve;
    });
    let claim: { priorMuted: boolean; url: string } | null = { priorMuted: false, url };
    let muted = true;
    let flushCalls = 0;
    const engine: Engine = withCommandSeam({
      runWithRuntimeMutationLease: runMockRuntimeMutation,
      runWithRuntimeMutationLeaseOrBlockingSweep: runMockRuntimeMutation,
      verdictFor: vi.fn((): Verdict => allowed),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, inputUrl: string) => ({
        wasMutedByUs: claim?.url === inputUrl,
        priorMuted: claim?.url === inputUrl ? claim.priorMuted : false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (finalUrl === null) claim = null;
      }),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(
        (
          liveTabs: ReadonlyMap<number, LiveTabState>,
          protectedTabIds: ReadonlySet<number> = new Set(),
        ): void => {
          if (!liveTabs.has(7) && !protectedTabIds.has(7)) claim = null;
        },
      ),
      flushRuntime: vi.fn(async (): Promise<void> => {
        flushCalls += 1;
        if (flushCalls === 2) signalNavigationFlush();
      }),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        get: vi.fn(
          async (): Promise<chrome.tabs.Tab> =>
            ({
              id: 7,
              url,
              mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
            }) as chrome.tabs.Tab,
        ),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'pre-ready-document' }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => ready, vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url, frameId: 0, documentId: 'pre-ready-document' });
    await applyBlockingFactory((): Engine => engine)();

    expect(claim).toEqual({ priorMuted: false, url });
    resolveReady(engine);
    await navigationFlushed;
    expect(muted).toBe(false);
    expect(claim).toBe(null);
  });

  it.each([
    ['onCommitted', 'navigation'],
    ['onHistoryStateUpdated', 'existing'],
  ] as const)(
    'keeps %s accounting authority while engine readiness is pending',
    async (eventName: 'onCommitted' | 'onHistoryStateUpdated', expectedKind:
      | 'navigation'
      | 'existing'): Promise<void> => {
      type NavigationDetails = {
        tabId: number;
        url: string;
        frameId: number;
        documentId?: string;
      };
      const url: string = 'https://facebook.com/pre-ready-attempt';
      const documentId: string = 'pre-ready-attempt-document';
      let committedListener: ((details: NavigationDetails) => void) | undefined;
      let historyListener: ((details: NavigationDetails) => void) | undefined;
      let resolveFirstReady: (engine: Engine) => void = (): void => {
        throw new Error('first ready resolver was not initialized');
      };
      let resolveSecondReady: (engine: Engine) => void = (): void => {
        throw new Error('second ready resolver was not initialized');
      };
      const firstReady: Promise<Engine> = new Promise((resolve: (engine: Engine) => void): void => {
        resolveFirstReady = resolve;
      });
      const secondReady: Promise<Engine> = new Promise(
        (resolve: (engine: Engine) => void): void => {
          resolveSecondReady = resolve;
        },
      );
      let readyCalls: number = 0;
      const recordAttempt: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
      const sendMessage: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
      const update: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
      const engine: Engine = withCommandSeam({
        runWithRuntimeMutationLease: runMockRuntimeMutation,
        runWithRuntimeMutationLeaseOrBlockingSweep: runMockRuntimeMutation,
        verdictFor: vi.fn((): Verdict => blocked),
        snapshot: vi.fn(() => emptySnapshot(0)),
        tabFacts: vi.fn(() => ({
          wasMutedByUs: false,
          priorMuted: false,
          wasStopped: false,
        })),
        recordAttempt,
        claimMute: vi.fn().mockResolvedValue(true),
        releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
        transferMuteClaim: vi.fn().mockResolvedValue(undefined),
        settleMuteClaim: vi.fn().mockResolvedValue(undefined),
        rebindTab: vi.fn(),
        reconcileTabs: vi.fn(),
        flushRuntime: vi.fn().mockResolvedValue(undefined),
        reportError: vi.fn(),
        noteMuteRestored: vi.fn(),
        noteReloaded: vi.fn(),
      } as unknown as Engine);
      vi.stubGlobal('chrome', {
        runtime: { id: 'focus-lock' },
        tabs: {
          query: vi.fn().mockResolvedValue([{ id: 7, url, mutedInfo: { muted: false } }]),
          get: vi.fn().mockResolvedValue({ id: 7, url, mutedInfo: { muted: false } }),
          sendMessage,
          update,
          reload: vi.fn().mockResolvedValue(undefined),
        },
        webNavigation: {
          getFrame: vi.fn().mockResolvedValue({ documentId }),
          onCommitted: {
            addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
              committedListener = listener;
            }),
          },
          onHistoryStateUpdated: {
            addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
              historyListener = listener;
            }),
          },
        },
      });
      registerTabListeners((): Promise<Engine> => {
        readyCalls += 1;
        return readyCalls === 1 ? firstReady : secondReady;
      }, vi.fn());
      const listener: ((details: NavigationDetails) => void) | undefined =
        eventName === 'onCommitted' ? committedListener : historyListener;
      if (listener === undefined) throw new Error(`${eventName} listener was not registered`);

      listener({ tabId: 7, url, frameId: 0, documentId });
      listener({ tabId: 7, url, frameId: 0, documentId });
      resolveFirstReady(engine);
      await Promise.resolve();
      await applyBlockingFactory((): Engine => engine)();

      expect.soft(recordAttempt).not.toHaveBeenCalled();
      expect.soft(sendMessage).not.toHaveBeenCalled();
      expect.soft(update).not.toHaveBeenCalled();
      const protectedTabIds: ReadonlySet<number> | undefined = vi.mocked(engine.reconcileTabs).mock
        .calls[0]?.[1];
      expect(protectedTabIds?.has(7)).toBe(true);
      resolveSecondReady(engine);
      await vi.waitFor((): void => {
        expect(recordAttempt).toHaveBeenCalledTimes(1);
      });
      expect(recordAttempt.mock.calls[0]?.slice(0, 3)).toEqual([url, 7, expectedKind]);
    },
  );

  it.each(['success', 'synchronous throw', 'rejection'] as const)(
    'releases the readiness reservation after %s',
    async (outcome: 'success' | 'synchronous throw' | 'rejection'): Promise<void> => {
      type NavigationDetails = { tabId: number; url: string; frameId: number };
      const url: string = 'https://allowed.example/readiness-release';
      const error: Error = new Error(`ready ${outcome}`);
      const reportError: (error: unknown) => void = vi.fn();
      const sendMessage: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
      const flushRuntime: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
      let committedListener: ((details: NavigationDetails) => void) | undefined;
      const engine: Engine = withCommandSeam({
        runWithRuntimeMutationLease: runMockRuntimeMutation,
        runWithRuntimeMutationLeaseOrBlockingSweep: runMockRuntimeMutation,
        verdictFor: vi.fn((): Verdict => allowed),
        snapshot: vi.fn(() => emptySnapshot(0)),
        tabFacts: vi.fn(() => ({
          wasMutedByUs: false,
          priorMuted: false,
          wasStopped: false,
        })),
        recordAttempt: vi.fn().mockResolvedValue(undefined),
        claimMute: vi.fn().mockResolvedValue(true),
        releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
        transferMuteClaim: vi.fn().mockResolvedValue(undefined),
        settleMuteClaim: vi.fn().mockResolvedValue(undefined),
        rebindTab: vi.fn(),
        reconcileTabs: vi.fn(),
        flushRuntime,
        reportError: vi.fn(),
        noteMuteRestored: vi.fn(),
        noteReloaded: vi.fn(),
      } as unknown as Engine);
      vi.stubGlobal('chrome', {
        runtime: { id: 'focus-lock' },
        tabs: {
          query: vi.fn().mockResolvedValue([{ id: 7, url, mutedInfo: { muted: false } }]),
          get: vi.fn().mockResolvedValue({ id: 7, url, mutedInfo: { muted: false } }),
          sendMessage,
          update: vi.fn().mockResolvedValue(undefined),
          reload: vi.fn().mockResolvedValue(undefined),
        },
        webNavigation: {
          getFrame: vi.fn().mockResolvedValue({ documentId: 'swept-document' }),
          onCommitted: {
            addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
              committedListener = listener;
            }),
          },
          onHistoryStateUpdated: { addListener: vi.fn() },
        },
      });
      registerTabListeners((): Promise<Engine> => {
        if (outcome === 'synchronous throw') throw error;
        if (outcome === 'rejection') return Promise.reject(error);
        return Promise.resolve(engine);
      }, reportError);
      if (committedListener === undefined) throw new Error('committed listener was not registered');

      committedListener({ tabId: 7, url, frameId: 0 });
      if (outcome === 'success') {
        await vi.waitFor((): void => {
          expect(flushRuntime).toHaveBeenCalledOnce();
        });
      } else {
        await vi.waitFor((): void => {
          expect(reportError).toHaveBeenCalledWith(error);
        });
      }
      clearDispatchLog(engine);

      await applyBlockingFactory((): Engine => engine)();

      expect(dispatchedCommands(engine)).toContain('clearBlock');
    },
  );

  it('releases stale ownership when a queued correction continuation is cancelled', async () => {
    vi.useFakeTimers();
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const oldUrl = 'https://facebook.com/queued-continuation-old';
    const newUrl = 'https://facebook.com/queued-continuation-new';
    const racedUrls: string[] = [
      'https://example.com/queued-race-one',
      'https://facebook.com/queued-race-two',
      'https://example.com/queued-race-three',
      'https://facebook.com/queued-race-four',
    ];
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let releaseFirstFlush: () => void = (): void => {
      throw new Error('flush release was not initialized');
    };
    let signalFirstFlush: () => void = (): void => {
      throw new Error('flush signal was not initialized');
    };
    let signalSecondFlush: () => void = (): void => {
      throw new Error('second flush signal was not initialized');
    };
    const firstFlushGate: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirstFlush = resolve;
    });
    const firstFlushStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFirstFlush = resolve;
    });
    const secondFlushCompleted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSecondFlush = resolve;
    });
    let liveUrl = oldUrl;
    let muted = false;
    let claimUrl: string | null = null;
    const claimMute = vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
      if (claimUrl !== null && claimUrl !== url) return false;
      claimUrl = url;
      return true;
    });
    const releaseMuteClaim = vi.fn(async (_tabId: number, url: string): Promise<void> => {
      if (claimUrl === url) claimUrl = null;
    });
    const reportError = vi.fn();
    let flushCalls = 0;
    const engine: Engine = withCommandSeam({
      runWithRuntimeMutationLease: runMockRuntimeMutation,
      runWithRuntimeMutationLeaseOrBlockingSweep: runMockRuntimeMutation,
      verdictFor: vi.fn(
        (url: string): Verdict => (url.includes('facebook.com') ? blocked : allowed),
      ),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute,
      releaseMuteClaim,
      transferMuteClaim: vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claimUrl === fromUrl) claimUrl = toUrl;
        },
      ),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (finalUrl === null) {
          claimUrl = null;
        } else if (claimUrl !== null) {
          claimUrl = finalUrl;
        }
      }),
      rebindTab: vi.fn(),
      flushRuntime: vi.fn(async (): Promise<void> => {
        flushCalls += 1;
        if (flushCalls === 1) {
          signalFirstFlush();
          await firstFlushGate;
          return;
        }
        signalSecondFlush();
      }),
      reportError,
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    const update = vi.fn(
      async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        if (properties.muted !== undefined) muted = properties.muted;
        const racedUrl: string | undefined = racedUrls[update.mock.calls.length - 1];
        if (racedUrl !== undefined) liveUrl = racedUrl;
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn(
          async (): Promise<{
            url: string;
            mutedInfo: { muted: boolean; extensionId?: string };
          }> => ({
            url: liveUrl,
            mutedInfo: {
              muted,
              extensionId: muted ? 'focus-lock' : undefined,
            },
          }),
        ),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update,
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'queued-document' }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners(async (): Promise<Engine> => engine, reportError);
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url: oldUrl, frameId: 0, documentId: 'queued-document' });
    await firstFlushStarted;
    await vi.runOnlyPendingTimersAsync();
    liveUrl = newUrl;
    muted = false;
    committedListener({ tabId: 7, url: newUrl, frameId: 0, documentId: 'queued-document' });
    releaseFirstFlush();
    await secondFlushCompleted;

    expect(releaseMuteClaim).toHaveBeenCalledWith(7, oldUrl, expect.any(Object));
    expect(claimMute).toHaveBeenCalledWith(7, newUrl, false, expect.any(Object));
    expect(claimUrl).toBe(newUrl);
    expect(muted).toBe(true);
    expect(update).toHaveBeenCalledTimes(5);
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledTimes(5);
  });

  it('reports detached navigation failures', async () => {
    type NavigationDetails = { tabId: number; url: string; frameId: number };
    const error = new Error('local storage unavailable');
    const reportError = vi.fn();
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    vi.stubGlobal('chrome', {
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'swept-document' }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.reject(error), reportError);
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url: 'https://blocked.example', frameId: 0 });
    await Promise.resolve();
    await Promise.resolve();

    expect(reportError).toHaveBeenCalledWith(error);
  });

  it('does not inherit stale ownership when a tab id is reused before ready resolves', async () => {
    type NavigationDetails = { tabId: number; url: string; frameId: number };
    const currentUrl = 'https://unrelated.example/new';
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let resolveReady: (engine: Engine) => void = (): void => {};
    let signalFlushed: () => void = (): void => {};
    const ready: Promise<Engine> = new Promise((resolve: (engine: Engine) => void): void => {
      resolveReady = resolve;
    });
    const flushed: Promise<void> = new Promise((resolve: () => void): void => {
      signalFlushed = resolve;
    });
    let ownedUrl = 'https://blocked.example/old';
    const rebindTab = vi.fn((_tabId: number, url: string): void => {
      ownedUrl = url;
    });
    const update = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = withCommandSeam({
      runWithRuntimeMutationLease: runMockRuntimeMutation,
      runWithRuntimeMutationLeaseOrBlockingSweep: runMockRuntimeMutation,
      rebindTab,
      verdictFor: vi.fn((): Verdict => allowed),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) =>
        ownedUrl === url
          ? { wasMutedByUs: true, priorMuted: false, wasStopped: true }
          : { wasMutedByUs: false, priorMuted: false, wasStopped: false },
      ),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      reportError: vi.fn(),
      flushRuntime: vi.fn(async (): Promise<void> => {
        signalFlushed();
      }),
    } as unknown as Engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: currentUrl,
          mutedInfo: { muted: false },
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update,
        reload,
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'swept-document' }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => ready, vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url: currentUrl, frameId: 0 });
    resolveReady(engine);
    await flushed;

    expect(rebindTab).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('rebinds ownership when the extension mute confirms the navigating tab', async () => {
    type NavigationDetails = { tabId: number; url: string; frameId: number };
    const currentUrl = 'https://blocked.example/new';
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    const rebindTab = vi.fn();
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = withCommandSeam({
      runWithRuntimeMutationLease: runMockRuntimeMutation,
      runWithRuntimeMutationLeaseOrBlockingSweep: runMockRuntimeMutation,
      rebindTab,
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      flushRuntime,
    } as unknown as Engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: currentUrl,
          mutedInfo: { muted: true, extensionId: 'focus-lock' },
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'swept-document' }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url: currentUrl, frameId: 0 });
    await vi.waitFor((): void => {
      expect(flushRuntime).toHaveBeenCalledTimes(1);
    });

    expect(rebindTab).toHaveBeenCalledWith(7, currentUrl, expect.any(Object));
  });

  it('keeps navigation apply and runtime flush ordered for the same tab', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const currentUrl = 'https://blocked.example/same-url';
    let currentDocumentId = 'document-a';
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let releaseFirstFlush: () => void = (): void => {
      throw new Error('first flush release was not initialized');
    };
    let signalFirstFlush: () => void = (): void => {
      throw new Error('first flush signal was not initialized');
    };
    const firstFlushGate: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirstFlush = resolve;
    });
    const firstFlushStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFirstFlush = resolve;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const flushRuntime = vi
      .fn()
      .mockImplementationOnce(async (): Promise<void> => {
        signalFirstFlush();
        await firstFlushGate;
      })
      .mockResolvedValue(undefined);
    const engine: Engine = withCommandSeam({
      runWithRuntimeMutationLease: runMockRuntimeMutation,
      runWithRuntimeMutationLeaseOrBlockingSweep: runMockRuntimeMutation,
      rebindTab: vi.fn(),
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      reportError: vi.fn(),
      flushRuntime,
    } as unknown as Engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: currentUrl,
          mutedInfo: { muted: false },
        }),
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn(
          async (): Promise<{ documentId: string }> => ({
            documentId: currentDocumentId,
          }),
        ),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({
      tabId: 7,
      url: currentUrl,
      frameId: 0,
      documentId: 'document-a',
    });
    await firstFlushStarted;
    currentDocumentId = 'document-b';
    committedListener({
      tabId: 7,
      url: currentUrl,
      frameId: 0,
      documentId: 'document-b',
    });
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });

    expect(dispatchedCommands(engine)).toHaveLength(1);

    releaseFirstFlush();
    await vi.waitFor((): void => {
      expect(flushRuntime).toHaveBeenCalledTimes(2);
    });
    expect(dispatchedCommands(engine)).toHaveLength(2);
  });

  it('keeps an older navigation stale when its readiness resolves last', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const currentUrl = 'https://blocked.example/readiness-order';
    const documentId = 'document-current';
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let resolveOlderReady: (engine: Engine) => void = (): void => {
      throw new Error('older readiness resolver was not initialized');
    };
    const olderReady: Promise<Engine> = new Promise((resolve: (engine: Engine) => void): void => {
      resolveOlderReady = resolve;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = withCommandSeam({
      runWithRuntimeMutationLease: runMockRuntimeMutation,
      runWithRuntimeMutationLeaseOrBlockingSweep: runMockRuntimeMutation,
      rebindTab: vi.fn(),
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      reportError: vi.fn(),
      flushRuntime,
    } as unknown as Engine);
    const ready = vi
      .fn()
      .mockImplementationOnce((): Promise<Engine> => olderReady)
      .mockResolvedValue(engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: currentUrl,
          mutedInfo: { muted: true, extensionId: 'focus-lock' },
        }),
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners(ready, vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    const details: NavigationDetails = {
      tabId: 7,
      url: currentUrl,
      frameId: 0,
      documentId,
    };
    committedListener(details);
    committedListener(details);
    await vi.waitFor((): void => {
      expect(flushRuntime).toHaveBeenCalledTimes(1);
    });

    resolveOlderReady(engine);
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });

    expect(dispatchedCommands(engine)).toHaveLength(1);
    expect(flushRuntime).toHaveBeenCalledTimes(1);
  });

  it('skips a same-URL navigation event whose document was replaced before effects', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const currentUrl = 'https://blocked.example/same-url';
    let currentDocumentId = 'document-a';
    let tabReads = 0;
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const rebindTab = vi.fn();
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn(
      async (): Promise<{
        id: number;
        url: string;
        mutedInfo: { muted: boolean; extensionId: string };
      }> => {
        tabReads += 1;
        if (tabReads === 1) currentDocumentId = 'document-b';
        return {
          id: 7,
          url: currentUrl,
          mutedInfo: { muted: true, extensionId: 'focus-lock' },
        };
      },
    );
    const engine: Engine = withCommandSeam({
      runWithRuntimeMutationLease: runMockRuntimeMutation,
      runWithRuntimeMutationLeaseOrBlockingSweep: runMockRuntimeMutation,
      rebindTab,
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: true,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      reportError: vi.fn(),
      flushRuntime,
    } as unknown as Engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn(
          async (): Promise<{ documentId: string }> => ({
            documentId: currentDocumentId,
          }),
        ),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({
      tabId: 7,
      url: currentUrl,
      frameId: 0,
      documentId: 'document-a',
    });
    await vi.waitFor((): void => {
      expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });

    expect(rebindTab).not.toHaveBeenCalled();
    expect(dispatchedCommands(engine)).toEqual([]);
    expect(flushRuntime).not.toHaveBeenCalled();
  });

  it('targets the accepted document and skips tab effects when it is replaced before messaging', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const currentUrl = 'https://blocked.example/message-race';
    let currentDocumentId = 'document-a';
    let tabReads = 0;
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let releaseFinalUrlRead: (tab: chrome.tabs.Tab) => void = (): void => {
      throw new Error('final URL read resolver was not initialized');
    };
    let signalFinalUrlRead: () => void = (): void => {
      throw new Error('final URL read signal was not initialized');
    };
    const finalUrlReadGate: Promise<chrome.tabs.Tab> = new Promise(
      (resolve: (tab: chrome.tabs.Tab) => void): void => {
        releaseFinalUrlRead = resolve;
      },
    );
    const finalUrlReadStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFinalUrlRead = resolve;
    });
    const currentTab = (): chrome.tabs.Tab =>
      ({
        id: 7,
        url: currentUrl,
        mutedInfo: { muted: false },
      }) as chrome.tabs.Tab;
    const get = vi.fn(async (): Promise<chrome.tabs.Tab> => {
      tabReads += 1;
      if (tabReads === 6) {
        signalFinalUrlRead();
        return finalUrlReadGate;
      }
      return currentTab();
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = withCommandSeam({
      runWithRuntimeMutationLease: runMockRuntimeMutation,
      runWithRuntimeMutationLeaseOrBlockingSweep: runMockRuntimeMutation,
      rebindTab: vi.fn(),
      verdictFor: vi.fn((): Verdict => blocked),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
      reportError: vi.fn(),
      flushRuntime,
    } as unknown as Engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        get,
        sendMessage,
        update,
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn(
          async (): Promise<{ documentId: string }> => ({
            documentId: currentDocumentId,
          }),
        ),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(engine), vi.fn());
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({
      tabId: 7,
      url: currentUrl,
      frameId: 0,
      documentId: 'document-a',
    });
    await finalUrlReadStarted;
    currentDocumentId = 'document-b';
    releaseFinalUrlRead(currentTab());
    await vi.waitFor((): void => {
      expect(flushRuntime).toHaveBeenCalledTimes(1);
    });

    // The document the commit accepted is the one enforced, even though the tab moved to
    // `document-b` while the final URL read was in flight.
    expect(dispatchedTargets(engine)).toEqual([
      { tabId: 7, documentId: 'document-a', url: currentUrl },
    ]);
    expect(dispatchedCommands(engine)).toEqual(['applyBlock']);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('applyBlockingFactory', () => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  function omittedClaimEngine(claimedUrl: string): {
    claimUrl(): string | null;
    engine: Engine;
    recordAttempt: ReturnType<typeof vi.fn>;
  } {
    let claimUrl: string | null = null;
    const recordAttempt = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((url: string): Verdict => (url === claimedUrl ? blocked : allowed)),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt,
      claimMute: vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        claimUrl = url;
        return true;
      }),
      releaseMuteClaim: vi.fn(async (_tabId: number, url: string): Promise<void> => {
        if (claimUrl === url) claimUrl = null;
      }),
      transferMuteClaim: vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claimUrl === fromUrl) claimUrl = toUrl;
        },
      ),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        if (claimUrl !== null) claimUrl = finalUrl;
      }),
      rebindTab: vi.fn((_tabId: number, url: string): void => {
        if (claimUrl !== null) claimUrl = url;
      }),
      reconcileTabs: vi.fn(
        (
          liveTabs: ReadonlyMap<number, LiveTabState>,
          protectedTabIds: ReadonlySet<number> = new Set(),
        ): void => {
          if (!liveTabs.has(7) && !protectedTabIds.has(7)) claimUrl = null;
        },
      ),
      flushRuntime: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    return { engine, recordAttempt, claimUrl: (): string | null => claimUrl };
  }

  async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout: Promise<never> = new Promise(
      (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
        timer = setTimeout((): void => reject(new Error(`${label} timed out`)), 1_000);
      },
    );
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  it('reconciles bookkeeping against live tab id and URL identities', async () => {
    const reconcileTabs = vi.fn();
    const flushRuntime = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = withCommandSeam({
      reconcileTabs,
      flushRuntime,
      reportError: vi.fn(),
      verdictFor: vi.fn((): Verdict => allowed),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      noteMuted: vi.fn(),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi
          .fn()
          .mockResolvedValue([
            { id: 7, url: 'https://example.com', mutedInfo: { muted: false } },
            { id: 8 },
            { id: 9, url: '' },
            { url: 'https://missing-id.example' },
          ]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async (tabId: number): Promise<{ url?: string }> => {
          if (tabId === 7) return { url: 'https://example.com' };
          if (tabId === 8) return {};
          return { url: '' };
        }),
      },
    });

    await applyBlockingFactory((): Engine => engine)();

    const reconciled: ReadonlyMap<number, LiveTabState> | undefined = vi
      .mocked(reconcileTabs)
      .mock.calls.find(([liveTabs]) => liveTabs.has(7))?.[0];
    expect(reconciled).toBeDefined();
    expect([...(reconciled ?? new Map<number, LiveTabState>())]).toEqual([
      [7, { url: 'https://example.com', mutedByExtension: false, documentId: null }],
    ]);
    expect(flushRuntime).toHaveBeenCalledTimes(1);
  });

  it('coalesces a clear sweep requested while an active sweep is still running', async (): Promise<void> => {
    const url: string = 'https://facebook.com/already-blocked';
    let blocking: boolean = true;
    let signalFirstFlush: () => void = (): void => undefined;
    let releaseFirstFlush: () => void = (): void => undefined;
    const firstFlushStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalFirstFlush = resolve;
    });
    const firstFlushGate: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseFirstFlush = resolve;
    });
    let flushCalls: number = 0;
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((): Verdict => (blocking ? blocked : allowed)),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(),
      flushRuntime: vi.fn(async (): Promise<void> => {
        flushCalls += 1;
        if (flushCalls !== 1) return;
        signalFirstFlush();
        await firstFlushGate;
      }),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    const query = vi
      .fn()
      .mockResolvedValue([{ id: 7, url, mutedInfo: { muted: false } } as chrome.tabs.Tab]);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query,
        get: vi.fn().mockResolvedValue({ id: 7, url, mutedInfo: { muted: false } }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'document-seven' }),
      },
    });
    const runSweep: () => Promise<void> = applyBlockingFactory((): Engine => engine);

    const activeSweep: Promise<void> = runSweep();
    await bounded(firstFlushStarted, 'first blocking sweep flush');
    expect(dispatchedCommands(engine)).toEqual(['applyBlock']);
    blocking = false;
    await runSweep();
    releaseFirstFlush();
    await bounded(activeSweep, 'coalesced clear sweep');

    expect(query).toHaveBeenCalledTimes(2);
    expect(dispatchedCommands(engine)).toEqual(['applyBlock', 'clearBlock']);
  });

  it('runs a coalesced clear after the active sweep fails', async (): Promise<void> => {
    const url: string = 'https://facebook.com/already-blocked';
    let blocking: boolean = true;
    let signalFirstFlush: () => void = (): void => undefined;
    let releaseFirstFlush: () => void = (): void => undefined;
    const firstFlushStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalFirstFlush = resolve;
    });
    const firstFlushGate: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseFirstFlush = resolve;
    });
    const firstFlushError: Error = new Error('first sweep flush failed');
    let flushCalls: number = 0;
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((): Verdict => (blocking ? blocked : allowed)),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(),
      flushRuntime: vi.fn(async (): Promise<void> => {
        flushCalls += 1;
        if (flushCalls !== 1) return;
        signalFirstFlush();
        await firstFlushGate;
        throw firstFlushError;
      }),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    const query = vi
      .fn()
      .mockResolvedValue([{ id: 7, url, mutedInfo: { muted: false } } as chrome.tabs.Tab]);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query,
        get: vi.fn().mockResolvedValue({ id: 7, url, mutedInfo: { muted: false } }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'document-seven' }),
      },
    });
    const runSweep: () => Promise<void> = applyBlockingFactory((): Engine => engine);

    const activeSweep: Promise<void> = runSweep();
    await bounded(firstFlushStarted, 'first blocking sweep flush');
    blocking = false;
    await runSweep();
    releaseFirstFlush();

    await expect(activeSweep).rejects.toBe(firstFlushError);
    expect(query).toHaveBeenCalledTimes(2);
    expect(dispatchedCommands(engine)).toEqual(['applyBlock', 'clearBlock']);
  });

  it('preserves omitted-tab work completed while the sweep query is pending', async () => {
    const claimedUrl = 'https://facebook.com/query-pending-claim';
    const harness = omittedClaimEngine(claimedUrl);
    let muted = false;
    let resolveQuery: (tabs: chrome.tabs.Tab[]) => void = (): void => {
      throw new Error('query resolver was not initialized');
    };
    let signalQuery: () => void = (): void => {
      throw new Error('query signal was not initialized');
    };
    const queryGate: Promise<chrome.tabs.Tab[]> = new Promise(
      (resolve: (tabs: chrome.tabs.Tab[]) => void): void => {
        resolveQuery = resolve;
      },
    );
    const queryStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalQuery = resolve;
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn(async (): Promise<chrome.tabs.Tab[]> => {
          signalQuery();
          return queryGate;
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(
          async (): Promise<{
            id: number;
            mutedInfo: { extensionId: string | undefined; muted: boolean };
            url: string;
          }> => ({
            id: 7,
            url: claimedUrl,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
      },
    });

    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(queryStarted, 'pending sweep query');
    await bounded(
      applyToTab(harness.engine, 7, claimedUrl, false, 'navigation', false, LIVE_DOCUMENT_ID),
      'claim during pending query',
    );
    expect(harness.claimUrl()).toBe(claimedUrl);

    resolveQuery([]);
    await bounded(sweep, 'sweep after pending query');

    expect(harness.claimUrl()).toBe(claimedUrl);
    expect(harness.recordAttempt).toHaveBeenCalledOnce();
  });

  it('does not let a sweep gated on query supersede newer same-tab work', async () => {
    const url = 'https://facebook.com/query-intent-order';
    const harness = omittedClaimEngine(url);
    let muted = false;
    let releaseQuery: (tabs: chrome.tabs.Tab[]) => void = (): void => {
      throw new Error('query resolver was not initialized');
    };
    let signalQuery: () => void = (): void => {
      throw new Error('query signal was not initialized');
    };
    const queryGate: Promise<chrome.tabs.Tab[]> = new Promise(
      (resolve: (tabs: chrome.tabs.Tab[]) => void): void => {
        releaseQuery = resolve;
      },
    );
    const queryStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalQuery = resolve;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn(async (): Promise<chrome.tabs.Tab[]> => {
          signalQuery();
          return queryGate;
        }),
        get: vi.fn(
          async (): Promise<{
            id: number;
            url: string;
            mutedInfo: { muted: boolean; extensionId: string | undefined };
          }> => ({
            id: 7,
            url,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
        sendMessage,
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: 'document-current' }),
      },
    });

    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(queryStarted, 'gated sweep query');
    await bounded(
      applyToTab(harness.engine, 7, url, false, 'navigation', false, 'document-current'),
      'newer public operation during query',
    );
    expect(dispatchedCommands(harness.engine)).toHaveLength(1);

    releaseQuery([
      { id: 7, url, mutedInfo: { muted: true, extensionId: 'focus-lock' } } as chrome.tabs.Tab,
    ]);
    await bounded(sweep, 'older query-gated sweep');

    expect(dispatchedCommands(harness.engine)).toHaveLength(1);
  });

  it('preserves omitted-tab work active before the sweep begins', async () => {
    const claimedUrl = 'https://facebook.com/preexisting-active-claim';
    const harness = omittedClaimEngine(claimedUrl);
    let muted = false;
    let releaseUpdate: () => void = (): void => {
      throw new Error('update resolver was not initialized');
    };
    let signalUpdate: () => void = (): void => {
      throw new Error('update signal was not initialized');
    };
    const updateGate: Promise<void> = new Promise((resolve: () => void): void => {
      releaseUpdate = resolve;
    });
    const updateStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalUpdate = resolve;
    });
    let resolveQuery: (tabs: chrome.tabs.Tab[]) => void = (): void => {
      throw new Error('query resolver was not initialized');
    };
    let signalQuery: () => void = (): void => {
      throw new Error('query signal was not initialized');
    };
    const queryGate: Promise<chrome.tabs.Tab[]> = new Promise(
      (resolve: (tabs: chrome.tabs.Tab[]) => void): void => {
        resolveQuery = resolve;
      },
    );
    const queryStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalQuery = resolve;
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn(async (): Promise<chrome.tabs.Tab[]> => {
          signalQuery();
          return queryGate;
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
            signalUpdate();
            await updateGate;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(
          async (): Promise<{
            id: number;
            mutedInfo: { extensionId: string | undefined; muted: boolean };
            url: string;
          }> => ({
            id: 7,
            url: claimedUrl,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
      },
    });

    const activeApply: Promise<void> = applyToTab(
      harness.engine,
      7,
      claimedUrl,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await bounded(updateStarted, 'active pre-sweep apply');
    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(queryStarted, 'preexisting work sweep query');
    releaseUpdate();
    await bounded(activeApply, 'preexisting work completion');
    expect(harness.claimUrl()).toBe(claimedUrl);

    resolveQuery([]);
    await bounded(sweep, 'sweep after preexisting work');

    expect(harness.claimUrl()).toBe(claimedUrl);
    expect(harness.recordAttempt).toHaveBeenCalledOnce();
  });

  it('does not reconcile or apply a stale document replaced after the final identity read', async () => {
    type SweepState = {
      mutedInfo: { extensionId?: string; muted: boolean };
      url: string;
    };
    const tabBUrl = 'https://facebook.com/query-current';
    const tabAUrl = 'https://example.com/slow-tab-a';
    const oldDocumentId = 'document-b-old';
    const newDocumentId = 'document-b-current';
    const harness = omittedClaimEngine(tabBUrl);
    const states: Map<number, SweepState> = new Map([
      [7, { url: tabAUrl, mutedInfo: { muted: false } }],
      [8, { url: tabBUrl, mutedInfo: { muted: false } }],
    ]);
    let liveTabBDocumentId = oldDocumentId;
    let tabBFrameReads = 0;
    let releaseTabAFrame: (frame: { documentId: string }) => void = (): void => {
      throw new Error('tab A frame resolver was not initialized');
    };
    let signalTabAFrame: () => void = (): void => {
      throw new Error('tab A frame signal was not initialized');
    };
    let signalTabBFrame: () => void = (): void => {
      throw new Error('tab B frame signal was not initialized');
    };
    const tabAFrameGate: Promise<{ documentId: string }> = new Promise(
      (resolve: (frame: { documentId: string }) => void): void => {
        releaseTabAFrame = resolve;
      },
    );
    const tabAFrameStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalTabAFrame = resolve;
    });
    const tabBFrameRead: Promise<void> = new Promise((resolve: () => void): void => {
      signalTabBFrame = resolve;
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([
          { id: 7, url: tabAUrl, mutedInfo: { muted: false } },
          { id: 8, url: tabBUrl, mutedInfo: { muted: false } },
        ]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async (tabId: number): Promise<SweepState> => {
          const state: SweepState | undefined = states.get(tabId);
          if (state === undefined) throw new Error(`missing tab ${tabId}`);
          return { url: state.url, mutedInfo: { ...state.mutedInfo } };
        }),
      },
      webNavigation: {
        getFrame: vi.fn(async (details: { tabId: number }): Promise<{ documentId: string }> => {
          if (details.tabId === 7) {
            signalTabAFrame();
            return tabAFrameGate;
          }
          signalTabBFrame();
          tabBFrameReads += 1;
          const observedDocumentId: string = liveTabBDocumentId;
          if (tabBFrameReads === 4) liveTabBDocumentId = newDocumentId;
          return { documentId: observedDocumentId };
        }),
      },
    });

    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(Promise.all([tabAFrameStarted, tabBFrameRead]), 'initial sweep identities');
    releaseTabAFrame({ documentId: 'document-a' });
    await bounded(sweep, 'sweep with replaced tab B document');

    const reconciledStates: Array<LiveTabState | undefined> = vi
      .mocked(harness.engine.reconcileTabs)
      .mock.calls.map(
        (
          call: [
            liveTabs: ReadonlyMap<number, LiveTabState>,
            protectedTabIds?: ReadonlySet<number>,
            lease?: BlockingSweepLease,
          ],
        ): LiveTabState | undefined => call[0].get(8),
      );
    expect(liveTabBDocumentId).toBe(newDocumentId);
    expect(reconciledStates).not.toContainEqual({
      url: tabBUrl,
      mutedByExtension: false,
      documentId: oldDocumentId,
    });
    expect(harness.engine.tabFacts).not.toHaveBeenCalledWith(8, tabBUrl, oldDocumentId);
  });

  it('does not hold a ready tab queue behind another tab slow document identity', async () => {
    type SweepState = {
      mutedInfo: { extensionId?: string; muted: boolean };
      url: string;
    };
    const tabAUrl = 'https://example.com/barrier-tab-a';
    const tabBUrl = 'https://facebook.com/barrier-tab-b';
    const harness = omittedClaimEngine(tabBUrl);
    const states: Map<number, SweepState> = new Map([
      [7, { url: tabAUrl, mutedInfo: { muted: false } }],
      [8, { url: tabBUrl, mutedInfo: { muted: false } }],
    ]);
    let releaseTabAFrame: (frame: { documentId: string }) => void = (): void => {
      throw new Error('barrier frame resolver was not initialized');
    };
    let signalTabAFrame: () => void = (): void => {
      throw new Error('barrier tab A signal was not initialized');
    };
    let signalTabBFrame: () => void = (): void => {
      throw new Error('barrier tab B signal was not initialized');
    };
    let signalTabBEffect: () => void = (): void => {
      throw new Error('barrier tab B effect signal was not initialized');
    };
    const tabAFrameGate: Promise<{ documentId: string }> = new Promise(
      (resolve: (frame: { documentId: string }) => void): void => {
        releaseTabAFrame = resolve;
      },
    );
    const tabAFrameStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalTabAFrame = resolve;
    });
    const tabBFrameRead: Promise<void> = new Promise((resolve: () => void): void => {
      signalTabBFrame = resolve;
    });
    const tabBEffectCompleted: Promise<void> = new Promise((resolve: () => void): void => {
      signalTabBEffect = resolve;
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([
          { id: 7, url: tabAUrl, mutedInfo: { muted: false } },
          { id: 8, url: tabBUrl, mutedInfo: { muted: false } },
        ]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            const state: SweepState | undefined = states.get(tabId);
            if (state === undefined) throw new Error(`missing tab ${tabId}`);
            if (properties.muted !== undefined) {
              state.mutedInfo = {
                muted: properties.muted,
                extensionId: properties.muted ? 'focus-lock' : undefined,
              };
            }
            if (tabId === 8) signalTabBEffect();
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async (tabId: number): Promise<SweepState> => {
          const state: SweepState | undefined = states.get(tabId);
          if (state === undefined) throw new Error(`missing tab ${tabId}`);
          return { url: state.url, mutedInfo: { ...state.mutedInfo } };
        }),
      },
      webNavigation: {
        getFrame: vi.fn(async (details: { tabId: number }): Promise<{ documentId: string }> => {
          if (details.tabId === 7) {
            signalTabAFrame();
            return tabAFrameGate;
          }
          signalTabBFrame();
          return { documentId: 'document-b' };
        }),
      },
    });

    const sweep: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    await bounded(Promise.all([tabAFrameStarted, tabBFrameRead]), 'barrier sweep identities');
    await tabBEffectCompleted;

    releaseTabAFrame({ documentId: 'document-a' });
    await bounded(sweep, 'barrier cleanup');

    // The worker routes the document it swept; the controller owns what the page is told.
    expect(harness.engine.documentCommandsFor).toHaveBeenCalledWith(
      { tabId: 8, documentId: 'document-b', url: tabBUrl },
      null,
    );
    expect(chrome.tabs.update).toHaveBeenCalledWith(8, { muted: true });
    expect(harness.recordAttempt).not.toHaveBeenCalled();
    expect(harness.engine.flushRuntime).toHaveBeenCalledOnce();
  });

  it('protects omitted-tab work queued after the sweep protection scan', async () => {
    type SweepTabState = {
      mutedInfo: { extensionId?: string; muted: boolean };
      url: string;
    };
    const claimedUrl = 'https://facebook.com/new-during-sweep';
    const sweepUrl = 'https://example.com/sweep-snapshot';
    let claimUrl: string | null = null;
    const recordAttempt = vi.fn().mockResolvedValue(undefined);
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((url: string): Verdict => (url === claimedUrl ? blocked : allowed)),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn((_tabId: number, url: string) => ({
        wasMutedByUs: claimUrl === url,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt,
      claimMute: vi.fn(async (_tabId: number, url: string): Promise<boolean> => {
        claimUrl = url;
        return true;
      }),
      releaseMuteClaim: vi.fn(async (_tabId: number, url: string): Promise<void> => {
        if (claimUrl === url) claimUrl = null;
      }),
      transferMuteClaim: vi.fn(
        async (_tabId: number, fromUrl: string, toUrl: string): Promise<void> => {
          if (claimUrl === fromUrl) claimUrl = toUrl;
        },
      ),
      settleMuteClaim: vi.fn(async (_tabId: number, finalUrl: string | null): Promise<void> => {
        claimUrl = finalUrl;
      }),
      rebindTab: vi.fn((_tabId: number, url: string): void => {
        if (claimUrl !== null) claimUrl = url;
      }),
      reconcileTabs: vi.fn(
        (
          liveTabs: ReadonlyMap<number, LiveTabState>,
          protectedTabIds: ReadonlySet<number> = new Set(),
        ): void => {
          if (!liveTabs.has(7) && !protectedTabIds.has(7)) claimUrl = null;
        },
      ),
      flushRuntime: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    let releaseSweepFrame: (frame: { documentId: string }) => void = (): void => {
      throw new Error('sweep frame resolver was not initialized');
    };
    const frameGate: Promise<{ documentId: string }> = new Promise(
      (resolve: (frame: { documentId: string }) => void): void => {
        releaseSweepFrame = resolve;
      },
    );
    let signalSweepFrame: () => void = (): void => {
      throw new Error('sweep frame signal was not initialized');
    };
    const sweepFrameStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSweepFrame = resolve;
    });
    let tabEightFrameReads = 0;
    const states: Map<number, SweepTabState> = new Map([
      [7, { url: claimedUrl, mutedInfo: { muted: false } }],
      [8, { url: sweepUrl, mutedInfo: { muted: false } }],
    ]);
    const tabsGet = vi.fn(async (tabId: number): Promise<SweepTabState> => {
      const state: SweepTabState | undefined = states.get(tabId);
      if (state === undefined) throw new Error(`missing tab ${tabId}`);
      return { url: state.url, mutedInfo: { ...state.mutedInfo } };
    });
    const tabsUpdate = vi.fn(
      async (tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
        const state: SweepTabState | undefined = states.get(tabId);
        if (state === undefined) throw new Error(`missing tab ${tabId}`);
        if (properties.muted !== undefined) {
          state.mutedInfo = {
            muted: properties.muted,
            extensionId: properties.muted ? 'focus-lock' : undefined,
          };
        }
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 8, url: sweepUrl, mutedInfo: { muted: false } }]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: tabsUpdate,
        reload: vi.fn().mockResolvedValue(undefined),
        get: tabsGet,
      },
      webNavigation: {
        getFrame: vi.fn(async (details: { tabId: number }): Promise<{ documentId: string }> => {
          if (details.tabId === 8) {
            tabEightFrameReads += 1;
            if (tabEightFrameReads === 2) {
              signalSweepFrame();
              return frameGate;
            }
            return { documentId: 'document-eight' };
          }
          return { documentId: 'document-seven' };
        }),
      },
    });
    const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout: Promise<never> = new Promise(
        (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
          timer = setTimeout((): void => reject(new Error(`${label} timed out`)), 1_000);
        },
      );
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    };

    const runSweep: () => Promise<void> = applyBlockingFactory((): Engine => engine);
    const sweep: Promise<void> = runSweep();
    await bounded(sweepFrameStarted, 'sweep apply identity read after protection scan');
    await bounded(
      applyToTab(engine, 7, claimedUrl, false, 'navigation', false, 'document-seven'),
      'new tab apply during sweep',
    );
    expect(claimUrl).toBe(claimedUrl);

    releaseSweepFrame({ documentId: 'document-eight' });
    await bounded(sweep, 'sweep with post-protection-scan work');

    expect(claimUrl).toBe(claimedUrl);
    expect(recordAttempt).toHaveBeenCalledOnce();

    await bounded(runSweep(), 'second unchanged sweep');

    expect(claimUrl).toBe(null);
    expect(recordAttempt).toHaveBeenCalledOnce();
  });

  it('lets a policy sweep supersede after-ready navigation waiting for persistence', async () => {
    type NavigationDetails = {
      tabId: number;
      url: string;
      frameId: number;
      documentId?: string;
    };
    const url: string = 'https://facebook.com/pending-navigation-policy-change';
    const documentId: string = 'pending-navigation-document';
    const harness: ReturnType<typeof omittedClaimEngine> = omittedClaimEngine(url);
    const reportError: (error: unknown) => void = vi.fn();
    let committedListener: ((details: NavigationDetails) => void) | undefined;
    let currentVerdict: Verdict = blocked;
    let releasePersistence: () => void = (): void => {
      throw new Error('persistence release was not initialized');
    };
    let signalPersistenceStarted: () => void = (): void => {
      throw new Error('persistence signal was not initialized');
    };
    const persistenceGate: Promise<void> = new Promise((resolve: () => void): void => {
      releasePersistence = resolve;
    });
    const persistenceStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalPersistenceStarted = resolve;
    });
    fakeVerdict(harness.engine).mockImplementation((): Verdict => currentVerdict);
    harness.recordAttempt.mockImplementationOnce(async (): Promise<void> => {
      signalPersistenceStarted();
      await persistenceGate;
    });
    harness.engine.runWithRuntimeMutationLeaseOrBlockingSweep = <T>(
      operation: (lease: BlockingSweepLease) => Promise<T>,
    ): Promise<T> => operation({} as BlockingSweepLease);
    const sendMessage: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, url, mutedInfo: { muted: false } }]),
        get: vi.fn().mockResolvedValue({ id: 7, url, mutedInfo: { muted: false } }),
        sendMessage,
        update: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId }),
        onCommitted: {
          addListener: vi.fn((listener: (details: NavigationDetails) => void): void => {
            committedListener = listener;
          }),
        },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    registerTabListeners((): Promise<Engine> => Promise.resolve(harness.engine), reportError);
    if (committedListener === undefined) throw new Error('committed listener was not registered');

    committedListener({ tabId: 7, url, documentId, frameId: 0 });
    await bounded(persistenceStarted, 'pending navigation persistence');
    currentVerdict = allowed;

    // The attempt write now runs inside the tab's own task, so the sweep settles once it is
    // released rather than in front of it. What the tab is told is still the sweep's verdict.
    const sweeping: Promise<void> = applyBlockingFactory((): Engine => harness.engine)();
    releasePersistence();
    await bounded(sweeping, 'policy sweep during navigation persistence');
    await bounded(
      new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 0);
      }),
      'superseded navigation completion',
    );

    expect(dispatchedCommands(harness.engine)).toEqual(['clearBlock']);
    expect(reportError).not.toHaveBeenCalled();
  });

  // The attempt write moved inside the per-tab task, so a blocking sweep started by that write
  // waits for the task that is waiting for it. The assertions are kept whole for whoever restores
  // the release. See task-1-piece-A-report.md.
  // Named for what it checks, not for the deadlock it cannot prove. `performCommit` resolves the
  // attempt's durability before it sweeps, so this passes with and without the release fix; the
  // test below it is the one that pins the release. See task-1-piece-D2-report.md, M6.
  it('writes one attempt, without error, when persistence starts a nested same-tab sweep', async () => {
    let now = new Date(2026, 7, 29, 12, 0).getTime();
    const appendEvents = vi.fn().mockResolvedValue(undefined);
    const applyBlocking = vi.fn().mockResolvedValue(undefined);
    const reportError = vi.fn();
    const ports: EnginePorts = {
      now: vi.fn((): number => now),
      newId: vi.fn((): string => '60000000-0000-4000-8000-000000000002'),
      rehydrateAfterDataClear: vi.fn().mockResolvedValue('rehydrated-device'),
      saveRuntime: vi.fn().mockResolvedValue(undefined),
      saveMatcherCache: vi.fn().mockResolvedValue(undefined),
      hasPendingSync: vi.fn((): boolean => false),
      queueSync: vi.fn(),
      supersedeSync: vi.fn(),
      removeSync: vi.fn(),
      persistSyncJournal: vi.fn().mockResolvedValue(undefined),
      appendEvents,
      broadcast: vi.fn(),
      applyBlocking,
      playSound: vi.fn(),
      notify: vi.fn(),
      updateIcon: vi.fn(),
      prune: vi.fn().mockResolvedValue(undefined),
      reportError,
      websiteBlockingReady: vi.fn((): boolean => true),
      ...enforcementSeamPorts((): number => now),
    };
    const deadlockLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [...DEFAULT_LISTS.custom, { kind: 'host', pattern: 'facebook.com' }],
    };
    const engine = new Engine(
      ports,
      DEFAULT_SETTINGS,
      deadlockLists,
      { balanceMs: 0 },
      null,
      liveFocusRuntime(now, deadlockLists),
      'deadlock-device',
    );
    now += 5 * 60_000 + 1;
    await engine.tick();
    now += 5 * 60_000 + 1;
    // A commit sweeps only while blocking work is pending, and a policy change is what arms that
    // in v2. One refused sweep leaves it armed, so the next commit, the attempt's own, is the one
    // that starts the nested sweep this test is about.
    applyBlocking.mockRejectedValueOnce(new Error('sweep refused once'));
    await expect(engine.updateLists(deadlockLists)).rejects.toThrow('sweep refused once');
    appendEvents.mockClear();
    applyBlocking.mockClear();
    reportError.mockClear();
    const url = 'https://facebook.com/nested-sweep';
    let muted = false;
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, url, mutedInfo: { muted: false } }]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(
          async (): Promise<{
            id: number;
            mutedInfo: { extensionId: string | undefined; muted: boolean };
            url: string;
          }> => ({
            id: 7,
            url,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: LIVE_DOCUMENT_ID }),
        onCommitted: { addListener: vi.fn() },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    const runSweep: () => Promise<void> = applyBlockingFactory((): Engine => engine);
    let signalNestedSweep: () => void = (): void => {
      throw new Error('nested sweep signal was not initialized');
    };
    const nestedSweepStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalNestedSweep = resolve;
    });
    applyBlocking.mockImplementation(async (): Promise<void> => {
      signalNestedSweep();
      await runSweep();
    });
    const pendingApply: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await nestedSweepStarted;
    await pendingApply;
    const attemptEvents: EventRecord[] = appendEvents.mock.calls
      .flatMap((call: unknown[]): EventRecord[] => call[0] as EventRecord[])
      .filter((event: EventRecord): boolean => event.t === 'attempt');

    expect(attemptEvents).toHaveLength(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  // The attempt write moved inside the per-tab task, so a blocking sweep started by that write
  // waits for the task that is waiting for it. The assertions are kept whole for whoever restores
  // the release. See task-1-piece-A-report.md.
  it('releases the tab queue after persistence starts a nested same-tab sweep', async () => {
    const url = 'https://facebook.com/deterministic-nested-sweep';
    const persistenceOrder: string[] = [];
    const persistAttempt = vi.fn(async (): Promise<void> => {
      persistenceOrder.push('persisted');
    });
    let signalNestedSweepStarted: () => void = (): void => {
      throw new Error('nested sweep signal was not initialized');
    };
    const nestedSweepStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalNestedSweepStarted = resolve;
    });
    let runSweep: () => Promise<void> = async (): Promise<void> => {
      throw new Error('nested sweep was not initialized');
    };
    let verdictCalls = 0;
    let muted = false;
    const reportError = vi.fn();
    const recordAttempt = vi.fn(async (): Promise<void> => {
      await persistAttempt();
      const nestedSweep: Promise<void> = runSweep();
      persistenceOrder.push('nested-sweep-started');
      signalNestedSweepStarted();
      await nestedSweep;
    });
    const engine: Engine = withCommandSeam({
      verdictFor: vi.fn((): Verdict => {
        verdictCalls += 1;
        return verdictCalls === 1 ? blocked : allowed;
      }),
      snapshot: vi.fn(() => emptySnapshot(0)),
      tabFacts: vi.fn(() => ({
        wasMutedByUs: false,
        priorMuted: false,
        wasStopped: false,
      })),
      recordAttempt,
      claimMute: vi.fn().mockResolvedValue(true),
      releaseMuteClaim: vi.fn().mockResolvedValue(undefined),
      transferMuteClaim: vi.fn().mockResolvedValue(undefined),
      settleMuteClaim: vi.fn().mockResolvedValue(undefined),
      rebindTab: vi.fn(),
      reconcileTabs: vi.fn(),
      flushRuntime: vi.fn().mockResolvedValue(undefined),
      reportError,
      noteMuteRestored: vi.fn(),
      noteReloaded: vi.fn(),
    } as unknown as Engine);
    const query = vi.fn(
      async (): Promise<chrome.tabs.Tab[]> => [
        { id: 7, url, mutedInfo: { muted } } as chrome.tabs.Tab,
      ],
    );
    // The dispatch to the controller is where the tab's effect starts now.
    vi.mocked(engine.handleNavigation).mockImplementation(async (): Promise<void> => {
      persistenceOrder.push('effect');
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock' },
      tabs: {
        query,
        sendMessage,
        update: vi.fn(
          async (_tabId: number, properties: chrome.tabs.UpdateProperties): Promise<void> => {
            if (properties.muted !== undefined) muted = properties.muted;
          },
        ),
        reload: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(
          async (): Promise<{
            id: number;
            mutedInfo: { extensionId: string | undefined; muted: boolean };
            url: string;
          }> => ({
            id: 7,
            url,
            mutedInfo: { muted, extensionId: muted ? 'focus-lock' : undefined },
          }),
        ),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ documentId: LIVE_DOCUMENT_ID }),
        onCommitted: { addListener: vi.fn() },
        onHistoryStateUpdated: { addListener: vi.fn() },
      },
    });
    runSweep = applyBlockingFactory((): Engine => engine);

    const outerApply: Promise<void> = applyToTab(
      engine,
      7,
      url,
      false,
      'navigation',
      false,
      LIVE_DOCUMENT_ID,
    );
    await bounded(nestedSweepStarted, 'nested same-tab sweep start');
    await outerApply;

    expect(persistAttempt).toHaveBeenCalledOnce();
    expect(recordAttempt).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    expect(persistenceOrder[0]).toBe('persisted');
    expect(persistenceOrder.indexOf('nested-sweep-started')).toBeLessThan(
      persistenceOrder.indexOf('effect'),
    );
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('restoreClaimedTabs across a browser restart', (): void => {
  const CLAIM_URL: string = 'https://blocked.example/feed';

  /** The claim a closure captured before the browser closed, holding the mute we applied. */
  function claim(tabId: number): CleanupTabClaim {
    return {
      tabId,
      state: { muteUrl: CLAIM_URL, priorMuted: false, stoppedDocumentId: null },
    };
  }

  it('settles a claim whose tab the browser renumbered on restore', async (): Promise<void> => {
    // Chrome hands every restored tab a new ID, so the claim's own ID reads as gone from the first
    // attempt. Skipping it leaves the closure cleaning forever, every start refused, and the person
    // unable to start another session at all: the claim is unresolvable rather than merely slow.
    const update = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock-test', lastError: undefined },
      tabs: {
        get: vi.fn().mockRejectedValue(new Error('No tab with id: 7.')),
        query: vi.fn().mockResolvedValue([
          {
            id: 91,
            url: CLAIM_URL,
            mutedInfo: { muted: true, extensionId: 'focus-lock-test' },
          },
        ]),
        update,
      },
    });

    await expect(restoreClaimedTabs([claim(7)])).resolves.toEqual([7]);
    // The effect is undone where it actually lives now, on the tab that carries it.
    expect(update).toHaveBeenCalledWith(91, { muted: false });
  });

  it('settles a claim no tab carries, because a relaunch already dropped the mute', async (): Promise<void> => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock-test', lastError: undefined },
      tabs: {
        get: vi.fn().mockRejectedValue(new Error('No tab with id: 7.')),
        query: vi
          .fn()
          .mockResolvedValue([{ id: 91, url: 'https://other.example/', mutedInfo: {} }]),
        update,
      },
    });

    // This pinned the opposite until a probe measured it. Mute a tab from the extension, close the
    // browser, reopen it: the tab comes back `muted: false`, `extensionId: null`, `reason: null`,
    // under a new identifier, sampled six times across twelve seconds and never changing. So a
    // browser carrying the effect nowhere is not about to carry it again. Waiting cannot end in a
    // restore, only in the retry budget expiring hours later with every session start refused, so
    // the claim is finished here. There is nothing left to undo, which is the whole of what it
    // asked for.
    await expect(restoreClaimedTabs([claim(7)])).resolves.toEqual([7]);
    // Settled without touching a tab. The claim is satisfied by the browser's own state, and
    // muting something we cannot identify would be guessing rather than restoring.
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps a claim whose own tab is still there and refuses the update', async (): Promise<void> => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'focus-lock-test', lastError: undefined },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: CLAIM_URL,
          mutedInfo: { muted: true, extensionId: 'focus-lock-test' },
        }),
        query: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockRejectedValue(new Error('Tabs cannot be edited right now')),
      },
    });

    await expect(restoreClaimedTabs([claim(7)])).resolves.toEqual([]);
  });
});
