import type { VNode } from 'preact';
import {
  type Dispatch,
  type StateUpdater,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import { formatNumber, t } from '../shared/i18n';
import type { CommandResponseV2, SessionCommandResultCodeV2 } from '../shared/messages';
import type { GateKind, GateState } from '../shared/types';

export type GateRequest =
  | { type: 'abandonGate'; expectedGate: GateState }
  | { type: 'confirmGate'; typedPhrase: string | null; expectedGate: GateState }
  | { type: 'forceEndGate' };

/** The opt-in bypass, worded exactly as the Options checkbox names it. */
const FORCE_END_LABEL: string = t('popup_gate_force_end');

/** The transport this panel sends through. Every surface answers with a coded v2 result. */
export type GateCommandSender = (
  request: GateRequest,
) => Promise<CommandResponseV2<SessionCommandResultCodeV2>>;

/**
 * Maps one transport answer to its message, or null when the command was accepted. The panel
 * never reads the answer, so the mapper is the validator and its parameter is `unknown` on
 * purpose: the sender's declared return type is a claim from the other side of a message port.
 */
export type GateCommandErrorMapper = (response: unknown, fallback: string) => string | null;

/**
 * The cancel gate's own confirm, for a gate that arrives without published copy. The worker
 * publishes the same words as a fixed English tag that the runtime contract validates, and
 * `confirmLabelText` in v2-command.tsx turns that tag into this very message, so the two agree in
 * every language.
 */

/**
 * The default confirm of each gate kind. An open End authority publishes its own cancel-gate
 * copy, which the panel prefers, so the cancel row is only the fallback for a gate without it.
 */
const CONFIRM_LABELS: Record<GateKind, string> = {
  pause: t('popup_unlock_all_sites'),
  unlockSite: t('popup_unlock_this_site'),
  cancel: t('shared_end_the_session'),
};

/** The wording a pause or unlock gate uses. An End authority publishes its own instead. */
const DEFAULT_PHRASE_LABEL: string = t('popup_gate_phrase_label');

/** Shown when the worker refused a gate command without naming a reason of its own. */
const GATE_UPDATE_FAILED_COPY: string = t('popup_gate_update_failed');

/**
 * Deliberation gate. The worker owns the timing: this panel only renders
 * gate state and refuses to enable confirm before readyAt.
 */
export interface GatePanelProps {
  gate: GateState;
  now: number;
  intention: string;
  /** The session channel this panel sends through. No default: see `commandError`. */
  sendCommand: GateCommandSender;
  /**
   * Must match the sender. `mapGateError` reads the coded v2 answer every live surface gets,
   * and validates it, because the transport carries no runtime guard of its own.
   */
  commandError: GateCommandErrorMapper;
  /** An End authority passes its exact published `copy.phraseLabel`. */
  phraseLabel?: string;
  /** An open End authority passes its exact published `copy.confirm`. */
  confirmLabel?: string;
}

export function GatePanel({
  gate,
  now,
  intention,
  sendCommand,
  commandError,
  phraseLabel = DEFAULT_PHRASE_LABEL,
  confirmLabel,
}: GatePanelProps): VNode {
  const [typed, setTyped]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const requestInFlight: { current: boolean } = useRef<boolean>(false);
  const backButton: { current: HTMLButtonElement | null } = useRef<HTMLButtonElement>(null);
  const panelId: string = useId();
  const waitId: string = `gate-wait-${panelId}`;
  const phraseId: string = `gate-phrase-${panelId}`;

  const totalS: number = Math.max(1, Math.round((gate.readyAt - gate.openedAt) / 1000));
  const elapsedS: number = Math.min(totalS, Math.max(0, Math.floor((now - gate.openedAt) / 1000)));
  /** A gate whose ready moment precedes its opening is not a deliberation window. */
  const ready: boolean = gate.readyAt >= gate.openedAt && now >= gate.readyAt;
  const phraseOk: boolean = gate.requiredPhrase === null || typed === gate.requiredPhrase;

  const requestGateUpdate: (request: GateRequest) => Promise<void> = async (
    request: GateRequest,
  ): Promise<void> => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setError(null);
    setPending(true);
    try {
      const response: CommandResponseV2<SessionCommandResultCodeV2> = await sendCommand(request);
      const responseError: string | null = commandError(response, GATE_UPDATE_FAILED_COPY);
      if (responseError !== null) setError(responseError);
    } catch {
      setError(GATE_UPDATE_FAILED_COPY);
    } finally {
      requestInFlight.current = false;
      setPending(false);
    }
  };

  /**
   * Opening a gate unmounts the control that opened it, so focus falls to the body on the one
   * flow whose whole purpose is to be navigated slowly. The panel is keyed by the gate identity,
   * so this runs once per gate. It claims focus only when nothing else holds it, which leaves a
   * gate that opened while the person was elsewhere alone, and it takes the deliberate exit
   * rather than the confirm, matching the dialog in Settings and the blocked-page overlay.
   */
  useLayoutEffect((): void => {
    const active: Element | null = document.activeElement;
    if (active === null || active === document.body) backButton.current?.focus();
  }, []);

  /**
   * The confirm button refuses for three reasons and used to name only the countdown, so a
   * person whose typed phrase does not match yet met a disabled button with nothing said about
   * it. Both live explanations already exist on the page: point at whichever one applies.
   */
  const confirmDescribedBy: string | undefined = !ready
    ? waitId
    : !phraseOk && gate.requiredPhrase !== null
      ? phraseId
      : undefined;

  const abandon: () => void = (): void => {
    void requestGateUpdate({ type: 'abandonGate', expectedGate: gate });
  };

  const confirm: () => void = (): void => {
    void requestGateUpdate({
      type: 'confirmGate',
      expectedGate: gate,
      typedPhrase: gate.requiredPhrase === null ? null : typed,
    });
  };

  /** The worker re-checks the setting and the minted flag, so this sends no gate identity. */
  const forceEnd: () => void = (): void => {
    void requestGateUpdate({ type: 'forceEndGate' });
  };

  return (
    <div class="gate-panel">
      {intention !== '' ? (
        <p class="gate-intention">{t('popup_gate_intention', { INTENTION: intention })}</p>
      ) : null}
      {!ready ? (
        <p class="gate-wait" id={waitId}>
          {t('popup_gate_wait_prefix')} <span class="time">{formatNumber(elapsedS)}</span>{' '}
          {t('popup_gate_wait_remaining', { TOTAL: formatNumber(totalS) })}
        </p>
      ) : null}
      <button
        ref={backButton}
        type="button"
        class="start-button"
        disabled={pending}
        onClick={abandon}
      >
        {t('popup_gate_keep_focusing')}
      </button>
      {gate.requiredPhrase !== null ? (
        <label class="gate-phrase">
          <span class="radio-hint" id={phraseId}>
            {phraseLabel} {gate.requiredPhrase}
          </span>
          <input
            type="text"
            value={typed}
            onInput={(e: Event): void => setTyped((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
      ) : null}
      <button
        type="button"
        class="gate-confirm"
        disabled={pending || !ready || !phraseOk}
        aria-describedby={confirmDescribedBy}
        onClick={confirm}
      >
        {confirmLabel ?? CONFIRM_LABELS[gate.kind]}
      </button>
      {gate.forceEndAvailable ? (
        <button type="button" class="gate-force-end" disabled={pending} onClick={forceEnd}>
          {FORCE_END_LABEL}
        </button>
      ) : null}
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
