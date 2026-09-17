import { t } from './i18n';
import type { Rejection } from './messages';

/** The one answer every ineligible or vanished work tab gets, from the popup and the overlay. */
export const CHOOSE_WORK_TAB_ERROR: string = t('shared_work_choose_tab_error');
export const WORK_TAB_CLOSED_ERROR: string = t('shared_work_tab_closed_error');
/** The `work-target-not-saved` start code carries this when the save itself failed. */
export const WORK_TARGET_NOT_SAVED_ERROR: string = t('shared_work_target_not_saved_error', {
  CHOOSE: CHOOSE_WORK_TAB_ERROR,
});
/** The service found another session than the one the request named. */
export const WORK_SESSION_CHANGED_ERROR: string = t('shared_work_session_changed_error');
/** The engine refused a work target action because the named session is not the live one. */
export const WORK_TARGET_ACTION_STALE_ERROR: string = t('shared_work_target_action_stale_error');

/** One eligible tab as the pickers see it: identity, title and hostname, never the full URL. */
export interface WorkTab {
  tabId: number;
  title: string;
  hostname?: string;
  lastAccessed?: number;
}

/** The chosen work tab, held in `chrome.storage.session` for exactly one focus session. */
export interface StoredWorkTarget {
  sessionId: string;
  tabId: number;
  incognito: boolean;
}

export type WorkTabIconResult = { ok: true; icon: string | null } | Rejection;

export type WorkTabsResult = { ok: true; tabs: WorkTab[] } | Rejection;

/**
 * `missing`: no session, or nothing chosen for the live one. `unavailable`: chosen, but closed,
 * blocked, or in the other privacy context. `ready`: the tab can be switched to now.
 */
export type WorkTargetResult =
  | {
      ok: true;
      sessionId: string | null;
      state: 'ready' | 'missing' | 'unavailable';
      title: string | null;
      hostname?: string;
    }
  | Rejection;

export function isBrowserTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseStoredWorkTarget(value: unknown): StoredWorkTarget | null {
  const record: Record<string, unknown> | null = dataRecord(value);
  if (record === null) return null;
  if (
    Object.keys(record).length !== 3 ||
    typeof record.sessionId !== 'string' ||
    record.sessionId.trim().length === 0 ||
    !isBrowserTabId(record.tabId) ||
    typeof record.incognito !== 'boolean'
  )
    return null;
  return { sessionId: record.sessionId, tabId: record.tabId, incognito: record.incognito };
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return null;
      const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
        value,
        key,
      );
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function exact(record: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key: string): boolean => Object.hasOwn(record, key))
  );
}

function rejection(record: Record<string, unknown>): Rejection | null {
  return record.ok === false &&
    typeof record.error === 'string' &&
    record.error.trim().length > 0 &&
    exact(record, ['ok', 'error'])
    ? { ok: false, error: record.error }
    : null;
}

export function parseWorkTargetResult(value: unknown): WorkTargetResult | null {
  const record: Record<string, unknown> | null = dataRecord(value);
  if (record === null) return null;
  if (record.ok === false) return rejection(record);
  if (
    record.ok !== true ||
    !(
      exact(record, ['ok', 'sessionId', 'state', 'title']) ||
      (record.state === 'ready' &&
        exact(record, ['ok', 'sessionId', 'state', 'title', 'hostname']) &&
        isWorkHostname(record.hostname))
    )
  )
    return null;
  const { sessionId, state, title }: Record<string, unknown> = record;
  if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.trim().length === 0))
    return null;
  if (state === 'ready' && typeof sessionId === 'string' && typeof title === 'string')
    return {
      ok: true,
      sessionId,
      state,
      title,
      ...(Object.hasOwn(record, 'hostname') ? { hostname: record.hostname as string } : {}),
    };
  if ((state === 'missing' || state === 'unavailable') && title === null)
    return { ok: true, sessionId, state, title };
  return null;
}

export function parseWorkTabsResult(value: unknown): WorkTabsResult | null {
  const record: Record<string, unknown> | null = dataRecord(value);
  if (record === null) return null;
  if (record.ok === false) return rejection(record);
  if (record.ok !== true || !exact(record, ['ok', 'tabs']) || !Array.isArray(record.tabs))
    return null;
  const tabs: WorkTab[] = [];
  try {
    for (const value of record.tabs as unknown[]) {
      const tab: Record<string, unknown> | null = dataRecord(value);
      if (
        tab === null ||
        !Object.keys(tab).every((key: string): boolean =>
          ['tabId', 'title', 'hostname', 'lastAccessed'].includes(key),
        ) ||
        (Object.hasOwn(tab, 'hostname') && !isWorkHostname(tab.hostname)) ||
        (Object.hasOwn(tab, 'lastAccessed') && !isWorkLastAccessed(tab.lastAccessed)) ||
        !isBrowserTabId(tab.tabId) ||
        typeof tab.title !== 'string'
      )
        return null;
      tabs.push({
        tabId: tab.tabId,
        title: tab.title,
        ...(Object.hasOwn(tab, 'hostname') ? { hostname: tab.hostname as string } : {}),
        ...(Object.hasOwn(tab, 'lastAccessed') ? { lastAccessed: tab.lastAccessed as number } : {}),
      });
    }
  } catch {
    return null;
  }
  return { ok: true, tabs };
}

/** A bare hostname as the URL parser would print it: no scheme, port, path, query or padding. */
export function isWorkHostname(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false;
  try {
    return new URL(`http://${value}/`).hostname === value;
  } catch {
    return false;
  }
}

export function isWorkLastAccessed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export const MAX_WORK_ICON_BYTES: number = 32 * 1024;
const PNG_PREFIX: string = 'data:image/png;base64,';

/** A PNG signature, an IHDR chunk, and a 1 to 128 pixel square or rectangle within the byte cap. */
export function isWorkIconBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 33 || bytes.length > MAX_WORK_ICON_BYTES) return false;
  const signature: number[] = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  if (!signature.every((value: number, index: number): boolean => bytes[index] === value))
    return false;
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width: number = view.getUint32(16);
  const height: number = view.getUint32(20);
  return width > 0 && width <= 128 && height > 0 && height <= 128;
}

export function parseWorkTabIconResult(value: unknown): WorkTabIconResult | null {
  const record: Record<string, unknown> | null = dataRecord(value);
  if (record === null) return null;
  if (record.ok === false) return rejection(record);
  if (record.ok !== true || !exact(record, ['ok', 'icon'])) return null;
  if (record.icon === null) return { ok: true, icon: null };
  const icon: unknown = record.icon;
  if (
    typeof icon !== 'string' ||
    !icon.startsWith(PNG_PREFIX) ||
    icon.length > PNG_PREFIX.length + 4 * Math.ceil(MAX_WORK_ICON_BYTES / 3)
  )
    return null;
  const encoded: string = icon.slice(PNG_PREFIX.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    return null;
  try {
    const decoded: string = atob(encoded);
    const bytes: Uint8Array = Uint8Array.from(decoded, (character: string): number =>
      character.charCodeAt(0),
    );
    return isWorkIconBytes(bytes) ? { ok: true, icon } : null;
  } catch {
    return null;
  }
}
