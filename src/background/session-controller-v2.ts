/**
 * The public command surface. Every popup command, alarm, navigation, and tick enters here, is
 * serialized against every other one, and answers with an exact result code from the spec's table.
 * Nothing in this file decides a stage: each command validates what it is allowed to do, delegates
 * to the runner that owns the work, and publishes the projection the runner left durable.
 *
 * Three properties the whole file serves. Every command answers a code and never throws across the
 * message boundary, except the two the spec says must fail loudly. Nothing is published before
 * `recover()` has resolved this profile's one runtime authority, so an unrecovered migrated
 * projection is never observed by a page. And the two runner entry points are serialized here,
 * which is the precondition the transition runner documents.
 */

import { accrue } from '../core/budget';
import {
  advanceSessionV2,
  assertCanStartNextFocusEarlyV2,
  beginPauseV2,
  type SessionAdvanceResultV2,
} from '../core/session-v2';
import { cancelPhrase, GATE_EXPIRY_MS, pausePhrase, unlockSitePhrase } from '../shared/constants';
import type { DocumentContentCommand } from '../shared/enforcement-v2';
import { CoreError } from '../shared/errors';
import { exactDataEqual } from '../shared/exact-data';
import { t } from '../shared/i18n';
import type {
  CommandResponseV2,
  RetryCleanupResultCodeV2,
  SessionCommandResultCodeV2,
  SoundId,
  StartSessionResponseV2,
} from '../shared/messages';
import { localDateStr, localMidnightAfter } from '../shared/time';
import type {
  BankState,
  GateKind,
  GateSettings,
  GateState,
  PauseEconomy,
  SessionConfigV2,
  SessionEventRecordV2,
  SessionSnapshotV2,
  SessionStateV2,
  SettingsV2,
  SiteUnlock,
  Verdict,
} from '../shared/types';
import { canonicalUnlockHost } from '../shared/unlock-host';
import { ensurePhaseAlarmV2, parseAlarmNameV2 } from './alarms-v2';
import { documentCommandKeyV2 } from './cleanup-progress-v2';
import {
  type CleanupJournalV2,
  cleanupJournalOfV2,
  durableCleanupClearCommandV2,
  journalProgressV2,
} from './cleanup-shared-v2';
import { closureIdV2, manualEndReasonV2 } from './closure-projection-v2';
import {
  closeSessionV2,
  commitClosureV2,
  prepareClosureV2,
  retryClosureCleanupV2,
  runClosureCleanupAttemptV2,
} from './closure-runner-v2';
import {
  type DocumentCommandOutcomeV2,
  sendDocumentEnforcementCommand,
  sendEpochResetCommand,
} from './content-transport-v2';
import { documentEnforcementAckRecordV2 } from './enforcement-ack-records-v2';
import type {
  DocumentEnforcementAck,
  DocumentEnforcementAckRecord,
  DocumentEpochResetAck,
  EnforcementCheckpoint,
  EpochResetAckRecord,
  FrozenDocumentCommand,
} from './enforcement-persistence-v2';
import { classifyEnforcementTargetV2, type TargetClassificationV2 } from './enforcement-targets-v2';
import { epochResetAckRecordV2, withoutTabEpochResetAcksV2 } from './epoch-reset-acks-v2';
import { buildSessionSnapshotV2 } from './lifecycle-projection-v2';
import {
  buildActiveOverlayView,
  buildFrozenDocumentCommandV2,
  buildFrozenEpochResetCommandV2,
} from './overlay-view-v2';
import { recoverRuntimeV2 } from './recovery-v2';
import { carryCommitCheckpointProjectionV2, projectRuntimeDomainV2 } from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type { RuntimeStateV2, SessionStartCandidate } from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';
import {
  nextScheduleInfoV2,
  pruneHandledOccurrencesOnTickV2,
  runScheduleCheckV2,
  type ScheduleRunnerPortsV2,
} from './schedule-runner-v2';
import {
  type CleanupEffectPortsV2,
  enterTransitionCleanupV2,
  handleCleanupNavigationV2,
  retryTransitionCleanupV2,
  runTransitionCleanupAttemptV2,
} from './transition-cleanup-v2';
import {
  driveTransitionV2,
  handleTransitionNavigationV2,
  type PreparedTransitionV2,
  prepareResumeTransitionV2,
  prepareStartTransitionV2,
  refreezeTransitionViewV2,
  type TransitionDriveResultV2,
  transitionMatcherV2,
} from './transition-runner-v2';

/** One settle's earnings: the advanced runtime, the bank it produced, and the event it reports. */
interface SettledEarningsV2 {
  runtime: RuntimeStateV2;
  bank: BankState | undefined;
  events: SessionEventRecordV2[];
}

/**
 * Whether the caller of `documentCommandsFor` sends the commands to the document. Only a delivering
 * caller may take the epoch reset, because taking it is what records the acknowledgement, and a
 * caller that reads the answer and drops it applies nothing. Reading is the default, so a new
 * caller cannot consume a reset it never delivers by forgetting to say so.
 */
export type DocumentCommandDeliveryV2 = 'deliver' | 'read';

/** What one document-command call decides inside the queue, before the attempt write runs. */
interface PreparedDocumentCommandsV2 {
  commands: DocumentContentCommand[];
  blocked: boolean;
}

/** The transport's answer for each command one batch sent, keyed by document. Unsent ones are absent. */
type DocumentDeliveryOutcomesV2 = ReadonlyMap<string, DocumentCommandOutcomeV2>;

export interface SessionControllerEffectsV2 extends CleanupEffectPortsV2 {
  broadcast(snapshot: SessionSnapshotV2): void;
  updateBadge(snapshot: SessionSnapshotV2): void;
  playSound(sound: SoundId): void;
  notify(title: string, body: string): void;
  /** The existing serialized tab engine clear, for a phase that blocks nothing. */
  clearBlockingForNonBlockingPhase(): Promise<void>;
  /** The existing `Engine.recordAttempt`, which owns `ATTEMPT_DEBOUNCE_MS` and the attempt event. */
  recordAttempt(url: string, tabId: number, kind: 'navigation' | 'existing'): Promise<void>;
  /**
   * The existing `Engine.markStopped`, which owns the tab claim. It is taken before the view that
   * stops the page is frozen, because the view reads the claim to explain itself.
   */
  markStoppedPage(tabId: number, url: string, documentId: string): Promise<void>;
}

// Precondition the cutover must satisfy before any v2 producer runs: the retained Engine appends its
// events through appendEventsV2, never through the v1 stores.appendEvents path, because the v1
// writer re-parses the whole LOCAL_EVENTS log through parseEventRecord, which drops v2 records and
// rebuilds legacy records. The cutover deletes stores.appendEvents, performAppendEvents, and
// readEvents.

type CommandResultV2 = CommandResponseV2<SessionCommandResultCodeV2>;
type RetryResultV2 = CommandResponseV2<RetryCleanupResultCodeV2>;

const OK: { ok: true; code: 'ok' } = { ok: true, code: 'ok' };

export class SessionControllerV2 {
  private queue: Promise<unknown> = Promise.resolve();
  private recovered: boolean = false;
  /** Set when a prepared closure write failed, so projection reports the closure it owes. */
  private closurePending: boolean = false;
  private pendingReason: 'website-access-lost' | 'content-registration-failed' | null = null;

  constructor(
    private readonly ports: RuntimePortsV2,
    private readonly schedule: ScheduleRunnerPortsV2,
    private readonly effects: SessionControllerEffectsV2,
  ) {}

  /**
   * The public read model at one instant. Pure: it writes nothing and publishes nothing, and the
   * core state is settled through `at` in memory first (spec 358).
   */
  snapshot(at: number): SessionSnapshotV2 {
    const durable: RuntimeStateV2 = this.ports.runtime();
    const read: SettledReadV2 = settledForReadV2(durable, at);
    const runtime: RuntimeStateV2 = read.runtime;
    const settings: SettingsV2 = this.schedule.settings();
    const base: SessionSnapshotV2 = buildSessionSnapshotV2({
      runtime,
      settings,
      bank: this.readBank(durable, at),
      at,
      nextSchedule: nextScheduleInfoV2(settings.schedule, runtime.handledScheduleOccurrences, at),
    });
    // A closure this worker owes, or one the settle just found owing because the session ran out
    // its own clock, is already the truth for the user. Both are reported as the cleanup they will
    // become rather than as the session that is still durable, and the id comes from that durable
    // session rather than the settled read, which no longer carries it.
    // A durable transition cleanup is not a closure and must not be reported as one: the
    // projection already describes it exactly, as a transition cleanup while its batch has
    // attempts left and as the transition error with its retry once the batch is spent. Overriding
    // that would name a closure no runtime row backs, hide the error and the retry the person
    // could act on, and offer a closure retry that answers `retry-not-available`.
    const transitionOwns: boolean = durable.pendingEnforcementTransition?.stage === 'cleanup';
    const owing: boolean = !transitionOwns && (this.closurePending || read.closureOwed);
    const owed: string | null = owing ? (durable.session?.sessionId ?? null) : null;
    return owed === null ? base : owedClosureSnapshot(base, owed);
  }

  hasActiveSession(): boolean {
    return this.ports.runtime().session !== null;
  }

  /**
   * The bank as `at` observes it. The read settles the core state through `at`, and the bank is
   * what settled focus earns, so it is reported at the same instant. The durable balance still
   * moves only when a settle writes, which is what a spend transacts against.
   */
  private readBank(durable: RuntimeStateV2, at: number): BankState {
    const bank: BankState = this.ports.bank();
    const session: SessionStateV2 | null = durable.session;
    if (session === null) return bank;
    const focused: number = advanceSessionV2(session, at).sessionFocusedMs;
    const delta: number = Math.max(0, focused - durable.accruedFocusMs);
    return delta === 0 ? bank : accrue(bank, delta, this.ports.economy());
  }

  /** Resolves the durable authority once, then allows publication. */
  async recover(): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      await recoverRuntimeV2(this.ports, this.effects);
      this.recovered = true;
      this.publish();
    });
  }

  /**
   * Periodic maintenance. It settles the durable session through now, expires the gate and
   * unlocks, prunes handled records, retries a due cleanup, runs the schedule check, and publishes.
   * A `tick` is never proof that a retry alarm exists, so the due journal is read from storage.
   */
  async tick(): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      await this.retryOwedClosure();
      await this.rollLocalDate();
      await this.settleThroughNow();
      await this.runDueCleanup();
      await this.runScheduleCheck();
      this.publish();
    });
  }

  /**
   * One schedule check on the queue the tick uses. The boot and a schedule settings write both run
   * it, so a window that is already open starts its session then rather than a tick later.
   */
  async checkSchedule(): Promise<void> {
    await this.enqueue((): Promise<void> => this.runScheduleCheck());
  }

  /** Routes one alarm to the owner named by its name. An unknown name is ignored. */
  async handleAlarm(name: string): Promise<void> {
    switch (parseAlarmNameV2(name)) {
      case 'tick':
        await this.tick();
        return;
      case 'phase':
        await this.enqueue(async (): Promise<void> => {
          await this.settleThroughNow();
          this.publish();
        });
        return;
      case 'transition-cleanup':
        await this.enqueue((): Promise<void> => this.runTransitionCleanupIfOwned());
        return;
      case 'closure-cleanup':
        await this.enqueue((): Promise<void> => this.runClosureCleanupIfOwned());
        return;
      default:
        return;
    }
  }

  /** Prepares and drives a manual start, answering the exact start code. */
  async startSession(config: SessionConfigV2): Promise<StartSessionResponseV2> {
    return this.enqueue(async (): Promise<StartSessionResponseV2> => {
      const journal: StartSessionResponseV2 | null = this.journalRejection();
      if (journal !== null) return journal;
      // A session that cannot block anything is not a session. Command admission belongs to the
      // controller, and the transition's audit cannot stand in for this: that audit asks the
      // browser about permissions, not whether this profile finished setting blocking up. The
      // refusal comes before anything is prepared, so no journal is written for it.
      if (!this.schedule.websiteBlockingReady()) {
        return { ok: false, code: 'invalid-request', error: 'invalid-request' };
      }
      let prepared: PreparedTransitionV2;
      try {
        prepared = await prepareStartTransitionV2(this.ports, candidateFor(config), 'manual');
      } catch {
        return { ok: false, code: 'invalid-request', error: 'invalid-request' };
      }
      const driven: TransitionDriveResultV2 = await driveTransitionV2(this.ports, prepared.matcher);
      if (driven.kind === 'published') {
        this.publish();
        return OK;
      }
      return this.startFailure();
    });
  }

  /** A Flexible End, on a published session or a committed transition. */
  async requestSessionEnd(): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const runtime: RuntimeStateV2 = this.ports.runtime();
      const session: SessionStateV2 | null = runtime.session;
      if (runtime.pendingClosure !== null) return failure('no-active-session');
      if (session === null) return failure('no-active-session');
      if (this.inTransitionCleanup()) return failure('transition-cleanup-pending');
      if (session.config.strictness !== 'flexible') return failure('end-not-allowed');
      await this.closeActiveSession(session, this.ports.now());
      return OK;
    });
  }

  /** Friction only: opens and persists the cancel gate, then refreshes every live view. */
  async openEndGate(): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const session: SessionStateV2 | null = this.ports.runtime().session;
      const guard: CommandResultV2 | null = this.endFamilyGuard(session);
      if (guard !== null) return guard;
      if (session === null || session.config.strictness !== 'friction') {
        return failure('end-not-allowed');
      }
      const gate: GateState | null = this.ports.runtime().gate;
      if (gate !== null) return gate.kind === 'cancel' ? OK : failure('end-not-allowed');
      // The bypass is minted here, from the setting as it stands when the gate opens, so a
      // setting toggled later neither offers nor revokes the button on a gate already open.
      const settings: GateSettings = this.ports.gateSettings();
      await this.commitLiveGate(
        {
          kind: 'cancel',
          host: null,
          openedAt: this.ports.now(),
          readyAt: this.ports.now() + settings.delayMs,
          requiredPhrase: settings.requireTypedPhrase
            ? cancelPhrase(session.config.intention)
            : null,
          forceEndAvailable: settings.allowForceEnd,
        },
        this.gateEvent('gateOpened', 'cancel', session),
      );
      return OK;
    });
  }

  /** Opens a pause or unlock gate, which the confirmation then spends the bank on. */
  async openGate(gate: 'pause' | 'unlockSite', host: string | null): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      // The affordability rule reads the durable balance, so the focus earned since the last
      // settle is credited first. Otherwise a gate the user has earned is refused until the tick.
      await this.settleThroughNow();
      const session: SessionStateV2 | null = this.ports.runtime().session;
      const guard: CommandResultV2 | null = this.gateGuard(session);
      if (guard !== null) return guard;
      if (session === null || session.phase !== 'focus') return failure('no-active-session');
      // A pause changes the phase and an unlock changes the economy, both of which a running
      // transition owns until it publishes, so neither gate opens while one is durable.
      if (this.ports.runtime().pendingEnforcementTransition !== null) {
        return failure('end-not-allowed');
      }
      const unlockHost: string | null = gate === 'unlockSite' ? canonicalUnlockHost(host) : null;
      if (gate === 'unlockSite' && unlockHost === null) {
        return failure('end-not-allowed');
      }
      // A gate the user cannot afford is not opened at all, which is what the v1 economy did: the
      // deliberation exists to spend a balance that is already there.
      const economy: PauseEconomy = this.ports.economy();
      const cost: number = gate === 'pause' ? economy.pauseMs : economy.unlockMs;
      if (this.ports.bank().balanceMs < cost) return failure('end-not-allowed');
      const previous: GateState | null = this.ports.runtime().gate;
      if (previous !== null) {
        if (previous.kind !== 'unlockSite' || gate !== 'unlockSite')
          return failure('end-not-allowed');
        if (canonicalUnlockHost(previous.host) === unlockHost) return OK;
      }
      const openedAt: number = Math.max(
        this.ports.now(),
        previous === null ? 0 : previous.openedAt + 1,
      );
      await this.commitLiveGate(
        {
          kind: gate,
          host: unlockHost,
          openedAt,
          readyAt: openedAt + this.ports.gateSettings().delayMs,
          requiredPhrase: this.gatePhrase(gate, unlockHost),
          forceEndAvailable: false,
        },
        [
          ...(previous === null ? [] : this.gateEvent('gateResisted', previous.kind, session)),
          ...this.gateEvent('gateOpened', gate, session),
        ],
      );
      return OK;
    });
  }

  /** Clears the gate, records the resistance, and refreshes the live views. */
  async abandonGate(expectedGate?: GateState): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const guard: CommandResultV2 | null = this.gateGuard(this.ports.runtime().session);
      if (guard !== null) return guard;
      const open: GateState | null = this.ports.runtime().gate;
      if (open === null) return failure('no-active-gate');
      if (expectedGate !== undefined && !exactDataEqual(open, expectedGate))
        return failure('no-active-gate');
      await this.commitLiveGate(
        null,
        this.gateEvent('gateResisted', open.kind, this.ports.runtime().session),
      );
      return OK;
    });
  }

  /** The phrase a gate demands, or null when the settings do not ask for one. */
  private gatePhrase(gate: 'pause' | 'unlockSite', host: string | null): string | null {
    if (!this.ports.gateSettings().requireTypedPhrase) return null;
    if (gate === 'pause') return pausePhrase();
    return host === null ? null : unlockSitePhrase(host);
  }

  /** Spends a ready gate. The cancel gate closes the session, the others buy their relief. */
  async confirmGate(
    typedPhrase: string | null,
    expectedGate?: GateState,
  ): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      if (expectedGate !== undefined && !exactDataEqual(this.ports.runtime().gate, expectedGate)) {
        return failure('no-active-gate');
      }
      // A spend is a durable transaction against the bank, so the focus earned since the last
      // settle is credited before the balance is read. The tick is a minute apart, and a user who
      // just earned a pause may not be refused it because nothing has settled yet.
      await this.settleThroughNow();
      const runtime: RuntimeStateV2 = this.ports.runtime();
      const gate: GateState | null = runtime.gate;
      const session: SessionStateV2 | null = runtime.session;
      if (this.inTransitionCleanup()) return failure('transition-cleanup-pending');
      if (runtime.pendingClosure !== null) return failure('closure-cleanup-pending');
      if (gate === null || session === null) return failure('no-active-gate');
      if (expectedGate !== undefined && !exactDataEqual(gate, expectedGate))
        return failure('no-active-gate');
      if (this.ports.now() < gate.readyAt) return failure('gate-not-ready');
      if (gate.requiredPhrase !== null && typedPhrase !== gate.requiredPhrase) {
        return failure('confirmation-mismatch');
      }
      if (gate.kind === 'cancel') {
        await this.closeActiveSession(session, this.ports.now());
        return OK;
      }
      return this.spendGate(gate, session);
    });
  }

  /**
   * The opt-in bypass of the cancel gate: ends a Friction session at once, skipping `readyAt` and
   * the typed phrase. It needs an open cancel gate on a Friction session, the live setting on, and
   * the flag the worker minted when that gate opened. Anything else is refused, and a pause or
   * unlock gate is refused outright because the bypass only ever ends a session.
   */
  async forceEndGate(): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const runtime: RuntimeStateV2 = this.ports.runtime();
      const session: SessionStateV2 | null = runtime.session;
      const guard: CommandResultV2 | null = this.endFamilyGuard(session);
      if (guard !== null) return guard;
      const gate: GateState | null = runtime.gate;
      if (gate === null) return failure('no-active-gate');
      if (gate.kind !== 'cancel') return failure('end-not-allowed');
      if (session === null || session.config.strictness !== 'friction') {
        return failure('end-not-allowed');
      }
      if (!this.ports.gateSettings().allowForceEnd || !gate.forceEndAvailable) {
        return failure('end-not-allowed');
      }
      await this.closeActiveSession(session, this.ports.now());
      return OK;
    });
  }

  /** A manual resume of a durable pause. */
  async resumeFromPause(): Promise<CommandResultV2> {
    return this.command((): Promise<CommandResultV2> => this.driveResume('manual', 'paused'));
  }

  /** An early end to a break, which the core validates before the transition is prepared. */
  async startNextFocusEarly(): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const session: SessionStateV2 | null = this.ports.runtime().session;
      // A live journal answers before the core rule does, so the popup reports the cleanup that is
      // actually blocking the command rather than the break rule underneath it.
      const guard: CommandResultV2 | null = this.gateGuard(session);
      if (guard !== null) return guard;
      if (session === null) return failure('no-active-session');
      try {
        assertCanStartNextFocusEarlyV2(session, this.ports.now());
      } catch {
        return failure('end-not-allowed');
      }
      return this.driveResume('break-expired', 'break');
    });
  }

  async retryTransitionCleanup(): Promise<RetryResultV2> {
    return this.enqueue(async (): Promise<RetryResultV2> => {
      const { code }: { code: RetryCleanupResultCodeV2 } = await retryTransitionCleanupV2(
        this.ports,
      );
      if (code !== 'ok') return { ok: false, code, error: code };
      await this.runTransitionCleanupIfOwned();
      return OK;
    });
  }

  async retryClosureCleanup(): Promise<RetryResultV2> {
    return this.enqueue(async (): Promise<RetryResultV2> => {
      const { code }: { code: RetryCleanupResultCodeV2 } = await retryClosureCleanupV2(this.ports);
      if (code !== 'ok') return { ok: false, code, error: code };
      await this.runClosureCleanupIfOwned();
      return OK;
    });
  }

  /**
   * Enforcement was lost under a live session, so it closes with that reason. A failed prepared
   * write leaves the session durable and raises the pending flag, which projection then reports.
   */
  async endForEnforcementLoss(
    reason: 'website-access-lost' | 'content-registration-failed',
  ): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      const session: SessionStateV2 | null = this.ports.runtime().session;
      if (session === null) return;
      try {
        await prepareClosureV2(this.ports, { endedAt: this.ports.now(), reason });
        this.closurePending = false;
        await this.finishOwedClosure();
      } catch (error: unknown) {
        // The prepared write is the one that must be durable. Until it is, the session stays
        // durable, the projection reports the closure, and every tick and command tries again.
        this.closurePending = true;
        this.pendingReason = reason;
        this.ports.reportError(error);
        await this.clearReachableDocuments();
      }
      this.publish();
    });
  }

  /** One navigation, routed by whatever durable authority currently owns the target. */
  async handleNavigation(
    target: { tabId: number; documentId: string; url: string },
    attemptKind: 'navigation' | 'existing' | null,
  ): Promise<void> {
    const blocked: boolean = await this.enqueue(async (): Promise<boolean> => {
      const enforceable: TargetClassificationV2 = classifyEnforcementTargetV2(
        target.tabId,
        target.url,
        target.documentId,
      );
      if (enforceable.kind !== 'enforceable') return false;
      const runtime: RuntimeStateV2 = this.ports.runtime();
      if (runtime.pendingEnforcementTransition !== null) {
        await handleTransitionNavigationV2(this.ports, transitionMatcherV2(this.ports), target);
      } else if (runtime.pendingClosure !== null) {
        await handleCleanupNavigationV2(this.ports, target);
      } else if (!this.idleRuntimeOwesNothing(target)) {
        await this.sendCurrentCommands(target, attemptKind !== null);
      }
      return this.blockedNow(target);
    });
    // Outside the queue, for the reason `documentCommandsFor` states.
    await this.recordAttemptIfBlocked(blocked, target, attemptKind);
  }

  /**
   * The commands one document must apply, newest persisted values only. The reset comes first when
   * the document has not acknowledged the current epoch, so it can accept what follows.
   */
  async documentCommandsFor(
    target: { tabId: number; documentId: string; url: string },
    attemptKind: 'navigation' | 'existing' | null,
    delivery: DocumentCommandDeliveryV2 = 'read',
  ): Promise<DocumentContentCommand[]> {
    const prepared: PreparedDocumentCommandsV2 = await this.enqueue(
      async (): Promise<PreparedDocumentCommandsV2> => {
        const enforceable: TargetClassificationV2 = classifyEnforcementTargetV2(
          target.tabId,
          target.url,
          target.documentId,
        );
        if (enforceable.kind !== 'enforceable') return { commands: [], blocked: false };
        // The claim comes first, because the view is frozen from the runtime that holds it. A
        // page whose load this answer stops would otherwise render the blocked overlay with
        // nothing on it saying why, until some later refresh happened to rebuild the view.
        if (delivery === 'deliver' && attemptKind === 'navigation') {
          await this.claimStoppedPage(target);
        }
        const command: FrozenDocumentCommand | null = await this.pulledCommandFor(
          target,
          attemptKind,
        );
        if (command === null) return { commands: [], blocked: this.blockedNow(target) };
        const commands: DocumentContentCommand[] = [];
        // The reset is handed over only to a caller that delivers the array. An acknowledgement
        // records what a document applied, and a caller that reads the answer and drops it applies
        // nothing: minting one there consumes the reset the next push still owes this document.
        if (delivery === 'deliver' && !this.hasCurrentEpochAck(target.tabId, target.documentId)) {
          commands.push(wireOf(await this.handOverEpochReset(target)));
        }
        commands.push(wireOf(command));
        return { commands, blocked: this.blockedNow(target) };
      },
    );
    // The attempt write is settled after the queue is released. It commits, a commit with blocking
    // work pending sweeps, and a sweep asks this controller for every target it finds, so holding
    // the queue across the write would leave it waiting for itself.
    await this.recordAttemptIfBlocked(prepared.blocked, target, attemptKind);
    return prepared.commands;
  }

  /**
   * Re-freezes every current document under a new operation and a higher runtime revision, then
   * sends them. It never touches the base-policy checkpoint, so a live change is invisible to
   * verification identity.
   */
  async refreshLiveViews(): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      const runtime: RuntimeStateV2 = this.ports.runtime();
      // A durable cleanup batch owns the command map and the revision that names it, which is why
      // the settle persist refuses the live commit for the same state. Without the same refusal
      // here every alarm and every sweeping command threw for the life of the journal, and the
      // browser-effect sweep behind the refresh was skipped with it.
      if (cleanupOwnsViewsV2(runtime)) return;
      await this.commitLiveViews(runtime);
    });
  }

  /**
   * Records one exact applied acknowledgement. Only the enforcement checkpoint carries per-target
   * records (spec 734: the applied response, wrapped with the worker-owned tab ID, is what enters
   * it), so a matching ack updates that target's record in place through a checkpoint-preserving
   * write. An ack for another epoch, another operation, another revision, or a document the
   * checkpoint does not name is dropped: the runners own operation-time acknowledgement, and this
   * path never invents a record the checkpoint did not already have.
   */
  async recordDocumentAck(ack: DocumentEnforcementAck): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      const runtime: RuntimeStateV2 = this.ports.runtime();
      const checkpoint: EnforcementCheckpoint | null = runtime.enforcementCheckpoint;
      const key: string = documentCommandKeyV2(ack.tabId, ack.documentId);
      const command: FrozenDocumentCommand | undefined = runtime.documentCommands[key];
      if (
        checkpoint === null ||
        command === undefined ||
        ack.enforcementEpoch !== runtime.enforcementEpoch ||
        command.operationId !== ack.operationId ||
        command.runtimeRevision !== ack.runtimeRevision ||
        checkpoint.operationId !== ack.operationId
      ) {
        return;
      }
      // A target the checkpoint never verified gains no record here: the runners own which
      // documents one operation acknowledged, and this path only refreshes what they wrote.
      const named: boolean = checkpoint.documents.some(
        (stored: DocumentEnforcementAckRecord): boolean =>
          stored.tabId === ack.tabId && stored.documentId === ack.documentId,
      );
      if (!named) return;
      const documents: DocumentEnforcementAckRecord[] = checkpoint.documents.map(
        (stored: DocumentEnforcementAckRecord): DocumentEnforcementAckRecord =>
          stored.tabId === ack.tabId && stored.documentId === ack.documentId
            ? documentEnforcementAckRecordV2(ack)
            : structuredClone(stored),
      );
      await this.write({
        ...structuredClone(runtime),
        enforcementCheckpoint: { ...structuredClone(checkpoint), documents },
      });
    });
  }

  /**
   * Drops the acknowledgement records of a tab the browser closed. Its documents are gone, the
   * back-forward cache included, so nothing will ask whether they acknowledged an epoch again, and
   * a record kept past that is a closed tab the runtime still remembers. The command map is left
   * alone: a cleanup batch or a transition view owns it while a journal lasts, and a session's
   * live refresh refreezes whatever it holds.
   */
  async forgetTab(tabId: number): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      const runtime: RuntimeStateV2 = this.ports.runtime();
      const epochResetAcks: Record<string, EpochResetAckRecord> = withoutTabEpochResetAcksV2(
        runtime.epochResetAcks,
        tabId,
      );
      if (Object.keys(epochResetAcks).length === Object.keys(runtime.epochResetAcks).length) return;
      await this.write({ ...structuredClone(runtime), epochResetAcks });
    });
  }

  /** One queue for every entry point, which is what serializes the runners against each other. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next: Promise<T> = this.queue.then(work, work);
    this.queue = next.then(
      (): void => undefined,
      (): void => undefined,
    );
    return next;
  }

  /** Wraps one command so a runner error becomes a code rather than a rejected message. */
  private command(work: () => Promise<CommandResultV2>): Promise<CommandResultV2> {
    return this.enqueue(async (): Promise<CommandResultV2> => {
      try {
        await this.retryOwedClosure();
        return await work();
      } catch (error: unknown) {
        // Only a genuine missing session becomes a code. Everything else propagates, because the
        // brief requires a failed durable closure write to keep the session active and throw, so
        // the router rejects the message and the popup can offer the retry.
        if (error instanceof CoreError && this.ports.runtime().session === null) {
          this.ports.reportError(error);
          return failure('no-active-session');
        }
        throw error;
      }
    });
  }

  private publish(): void {
    if (!this.recovered) return;
    const snapshot: SessionSnapshotV2 = this.snapshot(this.ports.now());
    this.effects.broadcast(snapshot);
    this.effects.updateBadge(snapshot);
  }

  /** The start rejection a journal forces, before anything is reserved. */
  private journalRejection(): StartSessionResponseV2 | null {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    if (runtime.pendingEnforcementTransition !== null) {
      return {
        ok: false,
        code: 'transition-cleanup-pending',
        error: 'transition-cleanup-pending',
      };
    }
    if (runtime.pendingClosure !== null) {
      return { ok: false, code: 'closure-cleanup-pending', error: 'closure-cleanup-pending' };
    }
    return null;
  }

  /**
   * A start that entered cleanup answers the failure that caused it. Cleanup runs to its resolution
   * inside the command whenever it can, so `cleanupPending` is true only for a journal that is
   * still durable once the attempt has had its turn.
   */
  private async startFailure(): Promise<StartSessionResponseV2> {
    const failed: string | null =
      this.ports.runtime().pendingEnforcementTransition?.failure ?? null;
    await this.runTransitionCleanupIfOwned();
    const pending: boolean = this.ports.runtime().pendingEnforcementTransition !== null;
    const code: StartSessionResponseV2['code'] = isFailureReason(failed)
      ? failed
      : 'tab-enforcement-failed';
    this.publish();
    return pending
      ? { ok: false, code, error: code, cleanupPending: true }
      : { ok: false, code, error: code };
  }

  private inTransitionCleanup(): boolean {
    return this.ports.runtime().pendingEnforcementTransition?.stage === 'cleanup';
  }

  /**
   * The journal guards an End command answers, per spec 1170: a session already closing is no
   * active session, which is what `requestSessionEnd` answers for the same state. Opening the
   * cancel gate is the Friction spelling of End, so the two agree rather than diverging on a race
   * only a stray message can reach. A pause or unlock gate is not an End and keeps `gateGuard`.
   */
  private endFamilyGuard(session: SessionStateV2 | null): CommandResultV2 | null {
    if (this.inTransitionCleanup()) return failure('transition-cleanup-pending');
    if (this.ports.runtime().pendingClosure !== null) return failure('no-active-session');
    if (session === null) return failure('no-active-session');
    return null;
  }

  /** The journal guards every gate command shares. Only Hard refuses End (spec 1021). */
  private gateGuard(session: SessionStateV2 | null): CommandResultV2 | null {
    if (this.inTransitionCleanup()) return failure('transition-cleanup-pending');
    if (this.ports.runtime().pendingClosure !== null) return failure('closure-cleanup-pending');
    if (session === null) return failure('no-active-session');
    return null;
  }

  /** Closes a published session, or hands a committed transition its manual end. */
  private async closeActiveSession(session: SessionStateV2, endedAt: number): Promise<void> {
    if (this.ports.runtime().pendingEnforcementTransition !== null) {
      await enterTransitionCleanupV2(this.ports, { cause: 'manual-end', failure: null, endedAt });
      await this.runTransitionCleanupIfOwned();
    } else {
      await closeSessionV2(this.ports, this.effects, {
        endedAt,
        reason: manualEndReasonV2(session.config.duration),
      });
    }
    this.publish();
  }

  /** Persists one gate value and refreshes every live view under a fresh operation. */
  private async commitLiveGate(
    gate: GateState | null,
    events: SessionEventRecordV2[],
    bank?: BankState,
  ): Promise<void> {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    await this.commitLiveViews(
      { ...structuredClone(runtime), gate: structuredClone(gate) },
      events,
      bank,
    );
  }

  /** The legacy gate event one gate command records, tagged with the session that owns it. */
  private gateEvent(
    t: 'gateOpened' | 'gateResisted',
    gate: GateKind,
    session: SessionStateV2 | null,
  ): SessionEventRecordV2[] {
    return [
      {
        t,
        at: this.ports.now(),
        gate,
        ...(session === null ? {} : { sessionId: session.sessionId }),
      },
    ];
  }

  /**
   * One durable live update: a higher runtime revision, a complete replacement command for every
   * current document under one fresh operation, and then the sends. The base-policy checkpoint is
   * carried through untouched.
   */
  private async commitLiveViews(
    base: RuntimeStateV2,
    events: SessionEventRecordV2[] = [],
    bank?: BankState,
  ): Promise<DocumentDeliveryOutcomesV2> {
    if (base.pendingEnforcementTransition !== null) {
      // A running transition owns its frozen view, so the runner refreezes it under the new tuple
      // and the verification budget is left exactly as it was.
      await refreezeTransitionViewV2(this.ports, transitionMatcherV2(this.ports), base);
      // The refreeze writes the runtime, not the journal, so a gate event or a spend needs its own
      // checkpoint over the row the refreeze just left. It replays that row unchanged.
      if (events.length > 0 || bank !== undefined) await this.commitLive(events, bank);
      // Spec 1021: the restarted pass reissues the replacement view. The runner already stepped the
      // stage back off any checkpoint the refreeze invalidated and carried the attempt count and
      // the ten-second deadline through, so the pass that reads this row resumes on what is left of
      // the original budget rather than a fresh one.
      const outcomes: DocumentDeliveryOutcomesV2 = await this.deliverBatch(
        Object.values(this.ports.runtime().documentCommands),
      );
      this.publish();
      return outcomes;
    }
    const session: SessionStateV2 | null = base.session;
    const runtimeRevision: number = base.runtimeRevision + 1;
    const operationId: string = this.ports.newId();
    const documentCommands: Record<string, FrozenDocumentCommand> = {};
    for (const [key, command] of Object.entries(base.documentCommands)) {
      documentCommands[key] = this.freezeLiveCommand(base, session, command, {
        operationId,
        runtimeRevision,
      });
    }
    const next: RuntimeStateV2 = validRuntime(
      carryCommitCheckpointProjectionV2({ ...base, runtimeRevision, documentCommands }),
    );
    await this.ports.commit({
      checkpointId: `${next.enforcementEpoch}:live-${runtimeRevision}`,
      projection: projectRuntimeDomainV2(next),
      bank: bank ?? this.ports.bank(),
      events: structuredClone(events),
      syncBank: bank !== undefined,
      aggregateSets: {},
      aggregateRemoves: [],
    });
    const outcomes: DocumentDeliveryOutcomesV2 = await this.deliverBatch(
      Object.values(documentCommands),
    );
    this.publish();
    return outcomes;
  }

  /** One checkpoint over the current durable row, for the events and the charge it carries. */
  private async commitLive(events: SessionEventRecordV2[], bank?: BankState): Promise<void> {
    const current: RuntimeStateV2 = this.ports.runtime();
    await this.ports.commit({
      checkpointId: `${current.enforcementEpoch}:live-${current.runtimeRevision}`,
      projection: projectRuntimeDomainV2(current),
      bank: bank ?? this.ports.bank(),
      events: structuredClone(events),
      syncBank: bank !== undefined,
      aggregateSets: {},
      aggregateRemoves: [],
    });
  }

  /** One replacement command for a live update, at the same target and the new tuple. */
  private freezeLiveCommand(
    runtime: RuntimeStateV2,
    session: SessionStateV2 | null,
    previous: FrozenDocumentCommand,
    tuple: { operationId: string; runtimeRevision: number },
  ): FrozenDocumentCommand {
    // The unlocks and the matcher move under a live update, so the verdict is evaluated again
    // rather than carried over. A purchased unlock has to clear the page it paid for, which is what
    // the v1 sweep does when a confirmed gate sets `needsBlocking`.
    const verdict: Verdict | null = evaluatedVerdictOf(
      this.ports,
      runtime,
      session,
      previous.expectedUrl,
    );
    const blocked: boolean = verdict?.blocked === true;
    return buildFrozenDocumentCommandV2({
      tabId: previous.tabId,
      documentId: previous.documentId,
      expectedUrl: previous.expectedUrl,
      operationId: tuple.operationId,
      enforcementEpoch: runtime.enforcementEpoch,
      sessionId: session === null ? previous.sessionId : session.sessionId,
      reservedSessionId: session === null ? previous.reservedSessionId : null,
      basePolicyRevision: runtime.basePolicyRevision,
      runtimeRevision: tuple.runtimeRevision,
      verdict: blocked && verdict !== null ? verdict : clearVerdictOf(previous),
      presentation: blocked ? 'active' : 'clear',
      overlay:
        blocked && session !== null && verdict !== null
          ? this.activeOverlayFor(runtime, session, previous, verdict)
          : null,
    });
  }

  private activeOverlayFor(
    runtime: RuntimeStateV2,
    session: SessionStateV2,
    previous: FrozenDocumentCommand,
    verdict: Verdict,
  ): ReturnType<typeof buildActiveOverlayView> {
    const economy = this.ports.economy();
    return buildActiveOverlayView({
      targetUrl: previous.expectedUrl,
      capturedAt: this.ports.now(),
      theme: this.ports.theme(),
      session,
      economy: {
        bankMs: Math.min(this.ports.bank().balanceMs, economy.capMs),
        bankAccrualPerMs: economy.earnRatio,
        bankCapMs: economy.capMs,
        pauseCostMs: economy.pauseMs,
        unlockCostMs: economy.unlockMs,
      },
      gate: runtime.gate,
      activeUnlocks: runtime.unlocks.filter(
        (unlock: SiteUnlock): boolean => unlock.until > this.ports.now(),
      ),
      attemptsToday: this.ports.attemptsToday(),
      stoppedPage: runtime.tabStates[previous.tabId]?.stoppedDocumentId === previous.documentId,
      verdict: structuredClone(verdict),
    });
  }

  /**
   * Spends a ready pause or unlock gate. A pause creates and reads back its replacement boundary
   * before the paused state is durable, so a refused alarm leaves the focus phase untouched.
   */
  private async spendGate(gate: GateState, session: SessionStateV2): Promise<CommandResultV2> {
    const economy: PauseEconomy = this.ports.economy();
    const now: number = this.ports.now();
    const cost: number = gate.kind === 'pause' ? economy.pauseMs : economy.unlockMs;
    const balance: number = this.ports.bank().balanceMs;
    if (balance < cost) return failure('end-not-allowed');
    const spent: BankState = { balanceMs: balance - cost };
    if (gate.kind === 'pause') return this.spendPause(session, spent, cost, now);
    const host: string | null = gate.host;
    if (host === null) return failure('end-not-allowed');
    const runtime: RuntimeStateV2 = this.ports.runtime();
    await this.commitLiveViews(
      {
        ...structuredClone(runtime),
        gate: null,
        unlocks: [...structuredClone(runtime.unlocks), { host, until: now + cost }],
      },
      [{ t: 'unlockTaken', at: now, host, ms: cost, sessionId: session.sessionId }],
      spent,
    );
    return OK;
  }

  /**
   * Buys one pause. The replacement boundary is created and read back before the spend becomes
   * durable, so a refused alarm costs the user nothing and leaves the focus phase untouched. The
   * paused state, the cleared checkpoint, the charge, and the `pauseTaken` event are one checkpoint.
   */
  private async spendPause(
    session: SessionStateV2,
    spent: BankState,
    cost: number,
    now: number,
  ): Promise<CommandResultV2> {
    const paused: SessionStateV2 = beginPauseV2(session, now, cost);
    if ((await this.ensurePhaseAlarm(paused)) === 'alarm-failed') {
      await this.restoreFocusAlarm(session);
      return failure('end-not-allowed');
    }
    const runtime: RuntimeStateV2 = this.ports.runtime();
    const next: RuntimeStateV2 = validRuntime({
      ...structuredClone(runtime),
      session: structuredClone(paused),
      gate: null,
      enforcementCheckpoint: null,
    });
    await this.ports.commit({
      checkpointId: `${paused.sessionId}:pause-${paused.phaseStartedAt}`,
      projection: projectRuntimeDomainV2(next),
      bank: spent,
      events: [{ t: 'pauseTaken', at: now, ms: cost, sessionId: paused.sessionId }],
      syncBank: true,
      aggregateSets: {},
      aggregateRemoves: [],
    });
    await this.effects.clearBlockingForNonBlockingPhase();
    this.publish();
    return OK;
  }

  private async ensurePhaseAlarm(session: SessionStateV2): Promise<'ready' | 'alarm-failed'> {
    return ensurePhaseAlarmV2(this.ports.alarms, session);
  }

  /** A refused pause alarm restores the prior focus boundary, or closes with `alarm-failed`. */
  private async restoreFocusAlarm(session: SessionStateV2): Promise<void> {
    if ((await this.ensurePhaseAlarm(session)) === 'ready') return;
    await closeSessionV2(this.ports, this.effects, {
      endedAt: this.ports.now(),
      reason: 'alarm-failed',
    });
    this.publish();
  }

  /** Prepares and drives a resume from the phase the trigger expires. */
  private async driveResume(
    trigger: 'manual' | 'break-expired',
    phase: 'paused' | 'break',
  ): Promise<CommandResultV2> {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    if (this.inTransitionCleanup()) return failure('transition-cleanup-pending');
    if (runtime.pendingClosure !== null) return failure('closure-cleanup-pending');
    if (runtime.session?.phase !== phase) return failure('no-active-session');
    const prepared: PreparedTransitionV2 = await prepareResumeTransitionV2(this.ports, trigger);
    const driven: TransitionDriveResultV2 = await driveTransitionV2(this.ports, prepared.matcher);
    if (driven.kind === 'cleanup') await this.runTransitionCleanupIfOwned();
    this.publish();
    if (driven.kind !== 'published') return failure('no-active-session');
    // The break is over, and the sound says so on every path back to focus, timed or manual.
    if (phase === 'break' && this.schedule.settings().sounds.breakEnd) {
      this.effects.playSound('breakEnd');
    }
    return OK;
  }

  /**
   * Walks every finished local day before the current instant is settled, exactly as the v1
   * catch-up loop does. Focus is settled through each midnight first, so a closure delta can never
   * land on a day this loop has already closed, and then the Engine's own bookkeeping closes that
   * day through `rolloverCheck`. A `date` in the future rebases backward, which the Engine also
   * owns, so one call at today's boundary hands it that work.
   */
  private async rollLocalDate(): Promise<void> {
    const now: number = this.ports.now();
    const today: string = localDateStr(now);
    if (this.ports.runtime().date > today) {
      await this.ports.rolloverCheck(now);
      return;
    }
    for (let day: number = 0; day < MAX_ROLLOVER_DAYS; day++) {
      // The date is captured as a value rather than through the runtime it came from. The port
      // hands out the Engine's live object, and the rollover moves the day on that same object, so
      // comparing the object with itself afterwards always agreed and the walk returned after one
      // day. A profile that was idle for a week then caught up one day per minute of wall clock.
      const from: string = this.ports.runtime().date;
      if (from >= today) return;
      const boundary: number = localMidnightAfter(from);
      await this.settleThrough(boundary);
      await this.ports.rolloverCheck(boundary);
      if (this.ports.runtime().date === from) return;
    }
    // The bound was reached with days still owed, which only a clock that jumped more than a year
    // can do. It converges over the next ticks, and a silent truncation would hide why.
    this.ports.reportError(
      new CoreError('invalid-rule', `the local-date walk stopped ${MAX_ROLLOVER_DAYS} days short`),
    );
  }

  /**
   * Settles the durable session through now and expires what the instant expires. The daily
   * aggregate and bank bookkeeping stay with the retained Engine, which `rolloverCheck` drives.
   */
  private async settleThroughNow(): Promise<void> {
    await this.settleThrough(this.ports.now());
  }

  /** Settles the durable session and expiries through one instant. */
  private async settleThrough(now: number): Promise<void> {
    const runtime: RuntimeStateV2 = pruneHandledOccurrencesOnTickV2(this.ports.runtime(), now);
    const session: SessionStateV2 | null = runtime.session;
    const gate: GateState | null = runtime.gate;
    const lapsed: boolean = gate !== null && gate.readyAt < now - GATE_EXPIRY_MS;
    const unlocks: SiteUnlock[] = runtime.unlocks.filter(
      (unlock: SiteUnlock): boolean => unlock.until > now,
    );
    const expired: RuntimeStateV2 = {
      ...structuredClone(runtime),
      gate: lapsed ? null : gate,
      unlocks,
    };
    // An expiry changes what every open document must show: a lapsed unlock re-blocks its page and
    // a lapsed gate takes its controls off the overlay, so it goes out as a live update rather than
    // a bare write. A gate the user let lapse is resistance, and the v1 engine records it as such.
    const live: boolean = lapsed || unlocks.length !== runtime.unlocks.length;
    const events: SessionEventRecordV2[] =
      lapsed && gate !== null ? this.gateEvent('gateResisted', gate.kind, session) : [];
    if (session === null) {
      await this.persistSettled(expired, live, events, now);
      return;
    }
    const advanced: SessionAdvanceResultV2 = advanceSessionV2(session, now);
    // A settled roll is a phase change like any other, and the log is what the stats read.
    for (const change of advanced.events) {
      events.push({
        t: 'phase',
        at: change.at,
        from: change.from,
        to: change.to,
        sessionId: session.sessionId,
      });
    }
    if (advanced.kind === 'timer-completed' && !cleanupOwnsViewsV2(expired)) {
      // The closure one await away replaces the whole command map with its clear batch, so a live
      // update here would send every document a blocking command for a session that is over.
      await this.persistSettled(expired, false, events, now);
      await closeSessionV2(this.ports, this.effects, {
        endedAt: advanced.endedAt,
        reason: 'timer-completed',
      });
      this.completionEffects();
      return;
    }
    // A cleanup journal keeps its session frozen at the instant its closure names, and that
    // closure is the only thing allowed to end it. Once the retained session's own clock runs out,
    // an unguarded settle would try to close it a second time, and the closure builder refuses
    // that on the spot, so the throw left every tick after it, and the whole minute of Engine
    // maintenance behind it, undone for as long as the journal lived.
    if (cleanupOwnsViewsV2(expired)) {
      await this.persistSettled(expired, false, events, now);
      return;
    }
    // Focus earns pause budget as it is settled, exactly as the v1 engine credited it, and the
    // closure reads `accruedFocusMs` as its watermark so nothing is counted twice.
    const earnings: SettledEarningsV2 = this.settleEarnings(
      { ...expired, session: structuredClone(advanced.state) },
      advanced.sessionFocusedMs,
      now,
    );
    const settled: RuntimeStateV2 = earnings.runtime;
    events.push(...earnings.events);
    if (advanced.kind === 'resume-required') {
      await this.persistSettled(settled, live, events, now, earnings.bank);
      const onBreak: boolean = advanced.trigger === 'break-expired';
      await this.driveResume(onBreak ? 'break-expired' : 'manual', onBreak ? 'break' : 'paused');
      return;
    }
    // A settle that rolls focus into its break changes every verdict on every open page, and the
    // focus checkpoint it leaves behind attests a phase that is over: a non-blocking phase holds
    // none, and the boundary parser refuses the row that keeps one.
    const rolled: boolean = advanced.state.phase !== session.phase;
    await this.persistSettled(
      rolled && advanced.state.phase !== 'focus'
        ? { ...settled, enforcementCheckpoint: null }
        : settled,
      live || rolled,
      events,
      now,
      earnings.bank,
    );
    // The boundary moved, so the alarm that carries it has to move with it. A settled roll is the
    // one phase change with no command behind it to create the alarm, and without this the worker
    // sleeps through every boundary after the first one and only the minute tick catches up.
    if (advanced.state.phaseEndsAt !== session.phaseEndsAt) {
      const current: SessionStateV2 | null = this.ports.runtime().session;
      if (current !== null && (await this.ensurePhaseAlarm(current)) === 'alarm-failed') {
        await closeSessionV2(this.ports, this.effects, { endedAt: now, reason: 'alarm-failed' });
        return;
      }
    }
    if (rolled && advanced.state.phase !== 'focus') {
      await this.effects.clearBlockingForNonBlockingPhase();
    }
    if (rolled && advanced.state.phase === 'break' && this.schedule.settings().sounds.breakStart) {
      this.effects.playSound('breakStart');
    }
  }

  /**
   * One settled runtime. An expiry that moved the gate or the unlocks goes out as a live update,
   * because every open document has to see it, unless a cleanup journal owns the command map: there
   * every document already holds the frozen clear command that journal is retrying, the boundary
   * refuses a map that is not the clear batch, and the runner refuses to refreeze a cleanup row at
   * all. So the drop and its event are committed on their own and nothing is sent, and the ordinary
   * live-update path returns the moment the journal resolves.
   */
  private async persistSettled(
    next: RuntimeStateV2,
    live: boolean,
    events: SessionEventRecordV2[],
    now: number,
    bank?: BankState,
  ): Promise<void> {
    const owned: boolean = cleanupOwnsViewsV2(next);
    if (live && !owned) {
      await this.commitLiveViews(next, events, bank);
      return;
    }
    if (events.length > 0 || bank !== undefined) {
      await this.commitSettled(next, events, now, bank);
      return;
    }
    await this.writeIfChanged(next);
  }

  /**
   * What one settle earned: the runtime with its focus watermark and daily focus advanced, the bank
   * the earning produced, and the event that reports it. A settle that added no focus earns nothing
   * and hands back no bank, so it stays a bare write.
   */
  private settleEarnings(
    runtime: RuntimeStateV2,
    focusedMs: number,
    now: number,
  ): SettledEarningsV2 {
    const delta: number = Math.max(0, focusedMs - runtime.accruedFocusMs);
    if (delta === 0) return { runtime, bank: undefined, events: [] };
    const economy: PauseEconomy = this.ports.economy();
    const before: BankState = this.ports.bank();
    const bank: BankState = accrue(before, delta, economy);
    const earned: number = bank.balanceMs - before.balanceMs;
    const session: SessionStateV2 | null = runtime.session;
    // The daily aggregate stays with the retained Engine, which owns every other write to it, so
    // this advances the watermark and the Engine credits the day with the difference.
    return {
      runtime: { ...runtime, accruedFocusMs: focusedMs },
      bank,
      events:
        earned > 0
          ? [
              {
                t: 'budgetEarned',
                at: now,
                ms: earned,
                ...(session === null ? {} : { sessionId: session.sessionId }),
              },
            ]
          : [],
    };
  }

  /** One checkpoint for a settled runtime and the events it carries, with no view refrozen. */
  private async commitSettled(
    next: RuntimeStateV2,
    events: SessionEventRecordV2[],
    now: number,
    bank?: BankState,
  ): Promise<void> {
    await this.ports.commit({
      checkpointId: `${next.enforcementEpoch}:settle-${now}`,
      projection: projectRuntimeDomainV2(validRuntime(next)),
      bank: bank ?? this.ports.bank(),
      events: structuredClone(events),
      syncBank: bank !== undefined,
      aggregateSets: {},
      aggregateRemoves: [],
    });
  }

  /** Timer completion is the one end that announces itself, and only when enabled. */
  private completionEffects(): void {
    const settings: SettingsV2 = this.schedule.settings();
    if (settings.sounds.sessionComplete) this.effects.playSound('sessionComplete');
    if (settings.sessionCompleteNotification) {
      this.effects.notify(t('notify_session_complete_title'), t('notify_session_complete_body'));
    }
    this.publish();
  }

  /** Retries the prepared write this worker owes, on every tick and every command. */
  private async retryOwedClosure(): Promise<void> {
    const reason: 'website-access-lost' | 'content-registration-failed' | null = this.pendingReason;
    if (!this.closurePending || reason === null) return;
    if (this.ports.runtime().session === null) {
      this.closurePending = false;
      return;
    }
    try {
      await prepareClosureV2(this.ports, { endedAt: this.ports.now(), reason });
      this.closurePending = false;
      this.pendingReason = null;
      await this.finishOwedClosure();
    } catch (error: unknown) {
      this.ports.reportError(error);
    }
  }

  /** Commits and cleans the closure whose prepared write just became durable. */
  private async finishOwedClosure(): Promise<void> {
    await commitClosureV2(this.ports);
    await runClosureCleanupAttemptV2(this.ports, this.effects);
  }

  /** Best-effort clears while a closure is owed, so blocking stops even before it is durable. */
  private async clearReachableDocuments(): Promise<void> {
    for (const command of Object.values(this.ports.runtime().documentCommands)) {
      if (command.presentation === 'clear') continue;
      await sendDocumentEnforcementCommand(this.ports.transport, command);
    }
  }

  private async runDueCleanup(): Promise<void> {
    await this.runTransitionCleanupIfOwned();
    await this.runClosureCleanupIfOwned();
  }

  private async runTransitionCleanupIfOwned(): Promise<void> {
    if (!this.inTransitionCleanup()) return;
    await runTransitionCleanupAttemptV2(this.ports, this.effects);
    this.publish();
  }

  private async runClosureCleanupIfOwned(): Promise<void> {
    if (this.ports.runtime().pendingClosure?.stage !== 'cleanup') return;
    await runClosureCleanupAttemptV2(this.ports, this.effects);
    this.publish();
  }

  private async runScheduleCheck(): Promise<void> {
    const { started }: { started: boolean } = await runScheduleCheckV2(this.ports, this.schedule);
    if (started) this.publish();
  }

  /** Sends the newest persisted command for one target, resetting its epoch first when needed. */
  private async sendCurrentCommands(
    target: {
      tabId: number;
      documentId: string;
      url: string;
    },
    refreezeChangedUrl: boolean = false,
  ): Promise<void> {
    const command: FrozenDocumentCommand = await this.currentCommandFor(target, refreezeChangedUrl);
    await this.deliver(command);
  }

  /**
   * One command, and the epoch reset that has to precede it. A document accepts nothing until it
   * has been reset onto the current epoch, so a send that skips the reset is a command the page
   * refuses and an overlay that never changes. A refused reset sends nothing.
   */
  private async deliver(command: FrozenDocumentCommand): Promise<void> {
    await this.deliverBatch([command]);
  }

  /** Reset independent documents together, then persist all valid answers in one write. */
  private async deliverBatch(
    commands: FrozenDocumentCommand[],
  ): Promise<DocumentDeliveryOutcomesV2> {
    const resets: Array<DocumentEpochResetAck | null> = await Promise.all(
      commands.map(
        async (command: FrozenDocumentCommand): Promise<DocumentEpochResetAck | null> => {
          if (
            !this.isCurrentDelivery(command) ||
            this.hasCurrentEpochAck(command.tabId, command.documentId)
          )
            return null;
          const outcome = await sendEpochResetCommand(
            this.ports.transport,
            this.resetCommandFor({
              tabId: command.tabId,
              documentId: command.documentId,
              url: command.expectedUrl,
            }),
          );
          return outcome.kind === 'reset' && this.isCurrentDelivery(command) ? outcome.ack : null;
        },
      ),
    );
    const runtime: RuntimeStateV2 = this.ports.runtime();
    const epochResetAcks: RuntimeStateV2['epochResetAcks'] = structuredClone(
      runtime.epochResetAcks,
    );
    for (const ack of resets) {
      if (ack !== null && ack.enforcementEpoch === runtime.enforcementEpoch) {
        epochResetAcks[documentCommandKeyV2(ack.tabId, ack.documentId)] =
          epochResetAckRecordV2(ack);
      }
    }
    if (!exactDataEqual(epochResetAcks, runtime.epochResetAcks)) {
      await this.write({
        ...structuredClone(runtime),
        epochResetAcks,
      });
    }
    const outcomes: Map<string, DocumentCommandOutcomeV2> = new Map();
    await Promise.all(
      commands.map(async (command: FrozenDocumentCommand): Promise<void> => {
        if (
          this.isCurrentDelivery(command) &&
          this.hasCurrentEpochAck(command.tabId, command.documentId)
        ) {
          outcomes.set(
            documentCommandKeyV2(command.tabId, command.documentId),
            await sendDocumentEnforcementCommand(this.ports.transport, command),
          );
        }
      }),
    );
    return outcomes;
  }

  /**
   * Whether a command is still the one this runtime owes its document. A stored command is current
   * while the map holds it exactly, and a pause, a break, or a purchased unlock keeps stored clears
   * that way. A clear the map does not hold is current while the tuple it was computed from is the
   * runtime's and nothing has been stored for that document since.
   */
  private isCurrentDelivery(command: FrozenDocumentCommand): boolean {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    if (command.enforcementEpoch !== runtime.enforcementEpoch) return false;
    const stored: FrozenDocumentCommand | undefined =
      runtime.documentCommands[documentCommandKeyV2(command.tabId, command.documentId)];
    if (stored !== undefined) return exactDataEqual(stored, command);
    return (
      !command.verdict.blocked &&
      command.runtimeRevision === runtime.runtimeRevision &&
      command.basePolicyRevision === runtime.basePolicyRevision
    );
  }

  /**
   * The command a pulling document is answered with, or null when this runtime owes it none.
   *
   * A durable cleanup batch is the whole command map while it lasts, and the validators require the
   * runtime to keep it exactly, so freezing an ordinary command here would write a map they refuse
   * and the pull would throw instead of answering. The batch's own command is handed back when it
   * names this document, and a document it does not name joins the batch through the leaf that owns
   * discovery, which is the same durable add the navigation push makes. A prepared closure holds no
   * durable batch, so it takes the ordinary path, exactly as the push side does.
   */
  private async pulledCommandFor(
    target: { tabId: number; documentId: string; url: string },
    attemptKind: 'navigation' | 'existing' | null,
  ): Promise<FrozenDocumentCommand | null> {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    const journal: CleanupJournalV2 | null = cleanupJournalOfV2(runtime);
    if (journal !== null) {
      const key: string = documentCommandKeyV2(target.tabId, target.documentId);
      const named: FrozenDocumentCommand | undefined = journalProgressV2(runtime, journal)
        .clearCommands[key];
      if (named !== undefined) return named;
      // A sweep reports what a target already holds and its URL comes from a tab query that may
      // already be behind, so it does not get to write a durable clear command for a page it may be
      // wrong about. A caller that names the URL the document is on does, which is how a document
      // that reached the worker only by pulling stops waiting for the journal's runner.
      if (attemptKind === null) return null;
      return await durableCleanupClearCommandV2(this.ports, journal, {
        tabId: target.tabId,
        documentId: target.documentId,
        expectedUrl: target.url,
      });
    }
    if (this.idleRuntimeOwesNothing(target)) return null;
    // A navigation or a document's own pull names the URL it is on, so a stored command for
    // another URL is refrozen. A sweep only reports what a target already holds: its URL comes
    // from a tab query that may already be behind the navigation it is racing.
    return await this.currentCommandFor(target, attemptKind !== null);
  }

  /**
   * The command one document must apply outside a cleanup journal. A stored command is answered as
   * it is, and a stored command for another URL is refrozen. Otherwise the command is computed from
   * the current tuple, and only a blocked one is persisted before it is returned. An allowed page
   * gets a clear the map never holds: a stored entry keeps the page address in the runtime for the
   * rest of the session, and the map is bounded to the documents the session is blocking. The
   * cleanup batch enumerates the live tabs on its own, so a page the map never held is still
   * cleared at the end.
   */
  private async currentCommandFor(
    target: {
      tabId: number;
      documentId: string;
      url: string;
    },
    refreezeChangedUrl: boolean = false,
  ): Promise<FrozenDocumentCommand> {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    const stored: FrozenDocumentCommand | undefined = runtime.documentCommands[key];
    if (stored !== undefined && (!refreezeChangedUrl || stored.expectedUrl === target.url)) {
      return structuredClone(stored);
    }
    if (stored !== undefined) {
      // A same-document navigation keeps the key and changes the URL, so the stored command is not
      // this page's command. The document already applied that tuple, and it accepts only a higher
      // one, so the whole map advances a revision with this target's new URL in it.
      return await this.refreezeChangedTarget(runtime, key, stored, target.url);
    }
    const session: SessionStateV2 | null = runtime.session;
    // The new document joins the tuple the others already hold. While the command map is the
    // current authority every stored command repeats the runtime revision, so raising it for one
    // late arrival would invalidate every command already frozen, and the runtime with it.
    const runtimeRevision: number = runtime.runtimeRevision;
    const operationId: string = this.ports.newId();
    const evaluated: Verdict | null = evaluatedVerdictOf(this.ports, runtime, session, target.url);
    const blocked: boolean = evaluated?.blocked === true;
    // A clear command carries the canonical clear verdict and nothing else. An allowed page under a
    // live session evaluates to a verdict of its own, which the frozen command contract refuses on
    // a clear presentation, so only a blocked page keeps the verdict it evaluated.
    const verdict: Verdict = blocked && evaluated !== null ? evaluated : CLEAR_VERDICT;
    const focused: SessionStateV2 | null =
      session !== null && session.phase === 'focus' ? session : null;
    const command: FrozenDocumentCommand = buildFrozenDocumentCommandV2({
      tabId: target.tabId,
      documentId: target.documentId,
      expectedUrl: target.url,
      operationId,
      enforcementEpoch: runtime.enforcementEpoch,
      sessionId: session === null ? null : session.sessionId,
      reservedSessionId: session === null ? runtime.enforcementEpoch : null,
      basePolicyRevision: runtime.basePolicyRevision,
      runtimeRevision,
      verdict,
      presentation: blocked ? 'active' : 'clear',
      overlay:
        blocked && focused !== null
          ? this.activeOverlayFor(
              runtime,
              focused,
              {
                ...structuredClone(runtime.documentCommands[key] ?? EMPTY_COMMAND),
                tabId: target.tabId,
                documentId: target.documentId,
                expectedUrl: target.url,
                verdict,
              },
              verdict,
            )
          : null,
    });
    if (!blocked) return command;
    // A document that already acknowledged this epoch has applied something under it, and the
    // clear it applied for an allowed page was never stored, so its tuple is not on record. The
    // page accepts a different view only at a strictly higher tuple, which the current revision
    // cannot be, so the entry joins through a live commit that advances the whole map. A document
    // with no acknowledgement holds nothing yet and joins at the current revision.
    if (
      runtime.pendingEnforcementTransition === null &&
      this.hasCurrentEpochAck(target.tabId, target.documentId)
    ) {
      return await this.freezeAcknowledgedTarget(runtime, key, command);
    }
    await this.write({
      ...structuredClone(runtime),
      runtimeRevision,
      documentCommands: { ...structuredClone(runtime.documentCommands), [key]: command },
    });
    return command;
  }

  /**
   * True when an idle runtime owes a document nothing. Every command an idle runtime sends is a
   * clear, so a document that acknowledged this epoch and has no stored entry already shows one,
   * either the batch clear the cleanup sent it or an idle clear it pulled. The batch clear names
   * the closed session and an idle clear names the epoch as its reservation, so at the same base
   * revision the page refuses the idle one, and sending it or answering it buys nothing.
   */
  private idleRuntimeOwesNothing(target: { tabId: number; documentId: string }): boolean {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    return (
      runtime.session === null &&
      runtime.pendingClosure === null &&
      runtime.pendingEnforcementTransition === null &&
      runtime.documentCommands[documentCommandKeyV2(target.tabId, target.documentId)] ===
        undefined &&
      this.hasCurrentEpochAck(target.tabId, target.documentId)
    );
  }

  /**
   * Adds one blocked command for an acknowledged document through a live commit, so every stored
   * command and this one land at the next revision and the page takes the new view.
   */
  private async freezeAcknowledgedTarget(
    runtime: RuntimeStateV2,
    key: string,
    command: FrozenDocumentCommand,
  ): Promise<FrozenDocumentCommand> {
    await this.commitLiveViews({
      ...structuredClone(runtime),
      documentCommands: { ...structuredClone(runtime.documentCommands), [key]: command },
    });
    const frozen: FrozenDocumentCommand | undefined = this.ports.runtime().documentCommands[key];
    if (frozen === undefined) {
      throw new CoreError('invalid-rule', 'a live view lost the target it was built for');
    }
    return structuredClone(frozen);
  }

  /**
   * The reset one pulling document is handed, recorded as acknowledged in the same breath. The
   * document asked for what it must apply and applies the array in order before it renders, so a
   * pull is as good an acknowledgement as a push answer. Without this the pull answers the same
   * reset on every navigation until some push happens to record one.
   */
  private async handOverEpochReset(target: {
    tabId: number;
    documentId: string;
    url: string;
  }): Promise<ReturnType<typeof buildFrozenEpochResetCommandV2>> {
    const reset: ReturnType<typeof buildFrozenEpochResetCommandV2> = this.resetCommandFor(target);
    const ack: EpochResetAckRecord = {
      version: 1,
      operationId: reset.operationId,
      enforcementEpoch: reset.enforcementEpoch,
      tabId: reset.tabId,
      documentId: reset.documentId,
      handledAt: this.ports.now(),
    };
    await this.write({
      ...structuredClone(this.ports.runtime()),
      epochResetAcks: {
        ...structuredClone(this.ports.runtime().epochResetAcks),
        [documentCommandKeyV2(ack.tabId, ack.documentId)]: ack,
      },
    });
    return reset;
  }

  /**
   * One live update for a document that navigated within itself. Every command is refrozen at the
   * next revision, with this target's new URL in place, and the command for that target is what
   * the caller sends. A target the new URL leaves unblocked is dropped from the map once the page
   * has applied its clear.
   */
  private async refreezeChangedTarget(
    runtime: RuntimeStateV2,
    key: string,
    stored: FrozenDocumentCommand,
    url: string,
  ): Promise<FrozenDocumentCommand> {
    const outcomes: DocumentDeliveryOutcomesV2 = await this.commitLiveViews({
      ...structuredClone(runtime),
      documentCommands: {
        ...structuredClone(runtime.documentCommands),
        [key]: { ...structuredClone(stored), expectedUrl: url },
      },
    });
    const refrozen: FrozenDocumentCommand | undefined = this.ports.runtime().documentCommands[key];
    if (refrozen === undefined) {
      throw new CoreError('invalid-rule', 'a refrozen live view lost the target it was built for');
    }
    await this.dropAcknowledgedClear(key, refrozen, outcomes.get(key));
    return structuredClone(refrozen);
  }

  /**
   * Drops the entry for a document the session no longer blocks, once the page has applied the
   * clear the refreeze sent it. A clear nobody applied is still owed, and the retained entry is
   * what the next live refresh resends. A running transition owns its frozen view, so its map is
   * left exactly as the runner froze it.
   */
  private async dropAcknowledgedClear(
    key: string,
    refrozen: FrozenDocumentCommand,
    outcome: DocumentCommandOutcomeV2 | undefined,
  ): Promise<void> {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    if (
      refrozen.verdict.blocked ||
      runtime.pendingEnforcementTransition !== null ||
      outcome?.kind !== 'applied'
    ) {
      return;
    }
    const documentCommands: Record<string, FrozenDocumentCommand> = {};
    for (const [existing, command] of Object.entries(runtime.documentCommands)) {
      if (existing !== key) documentCommands[existing] = structuredClone(command);
    }
    await this.write({ ...structuredClone(runtime), documentCommands });
  }

  private resetCommandFor(target: {
    tabId: number;
    documentId: string;
    url: string;
  }): ReturnType<typeof buildFrozenEpochResetCommandV2> {
    return buildFrozenEpochResetCommandV2({
      tabId: target.tabId,
      documentId: target.documentId,
      expectedUrl: target.url,
      operationId: this.ports.newId(),
      enforcementEpoch: this.ports.runtime().enforcementEpoch,
    });
  }

  private hasCurrentEpochAck(tabId: number, documentId: string): boolean {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    const ack: EpochResetAckRecord | undefined =
      runtime.epochResetAcks[documentCommandKeyV2(tabId, documentId)];
    return ack !== undefined && ack.enforcementEpoch === runtime.enforcementEpoch;
  }

  /** A blocked frozen verdict is what makes one navigation an attempt. Sweeps pass null. */
  /** Whether the command this target currently holds blocks it. Read inside the queue. */
  /**
   * Takes the stopped claim for a navigation this answer is about to block. The verdict is
   * evaluated rather than read off a frozen command, because the command for this document does
   * not exist yet: it is the one being built from the runtime this claim is about to enter.
   */
  private async claimStoppedPage(target: {
    tabId: number;
    documentId: string;
    url: string;
  }): Promise<void> {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    const evaluated: Verdict | null = evaluatedVerdictOf(
      this.ports,
      runtime,
      runtime.session,
      target.url,
    );
    if (evaluated?.blocked !== true) return;
    await this.effects.markStoppedPage(target.tabId, target.url, target.documentId);
  }

  private blockedNow(target: { tabId: number; documentId: string }): boolean {
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    return this.ports.runtime().documentCommands[key]?.verdict.blocked === true;
  }

  /** The attempt one blocked target records. Awaited outside the queue, never inside it. */
  private async recordAttemptIfBlocked(
    blocked: boolean,
    target: { tabId: number; url: string },
    attemptKind: 'navigation' | 'existing' | null,
  ): Promise<void> {
    if (!blocked || attemptKind === null) return;
    await this.effects.recordAttempt(target.url, target.tabId, attemptKind);
  }

  private async write(runtime: RuntimeStateV2): Promise<void> {
    await this.ports.writeRuntime(validRuntime(carryCommitCheckpointProjectionV2(runtime)));
  }

  private async writeIfChanged(runtime: RuntimeStateV2): Promise<void> {
    if (exactDataEqual(this.ports.runtime(), runtime)) return;
    await this.write(runtime);
  }
}

/**
 * The snapshot for a closure this worker owes but has not made durable. Only an active lifecycle
 * may carry a phase or a clock, so the owed projection reports the idle shape with the closure
 * cleanup the popup should render.
 */
function owedClosureSnapshot(base: SessionSnapshotV2, sessionId: string): SessionSnapshotV2 {
  return {
    ...base,
    lifecycle: {
      kind: 'cleanup',
      journal: 'closure',
      id: closureIdV2(sessionId),
      endAuthority: { kind: 'hidden' },
    },
    phase: 'idle',
    config: null,
    startedAt: null,
    phaseStartedAt: null,
    phaseEndsAt: null,
    sessionEndsAt: null,
    sessionFocusedMs: 0,
    cycleIndex: 0,
    bankAccrualPerMs: 0,
    activeUnlocks: [],
    gate: null,
    scheduleActive: false,
  };
}

/** A settled read, and whether the settle found a session that has run out its own clock. */
interface SettledReadV2 {
  runtime: RuntimeStateV2;
  closureOwed: boolean;
}

/**
 * The runtime as one instant observes it. Spec 358 settles the core state through the snapshot `at`
 * before an active snapshot is built, so a read that lands between a durable boundary and the tick
 * that writes it reports the phase the user is in rather than a countdown already past zero.
 *
 * The settle is in memory and writes nothing, which keeps `snapshot` pure and callable from
 * `publish`, and it models exactly one step: the phase that runs out into the phase behind it, which
 * the tick writes from the session's own clock. It never models a resume. The tick's resume
 * activates at the instant the worker wakes (`transition-runner-v2.ts`), not at the boundary behind
 * it, so a read that resumed here would invent a phase and a clock the worker will never write. A
 * session sitting past its boundary is left exactly as it is durable, and the projection reports it
 * as starting, because `at` is behind no phase it can publish.
 *
 * The session's own end is the one boundary that needs a closure rather than a phase, so that
 * reports the cleanup the worker owes instead of the idle shape.
 */
function settledForReadV2(runtime: RuntimeStateV2, at: number): SettledReadV2 {
  const session: SessionStateV2 | null = runtime.session;
  if (session === null) return { runtime, closureOwed: false };
  const advanced: SessionAdvanceResultV2 = advanceSessionV2(session, at);
  if (advanced.kind === 'timer-completed') {
    return { runtime: { ...runtime, session: null }, closureOwed: true };
  }
  if (advanced.kind !== 'active') return { runtime, closureOwed: false };
  const settled: SessionStateV2 = structuredClone(advanced.state);
  return {
    runtime: {
      ...runtime,
      session: settled,
      // A phase this settle rolled into is not the phase the durable focus checkpoint attests, and a
      // non-blocking phase publishes without one, so the read drops it exactly as the durable phase
      // change does.
      enforcementCheckpoint: settled.phase === 'focus' ? runtime.enforcementCheckpoint : null,
    },
    closureOwed: false,
  };
}

/** The verdict a focus session's captured policy gives one URL, or null outside focus. */
function evaluatedVerdictOf(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  session: SessionStateV2 | null,
  url: string,
): Verdict | null {
  if (session === null || session.phase !== 'focus') return null;
  return ports.verdictFor(
    ports.compileMatcher(session.config.rules, session.config.mode),
    url,
    runtime.unlocks,
  );
}

/** Nothing this controller hands a port is allowed to be a runtime the boundary would reject. */
/**
 * True while a durable cleanup batch owns the document commands and the revision that names them.
 * Both cleanup lifecycles refuse a live view commit in that state, the transition through its own
 * refreeze and the closure through the validator, so every caller asks this first rather than
 * discovering it as a thrown runtime.
 */
function cleanupOwnsViewsV2(runtime: RuntimeStateV2): boolean {
  return (
    runtime.pendingEnforcementTransition?.stage === 'cleanup' || runtime.pendingClosure !== null
  );
}

function validRuntime(runtime: RuntimeStateV2): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(runtime);
  if (parsed === null) {
    throw new CoreError('invalid-rule', 'the session controller built an invalid runtime');
  }
  return parsed;
}

/** A tick never walks more finished days than this, so a broken clock cannot spin the loop. */
const MAX_ROLLOVER_DAYS: number = 400;
const CLEAR_VERDICT: Verdict = {
  blocked: false,
  reason: 'no-session',
  categoryId: null,
  matchedPattern: null,
};
const EMPTY_COMMAND: FrozenDocumentCommand = {
  version: 1,
  command: 'apply-enforcement',
  operationId: '00000000-0000-4000-8000-000000000000',
  enforcementEpoch: '00000000-0000-4000-8000-000000000000',
  sessionId: null,
  reservedSessionId: '00000000-0000-4000-8000-000000000000',
  basePolicyRevision: 0,
  runtimeRevision: 0,
  documentId: 'placeholder',
  expectedUrl: 'https://placeholder.invalid/',
  presentation: 'clear',
  verdict: CLEAR_VERDICT,
  overlay: null,
  tabId: 0,
};

/** The v2 session config a manual start turns into the candidate the runner prepares. */
function candidateFor(config: SessionConfigV2): SessionStartCandidate {
  return {
    mode: config.mode,
    strictness: config.strictness,
    duration:
      config.duration.kind === 'until-stopped'
        ? { kind: 'until-stopped' }
        : { kind: 'manual-timed', minutes: config.duration.minutes },
    cycling: structuredClone(config.cycling),
    intention: config.intention,
    source: 'manual',
    scheduleOccurrence: null,
    scheduleWindow: null,
    rules: structuredClone(config.rules),
  };
}

function clearVerdictOf(previous: FrozenDocumentCommand): Verdict {
  return previous.presentation === 'clear' ? structuredClone(previous.verdict) : CLEAR_VERDICT;
}

function failure(code: Exclude<SessionCommandResultCodeV2, 'ok'>): CommandResultV2 {
  return { ok: false, code, error: code };
}

function isFailureReason(
  value: string | null,
): value is
  | 'website-access-lost'
  | 'content-registration-failed'
  | 'alarm-failed'
  | 'tab-enforcement-failed' {
  return (
    value === 'website-access-lost' ||
    value === 'content-registration-failed' ||
    value === 'alarm-failed' ||
    value === 'tab-enforcement-failed'
  );
}

/** The worker owns the tab target, so the wire command never carries it. */
function wireOf(
  command: FrozenDocumentCommand | ReturnType<typeof buildFrozenEpochResetCommandV2>,
): DocumentContentCommand {
  const { tabId: _tabId, ...wire } = command;
  return wire as DocumentContentCommand;
}
