import type { VNode } from 'preact';
import {
  type Dispatch,
  type StateUpdater,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import { t } from '../shared/i18n';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import type { SessionMode, SessionSnapshotV2 } from '../shared/types';
import type { WorkTab } from '../shared/work-target';
import { ThisTabButton } from './ThisTabButton';
import { useWorkTabs, type WorkTabsState, type WorkTargetState } from './use-work-tabs';

const CHOOSE_WORK_TAB_COPY: string = t('popup_choose_work_tab_copy');
const SAVING_WORK_TAB_COPY: string = t('popup_saving_work_tab');
const SAVE_WORK_TAB_FAILED_COPY: string = t('popup_save_work_tab_failed');
const CHOOSE_OPEN_TAB_OPTION: string = t('popup_choose_open_tab_option');

export interface WorkTabControlProps {
  snapshot: SessionSnapshotV2;
  work: WorkTargetState;
  /** Set while another command holds the view's in-flight lock. */
  disabled?: boolean;
  focusRequest?: number;
  onLoadError?: (error: string | null) => void;
  onError?: (error: string | null) => void;
}

/**
 * Shows the live session's work tab and lets it be chosen or replaced. The listing runs under
 * the rules the session captured at start, so it offers exactly what a save will accept. The
 * session identity resets the control, and a save that answers after a reset is dropped.
 */
export function WorkTabControl({
  snapshot,
  work,
  disabled = false,
  onError,
  onLoadError,
  focusRequest = 0,
}: WorkTabControlProps): VNode {
  const selectRef: { current: HTMLSelectElement | null } = useRef<HTMLSelectElement>(null);
  const lastFocusRequest: { current: number } = useRef<number>(0);
  const mode: SessionMode = snapshot.config?.mode ?? 'blacklist';
  const candidates: WorkTabsState = useWorkTabs(mode, snapshot.config?.rules);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [tabError, setTabError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const sessionId: string | null = work.target?.ok ? work.target.sessionId : null;
  const identity: string = JSON.stringify([sessionId, snapshot.startedAt, snapshot.sessionEndsAt]);
  const currentIdentity: { current: string } = useRef<string>(identity);
  currentIdentity.current = identity;
  const generation: { current: number } = useRef<number>(0);
  const inFlight: { current: boolean } = useRef<boolean>(false);
  useEffect((): (() => void) => {
    inFlight.current = false;
    setPending(false);
    setError(null);
    return (): void => {
      generation.current += 1;
    };
  }, [identity]);
  const select: (tabId: number) => Promise<void> = async (tabId: number): Promise<void> => {
    if (sessionId === null || work.windowId === null || pending || inFlight.current) return;
    const request: number = ++generation.current;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const response: unknown = await sendRequest({
        type: 'setWorkTarget',
        sessionId,
        tabId,
        windowId: work.windowId,
      });
      if (request !== generation.current || currentIdentity.current !== identity) return;
      setError(ackError(response, SAVE_WORK_TAB_FAILED_COPY));
    } catch {
      if (request !== generation.current || currentIdentity.current !== identity) return;
      setError(SAVE_WORK_TAB_FAILED_COPY);
    } finally {
      if (request === generation.current && currentIdentity.current === identity) {
        inFlight.current = false;
        setPending(false);
        work.refresh();
      }
    }
  };
  useEffect((): void => {
    onError?.(error ?? tabError);
  }, [error, tabError, onError]);
  useEffect((): void => {
    onLoadError?.(candidates.error);
  }, [candidates.error, onLoadError]);
  useLayoutEffect((): void => {
    if (focusRequest === lastFocusRequest.current || selectRef.current?.disabled !== false) return;
    lastFocusRequest.current = focusRequest;
    selectRef.current.focus();
    selectRef.current.scrollIntoView?.({ block: 'nearest' });
  }, [focusRequest, disabled, pending, sessionId, candidates.loading, candidates.context]);
  return (
    <div class="work-tab-control">
      <p class="work-target">
        {work.target?.ok && work.target.state === 'ready'
          ? t('popup_work_tab_named', { TITLE: work.target.title ?? '' })
          : CHOOSE_WORK_TAB_COPY}
      </p>
      <ThisTabButton
        key={identity}
        onError={onError === undefined ? undefined : setTabError}
        choiceKey={String(generation.current)}
        mode={mode}
        rules={snapshot.config?.rules}
        work={candidates}
        disabled={disabled || pending || sessionId === null}
        onSelect={(tabId: number): void => {
          void select(tabId);
        }}
      />
      <label class="work-tab-label">
        {t('popup_or_choose_another_tab')}
        <select
          ref={selectRef}
          aria-label={t('popup_work_tab_select_label')}
          value=""
          disabled={
            disabled ||
            pending ||
            sessionId === null ||
            candidates.context === null ||
            candidates.loading
          }
          onChange={(event: Event): void => {
            const value: string = (event.currentTarget as HTMLSelectElement).value;
            if (value !== '') void select(Number(value));
          }}
        >
          <option value="">{CHOOSE_OPEN_TAB_OPTION}</option>
          {candidates.tabs.map(
            (tab: WorkTab): VNode => (
              <option key={tab.tabId} value={tab.tabId}>
                {tab.title}
              </option>
            ),
          )}
        </select>
      </label>
      {onError === undefined && error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {pending ? (
        <p class="work-tab-hint" role="status">
          {SAVING_WORK_TAB_COPY}
        </p>
      ) : null}
    </div>
  );
}
