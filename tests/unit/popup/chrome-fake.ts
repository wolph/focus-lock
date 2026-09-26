/**
 * Minimal chrome global fake for popup component tests. Import this module
 * first in every popup test so globalThis.chrome exists before the code
 * under test loads.
 */
import { type Mock, vi } from 'vitest';

type MessageListener = (msg: unknown) => void;
type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

export const sendMessageMock: Mock = vi.fn();
export const openOptionsPageMock: Mock = vi.fn();
export const tabsCreateMock: Mock = vi.fn();
export const tabsQueryMock: Mock = vi.fn(async (): Promise<unknown[]> => []);
export const windowsGetCurrentMock: Mock = vi.fn(async (): Promise<unknown> => ({ id: 3 }));
export const permissionsRequestMock: Mock = vi.fn(async (): Promise<boolean> => false);

export const messageListeners: MessageListener[] = [];
export const storageChangeListeners: StorageChangeListener[] = [];

/** The popup's own local storage, which starts empty for every test. */
export const localStore: Map<string, unknown> = new Map<string, unknown>();

/** Push a worker broadcast through every captured onMessage listener. */
export function emitMessage(msg: unknown): void {
  for (const listener of [...messageListeners]) {
    listener(msg);
  }
}

/** Push one storage write through every captured onChanged listener. */
export function emitStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string = 'local',
): void {
  for (const listener of [...storageChangeListeners]) {
    listener(changes, areaName);
  }
}

export function resetChromeFake(): void {
  sendMessageMock.mockReset();
  openOptionsPageMock.mockReset();
  tabsCreateMock.mockReset();
  tabsQueryMock.mockReset();
  tabsQueryMock.mockResolvedValue([]);
  windowsGetCurrentMock.mockReset();
  windowsGetCurrentMock.mockResolvedValue({ id: 3 });
  permissionsRequestMock.mockReset();
  permissionsRequestMock.mockResolvedValue(false);
  messageListeners.length = 0;
  storageChangeListeners.length = 0;
  localStore.clear();
}

const chromeFake = {
  runtime: {
    sendMessage: sendMessageMock,
    onMessage: {
      addListener: (listener: MessageListener): void => {
        messageListeners.push(listener);
      },
      removeListener: (listener: MessageListener): void => {
        const index: number = messageListeners.indexOf(listener);
        if (index >= 0) messageListeners.splice(index, 1);
      },
    },
    openOptionsPage: openOptionsPageMock,
    getURL: (path: string): string => `chrome-extension://fake-id/${path}`,
  },
  tabs: {
    create: tabsCreateMock,
    query: tabsQueryMock,
  },
  windows: {
    getCurrent: windowsGetCurrentMock,
  },
  permissions: {
    request: permissionsRequestMock,
  },
  storage: {
    local: {
      get: async (key: string): Promise<Record<string, unknown>> =>
        localStore.has(key) ? { [key]: structuredClone(localStore.get(key)) } : {},
      set: async (items: Record<string, unknown>): Promise<void> => {
        for (const [key, value] of Object.entries(items))
          localStore.set(key, structuredClone(value));
      },
    },
    onChanged: {
      addListener: (listener: StorageChangeListener): void => {
        storageChangeListeners.push(listener);
      },
      removeListener: (listener: StorageChangeListener): void => {
        const index: number = storageChangeListeners.indexOf(listener);
        if (index >= 0) storageChangeListeners.splice(index, 1);
      },
    },
  },
};

// Boundary cast: the fake implements only the slice of chrome the popup uses.
(globalThis as { chrome?: unknown }).chrome = chromeFake;
