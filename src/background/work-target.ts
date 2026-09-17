import { t } from '../shared/i18n';
import type {
  Ack,
  CommandResponseV2,
  SessionCommandResultCodeV2,
  StartSessionResponseV2,
} from '../shared/messages';
import type { GateState, SessionConfigV2, SessionMode, SessionRuleSnapshot } from '../shared/types';
import {
  CHOOSE_WORK_TAB_ERROR,
  isWorkLastAccessed,
  parseStoredWorkTarget,
  type StoredWorkTarget,
  WORK_SESSION_CHANGED_ERROR,
  WORK_TAB_CLOSED_ERROR,
  WORK_TARGET_NOT_SAVED_ERROR,
  type WorkTab,
  type WorkTabIconResult,
  type WorkTabsResult,
  type WorkTargetResult,
} from '../shared/work-target';
import { chromeWorkTabIconPorts, type IconTarget, WorkTabIconService } from './work-tab-icons';

/** What decides whether a tab is eligible: a mode and the rule snapshot it is applied to. */
export interface WorkTargetPolicy {
  mode: SessionMode;
  rules: SessionRuleSnapshot;
}

/** The live session as the pickers see it: its identity plus the policy it captured at start. */
export interface WorkSession extends WorkTargetPolicy {
  sessionId: string;
}

/**
 * The session commands an action may issue while it holds the engine's mutation queue. The queued
 * `Engine.abandonGate` would wait behind the very frame the action runs in, so the frame carries a
 * direct one.
 */
export interface WorkTargetFrame {
  /** The gate open at this instant, or null. */
  gate(): GateState | null;
  /** Closes exactly that gate, with the controller's own result codes. */
  abandonGate(expectedGate: GateState): Promise<CommandResponseV2<SessionCommandResultCodeV2>>;
}

/** The slice of `Engine` this service reads and drives. */
export interface WorkTargetEngine {
  workTargetSession(): WorkSession | null;
  /** The pre-start policy: the popup's rule snapshot when it sent one, else the saved lists. */
  workTargetDraftPolicy(mode: SessionMode, rules?: SessionRuleSnapshot): WorkTargetPolicy;
  /** Whether `url` is allowed under `policy` with no temporary unlocks applied. */
  workTargetAllowed(url: string, policy: WorkTargetPolicy): boolean;
  /**
   * Runs `action` on the policy mutation queue after checking the live session is `sessionId`, so
   * no session command can commit between the check and the action's last step.
   */
  runWorkTargetAction(
    sessionId: string,
    action: (frame: WorkTargetFrame) => Promise<Ack>,
  ): Promise<Ack>;
  /** Starts the session and, while still inside its mutation frame, hands `afterStart` its id. */
  startSession(
    config: SessionConfigV2,
    afterStart?: (sessionId: string) => Promise<Ack>,
  ): Promise<StartSessionResponseV2>;
}

export interface WorkTargetPorts {
  extensionId: string;
  popupUrl: string;
  read(): Promise<unknown>;
  write(value: StoredWorkTarget): Promise<void>;
  tabs(): Promise<chrome.tabs.Tab[]>;
  tab(tabId: number): Promise<chrome.tabs.Tab>;
  window(windowId: number): Promise<chrome.windows.Window>;
  activate(tabId: number): Promise<void>;
  focus(windowId: number): Promise<void>;
  broadcast(): void;
}

const SESSION_WORK_TARGET: string = 'workTarget';

function failure(error: string): Ack & { ok: false } {
  return { ok: false, error };
}

function invalidStart(error: string): StartSessionResponseV2 {
  return { ok: false, code: 'invalid-request', error };
}

/** The sentence a refused gate abandon earns, by the controller's code. */
function gateFailureMessage(code: Exclude<SessionCommandResultCodeV2, 'ok'>): string {
  switch (code) {
    case 'no-active-session':
      return WORK_SESSION_CHANGED_ERROR;
    case 'transition-cleanup-pending':
    case 'closure-cleanup-pending':
    case 'data-clear-pending':
      return t('notify_work_gate_busy');
    default:
      return t('notify_work_gate_stuck');
  }
}

/** Tab destinations are local to this browser lifetime, independent of session persistence. */
export class WorkTargetService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly engine: WorkTargetEngine,
    private readonly ports: WorkTargetPorts,
    private readonly icons: WorkTabIconService = new WorkTabIconService(chromeWorkTabIconPorts()),
  ) {}

  private serialise<T>(action: () => Promise<T>): Promise<T> {
    const result: Promise<T> = this.queue.then(action, action);
    this.queue = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  private isPopup(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === this.ports.extensionId && sender.url === this.ports.popupUrl;
  }

  /**
   * Who may ask, and in which privacy context. The popup names its window and the answer is that
   * window's incognito flag. Content proves it is the top frame of the page Chrome still says it
   * is, and the answer is that tab's flag. Everyone else is refused.
   */
  private async context(
    windowId: number | undefined,
    sender: chrome.runtime.MessageSender,
    popupOnly: boolean = false,
  ): Promise<boolean> {
    if (sender.id !== this.ports.extensionId) throw new Error('Untrusted request.');
    if (this.isPopup(sender)) {
      if (windowId === undefined || (sender.tab !== undefined && sender.tab.windowId !== windowId))
        throw new Error('Open the popup in the browser window containing your work.');
      return (await this.ports.window(windowId)).incognito;
    }
    if (
      popupOnly ||
      windowId !== undefined ||
      sender.tab?.id === undefined ||
      (sender.frameId !== undefined && sender.frameId !== 0)
    )
      throw new Error('Use the Focus Lock popup to choose a work tab.');
    const source: chrome.tabs.Tab = await this.ports.tab(sender.tab.id);
    if (
      source.url !== sender.url ||
      source.incognito !== sender.tab.incognito ||
      !this.http(source.url)
    )
      // The blocked page shows this sentence verbatim when it recognises it, and recognises it by
      // comparing against the same message. Both sides must therefore read the same key, or the
      // match fails in every language but English and the page falls back to a generic error.
      throw new Error(t('overlay_target_page_changed'));
    return source.incognito;
  }

  private http(url: string | undefined): url is string {
    if (url === undefined) return false;
    try {
      return ['http:', 'https:'].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  }

  private suitable(tab: chrome.tabs.Tab, policy: WorkTargetPolicy, incognito: boolean): boolean {
    return (
      tab.id !== undefined &&
      tab.incognito === incognito &&
      this.http(tab.url) &&
      this.engine.workTargetAllowed(tab.url, policy) &&
      (tab.pendingUrl === undefined ||
        (this.http(tab.pendingUrl) && this.engine.workTargetAllowed(tab.pendingUrl, policy)))
    );
  }

  private current(sessionId: string): WorkSession {
    const session: WorkSession | null = this.engine.workTargetSession();
    if (session?.sessionId !== sessionId) throw new Error(WORK_SESSION_CHANGED_ERROR);
    return session;
  }

  /** The popup's pre-start listing. `rules` is the draft's snapshot, or absent for the saved lists. */
  async getWorkTabs(
    mode: SessionMode,
    windowId: number,
    rules: SessionRuleSnapshot | undefined,
    sender: chrome.runtime.MessageSender,
  ): Promise<WorkTabsResult> {
    try {
      const incognito: boolean = await this.context(windowId, sender, true);
      const policy: WorkTargetPolicy = this.engine.workTargetDraftPolicy(mode, rules);
      const tabs: chrome.tabs.Tab[] = await this.ports.tabs();
      return { ok: true, tabs: this.candidates(tabs, policy, incognito) };
    } catch (error: unknown) {
      return failure(this.error(error));
    }
  }

  /** The overlay's listing, under the live session's captured policy. */
  async getContentWorkTabs(
    sessionId: string,
    sender: chrome.runtime.MessageSender,
  ): Promise<WorkTabsResult> {
    try {
      const incognito: boolean = await this.context(undefined, sender);
      this.current(sessionId);
      const tabs: chrome.tabs.Tab[] = await this.ports.tabs();
      const session: WorkSession = this.current(sessionId);
      return { ok: true, tabs: this.candidates(tabs, session, incognito) };
    } catch (error: unknown) {
      return failure(this.error(error));
    }
  }

  async getWorkTabIcon(
    sessionId: string,
    tabId: number,
    sender: chrome.runtime.MessageSender,
  ): Promise<WorkTabIconResult> {
    try {
      const icon: string | null = await this.icons.get(async (): Promise<IconTarget> => {
        const incognito: boolean = await this.context(undefined, sender);
        this.current(sessionId);
        const tab: chrome.tabs.Tab = await this.ports.tab(tabId);
        if (!this.suitable(tab, this.current(sessionId), incognito))
          throw new Error(CHOOSE_WORK_TAB_ERROR);
        return { url: tab.url as string, incognito, favicon: tab.favIconUrl };
      });
      return { ok: true, icon };
    } catch (error: unknown) {
      return failure(this.error(error));
    }
  }

  private candidates(
    tabs: chrome.tabs.Tab[],
    policy: WorkTargetPolicy,
    incognito: boolean,
  ): WorkTab[] {
    return tabs
      .filter((tab: chrome.tabs.Tab): boolean => this.suitable(tab, policy, incognito))
      .map(
        (tab: chrome.tabs.Tab): WorkTab => ({
          tabId: tab.id as number,
          ...(isWorkLastAccessed(tab.lastAccessed) ? { lastAccessed: tab.lastAccessed } : {}),
          hostname: new URL(tab.url as string).hostname,
          title: tab.title || new URL(tab.url as string).hostname,
        }),
      )
      .sort(
        (left: WorkTab, right: WorkTab): number =>
          (right.lastAccessed ?? -1) - (left.lastAccessed ?? -1),
      );
  }

  /** Popup (with its window) or content (without): where the chosen tab stands right now. */
  async getWorkTarget(
    windowId: number | undefined,
    sender: chrome.runtime.MessageSender,
  ): Promise<WorkTargetResult> {
    try {
      const incognito: boolean = await this.context(windowId, sender);
      const stored: StoredWorkTarget | null = parseStoredWorkTarget(await this.ports.read());
      const session: WorkSession | null = this.engine.workTargetSession();
      const base: { ok: true; sessionId: string | null; title: null } = {
        ok: true,
        sessionId: session?.sessionId ?? null,
        title: null,
      };
      if (session === null || stored?.sessionId !== session.sessionId)
        return { ...base, state: 'missing' };
      if (stored.incognito !== incognito) return { ...base, state: 'unavailable' };
      let tab: chrome.tabs.Tab | null = null;
      try {
        tab = await this.ports.tab(stored.tabId);
      } catch {
        // A closed tab is unavailable, but its session may also have ended during the lookup.
      }
      if (this.engine.workTargetSession()?.sessionId !== session.sessionId)
        return this.getWorkTarget(windowId, sender);
      return tab !== null && this.suitable(tab, session, incognito)
        ? {
            ...base,
            state: 'ready',
            title: tab.title || new URL(tab.url as string).hostname,
            hostname: new URL(tab.url as string).hostname,
          }
        : { ...base, state: 'unavailable' };
    } catch (error: unknown) {
      return failure(this.error(error));
    }
  }

  setWorkTarget(
    sessionId: string,
    tabId: number,
    windowId: number | undefined,
    sender: chrome.runtime.MessageSender,
  ): Promise<Ack> {
    return this.serialise(async (): Promise<Ack> => {
      try {
        const incognito: boolean = await this.context(windowId, sender);
        return await this.engine.runWorkTargetAction(
          sessionId,
          (): Promise<Ack> => this.select(sessionId, tabId, incognito),
        );
      } catch (error: unknown) {
        return failure(this.error(error));
      }
    });
  }

  private async select(sessionId: string, tabId: number, incognito: boolean): Promise<Ack> {
    this.current(sessionId);
    let tab: chrome.tabs.Tab;
    try {
      tab = await this.ports.tab(tabId);
    } catch {
      this.current(sessionId);
      return failure(WORK_TAB_CLOSED_ERROR);
    }
    if (!this.suitable(tab, this.current(sessionId), incognito))
      return failure(CHOOSE_WORK_TAB_ERROR);
    await this.ports.write({ sessionId, tabId, incognito });
    this.current(sessionId);
    this.ports.broadcast();
    return { ok: true };
  }

  /**
   * The popup's start with a chosen tab. The tab is checked against the request's own rules
   * before anything starts, and saved for the minted session inside the start's mutation frame.
   * A save that fails after the start answers `work-target-not-saved`: the session is live.
   */
  startSession(
    config: SessionConfigV2,
    workTabId: number,
    windowId: number,
    sender: chrome.runtime.MessageSender,
  ): Promise<StartSessionResponseV2> {
    return this.serialise(async (): Promise<StartSessionResponseV2> => {
      let incognito: boolean;
      try {
        incognito = await this.context(windowId, sender, true);
        let tab: chrome.tabs.Tab;
        try {
          tab = await this.ports.tab(workTabId);
        } catch {
          return invalidStart(WORK_TAB_CLOSED_ERROR);
        }
        if (!this.suitable(tab, config, incognito)) return invalidStart(CHOOSE_WORK_TAB_ERROR);
      } catch (error: unknown) {
        return invalidStart(this.error(error));
      }
      return this.engine.startSession(config, async (sessionId: string): Promise<Ack> => {
        try {
          return await this.select(sessionId, workTabId, incognito);
        } catch {
          return failure(WORK_TARGET_NOT_SAVED_ERROR);
        }
      });
    });
  }

  /**
   * Closes an open gate, then activates the chosen tab and focuses its window. Every await is
   * followed by a session check, and the tab is re-read after the gate closes, because closing it
   * is what lets a page the tab had pending finish loading.
   */
  returnToWork(
    sessionId: string,
    windowId: number | undefined,
    sender: chrome.runtime.MessageSender,
  ): Promise<Ack> {
    return this.serialise(async (): Promise<Ack> => {
      try {
        const incognito: boolean = await this.context(windowId, sender);
        return await this.engine.runWorkTargetAction(
          sessionId,
          (frame: WorkTargetFrame): Promise<Ack> => this.switchToWork(sessionId, incognito, frame),
        );
      } catch (error: unknown) {
        return failure(`${this.error(error)} ${CHOOSE_WORK_TAB_ERROR}`);
      }
    });
  }

  private async switchToWork(
    sessionId: string,
    incognito: boolean,
    frame: WorkTargetFrame,
  ): Promise<Ack> {
    const stored: StoredWorkTarget | null = parseStoredWorkTarget(await this.ports.read());
    this.current(sessionId);
    if (stored?.sessionId !== sessionId || stored.incognito !== incognito)
      return failure(CHOOSE_WORK_TAB_ERROR);
    const tab: chrome.tabs.Tab = await this.ports.tab(stored.tabId);
    if (!this.suitable(tab, this.current(sessionId), incognito))
      return failure(CHOOSE_WORK_TAB_ERROR);
    const released: Ack = await this.releaseGate(frame);
    if (!released.ok) return released;
    this.current(sessionId);
    const latest: chrome.tabs.Tab = await this.ports.tab(stored.tabId);
    if (!this.suitable(latest, this.current(sessionId), incognito))
      return failure(CHOOSE_WORK_TAB_ERROR);
    await this.ports.activate(stored.tabId);
    this.current(sessionId);
    await this.ports.focus(latest.windowId);
    this.current(sessionId);
    return { ok: true };
  }

  /** No gate is nothing to do. A gate that closed under us is the same. Anything else is a refusal. */
  private async releaseGate(frame: WorkTargetFrame): Promise<Ack> {
    const gate: GateState | null = frame.gate();
    if (gate === null) return { ok: true };
    const cleared: CommandResponseV2<SessionCommandResultCodeV2> = await frame.abandonGate(gate);
    if (cleared.ok || cleared.code === 'no-active-gate') return { ok: true };
    return failure(gateFailureMessage(cleared.code));
  }

  private error(error: unknown): string {
    return error instanceof Error ? error.message : t('notify_work_tab_unavailable');
  }
}

export function chromeWorkTargetPorts(
  engine: Pick<WorkTargetEngine, 'workTargetSession'>,
): WorkTargetPorts {
  return {
    extensionId: chrome.runtime.id,
    popupUrl: chrome.runtime.getURL('src/popup/popup.html'),
    read: async (): Promise<unknown> =>
      (await chrome.storage.session.get(SESSION_WORK_TARGET))[SESSION_WORK_TARGET],
    write: (value: StoredWorkTarget): Promise<void> =>
      chrome.storage.session.set({ [SESSION_WORK_TARGET]: value }),
    tabs: (): Promise<chrome.tabs.Tab[]> => chrome.tabs.query({}),
    tab: (tabId: number): Promise<chrome.tabs.Tab> => chrome.tabs.get(tabId),
    window: (windowId: number): Promise<chrome.windows.Window> => chrome.windows.get(windowId),
    activate: async (tabId: number): Promise<void> => {
      await chrome.tabs.update(tabId, { active: true });
    },
    focus: async (windowId: number): Promise<void> => {
      await chrome.windows.update(windowId, { focused: true });
    },
    broadcast: (): void =>
      broadcastWorkTargetChanged(engine.workTargetSession()?.sessionId ?? null),
  };
}

interface PendingNotification {
  sessionId: string;
  allTargets: boolean;
  tabIds: Set<number>;
}

let pendingNotification: PendingNotification | null = null;
let notificationScheduled: boolean = false;
let latestSessionId: string | null = null;

/**
 * Extension pages hear it at once. Content documents hear it 25 ms later, coalesced, and only
 * when the stored target belongs to the session that is still live and one of the changed tabs
 * is that target, so a busy browser does not fan out on every title change of every tab.
 */
export function broadcastWorkTargetChanged(sessionId: string | null, tabId?: number): void {
  void chrome.runtime.sendMessage({ type: 'workTargetChanged' }).catch((): void => undefined);
  latestSessionId = sessionId;
  if (sessionId === null) return;
  if (pendingNotification?.sessionId !== sessionId) {
    pendingNotification = { sessionId, allTargets: false, tabIds: new Set<number>() };
  }
  if (tabId === undefined) pendingNotification.allTargets = true;
  else pendingNotification.tabIds.add(tabId);
  scheduleNotification();
}

function scheduleNotification(): void {
  if (notificationScheduled || pendingNotification === null) return;
  notificationScheduled = true;
  setTimeout((): void => {
    void flushNotification()
      .catch((): void => undefined)
      .finally((): void => {
        notificationScheduled = false;
        scheduleNotification();
      });
  }, 25);
}

async function flushNotification(): Promise<void> {
  const notification: PendingNotification | null = pendingNotification;
  pendingNotification = null;
  if (notification === null || latestSessionId !== notification.sessionId) return;
  const stored: StoredWorkTarget | null = parseStoredWorkTarget(
    (await chrome.storage.session.get(SESSION_WORK_TARGET))[SESSION_WORK_TARGET],
  );
  if (
    stored?.sessionId !== notification.sessionId ||
    latestSessionId !== notification.sessionId ||
    (!notification.allTargets && !notification.tabIds.has(stored.tabId))
  )
    return;
  const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({});
  if (latestSessionId !== notification.sessionId) return;
  await Promise.all(
    tabs
      .filter((tab: chrome.tabs.Tab): boolean => tab.id !== undefined)
      .map(async (tab: chrome.tabs.Tab): Promise<void> => {
        await chrome.tabs
          .sendMessage(tab.id as number, { type: 'workTargetChanged' })
          .catch((): void => undefined);
      }),
  );
}

/** The tab events that can change a picker's list or the chosen tab's title and address. */
export function registerWorkTargetListeners(
  currentSessionId: () => string | null,
  broadcast: (sessionId: string | null, tabId?: number) => void = broadcastWorkTargetChanged,
): void {
  chrome.tabs.onUpdated.addListener((tabId: number, change: chrome.tabs.OnUpdatedInfo): void => {
    if (change.url !== undefined || change.title !== undefined || change.status === 'complete')
      broadcast(currentSessionId(), tabId);
  });
  chrome.tabs.onCreated.addListener((tab: chrome.tabs.Tab): void => {
    if (tab.id !== undefined) broadcast(currentSessionId(), tab.id);
  });
  chrome.tabs.onRemoved.addListener((tabId: number): void => broadcast(currentSessionId(), tabId));
  chrome.tabs.onReplaced.addListener((_addedTabId: number, removedTabId: number): void =>
    broadcast(currentSessionId(), removedTabId),
  );
}
