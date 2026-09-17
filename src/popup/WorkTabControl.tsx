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
  const rootRef: { current: HTMLDivElement | null } = useRef<HTMLDivElement>(null);
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
  /**
   * A change-work-tab request moves focus to the button that starts the in-page picker. It used to
   * move focus into a dropdown of open tabs; that dropdown is gone by product rule, so the button
   * is the only in-popup way to reach the picker. See
   * docs/superpowers/specs/2026-09-17-popup-visibility-rules.md.
   */
  useLayoutEffect((): void => {
    if (focusRequest === lastFocusRequest.current) return;
    const button: HTMLButtonElement | null | undefined =
      rootRef.current?.querySelector<HTMLButtonElement>('button:enabled');
    if (button === null || button === undefined) return;
    lastFocusRequest.current = focusRequest;
    button.focus();
    button.scrollIntoView?.({ block: 'nearest' });
  }, [focusRequest, disabled, pending, sessionId, candidates.loading, candidates.context]);
  return (
    <div class="work-tab-control" ref={rootRef}>
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
        currentTarget={
          work.target?.ok && work.target.state === 'ready'
            ? { title: work.target.title, hostname: work.target.hostname }
            : null
        }
        disabled={disabled || pending || sessionId === null}
        onSelect={(tabId: number): void => {
          void select(tabId);
        }}
      />
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
