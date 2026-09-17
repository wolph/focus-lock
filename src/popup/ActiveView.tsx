import type { VNode } from 'preact';
import {
  type Dispatch,
  type StateUpdater,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import { getDomain } from 'tldts';
import { type AccessAvailability, accessAvailability } from '../shared/budget-display';
import { MIN_BREAK_BEFORE_EARLY_MS } from '../shared/constants';
import { t } from '../shared/i18n';
import { growBank } from '../shared/live';
import { ACTION_FAILED_COPY, RETURN_TO_WORK_FAILED_COPY } from '../shared/session-copy';
import { formatClock } from '../shared/time';
import type { EndAuthorityV2, GateState, SessionSnapshotV2 } from '../shared/types';
import { ClockStack } from './ClockStack';
import { GatePanel } from './GatePanel';
import { ReturnToWorkButton, type WorkDestination } from './ReturnToWorkButton';
import { useWorkTarget, type WorkTargetState } from './use-work-tabs';
import {
  endControl,
  gateConfirmLabel,
  gateIdentity,
  gateIntention,
  gatePhraseLabel,
  mapGateError,
  sendGateCommand,
  useV2Command,
  type V2Command,
} from './v2-command';
import { WorkTabControl } from './WorkTabControl';

type ActiveHostState =
  | { status: 'loading' }
  | { status: 'ready'; host: string }
  | { status: 'unsupported' }
  | { status: 'error' };

/** The active tab's host, for the unlock control's own wording. */
function useActiveHost(): ActiveHostState {
  const [state, setState]: [ActiveHostState, Dispatch<StateUpdater<ActiveHostState>>] =
    useState<ActiveHostState>({ status: 'loading' });
  useEffect((): void => {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs: chrome.tabs.Tab[]): void => {
        const url: string | undefined = tabs[0]?.url;
        if (url === undefined) {
          setState({ status: 'unsupported' });
          return;
        }
        try {
          const parsed: URL = new URL(url);
          if (
            (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.hostname === ''
          ) {
            setState({ status: 'unsupported' });
            return;
          }
          setState({ status: 'ready', host: getDomain(parsed.hostname) ?? parsed.hostname });
        } catch {
          setState({ status: 'unsupported' });
        }
      })
      .catch((): void => {
        setState({ status: 'error' });
      });
  }, []);
  return state;
}

/** The open cancel gate carried by End authority, absent for every other authority. */
function endGateOf(authority: EndAuthorityV2): GateState | null {
  return authority.kind === 'friction-gate' ? authority.gate : null;
}

function SpendButton({
  label,
  sub,
  disabledReason,
  onClick,
}: {
  label: string;
  sub: string | null;
  disabledReason: string | null;
  onClick: () => void;
}): VNode {
  return (
    <button
      type="button"
      class="spend-button"
      aria-label={[label, sub, disabledReason].filter(Boolean).join(' ')}
      disabled={disabledReason !== null}
      onClick={onClick}
    >
      <span class="spend-label">{label}</span>
      {sub !== null ? <span class="spend-sub">{sub}</span> : null}
      {disabledReason !== null ? (
        <span class="spend-sub spend-reason">{disabledReason}</span>
      ) : null}
    </button>
  );
}

export interface ActiveViewProps {
  snapshot: SessionSnapshotV2;
  now: number;
}

export function ActiveView({ snapshot, now }: ActiveViewProps): VNode {
  const viewRef: { current: HTMLElement | null } = useRef<HTMLElement | null>(null);
  /** Disabling in the same tick keeps a second click from racing the pending commit. */
  const command: V2Command = useV2Command({
    onBegin: (): void => {
      for (const button of viewRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
        button.disabled = true;
      }
    },
  });
  const activeSite: ActiveHostState = useActiveHost();
  const activeHost: string | null = activeSite.status === 'ready' ? activeSite.host : null;
  const work: WorkTargetState = useWorkTarget(snapshot);

  /** Grown to `now` so the credit amount stays current between snapshots. */
  const bankMs: number = growBank(
    snapshot.bankMs,
    snapshot.bankAccrualPerMs,
    snapshot.bankCapMs,
    snapshot.at,
    now,
  );
  const unlockCost: string = formatClock(snapshot.unlockCostMs);
  const pauseCost: string = formatClock(snapshot.pauseCostMs);
  const intention: string = snapshot.config?.intention ?? '';
  const authority: EndAuthorityV2 = snapshot.lifecycle.endAuthority;
  const activeGate: GateState | null = snapshot.gate ?? endGateOf(authority);

  const [focusRequest, setFocusRequest]: [number, Dispatch<StateUpdater<number>>] =
    useState<number>(0);
  const [workLoadError, setWorkLoadError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const [workError, setWorkError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const previousGate: { current: GateState | null } = useRef<GateState | null>(activeGate);
  useLayoutEffect((): void => {
    if (
      previousGate.current !== null &&
      activeGate === null &&
      document.activeElement === document.body
    ) {
      viewRef.current?.querySelector<HTMLElement>('.active-core button:enabled')?.focus();
    }
    previousGate.current = activeGate;
  }, [activeGate]);
  const chooseWorkTab: () => void = (): void => {
    setFocusRequest((previous: number): number => previous + 1);
  };

  /**
   * Each spend control counts to its own cost within the current focus block, or explains why
   * that credit cannot be reached. An affordable spend has no message, so the reason is null.
   */
  const availabilityReason: (costMs: number) => string | null = (costMs: number): string | null => {
    const availability: AccessAvailability = accessAvailability(snapshot, now, costMs);
    return availability.affordable ? null : availability.message;
  };
  const unlockAvailability: string | null = availabilityReason(snapshot.unlockCostMs);
  const pauseAvailability: string | null = availabilityReason(snapshot.pauseCostMs);
  const pendingReason: string | null = command.pending ? t('popup_action_in_progress') : null;
  const activeSiteReason: string | null =
    activeSite.status === 'loading'
      ? t('popup_active_site_checking')
      : activeSite.status === 'unsupported'
        ? t('popup_active_site_unsupported')
        : activeSite.status === 'error'
          ? t('popup_active_site_unknown')
          : null;
  const unlockDisabledReason: string | null =
    pendingReason ?? activeSiteReason ?? unlockAvailability;
  const pauseDisabledReason: string | null = pendingReason ?? pauseAvailability;
  const breakEarlyVisible: boolean =
    snapshot.phase === 'break' &&
    snapshot.phaseStartedAt !== null &&
    now - snapshot.phaseStartedAt >= MIN_BREAK_BEFORE_EARLY_MS;

  const endAction: VNode | null = endControl(authority, command);

  /** Offered only while no gate is open and the chosen tab can be switched to right now. */
  const returnDestination: WorkDestination | null =
    activeGate === null && work.target?.ok === true && work.target.state === 'ready'
      ? { title: work.target.title, hostname: work.target.hostname }
      : null;
  /** Runs under the view's one in-flight lock, so a return and a gate command cannot race. */
  const returnToWork: () => Promise<void> = async (): Promise<void> => {
    if (!work.target?.ok || work.target.sessionId === null || work.windowId === null) return;
    await command.run(
      { type: 'returnToWork', sessionId: work.target.sessionId, windowId: work.windowId },
      RETURN_TO_WORK_FAILED_COPY,
    );
    work.refresh();
  };

  const phaseControls: VNode | null =
    snapshot.phase === 'paused' ? (
      <button
        type="button"
        class="start-button"
        disabled={command.pending}
        onClick={(): void => void command.run({ type: 'resumeFromPause' }, ACTION_FAILED_COPY)}
      >
        {t('popup_resume_now')}
      </button>
    ) : snapshot.phase === 'break' ? (
      breakEarlyVisible ? (
        <button
          type="button"
          class="start-button"
          disabled={command.pending}
          onClick={(): void =>
            void command.run({ type: 'startNextFocusEarly' }, ACTION_FAILED_COPY)
          }
        >
          {t('popup_start_next_focus_early')}
        </button>
      ) : null
    ) : (
      <>
        <SpendButton
          label={t('popup_unlock_this_site')}
          sub={
            activeHost === null
              ? t('popup_spend_cost', { ACCESS: unlockCost, CREDIT: unlockCost })
              : t('popup_spend_cost_host', {
                  ACCESS: unlockCost,
                  CREDIT: unlockCost,
                  HOST: activeHost,
                })
          }
          disabledReason={unlockDisabledReason}
          onClick={(): void =>
            void command.run(
              { type: 'openGate', gate: 'unlockSite', host: activeHost },
              ACTION_FAILED_COPY,
            )
          }
        />
        <SpendButton
          label={t('popup_unlock_all_sites')}
          sub={t('popup_spend_cost', { ACCESS: pauseCost, CREDIT: pauseCost })}
          disabledReason={pauseDisabledReason}
          onClick={(): void =>
            void command.run({ type: 'openGate', gate: 'pause', host: null }, ACTION_FAILED_COPY)
          }
        />
      </>
    );

  return (
    <section ref={viewRef} class="view active-view">
      <div class="active-core">
        <ClockStack snapshot={snapshot} now={now} />
        {intention !== '' ? <p class="intention-line">{intention}</p> : null}
        {activeGate === null && snapshot.phase !== 'focus' ? phaseControls : null}
        {returnDestination !== null ? (
          <ReturnToWorkButton
            destination={returnDestination}
            secondary={snapshot.phase === 'paused' || breakEarlyVisible}
            disabled={command.pending}
            onClick={(): void => void returnToWork()}
          />
        ) : activeGate === null ? (
          <button
            type="button"
            class={
              snapshot.phase === 'paused' || breakEarlyVisible ? 'secondary-button' : 'start-button'
            }
            disabled={command.pending}
            onClick={chooseWorkTab}
          >
            {t('popup_choose_work_tab_button')}
          </button>
        ) : null}
        {returnDestination !== null ? (
          <button
            type="button"
            class="text-button"
            disabled={command.pending}
            onClick={chooseWorkTab}
          >
            {t('popup_change_work_tab_button')}
          </button>
        ) : null}
      </div>
      {activeSite.status === 'error' ? (
        <p class="form-error" role="alert">
          {t('popup_active_site_error')}
        </p>
      ) : null}

      {/* Always visible, never behind a disclosure: see docs/superpowers/specs/2026-09-17-popup-visibility-rules.md */}
      <section class="session-actions" aria-label={t('popup_session_actions_summary')}>
        <span class="meter-label">
          {t('popup_site_access_credit', { CREDIT: formatClock(bankMs) })}
        </span>
        {activeGate === null ? (
          <div class="actions">
            {snapshot.phase === 'focus' ? phaseControls : null}
            {endAction}
          </div>
        ) : null}
        <WorkTabControl
          snapshot={snapshot}
          work={work}
          disabled={command.pending || activeGate !== null}
          onError={setWorkError}
          onLoadError={setWorkLoadError}
          focusRequest={focusRequest}
        />
      </section>
      {workLoadError !== null ? <p class="form-error">{workLoadError}</p> : null}
      {workError !== null ? (
        <p class="form-error" role="alert">
          {workError}
        </p>
      ) : null}
      {activeGate !== null ? (
        <GatePanel
          key={gateIdentity(activeGate)}
          gate={activeGate}
          now={now}
          intention={gateIntention(authority, activeGate, snapshot.config)}
          phraseLabel={gatePhraseLabel(authority, activeGate)}
          confirmLabel={gateConfirmLabel(authority, activeGate)}
          sendCommand={sendGateCommand}
          commandError={mapGateError}
        />
      ) : null}
      {command.error !== null ? (
        <p class="form-error" role="alert">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}
