/**
 * The site access drawer: the credit line, the two spend actions with their own countdown or
 * explanation, the End control, and the deliberation gate. Every word comes from the view, the
 * countdowns and the gate ring are this module's arithmetic on the frozen timing rows.
 */
import { formatNumber, t } from '../shared/i18n';
import { formatClock } from '../shared/time';
import type { GateState } from '../shared/types';
import type { ActionSender } from './overlay-actions';
import { buildRing, RING_CIRCUMFERENCE } from './overlay-host';
import type { GateControls, MountedOverlay, SpendControl } from './overlay-state';
import {
  type AccessWait,
  type ActiveOverlayView,
  accessWait,
  bankAt,
  endActionLabel,
} from './overlay-timing';

/** Ids inside the overlay's own shadow root, where `aria-describedby` resolves. */
const GATE_WAIT_ID: string = 'focus-lock-gate-wait';
const PHRASE_TEXT_ID: string = 'focus-lock-gate-phrase';

/**
 * The credit line, the access actions or the open gate, and the note live in one collapsed
 * drawer: the page leads with the next step, and site access is there for whoever asks.
 */
export function buildAccessDrawer(
  overlay: MountedOverlay,
  view: ActiveOverlayView,
  now: number,
  accessOpen: boolean,
  act: ActionSender,
): HTMLDetailsElement {
  const details: HTMLDetailsElement = document.createElement('details');
  details.className = 'access';
  details.open = view.gate !== null || accessOpen;
  const summary: HTMLElement = document.createElement('summary');
  summary.textContent = t('shared_overlay_access_summary');
  summary.dataset.focus = 'summary';
  details.appendChild(summary);
  const label: HTMLElement = document.createElement('div');
  label.className = 'bank';
  details.appendChild(label);
  overlay.bankLabel = label;
  updateBank(overlay, view, now);
  details.appendChild(
    view.gate === null
      ? buildButtons(overlay, view, now, act)
      : buildGate(overlay, view, view.gate, now, act),
  );
  const note: HTMLElement = document.createElement('p');
  note.className = 'access-note';
  note.textContent = t('shared_overlay_access_note');
  details.appendChild(note);
  overlay.access = details;
  return details;
}

/** Repaints what the drawer may recompute on its own: the bank, the waits, the gate ring. */
export function updateAccess(overlay: MountedOverlay, view: ActiveOverlayView, now: number): void {
  updateBank(overlay, view, now);
  for (const control of overlay.spends) updateSpend(control, view, now);
  updateGate(overlay, view, now);
}

function updateBank(overlay: MountedOverlay, view: ActiveOverlayView, now: number): void {
  if (overlay.bankLabel === null) return;
  overlay.bankLabel.textContent = t('shared_overlay_bank_amount', {
    AMOUNT: formatClock(bankAt(view, now)),
  });
}

function buildButtons(
  overlay: MountedOverlay,
  view: ActiveOverlayView,
  now: number,
  act: ActionSender,
): HTMLElement {
  const row: HTMLElement = document.createElement('div');
  row.className = 'buttons';
  const unlock: SpendControl = spendButton(
    view.copy.unlockAction,
    view.economy.unlockCostMs,
    'spend-unlock',
    (): void => {
      act({ type: 'openGate', gate: 'unlockSite', host: window.location.hostname });
    },
  );
  const pause: SpendControl = spendButton(
    view.copy.pauseAction,
    view.economy.pauseCostMs,
    'spend-pause',
    (): void => {
      act({ type: 'openGate', gate: 'pause', host: null });
    },
  );
  overlay.spends = [unlock, pause];
  row.append(unlock.button, pause.button);
  if (view.actions.end !== 'hidden') {
    row.appendChild(endButton(endActionLabel(view.copy.endAction), view.actions.end, act));
  }
  for (const control of overlay.spends) updateSpend(control, view, now);
  return row;
}

function spendButton(
  label: string,
  costMs: number,
  focusKey: string,
  onClick: () => void,
): SpendControl {
  const button: HTMLButtonElement = document.createElement('button');
  button.className = 'pill';
  button.type = 'button';
  button.dataset.focus = focusKey;
  const text: HTMLSpanElement = document.createElement('span');
  text.textContent = label;
  const ready: HTMLSpanElement = document.createElement('span');
  ready.className = 'ready';
  ready.hidden = true;
  button.append(text, ready);
  button.addEventListener('click', onClick);
  return { button, costMs, ready };
}

/**
 * The action the view carries decides the command, because the worker refuses `requestSessionEnd`
 * for anything but a Flexible session. A Friction overlay opens the cancel gate instead, which is
 * what the v1 renderer did from this same button and what the popup still does.
 */
function endButton(
  label: string,
  action: 'request-end' | 'open-end-gate',
  act: ActionSender,
): HTMLButtonElement {
  const button: HTMLButtonElement = document.createElement('button');
  button.className = 'linkish';
  button.type = 'button';
  button.dataset.focus = 'end';
  button.textContent = label;
  button.addEventListener('click', (): void => {
    act(action === 'open-end-gate' ? { type: 'openEndGate' } : { type: 'requestSessionEnd' });
  });
  return button;
}

function updateSpend(control: SpendControl, view: ActiveOverlayView, now: number): void {
  const wait: AccessWait = accessWait(view, now, control.costMs);
  control.button.disabled = !wait.affordable;
  control.ready.hidden = wait.affordable;
  control.ready.textContent = wait.affordable ? '' : accessWaitText(wait);
}

/** The countdown is this module's number and every other word under an action is the catalogue's. */
function accessWaitText(wait: AccessWait): string {
  switch (wait.reason) {
    case 'ready-in':
      return t('shared_ready_in', { CLOCK: formatClock(wait.waitMs ?? 0) });
    case 'updating':
      return t('shared_updating_session');
    case 'above-limit':
      return t('shared_cost_exceeds_limit');
    case 'earning-off':
      return t('shared_credit_off');
    case 'not-enough-time':
      return t('shared_not_enough_time');
    default:
      return '';
  }
}

/**
 * The two `?? ''` fallbacks below are unreachable, and deliberately kept.
 * `validateDetachedActiveCopy` in `shared/enforcement-v2-validation.ts` requires `gateTitle` and
 * `gateConfirm` to be non-blank strings whenever a gate is open, and this function runs only for an
 * open gate, so neither can be null here. The contract cannot say so in a way TypeScript can use,
 * because `gate` and `copy` are sibling fields and no union on one narrows the other. Tying them
 * together is a wire-shape change parked as its own item. Throwing instead would break a blocked
 * page mid-render for a case the validator already refuses.
 */
function buildGate(
  overlay: MountedOverlay,
  view: ActiveOverlayView,
  gate: GateState,
  now: number,
  act: ActionSender,
): HTMLElement {
  const wrap: HTMLElement = document.createElement('div');
  wrap.className = 'gate';
  // Keep focusing comes first: the strongest thing on a gate is the way back out of it.
  const keep: HTMLButtonElement = document.createElement('button');
  keep.className = 'keep-focusing pill';
  keep.type = 'button';
  keep.dataset.focus = 'gate-keep';
  keep.textContent = t('shared_gate_back');
  keep.addEventListener('click', (): void => {
    act({ type: 'abandonGate', expectedGate: gate });
  });
  wrap.appendChild(keep);
  appendLine(wrap, 'gate-title', view.copy.gateTitle ?? '');
  if (view.copy.gateSaid !== null) appendLine(wrap, 'gate-said', view.copy.gateSaid);
  const ring: { waitWrap: HTMLElement; ringFill: SVGCircleElement; count: HTMLElement } =
    buildRing();
  ring.waitWrap.id = GATE_WAIT_ID;
  wrap.appendChild(ring.waitWrap);
  const phrase: HTMLInputElement | null = appendPhrase(overlay, wrap, gate);
  const confirm: HTMLButtonElement = document.createElement('button');
  confirm.className = 'pill';
  confirm.type = 'button';
  confirm.dataset.focus = 'gate-confirm';
  confirm.textContent = view.copy.gateConfirm ?? '';
  confirm.hidden = true;
  confirm.addEventListener('click', (): void => {
    act({ type: 'confirmGate', typedPhrase: phrase?.value ?? null, expectedGate: gate });
  });
  wrap.appendChild(confirm);
  // The bypass exists only on a gate the worker minted it for. The worker re-checks the setting
  // and the flag, so the command carries no gate identity.
  if (gate.forceEndAvailable) {
    const forceEnd: HTMLButtonElement = document.createElement('button');
    forceEnd.className = 'force-end';
    forceEnd.type = 'button';
    forceEnd.dataset.focus = 'gate-force-end';
    forceEnd.textContent = t('shared_overlay_gate_force_end');
    forceEnd.addEventListener('click', (): void => {
      act({ type: 'forceEndGate' });
    });
    wrap.appendChild(forceEnd);
  }
  overlay.gate = {
    ringFill: ring.ringFill,
    count: ring.count,
    waitWrap: ring.waitWrap,
    confirm,
    phrase,
  };
  updateGate(overlay, view, now);
  return wrap;
}

function appendPhrase(
  overlay: MountedOverlay,
  wrap: HTMLElement,
  gate: GateState,
): HTMLInputElement | null {
  if (gate.requiredPhrase === null) return null;
  appendLine(wrap, 'phrase-label', t('shared_gate_phrase_label'));
  appendLine(wrap, 'phrase-text', gate.requiredPhrase).id = PHRASE_TEXT_ID;
  const input: HTMLInputElement = document.createElement('input');
  input.className = 'phrase';
  input.type = 'text';
  input.setAttribute('aria-label', t('shared_gate_phrase_label'));
  input.addEventListener('input', (): void => {
    if (overlay.view.presentation === 'active') updateGate(overlay, overlay.view, Date.now());
  });
  wrap.appendChild(input);
  return input;
}

export function updateGate(overlay: MountedOverlay, view: ActiveOverlayView, now: number): void {
  const controls: GateControls | null = overlay.gate;
  const gate: GateState | null = view.gate;
  if (controls === null || gate === null) return;
  const span: number = gate.readyAt - gate.openedAt;
  const progress: number = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - gate.openedAt) / span));
  controls.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
  controls.count.textContent = formatNumber(Math.max(0, Math.ceil((gate.readyAt - now) / 1000)));
  const ready: boolean = now >= gate.readyAt;
  controls.waitWrap.hidden = ready;
  controls.confirm.hidden = !ready;
  const phraseOk: boolean =
    gate.requiredPhrase === null ||
    (controls.phrase !== null && controls.phrase.value === gate.requiredPhrase);
  controls.confirm.disabled = !(ready && phraseOk);
  // Both reasons the confirm refuses are already written on the panel, so it names the one that
  // currently applies rather than leaving a disabled button with nothing said about it.
  const describedBy: string | null = !ready ? GATE_WAIT_ID : phraseOk ? null : PHRASE_TEXT_ID;
  if (describedBy === null) controls.confirm.removeAttribute('aria-describedby');
  else controls.confirm.setAttribute('aria-describedby', describedBy);
}

export function appendLine(parent: HTMLElement, className: string, text: string): HTMLElement {
  const line: HTMLElement = document.createElement('div');
  line.className = className;
  line.textContent = text;
  parent.appendChild(line);
  return line;
}
