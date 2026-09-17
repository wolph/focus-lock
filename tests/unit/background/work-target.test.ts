import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { Engine, type EnginePorts } from '../../../src/background/engine';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import { type WorkTabIconPorts, WorkTabIconService } from '../../../src/background/work-tab-icons';
import {
  type WorkSession,
  type WorkTargetEngine,
  type WorkTargetFrame,
  type WorkTargetPolicy,
  type WorkTargetPorts,
  WorkTargetService,
} from '../../../src/background/work-target';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../../src/shared/constants';
import { exactDataEqual } from '../../../src/shared/exact-data';
import { t } from '../../../src/shared/i18n';
import type {
  Ack,
  CommandResponseV2,
  SessionCommandResultCodeV2,
  StartSessionResponseV2,
} from '../../../src/shared/messages';
import type {
  GateState,
  ListsConfig,
  SessionConfigV2,
  SessionMode,
  SessionRuleSnapshot,
} from '../../../src/shared/types';
import type { WorkTabsResult } from '../../../src/shared/work-target';
import { engineSeamPortsV2, uuidMinterV2 } from './engine-ports-fake';
import { OTHER_SESSION_ID, SESSION_ID } from './runtime-v2-fixtures';

const NEW_SESSION_ID: string = '10000000-0000-4000-8000-000000000003';
const RULES: SessionRuleSnapshot = rulesFromLists(DEFAULT_LISTS);
const CHOOSE_TARGET: string = 'Choose an available work tab.';
const PAUSE_GATE: GateState = {
  kind: 'pause',
  host: null,
  openedAt: 1,
  readyAt: 2,
  requiredPhrase: null,
  forceEndAvailable: false,
};
const popup: chrome.runtime.MessageSender = {
  id: 'extension',
  url: 'chrome-extension://extension/src/popup/popup.html',
};
const config: SessionConfigV2 = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'timed', minutes: 25 },
  cycling: null,
  intention: '',
  source: 'manual',
  scheduleOccurrence: null,
  rules: RULES,
};
function tab(id: number, url: string, incognito: boolean = false): chrome.tabs.Tab {
  return { id, url, title: `Tab ${id}`, incognito, windowId: incognito ? 2 : 1 } as chrome.tabs.Tab;
}
function workSession(sessionId: string, mode: SessionMode = 'blacklist'): WorkSession {
  return { sessionId, mode, rules: RULES };
}

describe('work targets', (): void => {
  let session: WorkSession | null;
  let openGate: GateState | null;
  let stored: unknown;
  let tabs: chrome.tabs.Tab[];
  let calls: string[];
  let draftRules: Array<SessionRuleSnapshot | undefined>;
  let frame: WorkTargetFrame;
  let engine: WorkTargetEngine;
  let ports: WorkTargetPorts;
  let service: WorkTargetService;
  beforeEach((): void => {
    session = workSession(SESSION_ID);
    openGate = null;
    stored = undefined;
    tabs = [
      tab(1, 'https://work.example'),
      tab(2, 'https://blocked.example'),
      tab(3, 'chrome://settings'),
      tab(4, 'https://private.example', true),
    ];
    calls = [];
    draftRules = [];
    frame = {
      gate: (): GateState | null => openGate,
      abandonGate: async (
        expected: GateState,
      ): Promise<CommandResponseV2<SessionCommandResultCodeV2>> => {
        calls.push('gate');
        if (!exactDataEqual(openGate, expected))
          return { ok: false, code: 'no-active-gate', error: 'no-active-gate' };
        openGate = null;
        return { ok: true, code: 'ok' };
      },
    };
    engine = {
      workTargetSession: (): WorkSession | null => session,
      workTargetDraftPolicy: (mode: SessionMode, rules?: SessionRuleSnapshot): WorkTargetPolicy => {
        draftRules.push(rules);
        return { mode, rules: rules ?? RULES };
      },
      workTargetAllowed: (url: string, policy: WorkTargetPolicy): boolean =>
        policy.mode === 'blacklist' ? !url.includes('blocked') : url.includes('work'),
      runWorkTargetAction: async (
        _id: string,
        action: (frame: WorkTargetFrame) => Promise<Ack>,
      ): Promise<Ack> => action(frame),
      startSession: async (
        started: SessionConfigV2,
        afterStart?: (id: string) => Promise<Ack>,
      ): Promise<StartSessionResponseV2> => {
        session = { sessionId: NEW_SESSION_ID, mode: started.mode, rules: started.rules };
        if (afterStart === undefined) return { ok: true, code: 'ok' };
        const saved: Ack = await afterStart(NEW_SESSION_ID);
        return saved.ok
          ? { ok: true, code: 'ok' }
          : { ok: false, code: 'work-target-not-saved', error: saved.error };
      },
    };
    ports = {
      extensionId: 'extension',
      popupUrl: popup.url as string,
      read: async (): Promise<unknown> => stored,
      write: async (value: unknown): Promise<void> => {
        stored = value;
      },
      tabs: async (): Promise<chrome.tabs.Tab[]> => tabs,
      tab: async (id: number): Promise<chrome.tabs.Tab> => {
        const found: chrome.tabs.Tab | undefined = tabs.find(
          (item: chrome.tabs.Tab): boolean => item.id === id,
        );
        if (found === undefined) throw new Error('missing');
        return found;
      },
      window: async (id: number): Promise<chrome.windows.Window> =>
        ({ id, incognito: id === 2 }) as chrome.windows.Window,
      activate: async (id: number): Promise<void> => {
        calls.push(`tab:${id}`);
      },
      focus: async (id: number): Promise<void> => {
        calls.push(`window:${id}`);
      },
      broadcast: vi.fn(),
    };
    service = new WorkTargetService(engine, ports);
  });
  it('serves icons only to current trusted content for a suitable tab without activation', async (): Promise<void> => {
    const encoded: string =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Tf8AAAAASUVORK5CYII=';
    const fetch: Mock<WorkTabIconPorts['fetch']> = vi.fn(
      async (): Promise<Response> =>
        new Response(
          Uint8Array.from(atob(encoded), (value: string): number => value.charCodeAt(0)),
        ),
    );
    const icons: WorkTabIconService = new WorkTabIconService({
      url: (url: string): string => url,
      fetch,
    });
    service = new WorkTargetService(engine, ports, icons);
    const content: chrome.runtime.MessageSender = {
      id: 'extension',
      url: tabs[1]?.url,
      tab: { ...tabs[1] } as chrome.tabs.Tab,
      frameId: 0,
    };
    expect(await service.getWorkTabIcon(SESSION_ID, 1, content)).toEqual({
      ok: true,
      icon: `data:image/png;base64,${encoded}`,
    });
    for (const sender of [
      popup,
      { ...content, id: 'other' },
      { ...content, frameId: 1 },
      { ...content, url: 'https://changed.example' },
    ])
      expect(await service.getWorkTabIcon(SESSION_ID, 1, sender)).toMatchObject({ ok: false });
    for (const id of [2, 3, 4, 99])
      expect(await service.getWorkTabIcon(SESSION_ID, id, content)).toMatchObject({ ok: false });
    expect(await service.getWorkTabIcon(OTHER_SESSION_ID, 1, content)).toMatchObject({
      ok: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
    expect(stored).toBeUndefined();
    expect(ports.broadcast).not.toHaveBeenCalled();
  });
  it.each(['source', 'session', 'policy', 'privacy', 'destination'])(
    'revalidates %s after fetching an icon',
    async (changed: string): Promise<void> => {
      const content: chrome.runtime.MessageSender = {
        id: 'extension',
        url: tabs[1]?.url,
        tab: { ...tabs[1] } as chrome.tabs.Tab,
        frameId: 0,
      };
      const icons: WorkTabIconService = new WorkTabIconService({
        url: (url: string): string => url,
        fetch: async (): Promise<Response> => {
          if (changed === 'source') tabs[1] = tab(2, 'https://changed.example');
          if (changed === 'session') session = null;
          if (changed === 'policy') session = workSession(SESSION_ID, 'whitelist');
          if (changed === 'policy') engine.workTargetAllowed = (): boolean => false;
          if (changed === 'privacy') tabs[0] = tab(1, 'https://work.example', true);
          if (changed === 'destination') tabs[0] = tab(1, 'https://changed.example');
          return new Response(new Uint8Array([1, 2, 3]));
        },
      });
      service = new WorkTargetService(engine, ports, icons);
      expect(await service.getWorkTabIcon(SESSION_ID, 1, content)).toMatchObject({ ok: false });
      expect(calls).toEqual([]);
    },
  );
  it('lists only eligible HTTP tabs in the popup context', async (): Promise<void> => {
    expect(await service.getWorkTabs('blacklist', 1, undefined, popup)).toEqual({
      ok: true,
      tabs: [{ tabId: 1, title: 'Tab 1', hostname: 'work.example' }],
    });
    expect(await service.getWorkTabs('whitelist', 2, undefined, popup)).toEqual({
      ok: true,
      tabs: [],
    });
  });
  it('lists the pre-start candidates under the supplied rules or the saved lists', async (): Promise<void> => {
    const custom: SessionRuleSnapshot = rulesFromLists({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'news.example' }],
    });
    expect(await service.getWorkTabs('blacklist', 1, custom, popup)).toMatchObject({ ok: true });
    expect(await service.getWorkTabs('blacklist', 1, undefined, popup)).toMatchObject({ ok: true });
    expect(draftRules).toEqual([custom, undefined]);
  });
  it('orders eligible tabs by MRU with unknown timestamps last and stable ties', async (): Promise<void> => {
    tabs = [
      tab(1, 'https://work.example'),
      { ...tab(5, 'https://five.example'), lastAccessed: 20 },
      { ...tab(6, 'https://six.example'), lastAccessed: 10 },
      { ...tab(7, 'https://seven.example'), lastAccessed: 20 },
    ];
    const result: WorkTabsResult = await service.getWorkTabs('blacklist', 1, undefined, popup);
    expect(result).toEqual({
      ok: true,
      tabs: [
        { tabId: 5, title: 'Tab 5', hostname: 'five.example', lastAccessed: 20 },
        { tabId: 7, title: 'Tab 7', hostname: 'seven.example', lastAccessed: 20 },
        { tabId: 6, title: 'Tab 6', hostname: 'six.example', lastAccessed: 10 },
        { tabId: 1, title: 'Tab 1', hostname: 'work.example' },
      ],
    });
    stored = { sessionId: SESSION_ID, tabId: 1, incognito: false };
    expect(await service.getWorkTarget(1, popup)).toEqual({
      ok: true,
      sessionId: SESSION_ID,
      state: 'ready',
      title: 'Tab 1',
      hostname: 'work.example',
    });
  });
  it('projects only hostname alongside the title and tab identity', async (): Promise<void> => {
    tabs[0] = tab(1, 'https://work.example/private/report?token=private#section');
    expect(await service.getWorkTabs('blacklist', 1, undefined, popup)).toEqual({
      ok: true,
      tabs: [{ tabId: 1, title: 'Tab 1', hostname: 'work.example' }],
    });
  });
  it('rejects popup-shaped content requests and other extension pages', async (): Promise<void> => {
    const content: chrome.runtime.MessageSender = {
      id: 'extension',
      url: tabs[0]?.url,
      tab: tabs[0],
    };
    expect(await service.getWorkTabs('blacklist', 1, undefined, content)).toMatchObject({
      ok: false,
    });
    expect(await service.setWorkTarget(SESSION_ID, 1, 1, content)).toMatchObject({ ok: false });
    expect(
      await service.getWorkTabs('blacklist', 1, undefined, {
        ...popup,
        url: 'chrome-extension://extension/src/options/options.html',
      }),
    ).toMatchObject({ ok: false });
  });
  it('lists and selects from trusted content using the live session policy', async (): Promise<void> => {
    const content: chrome.runtime.MessageSender = {
      id: 'extension',
      url: tabs[1]?.url,
      tab: tabs[1],
      frameId: 0,
    };
    tabs.push(tab(5, 'https://other.example'));
    session = workSession(SESSION_ID, 'whitelist');
    expect(await service.getContentWorkTabs(SESSION_ID, content)).toEqual({
      ok: true,
      tabs: [{ tabId: 1, title: 'Tab 1', hostname: 'work.example' }],
    });
    expect(await service.setWorkTarget(SESSION_ID, 1, undefined, content)).toEqual({ ok: true });
    expect(stored).toEqual({ sessionId: SESSION_ID, tabId: 1, incognito: false });
    expect(await service.setWorkTarget(SESSION_ID, 5, undefined, content)).toMatchObject({
      ok: false,
    });
    expect(await service.setWorkTarget(OTHER_SESSION_ID, 1, undefined, content)).toMatchObject({
      ok: false,
    });
    expect(calls).toEqual([]);
  });
  it('rejects stale content lists and untrusted frame or privacy contexts', async (): Promise<void> => {
    const content: chrome.runtime.MessageSender = {
      id: 'extension',
      url: tabs[1]?.url,
      tab: tabs[1],
      frameId: 0,
    };
    expect(await service.getContentWorkTabs(OTHER_SESSION_ID, content)).toMatchObject({
      ok: false,
    });
    for (const unsafe of [
      { ...content, frameId: 1 },
      { ...content, id: 'other' },
      { ...content, url: 'https://changed.example' },
      { ...content, tab: { ...(tabs[1] as chrome.tabs.Tab), incognito: true } },
      popup,
    ]) {
      expect(await service.getContentWorkTabs(SESSION_ID, unsafe)).toMatchObject({ ok: false });
      expect(await service.setWorkTarget(SESSION_ID, 1, undefined, unsafe)).toMatchObject({
        ok: false,
      });
    }
    expect(await service.setWorkTarget(SESSION_ID, 4, undefined, content)).toMatchObject({
      ok: false,
    });
    ports.tabs = async (): Promise<chrome.tabs.Tab[]> => {
      session = workSession(OTHER_SESSION_ID);
      return tabs;
    };
    expect(await service.getContentWorkTabs(SESSION_ID, content)).toMatchObject({ ok: false });
    expect(stored).toBeUndefined();
  });
  it('persists only session identity, tab identity and privacy context across worker wake', async (): Promise<void> => {
    expect(await service.setWorkTarget(SESSION_ID, 1, 1, popup)).toEqual({ ok: true });
    expect(stored).toEqual({ sessionId: SESSION_ID, tabId: 1, incognito: false });
    const restarted: WorkTargetService = new WorkTargetService(engine, ports);
    expect(await restarted.getWorkTarget(1, popup)).toEqual({
      ok: true,
      sessionId: SESSION_ID,
      state: 'ready',
      title: 'Tab 1',
      hostname: 'work.example',
    });
    stored = undefined;
    expect(await restarted.getWorkTarget(1, popup)).toMatchObject({ state: 'missing' });
  });
  it('clears an open gate then activates the existing target and its window without navigation', async (): Promise<void> => {
    await service.setWorkTarget(SESSION_ID, 1, 1, popup);
    openGate = PAUSE_GATE;
    const content: chrome.runtime.MessageSender = {
      id: 'extension',
      url: tabs[1]?.url,
      tab: tabs[1],
      frameId: 0,
    };
    expect(await service.returnToWork(SESSION_ID, undefined, content)).toEqual({ ok: true });
    expect(calls).toEqual(['gate', 'tab:1', 'window:1']);
    expect(openGate).toBeNull();
  });
  it('switches without a gate command when no gate is open', async (): Promise<void> => {
    await service.setWorkTarget(SESSION_ID, 1, 1, popup);
    expect(await service.returnToWork(SESSION_ID, 1, popup)).toEqual({ ok: true });
    expect(calls).toEqual(['tab:1', 'window:1']);
  });
  it('reports a gate the worker could not close and leaves the tabs alone', async (): Promise<void> => {
    await service.setWorkTarget(SESSION_ID, 1, 1, popup);
    openGate = PAUSE_GATE;
    frame.abandonGate = async (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> => ({
      ok: false,
      code: 'transition-cleanup-pending',
      error: 'transition-cleanup-pending',
    });
    expect(await service.returnToWork(SESSION_ID, 1, popup)).toEqual({
      ok: false,
      error: t('notify_work_gate_busy'),
    });
    expect(calls).toEqual([]);
  });
  it('rejects stale sessions, blocked targets, closed tabs and crossed privacy contexts', async (): Promise<void> => {
    await service.setWorkTarget(SESSION_ID, 1, 1, popup);
    expect(await service.returnToWork(OTHER_SESSION_ID, 1, popup)).toMatchObject({ ok: false });
    expect(await service.returnToWork(SESSION_ID, 2, popup)).toMatchObject({ ok: false });
    tabs[0] = tab(1, 'https://blocked.example');
    expect(await service.getWorkTarget(1, popup)).toMatchObject({ state: 'unavailable' });
    expect(await service.returnToWork(SESSION_ID, 1, popup)).toMatchObject({ ok: false });
    tabs.shift();
    expect(await service.returnToWork(SESSION_ID, 1, popup)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
  it('does not leak a selected private title into normal content', async (): Promise<void> => {
    await service.setWorkTarget(SESSION_ID, 4, 2, popup);
    expect(await service.getWorkTarget(1, popup)).toMatchObject({
      state: 'unavailable',
      title: null,
    });
  });
  it('starts with a work tab and saves it for the minted session', async (): Promise<void> => {
    expect(await service.startSession(config, 1, 1, popup)).toEqual({ ok: true, code: 'ok' });
    expect(stored).toEqual({ sessionId: NEW_SESSION_ID, tabId: 1, incognito: false });
    expect(ports.broadcast).toHaveBeenCalledOnce();
  });
  it('refuses a work tab the draft rules block before anything starts', async (): Promise<void> => {
    expect(await service.startSession(config, 2, 1, popup)).toEqual({
      ok: false,
      code: 'invalid-request',
      error: CHOOSE_TARGET,
    });
    expect(session?.sessionId).toBe(SESSION_ID);
    expect(stored).toBeUndefined();
  });
  it('reports a started session accurately when target persistence fails', async (): Promise<void> => {
    ports.write = async (): Promise<void> => {
      throw new Error('storage failed');
    };
    expect(await service.startSession(config, 1, 1, popup)).toEqual({
      ok: false,
      code: 'work-target-not-saved',
      error: `Session started, but the work tab could not be saved. ${CHOOSE_TARGET}`,
    });
    expect(session?.sessionId).toBe(NEW_SESSION_ID);
  });
  it('rejects a stale selection after asynchronous tab lookup changes the session', async (): Promise<void> => {
    ports.tab = async (): Promise<chrome.tabs.Tab> => {
      session = workSession(OTHER_SESSION_ID);
      return tabs[0] as chrome.tabs.Tab;
    };
    expect(await service.setWorkTarget(SESSION_ID, 1, 1, popup)).toMatchObject({ ok: false });
    expect(stored).toBeUndefined();
  });
  it('reports a stale return when the session changes during window focus', async (): Promise<void> => {
    await service.setWorkTarget(SESSION_ID, 1, 1, popup);
    ports.focus = async (): Promise<void> => {
      session = null;
    };
    expect(await service.returnToWork(SESSION_ID, 1, popup)).toMatchObject({ ok: false });
  });
  it('returns the current session after a target lookup fails during a session change', async (): Promise<void> => {
    await service.setWorkTarget(SESSION_ID, 1, 1, popup);
    ports.tab = async (): Promise<chrome.tabs.Tab> => {
      session = workSession(OTHER_SESSION_ID);
      throw new Error('tab closed');
    };
    expect(await service.getWorkTarget(1, popup)).toEqual({
      ok: true,
      sessionId: OTHER_SESSION_ID,
      state: 'missing',
      title: null,
    });
  });
  it('explains a closed selection without exposing browser tab identifiers', async (): Promise<void> => {
    ports.tab = async (): Promise<chrome.tabs.Tab> => {
      throw new Error('No tab with id: 7.');
    };
    expect(await service.setWorkTarget(SESSION_ID, 7, 1, popup)).toEqual({
      ok: false,
      error: 'That tab is no longer available. Choose another work tab.',
    });
    expect(stored).toBeUndefined();
    expect(calls).toEqual([]);
  });
  it('serialises competing selections so the last request wins', async (): Promise<void> => {
    tabs.push(tab(5, 'https://second.example'));
    const results: Ack[] = await Promise.all([
      service.setWorkTarget(SESSION_ID, 1, 1, popup),
      service.setWorkTarget(SESSION_ID, 5, 1, popup),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(stored).toMatchObject({ tabId: 5 });
  });
});

describe('Chrome work target ports', (): void => {
  it('uses only session storage and pushes refresh messages without enforcement sweeps', async (): Promise<void> => {
    const set: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const get: ReturnType<typeof vi.fn> = vi
      .fn()
      .mockResolvedValue({ workTarget: { sessionId: 's', tabId: 7, incognito: false } });
    const sendMessage: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'extension',
        getURL: (path: string): string => `chrome-extension://extension/${path}`,
        sendMessage,
      },
      storage: { session: { get, set } },
      tabs: { query: vi.fn().mockResolvedValue([tab(7, 'https://work.example')]), sendMessage },
    });
    const { chromeWorkTargetPorts }: typeof import('../../../src/background/work-target') =
      await import('../../../src/background/work-target');
    const browserPorts: WorkTargetPorts = chromeWorkTargetPorts({
      workTargetSession: (): WorkSession => workSession('s'),
    });
    expect(await browserPorts.read()).toMatchObject({ tabId: 7 });
    await browserPorts.write({ sessionId: 's', tabId: 7, incognito: false });
    expect(set).toHaveBeenCalledWith({
      workTarget: { sessionId: 's', tabId: 7, incognito: false },
    });
    browserPorts.broadcast();
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 35);
    });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'workTargetChanged' });
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'workTargetChanged' });
    vi.unstubAllGlobals();
  });
});

it('refreshes mounted interfaces for relevant tab changes only', async (): Promise<void> => {
  const events: Record<string, (...args: unknown[]) => void> = {};
  const broadcast: ReturnType<typeof vi.fn<() => void>> = vi.fn<() => void>();
  const event: (name: string) => { addListener: (listener: (...args: unknown[]) => void) => void } =
    (name: string): { addListener: (listener: (...args: unknown[]) => void) => void } => ({
      addListener: (listener: (...args: unknown[]) => void): void => {
        events[name] = listener;
      },
    });
  vi.stubGlobal('chrome', {
    tabs: {
      onUpdated: event('updated'),
      onCreated: event('created'),
      onRemoved: event('removed'),
      onReplaced: event('replaced'),
    },
  });
  const { registerWorkTargetListeners }: typeof import('../../../src/background/work-target') =
    await import('../../../src/background/work-target');
  registerWorkTargetListeners((): string => 's', broadcast);
  events.updated?.(1, { status: 'loading' });
  expect(broadcast).not.toHaveBeenCalled();
  events.updated?.(1, { url: 'https://work.example' });
  events.updated?.(1, { title: 'New title' });
  events.created?.(tab(1, 'https://work.example'));
  events.removed?.(1);
  events.replaced?.(2, 1);
  expect(broadcast).toHaveBeenCalledTimes(5);
  vi.unstubAllGlobals();
});

describe('work target notification fanout', (): void => {
  it.each([
    { label: 'idle', sessionId: null, storedSessionId: null, changedTabId: 7, expectedFanout: 0 },
    {
      label: 'active without a target',
      sessionId: 'active',
      storedSessionId: null,
      changedTabId: 7,
      expectedFanout: 0,
    },
    {
      label: 'stale stored target',
      sessionId: 'active',
      storedSessionId: 'old',
      changedTabId: 7,
      expectedFanout: 0,
    },
    {
      label: 'unrelated tab',
      sessionId: 'active',
      storedSessionId: 'active',
      changedTabId: 8,
      expectedFanout: 0,
    },
    {
      label: 'selected tab',
      sessionId: 'active',
      storedSessionId: 'active',
      changedTabId: 7,
      expectedFanout: 100,
    },
  ])(
    'coalesces title updates for $label',
    async ({
      sessionId,
      storedSessionId,
      changedTabId,
      expectedFanout,
    }: {
      sessionId: string | null;
      storedSessionId: string | null;
      changedTabId: number;
      expectedFanout: number;
    }): Promise<void> => {
      let onUpdated: ((tabId: number, change: chrome.tabs.OnUpdatedInfo) => void) | undefined;
      const runtimeMessage: ReturnType<typeof vi.fn<() => Promise<void>>> = vi
        .fn<() => Promise<void>>()
        .mockResolvedValue(undefined);
      const contentMessage: ReturnType<typeof vi.fn<() => Promise<void>>> = vi
        .fn<() => Promise<void>>()
        .mockResolvedValue(undefined);
      const query: ReturnType<typeof vi.fn<() => Promise<chrome.tabs.Tab[]>>> = vi
        .fn<() => Promise<chrome.tabs.Tab[]>>()
        .mockResolvedValue(
          Array.from(
            { length: 100 },
            (_: unknown, index: number): chrome.tabs.Tab => tab(index, 'https://work.example'),
          ),
        );
      vi.stubGlobal('chrome', {
        runtime: { sendMessage: runtimeMessage },
        storage: {
          session: {
            get: vi.fn().mockResolvedValue({
              workTarget:
                storedSessionId === null
                  ? undefined
                  : { sessionId: storedSessionId, tabId: 7, incognito: false },
            }),
          },
        },
        tabs: {
          query,
          sendMessage: contentMessage,
          onUpdated: {
            addListener: (
              listener: (tabId: number, change: chrome.tabs.OnUpdatedInfo) => void,
            ): void => {
              onUpdated = listener;
            },
          },
          onCreated: { addListener: vi.fn() },
          onRemoved: { addListener: vi.fn() },
          onReplaced: { addListener: vi.fn() },
        },
      });
      const { registerWorkTargetListeners }: typeof import('../../../src/background/work-target') =
        await import('../../../src/background/work-target');
      registerWorkTargetListeners((): string | null => sessionId);
      for (let index: number = 0; index < 3; index++)
        onUpdated?.(changedTabId, { title: `Title ${index}` });
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 35);
      });
      expect(runtimeMessage).toHaveBeenCalledTimes(3);
      expect(contentMessage).toHaveBeenCalledTimes(expectedFanout);
      expect(query).toHaveBeenCalledTimes(expectedFanout === 0 ? 0 : 1);
      vi.unstubAllGlobals();
    },
  );
});

it('coalesces policy notifications and drops a pending fanout when the session ends', async (): Promise<void> => {
  const contentMessage: ReturnType<typeof vi.fn<() => Promise<void>>> = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const query: ReturnType<typeof vi.fn<() => Promise<chrome.tabs.Tab[]>>> = vi
    .fn<() => Promise<chrome.tabs.Tab[]>>()
    .mockResolvedValue([tab(7, 'https://work.example')]);
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    storage: {
      session: {
        get: vi
          .fn()
          .mockResolvedValue({ workTarget: { sessionId: 'active', tabId: 7, incognito: false } }),
      },
    },
    tabs: { query, sendMessage: contentMessage },
  });
  const { broadcastWorkTargetChanged }: typeof import('../../../src/background/work-target') =
    await import('../../../src/background/work-target');
  broadcastWorkTargetChanged('active');
  await Promise.resolve();
  broadcastWorkTargetChanged('active');
  await new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 35);
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(contentMessage).toHaveBeenCalledTimes(1);
  broadcastWorkTargetChanged('active');
  broadcastWorkTargetChanged(null);
  await new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 35);
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(contentMessage).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});

/** The engine fixture boots on one fixed enforcement epoch so its runtime parses. */
const ENGINE_EPOCH_ID: string = '30000000-0000-4000-8000-0000000000b1';
const BLOCKED_HOST: string = 'facebook.com';
const ENGINE_LISTS: ListsConfig = {
  ...DEFAULT_LISTS,
  custom: [{ kind: 'host', pattern: BLOCKED_HOST }],
};

interface EngineHarness {
  engine: Engine;
  setNow(ms: number): void;
  now(): number;
}

async function realEngine(options?: {
  workTargetChanged?: () => void;
  reportError?: (error: unknown) => void;
  bankMs?: number;
}): Promise<EngineHarness> {
  let nowMs: number = new Date(2026, 7, 31, 12, 0).getTime();
  const now: () => number = (): number => nowMs;
  const ports: EnginePorts = {
    now,
    newId: uuidMinterV2(),
    rehydrateAfterDataClear: async (): Promise<string> => 'device-rehydrated',
    saveRuntime: async (): Promise<void> => undefined,
    saveMatcherCache: async (): Promise<void> => undefined,
    queueSync: (): void => undefined,
    supersedeSync: (): void => undefined,
    removeSync: (): void => undefined,
    persistSyncJournal: async (): Promise<void> => undefined,
    appendEvents: async (): Promise<void> => undefined,
    broadcast: (): void => undefined,
    workTargetChanged: options?.workTargetChanged,
    applyBlocking: async (): Promise<void> => undefined,
    playSound: (): void => undefined,
    notify: (): void => undefined,
    updateIcon: (): void => undefined,
    prune: async (): Promise<void> => undefined,
    reportError: options?.reportError ?? ((): void => undefined),
    websiteBlockingReady: (): boolean => true,
    hasPendingSync: (): boolean => false,
    ...engineSeamPortsV2({
      now,
      rememberAlarms: true,
      readTargetGeneration: (): number => 0,
    }),
  };
  const engine: Engine = new Engine(
    ports,
    DEFAULT_SETTINGS,
    ENGINE_LISTS,
    { balanceMs: options?.bankMs ?? 0 },
    null,
    emptyRuntimeV2(nowMs, ENGINE_EPOCH_ID),
    'device-id',
  );
  await engine.recover();
  return {
    engine,
    now,
    setNow: (ms: number): void => {
      nowMs = ms;
    },
  };
}

function engineConfig(): SessionConfigV2 {
  return { ...config, rules: rulesFromLists(ENGINE_LISTS) };
}

describe('the v2 engine work target seam', (): void => {
  it('exposes the live session identity with its captured policy', async (): Promise<void> => {
    const { engine }: EngineHarness = await realEngine();
    expect(engine.workTargetSession()).toBeNull();
    const started: SessionConfigV2 = engineConfig();
    expect(await engine.startSession(started)).toEqual({ ok: true, code: 'ok' });
    const session: WorkSession | null = engine.workTargetSession();
    expect(session).toMatchObject({ mode: 'blacklist', rules: started.rules });
    expect(session?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('evaluates eligibility with the given policy and never with a temporary unlock', async (): Promise<void> => {
    const harness: EngineHarness = await realEngine({ bankMs: 60 * 60_000 });
    const { engine }: EngineHarness = harness;
    expect(await engine.startSession(engineConfig())).toEqual({ ok: true, code: 'ok' });
    const session: WorkSession = engine.workTargetSession() as WorkSession;
    expect(engine.workTargetAllowed(`https://${BLOCKED_HOST}/feed`, session)).toBe(false);
    expect(engine.workTargetAllowed('https://work.example/report', session)).toBe(true);
    expect((await engine.openGate('unlockSite', BLOCKED_HOST)).ok).toBe(true);
    harness.setNow(harness.now() + DEFAULT_SETTINGS.gate.delayMs + 1_000);
    expect(await engine.confirmGate(null)).toEqual({ ok: true, code: 'ok' });
    expect(engine.snapshot().activeUnlocks).toHaveLength(1);
    expect(engine.workTargetAllowed(`https://${BLOCKED_HOST}/feed`, session)).toBe(false);
  });
  it('builds the pre-start policy from the supplied rules or the saved lists', async (): Promise<void> => {
    const { engine }: EngineHarness = await realEngine();
    const saved: WorkTargetPolicy = engine.workTargetDraftPolicy('blacklist');
    expect(saved.rules).toEqual(rulesFromLists(ENGINE_LISTS));
    expect(engine.workTargetAllowed(`https://${BLOCKED_HOST}/feed`, saved)).toBe(false);
    expect(engine.workTargetAllowed('https://news.example/story', saved)).toBe(true);
    const draft: WorkTargetPolicy = engine.workTargetDraftPolicy(
      'blacklist',
      rulesFromLists({ ...DEFAULT_LISTS, custom: [{ kind: 'host', pattern: 'news.example' }] }),
    );
    expect(engine.workTargetAllowed(`https://${BLOCKED_HOST}/feed`, draft)).toBe(true);
    expect(engine.workTargetAllowed('https://news.example/story', draft)).toBe(false);
    expect(
      engine.workTargetAllowed('https://work.example', { mode: 'whitelist', rules: draft.rules }),
    ).toBe(false);
  });
  it('runs a work target action inside the mutation queue for the named session only', async (): Promise<void> => {
    const { engine }: EngineHarness = await realEngine({ bankMs: 60 * 60_000 });
    await engine.startSession(engineConfig());
    const sessionId: string = (engine.workTargetSession() as WorkSession).sessionId;
    const action: Mock<(frame: WorkTargetFrame) => Promise<Ack>> = vi.fn(
      async (): Promise<Ack> => ({ ok: true }),
    );
    expect(await engine.runWorkTargetAction(OTHER_SESSION_ID, action)).toEqual({
      ok: false,
      error: 'The focus session has changed. Reopen the popup.',
    });
    expect(action).not.toHaveBeenCalled();
    let seenGate: GateState | null = PAUSE_GATE;
    expect(
      await engine.runWorkTargetAction(sessionId, async (frame: WorkTargetFrame): Promise<Ack> => {
        seenGate = frame.gate();
        return { ok: true };
      }),
    ).toEqual({ ok: true });
    expect(seenGate).toBeNull();
    expect((await engine.openGate('pause', null)).ok).toBe(true);
    expect(
      await engine.runWorkTargetAction(sessionId, async (frame: WorkTargetFrame): Promise<Ack> => {
        const gate: GateState | null = frame.gate();
        if (gate === null) return { ok: false, error: 'no gate' };
        const cleared: CommandResponseV2<SessionCommandResultCodeV2> =
          await frame.abandonGate(gate);
        return cleared.ok ? { ok: true } : { ok: false, error: cleared.code };
      }),
    ).toEqual({ ok: true });
    expect(engine.snapshot().gate).toBeNull();
    expect(engine.hasActiveSession()).toBe(true);
  });
  it('hands the minted session id to the after-start hook inside the start frame', async (): Promise<void> => {
    const { engine }: EngineHarness = await realEngine();
    const seen: string[] = [];
    expect(
      await engine.startSession(engineConfig(), async (sessionId: string): Promise<Ack> => {
        seen.push(sessionId);
        return { ok: true };
      }),
    ).toEqual({ ok: true, code: 'ok' });
    expect(seen).toEqual([(engine.workTargetSession() as WorkSession).sessionId]);
  });
  it('reports a saved-tab failure as its own start code while the session stays live', async (): Promise<void> => {
    const reportError: Mock<(error: unknown) => void> = vi.fn();
    const { engine }: EngineHarness = await realEngine({ reportError });
    expect(
      await engine.startSession(
        engineConfig(),
        async (): Promise<Ack> => ({ ok: false, error: 'storage failed' }),
      ),
    ).toEqual({ ok: false, code: 'work-target-not-saved', error: 'storage failed' });
    expect(engine.hasActiveSession()).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
    const second: EngineHarness = await realEngine({ reportError });
    expect(
      await second.engine.startSession(engineConfig(), async (): Promise<Ack> => {
        throw new Error('hook exploded');
      }),
    ).toEqual({
      ok: false,
      code: 'work-target-not-saved',
      error: `Session started, but the work tab could not be saved. ${CHOOSE_TARGET}`,
    });
    expect(second.engine.hasActiveSession()).toBe(true);
    expect(reportError).toHaveBeenCalledOnce();
  });
  it('does not run the after-start hook when the start is refused', async (): Promise<void> => {
    const { engine }: EngineHarness = await realEngine();
    await engine.startSession(engineConfig());
    const hook: Mock<(sessionId: string) => Promise<Ack>> = vi.fn(
      async (): Promise<Ack> => ({ ok: true }),
    );
    const response: StartSessionResponseV2 = await engine.startSession(engineConfig(), hook);
    expect(response.ok).toBe(false);
    expect(hook).not.toHaveBeenCalled();
  });
  it('publishes a work target change on every session publish and after a lists change', async (): Promise<void> => {
    const changed: Mock<() => void> = vi.fn();
    const { engine }: EngineHarness = await realEngine({ workTargetChanged: changed });
    // Recovery publishes once, so the pickers refresh on boot as well.
    expect(changed).toHaveBeenCalledTimes(1);
    changed.mockClear();
    expect(await engine.updateLists(DEFAULT_LISTS)).toEqual({ ok: true });
    expect(changed).toHaveBeenCalledTimes(1);
    changed.mockClear();
    expect(await engine.startSession({ ...config, rules: rulesFromLists(DEFAULT_LISTS) })).toEqual({
      ok: true,
      code: 'ok',
    });
    expect(changed).toHaveBeenCalled();
  });
});
