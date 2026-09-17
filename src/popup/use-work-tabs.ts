import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../shared/i18n';
import { type Request, sendRequest } from '../shared/messages';
import type { SessionMode, SessionRuleSnapshot, SessionSnapshotV2 } from '../shared/types';
import {
  isBrowserTabId,
  parseWorkTabsResult,
  parseWorkTargetResult,
  type WorkTab,
  type WorkTabsResult,
  type WorkTargetResult,
} from '../shared/work-target';

/** The popup's own window and its active tab, which fix the privacy context of every request. */
export interface WorkContext {
  windowId: number;
  activeTabId: number | null;
}

export interface WorkTabsState {
  loading: boolean;
  context: WorkContext | null;
  tabs: WorkTab[];
  error: string | null;
}

export type WorkTabsRequest = Extract<Request, { type: 'getWorkTabs'; mode: SessionMode }>;

const WORK_TABS_UNAVAILABLE_ERROR: string = t('popup_work_tabs_unavailable');

export async function currentContext(): Promise<WorkContext> {
  const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({ active: true, currentWindow: true });
  const active: chrome.tabs.Tab | undefined = tabs[0];
  const windowId: number | undefined = active?.windowId ?? (await chrome.windows.getCurrent()).id;
  if (!isBrowserTabId(windowId)) throw new Error('No popup window');
  return { windowId, activeTabId: isBrowserTabId(active?.id) ? active.id : null };
}

/**
 * The popup listing: eligible tabs under the draft's rules before a start, or under the live
 * session's captured rules, so the list matches what a start or a save will accept.
 */
export function workTabsRequest(
  mode: SessionMode,
  windowId: number,
  rules: SessionRuleSnapshot | undefined,
): WorkTabsRequest {
  return rules === undefined
    ? { type: 'getWorkTabs', mode, windowId }
    : { type: 'getWorkTabs', mode, windowId, rules };
}

function isWorkNotification(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value.type === 'stateChanged' || value.type === 'workTargetChanged')
  );
}

/**
 * The eligible tabs for `mode` under `rules`, refreshed on every `stateChanged` and
 * `workTargetChanged` broadcast. A generation counter drops answers that arrive out of order.
 */
export function useWorkTabs(mode: SessionMode, rules?: SessionRuleSnapshot): WorkTabsState {
  const [state, setState]: [WorkTabsState, Dispatch<StateUpdater<WorkTabsState>>] =
    useState<WorkTabsState>({ loading: true, context: null, tabs: [], error: null });
  /**
   * A rebased draft and a republished snapshot hand over fresh rule objects with the same
   * content, so the listing is keyed by the rules' value, not their identity.
   */
  const rulesKey: string = rules === undefined ? '' : JSON.stringify(rules);
  const latestRules: { current: SessionRuleSnapshot | undefined } = useRef<
    SessionRuleSnapshot | undefined
  >(rules);
  latestRules.current = rules;
  useEffect((): (() => void) => {
    let generation: number = 0;
    const refresh: () => Promise<void> = async (): Promise<void> => {
      const request: number = ++generation;
      setState((previous: WorkTabsState): WorkTabsState => ({ ...previous, loading: true }));
      try {
        const context: WorkContext = await currentContext();
        const result: WorkTabsResult | null = parseWorkTabsResult(
          await sendRequest(workTabsRequest(mode, context.windowId, latestRules.current)),
        );
        if (request !== generation) return;
        setState({
          loading: false,
          context,
          tabs: result?.ok ? result.tabs : [],
          error: result?.ok ? null : WORK_TABS_UNAVAILABLE_ERROR,
        });
      } catch {
        if (request === generation) {
          setState({ loading: false, context: null, tabs: [], error: WORK_TABS_UNAVAILABLE_ERROR });
        }
      }
    };
    const listener: (value: unknown) => void = (value: unknown): void => {
      if (isWorkNotification(value)) void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    void refresh();
    return (): void => {
      generation += 1;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [mode, rulesKey]);
  return state;
}

export interface WorkTargetState {
  target: WorkTargetResult | null;
  windowId: number | null;
  refresh: () => void;
}

/**
 * Where the live session's work tab stands, re-read on every published snapshot and on every
 * `workTargetChanged` broadcast. The answer carries the session id the return control sends.
 */
export function useWorkTarget(snapshot: SessionSnapshotV2): WorkTargetState {
  const [target, setTarget]: [
    WorkTargetResult | null,
    Dispatch<StateUpdater<WorkTargetResult | null>>,
  ] = useState<WorkTargetResult | null>(null);
  const [windowId, setWindowId]: [number | null, Dispatch<StateUpdater<number | null>>] = useState<
    number | null
  >(null);
  const refreshRef: { current: () => void } = useRef<() => void>((): void => {});
  useEffect((): (() => void) => {
    let generation: number = 0;
    const refresh: () => Promise<void> = async (): Promise<void> => {
      const request: number = ++generation;
      try {
        const context: WorkContext = await currentContext();
        const result: WorkTargetResult | null = parseWorkTargetResult(
          await sendRequest({ type: 'getWorkTarget', windowId: context.windowId }),
        );
        if (request !== generation) return;
        setWindowId(context.windowId);
        setTarget(result);
      } catch {
        if (request === generation) setTarget(null);
      }
    };
    refreshRef.current = (): void => {
      void refresh();
    };
    const listener: (value: unknown) => void = (value: unknown): void => {
      if (isWorkNotification(value)) void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    void refresh();
    return (): void => {
      generation += 1;
      chrome.runtime.onMessage.removeListener(listener);
      refreshRef.current = (): void => {};
    };
  }, [snapshot]);
  return { target, windowId, refresh: (): void => refreshRef.current() };
}
