import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../shared/i18n';
import { sendRequest } from '../shared/messages';
import type { SessionMode, SessionRuleSnapshot } from '../shared/types';
import { parseWorkTabsResult, type WorkTab, type WorkTabsResult } from '../shared/work-target';
import { type WorkTabsState, workTabsRequest } from './use-work-tabs';

export const USE_THIS_TAB_LABEL: string = t('popup_use_this_tab');
export const CURRENT_TAB_UNAVAILABLE_HINT: string = t('popup_current_tab_unavailable');
const CHECKING_CURRENT_TAB_HINT: string = t('popup_checking_current_tab');
const FINDING_CURRENT_TAB_HINT: string = t('popup_finding_current_tab');
const CURRENT_TAB_LOAD_ERROR: string = t('popup_current_tab_load_failed');

export interface ThisTabButtonProps {
  work: WorkTabsState;
  disabled?: boolean;
  mode: SessionMode;
  /** The rules the listing was made under, sent again so the recheck matches it. */
  rules?: SessionRuleSnapshot;
  /** Changes whenever the owner's choice changes, so a stale lookup cannot overrule a newer one. */
  choiceKey: string;
  onError?: (error: string | null) => void;
  onSelect: (tabId: number) => void;
}

/**
 * Proposes the popup's active tab as the work tab. The click re-reads the active tab and the
 * eligible listing at that moment, because the tab may have changed since the popup opened.
 */
export function ThisTabButton({
  work,
  disabled = false,
  mode,
  rules,
  choiceKey,
  onSelect,
  onError,
}: ThisTabButtonProps): VNode {
  const current: WorkTab | undefined = work.tabs.find(
    (tab: WorkTab): boolean => tab.tabId === work.context?.activeTabId,
  );
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const latestChoice: { current: string } = useRef<string>(choiceKey);
  latestChoice.current = choiceKey;
  const generation: { current: number } = useRef<number>(0);
  const inFlight: { current: boolean } = useRef<boolean>(false);
  useEffect((): (() => void) => {
    return (): void => {
      generation.current += 1;
    };
  }, []);
  const choose: () => Promise<void> = async (): Promise<void> => {
    if (inFlight.current || work.context === null) return;
    const request: number = ++generation.current;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const active: chrome.tabs.Tab | undefined = (
        await chrome.tabs.query({ active: true, currentWindow: true })
      )[0];
      const available: WorkTabsResult | null = parseWorkTabsResult(
        await sendRequest(workTabsRequest(mode, work.context.windowId, rules)),
      );
      if (request !== generation.current || latestChoice.current !== choiceKey) return;
      if (
        active?.windowId !== work.context.windowId ||
        !available?.ok ||
        !available.tabs.some((tab: WorkTab): boolean => tab.tabId === active?.id)
      ) {
        setError(CURRENT_TAB_UNAVAILABLE_HINT);
        return;
      }
      onSelect(active.id as number);
    } catch {
      if (request === generation.current) setError(CURRENT_TAB_LOAD_ERROR);
    } finally {
      if (request === generation.current) {
        inFlight.current = false;
        setPending(false);
      }
    }
  };
  useEffect((): void => {
    onError?.(error);
  }, [error, onError]);
  const hint: string = pending
    ? CHECKING_CURRENT_TAB_HINT
    : (error ??
      (work.loading
        ? FINDING_CURRENT_TAB_HINT
        : (work.error ?? current?.title ?? CURRENT_TAB_UNAVAILABLE_HINT)));
  return (
    <div class="this-tab-choice">
      <button
        type="button"
        class="this-tab-button"
        disabled={disabled || current === undefined || work.loading || pending}
        aria-describedby="this-tab-hint"
        onClick={(): void => {
          void choose();
        }}
      >
        {USE_THIS_TAB_LABEL}
      </button>
      <p id="this-tab-hint" class="work-tab-hint">
        {hint}
      </p>
    </div>
  );
}
