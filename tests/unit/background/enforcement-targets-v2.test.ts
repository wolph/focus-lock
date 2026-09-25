import { describe, expect, it } from 'vitest';
import type { ContentTransportPortsV2 } from '../../../src/background/content-transport-v2';
import type {
  DocumentEnforcementAck,
  DocumentEpochResetAck,
  EnforcementTargetExclusion,
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from '../../../src/background/enforcement-persistence-v2';
import { validateDetachedEnforcementTargetExclusion } from '../../../src/background/enforcement-persistence-v2-validation';
import type {
  EnforcementPassResultV2,
  EnforcementTargetPortsV2,
  FreshnessAttemptResultV2,
  FreshnessBudgetV2,
  SweepDriverV2,
  TargetClassificationV2,
} from '../../../src/background/enforcement-targets-v2';
import {
  classifyEnforcementTargetV2,
  enumerateEnforcementTargetsV2,
  FINAL_FRESHNESS_TIMEOUT_MS,
  freshnessBudgetPermitsV2,
  isEnforceableHttpUrlV2,
  isKnownUnsupportedUrlV2,
  MAX_FINAL_FRESHNESS_ATTEMPTS,
  MAX_TARGET_RESOLVER_PASSES,
  runEnforcementPassV2,
  runFreshnessAttemptV2,
} from '../../../src/background/enforcement-targets-v2';
import {
  buildFrozenDocumentCommandV2,
  buildFrozenEpochResetCommandV2,
  buildStartingOverlayView,
} from '../../../src/background/overlay-view-v2';
import type {
  ContentEnforcementResponse,
  DocumentContentCommand,
  DocumentEnforcementCommand,
  DocumentOverlayView,
  ResetEnforcementEpochCommand,
} from '../../../src/shared/enforcement-v2';
import { exactDataEqual } from '../../../src/shared/exact-data';
import type { Verdict } from '../../../src/shared/types';

type EnforceableTarget = Extract<TargetClassificationV2, { kind: 'enforceable' }>;
type StablePassV2 = Extract<EnforcementPassResultV2, { kind: 'stable' }>;
type TabRow = { tabId: number; url: string | null };

const NOW: number = 1_750_000_000_000;
const SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
const RESET_OPERATION_ID: string = '20000000-0000-4000-8000-000000000002';
const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';
const STALE_RUNTIME_REVISION: number = 9;
const BLOCKED_VERDICT: Verdict = {
  blocked: true,
  reason: 'category',
  categoryId: 'social',
  matchedPattern: 'example.com',
};

interface SentMessage {
  tabId: number;
  documentId: string;
  message: DocumentContentCommand;
}

interface WorldOptions {
  tabs?: TabRow[];
  /** What Chrome answers when the sweep tries to put the script into one tab. */
  scriptable?: (tabId: number, world: FakeWorld) => 'ready' | 'unscriptable';
  generationScript?: number[];
  documentIds?: Record<number, string | null>;
  generation?: number;
  acked?: string[];
  onQuery?: (index: number, world: FakeWorld) => void;
  documentIdFor?: (tabId: number, world: FakeWorld) => string | null;
  answer?: (
    message: DocumentContentCommand,
    tabId: number,
    documentId: string,
    world: FakeWorld,
  ) => Promise<unknown>;
}

interface FakeWorld {
  tabs: TabRow[];
  documentIds: Record<number, string | null>;
  generation: number;
  now: number;
  queries: number;
  generationReads: number;
  runtimeRevision: number;
  events: string[];
  sent: SentMessage[];
  epochAcks: Set<string>;
  recordedAcks: DocumentEpochResetAck[];
  commands: Map<string, FrozenDocumentCommand>;
  staleCommands: Map<string, FrozenDocumentCommand>;
  injected: number[];
  ports: EnforcementTargetPortsV2;
  driver: SweepDriverV2;
}

function targetKey(tabId: number, documentId: string): string {
  return `${tabId}:${documentId}`;
}

/** A frozen command belongs to the exact target it was built for, URL and revision included. */
function commandKey(target: EnforceableTarget, runtimeRevision: number): string {
  return `${targetKey(target.tabId, target.documentId)}:${target.url}:${runtimeRevision}`;
}

function startingView(): DocumentOverlayView {
  return buildStartingOverlayView({
    capturedAt: NOW,
    theme: 'dark',
    stoppedPage: false,
    verdict: BLOCKED_VERDICT,
  });
}

function frozenCommand(
  target: EnforceableTarget,
  runtimeRevision: number = 0,
): FrozenDocumentCommand {
  return buildFrozenDocumentCommandV2({
    tabId: target.tabId,
    documentId: target.documentId,
    expectedUrl: target.url,
    operationId: OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
    sessionId: null,
    reservedSessionId: SESSION_ID,
    basePolicyRevision: 4,
    runtimeRevision,
    verdict: BLOCKED_VERDICT,
    presentation: 'starting',
    overlay: startingView(),
  });
}

function frozenReset(target: EnforceableTarget): FrozenEpochResetCommand {
  return buildFrozenEpochResetCommandV2({
    tabId: target.tabId,
    documentId: target.documentId,
    expectedUrl: target.url,
    operationId: RESET_OPERATION_ID,
    enforcementEpoch: EPOCH_ID,
  });
}

function appliedAnswer(
  message: DocumentEnforcementCommand,
  handledAt: number,
): ContentEnforcementResponse {
  return {
    version: 1,
    disposition: 'applied',
    operationId: message.operationId,
    enforcementEpoch: message.enforcementEpoch,
    sessionId: message.sessionId,
    reservedSessionId: message.reservedSessionId,
    basePolicyRevision: message.basePolicyRevision,
    runtimeRevision: message.runtimeRevision,
    documentId: message.documentId,
    observedUrl: message.expectedUrl,
    presentation: message.presentation,
    verdict: message.verdict,
    overlay: message.overlay,
    handledAt,
  };
}

function epochResetAnswer(
  message: ResetEnforcementEpochCommand,
  handledAt: number,
): ContentEnforcementResponse {
  return {
    version: 1,
    disposition: 'epoch-reset',
    operationId: message.operationId,
    enforcementEpoch: message.enforcementEpoch,
    documentId: message.documentId,
    observedUrl: message.expectedUrl,
    handledAt,
  };
}

function staleAnswer(
  message: DocumentEnforcementCommand,
  handledAt: number,
): ContentEnforcementResponse {
  return {
    version: 1,
    disposition: 'stale-command',
    operationId: message.operationId,
    enforcementEpoch: message.enforcementEpoch,
    documentId: message.documentId,
    observedUrl: message.expectedUrl,
    requested: {
      enforcementEpoch: message.enforcementEpoch,
      sessionId: message.sessionId,
      reservedSessionId: message.reservedSessionId,
      basePolicyRevision: message.basePolicyRevision,
      runtimeRevision: message.runtimeRevision,
    },
    current: {
      enforcementEpoch: message.enforcementEpoch,
      sessionId: message.sessionId,
      reservedSessionId: message.reservedSessionId,
      basePolicyRevision: message.basePolicyRevision,
      runtimeRevision: message.runtimeRevision + 5,
    },
    handledAt,
  };
}

function resetRequiredAnswer(
  message: DocumentEnforcementCommand,
  handledAt: number,
): ContentEnforcementResponse {
  return {
    version: 1,
    disposition: 'reset-required',
    operationId: message.operationId,
    enforcementEpoch: message.enforcementEpoch,
    documentId: message.documentId,
    observedUrl: message.expectedUrl,
    requestedEpoch: message.enforcementEpoch,
    currentEpoch: null,
    handledAt,
  };
}

function isEnforcementMessage(
  message: DocumentContentCommand,
): message is DocumentEnforcementCommand {
  return message.command === 'apply-enforcement';
}

async function defaultAnswer(
  message: DocumentContentCommand,
  _tabId: number,
  _documentId: string,
  world: FakeWorld,
): Promise<unknown> {
  return isEnforcementMessage(message)
    ? appliedAnswer(message, world.now)
    : epochResetAnswer(message, world.now);
}

function makeWorld(options: WorldOptions = {}): FakeWorld {
  const world: FakeWorld = {
    tabs: options.tabs ?? [{ tabId: 7, url: 'https://example.com/path' }],
    documentIds: options.documentIds ?? { 7: 'document-7' },
    generation: options.generation ?? 12,
    now: NOW,
    queries: 0,
    generationReads: 0,
    runtimeRevision: 0,
    events: [],
    sent: [],
    epochAcks: new Set<string>(options.acked ?? []),
    recordedAcks: [],
    commands: new Map<string, FrozenDocumentCommand>(),
    staleCommands: new Map<string, FrozenDocumentCommand>(),
    injected: [],
    ports: {} as EnforcementTargetPortsV2,
    driver: {} as SweepDriverV2,
  };
  const answer: NonNullable<WorldOptions['answer']> = options.answer ?? defaultAnswer;
  world.ports = {
    queryTopFrameTabs: async (): Promise<TabRow[]> => {
      world.queries += 1;
      options.onQuery?.(world.queries, world);
      return world.tabs.map((tab: TabRow): TabRow => ({ ...tab }));
    },
    topFrameDocumentId: async (tabId: number): Promise<string | null> => {
      if (options.documentIdFor !== undefined) return options.documentIdFor(tabId, world);
      return world.documentIds[tabId] ?? null;
    },
    readTargetGeneration: (): number => {
      const script: number[] | undefined = options.generationScript;
      const read: number = world.generationReads;
      world.generationReads += 1;
      if (script === undefined || script.length === 0) return world.generation;
      return script[Math.min(read, script.length - 1)] ?? world.generation;
    },
    now: (): number => world.now,
    ensureDocumentScript: async (tabId: number): Promise<'ready' | 'unscriptable'> => {
      world.injected.push(tabId);
      world.events.push(`inject:${String(tabId)}`);
      return options.scriptable?.(tabId, world) ?? 'ready';
    },
  };
  const transport: ContentTransportPortsV2 = {
    sendToDocument: async (
      tabId: number,
      documentId: string,
      message: DocumentContentCommand,
    ): Promise<unknown> => {
      world.sent.push({ tabId, documentId, message });
      world.events.push(`${message.command}:${targetKey(tabId, documentId)}`);
      return answer(message, tabId, documentId, world);
    },
  };
  world.driver = {
    commandFor: async (target: EnforceableTarget): Promise<FrozenDocumentCommand> => {
      const key: string = commandKey(target, world.runtimeRevision);
      const existing: FrozenDocumentCommand | undefined = world.commands.get(key);
      if (existing !== undefined) return existing;
      const built: FrozenDocumentCommand = frozenCommand(target, world.runtimeRevision);
      world.commands.set(key, built);
      return built;
    },
    resetFor: async (target: EnforceableTarget): Promise<FrozenEpochResetCommand> =>
      frozenReset(target),
    hasEpochAck: (tabId: number, documentId: string): boolean =>
      world.epochAcks.has(targetKey(tabId, documentId)),
    recordEpochAck: async (ack: DocumentEpochResetAck): Promise<void> => {
      await Promise.resolve();
      world.recordedAcks.push(ack);
      world.epochAcks.add(targetKey(ack.tabId, ack.documentId));
      world.events.push(`record:${targetKey(ack.tabId, ack.documentId)}`);
    },
    onStale: async (target: EnforceableTarget): Promise<FrozenDocumentCommand> => {
      // The worker rereads durable runtime, so every later command in this sweep carries the
      // higher revision too.
      world.runtimeRevision = STALE_RUNTIME_REVISION;
      const key: string = commandKey(target, STALE_RUNTIME_REVISION);
      const existing: FrozenDocumentCommand | undefined = world.staleCommands.get(key);
      if (existing !== undefined) return existing;
      const built: FrozenDocumentCommand = frozenCommand(target, STALE_RUNTIME_REVISION);
      world.staleCommands.set(key, built);
      return built;
    },
    transport,
  };
  return world;
}

function budget(overrides: Partial<FreshnessBudgetV2> = {}): FreshnessBudgetV2 {
  return { verificationStartedAt: NOW, freshnessAttempts: 0, ...overrides };
}

function stableResult(
  result: EnforcementPassResultV2,
): Extract<EnforcementPassResultV2, { kind: 'stable' }> {
  if (result.kind !== 'stable') throw new Error(`expected a stable pass, got ${result.detail}`);
  return result;
}

describe('target classification', () => {
  it('limits known-unsupported to the two Web Store prefixes', () => {
    expect(isKnownUnsupportedUrlV2('https://chromewebstore.google.com/detail/x')).toBe(true);
    expect(isKnownUnsupportedUrlV2('https://chrome.google.com/webstore/detail/x')).toBe(true);
    expect(isKnownUnsupportedUrlV2('https://chromewebstore.google.com/')).toBe(true);
    expect(isKnownUnsupportedUrlV2('https://chrome.google.com/webstore/')).toBe(true);

    expect(isKnownUnsupportedUrlV2('https://chrome.google.com/')).toBe(false);
    expect(isKnownUnsupportedUrlV2('https://chrome.google.com/sync')).toBe(false);
    expect(isKnownUnsupportedUrlV2('http://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isKnownUnsupportedUrlV2('https://chromewebstore.google.com.evil.test/detail/x')).toBe(
      false,
    );
    expect(isKnownUnsupportedUrlV2('https://evil.test/https://chromewebstore.google.com/')).toBe(
      false,
    );
  });

  it('treats every other HTTP(S) page as enforceable and every other scheme as outside', () => {
    expect(isEnforceableHttpUrlV2('https://example.com/path')).toBe(true);
    expect(isEnforceableHttpUrlV2('http://example.com/path')).toBe(true);
    expect(isEnforceableHttpUrlV2('https://chrome.google.com/')).toBe(true);
    expect(isEnforceableHttpUrlV2('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isEnforceableHttpUrlV2('chrome://extensions')).toBe(false);
    expect(isEnforceableHttpUrlV2('about:blank')).toBe(false);
    expect(isEnforceableHttpUrlV2('file:///x')).toBe(false);
  });

  it('classifies one target per outcome', () => {
    expect(classifyEnforcementTargetV2(7, 'https://example.com/path', 'document-7')).toEqual({
      kind: 'enforceable',
      tabId: 7,
      documentId: 'document-7',
      url: 'https://example.com/path',
    });
    expect(
      classifyEnforcementTargetV2(8, 'https://chromewebstore.google.com/detail/x', 'document-8'),
    ).toEqual({
      kind: 'known-unsupported',
      tabId: 8,
      documentId: 'document-8',
      url: 'https://chromewebstore.google.com/detail/x',
    });
    expect(
      classifyEnforcementTargetV2(9, 'https://chrome.google.com/webstore/detail/x', null),
    ).toEqual({
      kind: 'known-unsupported',
      tabId: 9,
      documentId: null,
      url: 'https://chrome.google.com/webstore/detail/x',
    });
    expect(classifyEnforcementTargetV2(10, 'https://example.com/path', null)).toEqual({
      kind: 'changed',
      tabId: 10,
      url: 'https://example.com/path',
      documentId: null,
    });
    for (const url of ['chrome://extensions', 'about:blank', 'file:///x', null]) {
      expect(classifyEnforcementTargetV2(11, url, 'document-11')).toEqual({
        kind: 'outside',
        tabId: 11,
      });
    }
  });

  it('enumerates every tab through the injected ports', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      tabs: [
        { tabId: 7, url: 'https://example.com/path' },
        { tabId: 8, url: 'https://chromewebstore.google.com/detail/x' },
        { tabId: 9, url: 'chrome://extensions' },
        { tabId: 10, url: 'https://pending.example/path' },
      ],
      documentIds: { 7: 'document-7', 8: 'document-8', 10: null },
    });

    const targets: TargetClassificationV2[] = await enumerateEnforcementTargetsV2(world.ports);

    expect(targets.map((target: TargetClassificationV2): string => target.kind)).toEqual([
      'enforceable',
      'known-unsupported',
      'outside',
      'changed',
    ]);
  });

  it('skips a row that cannot name a tab and never touches a hostile URL', async (): Promise<void> => {
    const hostileUrl: string = new Proxy(
      {},
      {
        get(): never {
          throw new Error('hostile url read');
        },
      },
    ) as unknown as string;
    const world: FakeWorld = makeWorld({
      tabs: [
        { tabId: 1.5, url: 'https://example.com/path' },
        { tabId: -1, url: 'https://example.com/path' },
        { tabId: 12, url: hostileUrl },
        { tabId: 7, url: 'https://example.com/path' },
      ],
      documentIds: { 7: 'document-7' },
    });

    const targets: TargetClassificationV2[] = await enumerateEnforcementTargetsV2(world.ports);

    expect(targets).toEqual([
      { kind: 'outside', tabId: 12 },
      { kind: 'enforceable', tabId: 7, documentId: 'document-7', url: 'https://example.com/path' },
    ]);
  });

  it('treats a throwing document-ID read as a missing document for that pass', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      documentIdFor: (): string | null => {
        throw new Error('tab is closing');
      },
    });

    const targets: TargetClassificationV2[] = await enumerateEnforcementTargetsV2(world.ports);

    expect(targets).toEqual([
      { kind: 'changed', tabId: 7, url: 'https://example.com/path', documentId: null },
    ]);
  });
});

describe('runEnforcementPassV2 handshake and acknowledgement', () => {
  it('resets before the first command and records the reset before it sends', async (): Promise<void> => {
    const world: FakeWorld = makeWorld();

    const result: EnforcementPassResultV2 = await runEnforcementPassV2(world.ports, world.driver);
    const stable: Extract<EnforcementPassResultV2, { kind: 'stable' }> = stableResult(result);

    expect(world.events).toEqual([
      'reset-enforcement-epoch:7:document-7',
      'record:7:document-7',
      'apply-enforcement:7:document-7',
    ]);
    expect(world.recordedAcks).toHaveLength(1);
    expect(stable.documents.map((ack: DocumentEnforcementAck): number => ack.tabId)).toEqual([7]);
    expect(stable.documents[0]?.documentId).toBe('document-7');
    expect(stable.documents[0]?.operationId).toBe(OPERATION_ID);
    expect(stable.generation).toBe(12);
    expect(stable.exclusions).toEqual([]);
  });

  it('skips the handshake for a document that already acknowledged the epoch', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({ acked: ['7:document-7'] });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(world.events).toEqual(['apply-enforcement:7:document-7']);
    expect(world.recordedAcks).toEqual([]);
    expect(stable.documents).toHaveLength(1);
  });

  it('replaces a stale command through the driver and requires the replacement to apply', async (): Promise<void> => {
    let staleAnswers: number = 0;
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      answer: async (
        message: DocumentContentCommand,
        _tabId: number,
        _documentId: string,
        state: FakeWorld,
      ): Promise<unknown> => {
        if (isEnforcementMessage(message) && message.runtimeRevision === 0) {
          staleAnswers += 1;
          return staleAnswer(message, state.now);
        }
        return defaultAnswer(message, _tabId, _documentId, state);
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(staleAnswers).toBe(1);
    expect(world.sent).toHaveLength(2);
    expect(stable.documents[0]?.runtimeRevision).toBe(9);
  });

  it('runs the handshake and resends when the document asks for a reset', async (): Promise<void> => {
    let resetRequired: number = 0;
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      answer: async (
        message: DocumentContentCommand,
        tabId: number,
        documentId: string,
        state: FakeWorld,
      ): Promise<unknown> => {
        if (isEnforcementMessage(message) && resetRequired === 0) {
          resetRequired += 1;
          return resetRequiredAnswer(message, state.now);
        }
        return defaultAnswer(message, tabId, documentId, state);
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(world.events).toEqual([
      'apply-enforcement:7:document-7',
      'reset-enforcement-epoch:7:document-7',
      'record:7:document-7',
      'apply-enforcement:7:document-7',
    ]);
    expect(stable.documents).toHaveLength(1);
  });

  it('sends structurally equal messages when the same target is visited again', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      onQuery: (index: number, state: FakeWorld): void => {
        if (index === 2) state.documentIds = { 7: null };
        if (index === 3) state.documentIds = { 7: 'document-7' };
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );
    const enforcementSends: SentMessage[] = world.sent.filter((sent: SentMessage): boolean =>
      isEnforcementMessage(sent.message),
    );

    expect(enforcementSends).toHaveLength(2);
    expect(exactDataEqual(enforcementSends[0]?.message, enforcementSends[1]?.message)).toBe(true);
    expect(stable.documents).toHaveLength(1);
  });
});

describe('runEnforcementPassV2 stabilization', () => {
  it('records a Web Store tab as an exclusion and never sends it a command', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      tabs: [
        { tabId: 7, url: 'https://example.com/path' },
        { tabId: 8, url: 'https://chromewebstore.google.com/detail/x' },
        { tabId: 9, url: 'https://chrome.google.com/webstore/detail/x' },
      ],
      documentIds: { 7: 'document-7', 8: 'document-8', 9: null },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );
    const expected: EnforcementTargetExclusion[] = [
      {
        tabId: 8,
        documentId: 'document-8',
        url: 'https://chromewebstore.google.com/detail/x',
        reason: 'known-unsupported',
      },
      {
        tabId: 9,
        documentId: null,
        url: 'https://chrome.google.com/webstore/detail/x',
        reason: 'known-unsupported',
      },
    ];

    expect(stable.exclusions).toEqual(expected);
    for (const exclusion of stable.exclusions) {
      expect(validateDetachedEnforcementTargetExclusion(exclusion)).toBe(true);
      expect(isKnownUnsupportedUrlV2(exclusion.url)).toBe(true);
    }
    expect(world.sent.every((sent: SentMessage): boolean => sent.tabId === 7)).toBe(true);
  });

  it('drops a tab that closed after enumeration', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      tabs: [
        { tabId: 7, url: 'https://example.com/path' },
        { tabId: 8, url: 'https://other.example/path' },
      ],
      documentIds: { 7: 'document-7', 8: 'document-8' },
      onQuery: (index: number, state: FakeWorld): void => {
        if (index === 2) {
          state.tabs = [{ tabId: 7, url: 'https://example.com/path' }];
          state.documentIds = { 7: 'document-7' };
        }
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(stable.documents.map((ack: DocumentEnforcementAck): number => ack.tabId)).toEqual([7]);
  });

  it('drops a pending tab that disappears before the reread', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      tabs: [
        { tabId: 7, url: 'https://example.com/path' },
        { tabId: 8, url: 'https://other.example/path' },
      ],
      documentIds: { 7: 'document-7', 8: null },
      onQuery: (index: number, state: FakeWorld): void => {
        if (index === 2) state.tabs = [{ tabId: 7, url: 'https://example.com/path' }];
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(world.queries).toBe(2);
    expect(stable.documents.map((ack: DocumentEnforcementAck): number => ack.tabId)).toEqual([7]);
    expect(world.sent.every((sent: SentMessage): boolean => sent.tabId === 7)).toBe(true);
  });

  it('reevaluates a document that changed after its acknowledgement', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      onQuery: (index: number, state: FakeWorld): void => {
        if (index === 2) {
          state.tabs = [{ tabId: 7, url: 'https://example.com/next' }];
          state.documentIds = { 7: 'document-8' };
        }
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(world.queries).toBe(4);
    expect(stable.documents).toHaveLength(1);
    expect(stable.documents[0]?.documentId).toBe('document-8');
    expect(stable.documents[0]?.url).toBe('https://example.com/next');
  });

  it('is not stable when a document keeps its ID but moves its URL', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      onQuery: (index: number, state: FakeWorld): void => {
        // A same-document navigation: the document ID survives, the URL does not.
        if (index === 2) state.tabs = [{ tabId: 7, url: 'https://example.com/next' }];
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(world.queries).toBe(4);
    expect(stable.documents).toHaveLength(1);
    expect(stable.documents[0]?.documentId).toBe('document-7');
    expect(stable.documents[0]?.url).toBe('https://example.com/next');
  });

  it('is not stable while one pass holds more than one runtime revision', async (): Promise<void> => {
    let staleAnswers: number = 0;
    const world: FakeWorld = makeWorld({
      tabs: [
        { tabId: 7, url: 'https://example.com/path' },
        { tabId: 8, url: 'https://other.example/path' },
      ],
      documentIds: { 7: 'document-7', 8: 'document-8' },
      acked: ['7:document-7', '8:document-8'],
      answer: async (
        message: DocumentContentCommand,
        tabId: number,
        documentId: string,
        state: FakeWorld,
      ): Promise<unknown> => {
        // Only the second target has drifted, so the first pass acknowledges two revisions.
        if (tabId === 8 && isEnforcementMessage(message) && message.runtimeRevision === 0) {
          staleAnswers += 1;
          return staleAnswer(message, state.now);
        }
        return defaultAnswer(message, tabId, documentId, state);
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(staleAnswers).toBe(1);
    expect(world.queries).toBe(4);
    expect(
      stable.documents.map((ack: DocumentEnforcementAck): number => ack.runtimeRevision),
    ).toEqual([STALE_RUNTIME_REVISION, STALE_RUNTIME_REVISION]);
  });

  it('retries a stable tab with no document ID and fails after the third pass', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({ documentIds: { 7: null } });

    const result: EnforcementPassResultV2 = await runEnforcementPassV2(world.ports, world.driver);

    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') expect(result.detail).toContain('3 target passes');
    expect(world.sent).toEqual([]);
    expect(MAX_TARGET_RESOLVER_PASSES).toBe(3);
    // one enumeration and one reread per pass, and no fourth pass
    expect(world.queries).toBe(6);
  });

  it('accepts a document ID that arrives on a later pass', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      documentIds: { 7: null },
      onQuery: (index: number, state: FakeWorld): void => {
        if (index === 3) state.documentIds = { 7: 'document-7' };
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(stable.documents).toHaveLength(1);
    expect(stable.documents[0]?.documentId).toBe('document-7');
  });
});

describe('runEnforcementPassV2 transport classification rows', () => {
  it('drops a target whose tab closed during the send', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      tabs: [
        { tabId: 7, url: 'https://example.com/path' },
        { tabId: 8, url: 'https://other.example/path' },
      ],
      documentIds: { 7: 'document-7', 8: 'document-8' },
      acked: ['7:document-7', '8:document-8'],
      answer: async (
        message: DocumentContentCommand,
        tabId: number,
        documentId: string,
        state: FakeWorld,
      ): Promise<unknown> => {
        if (tabId === 8) throw new Error('The tab was closed.');
        return defaultAnswer(message, tabId, documentId, state);
      },
      onQuery: (index: number, state: FakeWorld): void => {
        if (index === 2) state.tabs = [{ tabId: 7, url: 'https://example.com/path' }];
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(stable.documents.map((ack: DocumentEnforcementAck): number => ack.tabId)).toEqual([7]);
    expect(world.queries).toBe(2);
  });

  it('reevaluates a document that answers for another URL', async (): Promise<void> => {
    let navigated: boolean = false;
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      answer: async (
        message: DocumentContentCommand,
        tabId: number,
        documentId: string,
        state: FakeWorld,
      ): Promise<unknown> => {
        if (isEnforcementMessage(message) && !navigated) {
          navigated = true;
          return appliedAnswer({ ...message, expectedUrl: 'https://example.com/next' }, state.now);
        }
        return defaultAnswer(message, tabId, documentId, state);
      },
    });

    const stable: StablePassV2 = stableResult(
      await runEnforcementPassV2(world.ports, world.driver),
    );

    expect(world.queries).toBe(4);
    expect(stable.documents).toHaveLength(1);
    expect(stable.documents[0]?.url).toBe('https://example.com/path');
  });
});

describe('runEnforcementPassV2 fatal outcomes', () => {
  it('never downgrades an ordinary page that stays silent after the script is put in it', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      answer: async (message: DocumentContentCommand): Promise<unknown> => {
        if (isEnforcementMessage(message)) throw new Error('Receiving end does not exist.');
        return undefined;
      },
    });

    const result: EnforcementPassResultV2 = await runEnforcementPassV2(world.ports, world.driver);

    // Chrome allows the script, so silence is a page this session cannot enforce, and it is fatal.
    expect(world.injected).toEqual([7]);
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') expect(result.detail).toContain('7');
  });

  it('puts the script into a document that has none and enforces it', async (): Promise<void> => {
    let receiver: boolean = false;
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      scriptable: (_tabId: number, world: FakeWorld): 'ready' => {
        // Injecting is what gives this document its listener, which is the ordinary case for a
        // tab that was already open when the extension was installed or reloaded.
        receiver = true;
        void world;
        return 'ready';
      },
      answer: async (
        message: DocumentContentCommand,
        tabId: number,
        documentId: string,
        world: FakeWorld,
      ): Promise<unknown> => {
        if (isEnforcementMessage(message) && !receiver) {
          throw new Error('Receiving end does not exist.');
        }
        return await defaultAnswer(message, tabId, documentId, world);
      },
    });

    const result: EnforcementPassResultV2 = await runEnforcementPassV2(world.ports, world.driver);

    expect(world.injected).toEqual([7]);
    expect(result.kind).toBe('stable');
    if (result.kind === 'stable') expect(result.documents).toHaveLength(1);
  });

  it('excludes a document Chrome refuses to script instead of abandoning the sweep', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      tabs: [
        { tabId: 7, url: 'https://example.com/path' },
        { tabId: 8, url: 'https://dead.example/gone' },
      ],
      documentIds: { 7: 'document-7', 8: 'document-8' },
      acked: ['7:document-7', '8:document-8'],
      scriptable: (tabId: number): 'ready' | 'unscriptable' =>
        tabId === 8 ? 'unscriptable' : 'ready',
      answer: async (
        message: DocumentContentCommand,
        tabId: number,
        documentId: string,
        world: FakeWorld,
      ): Promise<unknown> => {
        if (isEnforcementMessage(message) && tabId === 8) {
          throw new Error('Receiving end does not exist.');
        }
        return await defaultAnswer(message, tabId, documentId, world);
      },
    });

    const result: EnforcementPassResultV2 = await runEnforcementPassV2(world.ports, world.driver);

    expect(result.kind).toBe('stable');
    if (result.kind !== 'stable') return;
    // The page Chrome will not let the extension into is recorded rather than enforced, and the
    // ordinary page beside it is still covered.
    expect(result.documents.map((ack: DocumentEnforcementAck): number => ack.tabId)).toEqual([7]);
    expect(result.exclusions).toEqual([
      {
        tabId: 8,
        documentId: 'document-8',
        url: 'https://dead.example/gone',
        reason: 'unscriptable',
      },
    ]);
    for (const exclusion of result.exclusions) {
      expect(validateDetachedEnforcementTargetExclusion(exclusion)).toBe(true);
    }
  });

  it('reports a mismatch answer with its detail', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      answer: async (): Promise<unknown> => ({ nonsense: true }),
    });

    const result: EnforcementPassResultV2 = await runEnforcementPassV2(world.ports, world.driver);

    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') {
      expect(result.detail).toContain('exact content enforcement response');
    }
  });

  it('fails when a replaced stale command is still refused', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      answer: async (
        message: DocumentContentCommand,
        _tabId: number,
        _documentId: string,
        state: FakeWorld,
      ): Promise<unknown> =>
        isEnforcementMessage(message) ? staleAnswer(message, state.now) : undefined,
    });

    const result: EnforcementPassResultV2 = await runEnforcementPassV2(world.ports, world.driver);

    expect(result.kind).toBe('unreachable');
  });

  it('fails when the epoch reset answers from another URL', async (): Promise<void> => {
    // The enforcement flow keeps spec 1343: a verdict is computed for one URL and must never be
    // applied to another, so URL drift here is fatal. Cleanup narrows this for its own resets,
    // which carry no verdict, and that narrowing must not reach this pass.
    const world: FakeWorld = makeWorld({
      answer: async (
        message: DocumentContentCommand,
        _tabId: number,
        _documentId: string,
        state: FakeWorld,
      ): Promise<unknown> => {
        if (isEnforcementMessage(message)) return appliedAnswer(message, state.now);
        return {
          version: 1,
          disposition: 'epoch-reset',
          operationId: message.operationId,
          enforcementEpoch: message.enforcementEpoch,
          documentId: message.documentId,
          observedUrl: 'https://facebook.com/feed/story',
          handledAt: state.now,
        };
      },
    });

    const result: EnforcementPassResultV2 = await runEnforcementPassV2(world.ports, world.driver);

    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') {
      expect(result.detail).toContain('observedUrl');
    }
    expect(world.recordedAcks).toEqual([]);
  });

  it('fails when the epoch handshake is rejected', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      answer: async (
        message: DocumentContentCommand,
        _tabId: number,
        _documentId: string,
        state: FakeWorld,
      ): Promise<unknown> => {
        if (isEnforcementMessage(message)) return appliedAnswer(message, state.now);
        return {
          version: 1,
          disposition: 'epoch-reset-rejected',
          operationId: message.operationId,
          enforcementEpoch: message.enforcementEpoch,
          currentEpoch: '30000000-0000-4000-8000-000000000002',
          reason: 'retired-epoch',
          documentId: message.documentId,
          observedUrl: message.expectedUrl,
          handledAt: state.now,
        };
      },
    });

    const result: EnforcementPassResultV2 = await runEnforcementPassV2(world.ports, world.driver);

    expect(result.kind).toBe('unreachable');
    expect(world.recordedAcks).toEqual([]);
  });
});

describe('freshnessBudgetPermitsV2', () => {
  it('permits only inside both bounds', () => {
    expect(MAX_FINAL_FRESHNESS_ATTEMPTS).toBe(3);
    expect(FINAL_FRESHNESS_TIMEOUT_MS).toBe(10_000);
    expect(freshnessBudgetPermitsV2(budget(), NOW)).toBe(true);
    expect(freshnessBudgetPermitsV2(budget({ freshnessAttempts: 2 }), NOW)).toBe(true);
    expect(freshnessBudgetPermitsV2(budget({ freshnessAttempts: 3 }), NOW)).toBe(false);
    expect(freshnessBudgetPermitsV2(budget({ freshnessAttempts: 4 }), NOW)).toBe(false);
    expect(freshnessBudgetPermitsV2(budget(), NOW + FINAL_FRESHNESS_TIMEOUT_MS - 1)).toBe(true);
    expect(freshnessBudgetPermitsV2(budget(), NOW + FINAL_FRESHNESS_TIMEOUT_MS)).toBe(false);
    expect(freshnessBudgetPermitsV2(budget(), NOW + FINAL_FRESHNESS_TIMEOUT_MS + 1)).toBe(false);
  });
});

describe('runFreshnessAttemptV2', () => {
  it('verifies two consecutive stable passes under one generation', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({ acked: ['7:document-7'] });

    const result: FreshnessAttemptResultV2 = await runFreshnessAttemptV2(
      world.ports,
      world.driver,
      budget(),
    );

    expect(result.kind).toBe('verified');
    if (result.kind === 'verified') {
      expect(result.generation).toBe(12);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]?.tabId).toBe(7);
      expect(result.exclusions).toEqual([]);
      expect(result.completedAt).toBe(NOW);
    }
    expect(world.sent).toHaveLength(2);
  });

  it('fails an attempt when the first pass ends on a different generation', async (): Promise<void> => {
    // reads: attempt start, first pass end.
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      generationScript: [12, 13],
    });

    const result: FreshnessAttemptResultV2 = await runFreshnessAttemptV2(
      world.ports,
      world.driver,
      budget(),
    );

    expect(result).toEqual({ kind: 'generation-changed' });
    expect(world.sent).toHaveLength(1);
  });

  it('fails an attempt when the generation moves between the two passes', async (): Promise<void> => {
    // reads: attempt start, first pass end, second pass start.
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      generationScript: [12, 12, 14],
    });

    const result: FreshnessAttemptResultV2 = await runFreshnessAttemptV2(
      world.ports,
      world.driver,
      budget(),
    );

    expect(result).toEqual({ kind: 'generation-changed' });
    expect(world.sent).toHaveLength(1);
  });

  it('fails an attempt when the second pass ends on a different generation', async (): Promise<void> => {
    // reads: attempt start, first pass end, second pass start, second pass end.
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      generationScript: [12, 12, 12, 15],
    });

    const result: FreshnessAttemptResultV2 = await runFreshnessAttemptV2(
      world.ports,
      world.driver,
      budget(),
    );

    expect(result).toEqual({ kind: 'generation-changed' });
    expect(world.sent).toHaveLength(2);
  });

  it('fails an attempt when the deadline arrives between passes', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({
      acked: ['7:document-7'],
      onQuery: (index: number, state: FakeWorld): void => {
        if (index === 2) state.now = NOW + FINAL_FRESHNESS_TIMEOUT_MS;
      },
    });

    const result: FreshnessAttemptResultV2 = await runFreshnessAttemptV2(
      world.ports,
      world.driver,
      budget(),
    );

    expect(result).toEqual({ kind: 'deadline' });
    expect(world.sent).toHaveLength(1);
  });

  it('refuses to begin an attempt the budget no longer permits', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({ acked: ['7:document-7'] });

    const exhausted: FreshnessAttemptResultV2 = await runFreshnessAttemptV2(
      world.ports,
      world.driver,
      budget({ freshnessAttempts: MAX_FINAL_FRESHNESS_ATTEMPTS }),
    );

    expect(exhausted).toEqual({ kind: 'deadline' });
    expect(world.queries).toBe(0);
    expect(world.sent).toEqual([]);
  });

  it('reports an unreachable pass with its detail', async (): Promise<void> => {
    const world: FakeWorld = makeWorld({ documentIds: { 7: null } });

    const result: FreshnessAttemptResultV2 = await runFreshnessAttemptV2(
      world.ports,
      world.driver,
      budget(),
    );

    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') expect(result.detail).toContain('document');
  });
});
