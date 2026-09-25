/**
 * The v2 enforcement seams every test that boots a real `Engine` has to supply. Three suites built
 * this block by hand, so it lives here once, parameterized where the copies genuinely differed:
 * how the transport answers, whether the alarms are remembered, and what the target generation
 * reads. Everything else is the same empty answer in all three.
 *
 * It is a test fixture and never a production builder. The cooperative transport echoes whatever
 * the controller froze, which is what a content script that applied a command sends back, so the
 * real response classifier decides the outcome and a test only scripts the deviation it cares
 * about.
 */

import type {
  AlarmNameV2,
  AlarmPortsV2,
  ScheduledAlarmV2,
} from '../../../src/background/alarms-v2';
import type { ContentTransportPortsV2 } from '../../../src/background/content-transport-v2';
import type { EnforcementTargetPortsV2 } from '../../../src/background/enforcement-targets-v2';
import type { EnginePorts } from '../../../src/background/engine';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import type { DailyAgg } from '../../../src/shared/types';

/**
 * How a document answers the command it was sent.
 *
 * - `cooperative`: it applied the command and echoes the tuple back, the answer a live content
 *   script gives.
 * - `silent`: it answers nothing, which is what a target with no content script does.
 */
export type EngineTransportModeV2 = 'cooperative' | 'silent';

export interface EngineSeamOptionsV2 {
  /** The clock the seams read, shared with the engine under test. */
  now: () => number;
  /** Defaults to `silent`, because most suites seed sessions rather than drive enforcement. */
  transport?: EngineTransportModeV2;
  /**
   * Every command the transport carried, in order, with the tab it was addressed to, for a suite
   * that asserts on what was sent and where it landed.
   */
  onCommand?: (command: DocumentContentCommand, tabId: number) => void;
  /** Remembers what the controller scheduled so `get` reads it back. Off by default. */
  rememberAlarms?: boolean;
  /** The tab generation a sweep compares against. Defaults to a fixed one. */
  readTargetGeneration?: () => number;
}

/**
 * The identity source a v2 harness must give `EnginePorts.newId`.
 *
 * Every identity the runtime parser accepts is a UUID: the enforcement epoch, the session, the
 * operations, the transition. A harness minting anything else produces a runtime the parser
 * refuses, and the refusal surfaces wherever the Engine next writes rather than where the bad
 * identity was minted. The worst case is the epoch, because the Engine mints a fresh one after an
 * all-data clear and hands it straight to `emptyRuntimeV2`.
 *
 * Each call returns a distinct UUID, so a suite can tell one minted identity from the next.
 */
export function uuidMinterV2(): () => string {
  let minted: number = 0;
  return (): string => {
    minted += 1;
    return `40000000-0000-4000-8000-${String(minted).padStart(12, '0')}`;
  };
}

/** The `EnginePorts` members the v2 enforcement seam owns. */
export type EngineSeamPortsV2 = Pick<
  EnginePorts,
  | 'alarms'
  | 'auditEnforcement'
  | 'clearBlockingForNonBlockingPhase'
  | 'loadAggregates'
  | 'reloadStoppedDocuments'
  | 'restoreTabClaims'
  | 'targets'
  | 'transport'
>;

/** The response a cooperative document gives for one command. */
function cooperativeResponse(message: DocumentContentCommand, handledAt: number): unknown {
  if (message.command === 'reset-enforcement-epoch') {
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

function alarmPortsV2(remember: boolean, now: () => number): AlarmPortsV2 {
  if (!remember) {
    return {
      create: (): Promise<void> => Promise.resolve(),
      createPeriodic: (): Promise<void> => Promise.resolve(),
      get: (): Promise<ScheduledAlarmV2 | null> => Promise.resolve(null),
      clear: (): Promise<void> => Promise.resolve(),
    };
  }
  const scheduled: Map<string, ScheduledAlarmV2> = new Map<string, ScheduledAlarmV2>();
  return {
    create: async (name: AlarmNameV2, when: number): Promise<void> => {
      scheduled.set(name, { scheduledTime: when, periodInMinutes: null });
    },
    createPeriodic: async (name: AlarmNameV2, periodInMinutes: number): Promise<void> => {
      scheduled.set(name, { scheduledTime: now(), periodInMinutes });
    },
    get: async (name: AlarmNameV2): Promise<ScheduledAlarmV2 | null> => scheduled.get(name) ?? null,
    clear: async (name: AlarmNameV2): Promise<void> => {
      scheduled.delete(name);
    },
  };
}

/** The v2 enforcement seams one `EnginePorts` needs, spread into whatever else a suite builds. */
export function engineSeamPortsV2(options: EngineSeamOptionsV2): EngineSeamPortsV2 {
  const now: () => number = options.now;
  const cooperative: boolean = options.transport === 'cooperative';
  const record: (command: DocumentContentCommand, tabId: number) => void =
    options.onCommand ?? ((): void => undefined);
  const targets: EnforcementTargetPortsV2 = {
    queryTopFrameTabs: (): Promise<Array<{ tabId: number; url: string | null }>> =>
      Promise.resolve([]),
    topFrameDocumentId: (): Promise<string | null> => Promise.resolve(null),
    readTargetGeneration: options.readTargetGeneration ?? ((): number => 1),
    now,
    ensureDocumentScript: (): Promise<'ready' | 'unscriptable'> => Promise.resolve('ready'),
  };
  const transport: ContentTransportPortsV2 = {
    sendToDocument: (
      tabId: number,
      _documentId: string,
      message: DocumentContentCommand,
    ): Promise<unknown> => {
      record(message, tabId);
      return Promise.resolve(cooperative ? cooperativeResponse(message, now()) : null);
    },
  };
  return {
    auditEnforcement: (): Promise<'ready'> => Promise.resolve('ready'),
    loadAggregates: (): Promise<Record<string, DailyAgg>> => Promise.resolve({}),
    // `EnginePorts` still declares this port, so the fake has to supply it, but nothing in the
    // worker reads it: the Engine builds the controller effect of the same name itself and clears
    // through `applyBlocking`. A resolved stub would let a reader reappear behind a green suite, so
    // this one fails instead of pretending the seam is live. See task-1-review-tests.md, I4.
    clearBlockingForNonBlockingPhase: (): Promise<void> => {
      throw new Error('EnginePorts.clearBlockingForNonBlockingPhase has no production reader');
    },
    restoreTabClaims: (): Promise<number[]> => Promise.resolve([]),
    reloadStoppedDocuments: (): Promise<void> => Promise.resolve(),
    targets,
    transport,
    alarms: alarmPortsV2(options.rememberAlarms === true, now),
  };
}
