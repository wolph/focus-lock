/**
 * Renders the blocked page from one frozen `DocumentOverlayView`. Every word on the page comes
 * from the view's own copy fields, so this module formats numbers and never authors wording. It
 * ticks the time line, the credit, and the gate readiness locally from the view's timestamps and
 * waits for a newer worker command for anything else. The one round trip it owns is the work
 * target lookup, whose answers are lookup labels rather than session state.
 */
import type { DocumentOverlayView } from '../shared/enforcement-v2';
import { exactDataEqual } from '../shared/exact-data';
import { t } from '../shared/i18n';
import { applyTheme } from '../shared/theme';
import type { GateState, Verdict } from '../shared/types';
import { appendLine, buildAccessDrawer, updateAccess, updateGate } from './overlay-access';
import { actionErrorElement, disableAllActions, requestAction } from './overlay-actions';
import {
  focusInitialControl,
  mountOverlayHost,
  type OverlayHostElements,
  padlockSvg,
  unmountOverlayHost,
} from './overlay-host';
import { type MountedOverlay, mountedOverlay, setMountedOverlay } from './overlay-state';
import { OVERLAY_TICK_MS } from './overlay-styles';
import { type ActiveOverlayView, focusProgress, remainingLabel } from './overlay-timing';
import {
  buildWorkTarget,
  closeWorkPicker,
  loadWorkTarget,
  resetWorkTarget,
  setPanelInert,
  updateTarget,
} from './overlay-work-target';

export { refreshWorkTarget } from './overlay-work-target';

type StartingOverlayView = Extract<DocumentOverlayView, { presentation: 'starting' }>;

/**
 * Paints one frozen view. A view and verdict structurally equal to the painted pair is the
 * worker replaying its own command, so the panel, its focus, and any pending action survive.
 */
export function renderDocumentOverlay(view: DocumentOverlayView, verdict: Verdict): void {
  const current: MountedOverlay | null = mountedOverlay();
  if (
    current !== null &&
    exactDataEqual(current.view, view) &&
    exactDataEqual(current.verdict, verdict)
  ) {
    return;
  }
  const overlay: MountedOverlay = current ?? mountOverlay(view, verdict);
  // Every blocked attempt anywhere moves `attemptsToday`, which every open overlay carries, so a
  // person typing the confirmation phrase gets a structurally different view mid-gate. The panel
  // is rebuilt from scratch on any difference, so the phrase, the caret, the open drawer, the
  // scroll position and the focused control are carried across a repaint the same session
  // survives. The popup solves the mirror of this by keying its panel on the gate identity.
  const carried: CarriedState = carriedState(overlay, view);
  const sessionChanged: boolean = current === null || !sameSession(overlay.view, view);
  if (sessionChanged) {
    closeWorkPicker(overlay, false);
    resetWorkTarget(overlay);
    overlay.actionError = null;
  }
  if (sessionChanged || gateIdentityOf(overlay.view) !== gateIdentityOf(view)) {
    overlay.actionPending = false;
    overlay.actionError = null;
    overlay.actionGeneration += 1;
  }
  setMountedOverlay(overlay);
  overlay.view = view;
  overlay.verdict = verdict;
  applyTheme(overlay.host, view.theme);
  if (!overlay.actionPending) overlay.actionGeneration += 1;
  renderPanel(overlay, carried.accessOpen);
  if (overlay.picker !== null) setPanelInert(overlay, true);
  if (overlay.actionPending) disableAllActions(overlay);
  overlay.container.scrollTop = carried.scrollTop;
  restoreFocus(overlay, carried);
  if (sessionChanged) void loadWorkTarget(overlay);
}

interface CarriedGateInput {
  value: string;
  focused: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
}

interface CarriedState {
  gate: CarriedGateInput | null;
  accessOpen: boolean;
  scrollTop: number;
  /** The `data-focus` key of the focused lock screen control, so its successor takes focus. */
  focusKey: string | null;
}

function carriedState(overlay: MountedOverlay, next: DocumentOverlayView): CarriedState {
  const same: boolean = overlay.view !== next && sameSession(overlay.view, next);
  const active: Element | null = overlay.root.activeElement;
  const focusKey: string | null =
    active !== null && overlay.container.querySelector('.panel')?.contains(active) === true
      ? active.getAttribute('data-focus')
      : null;
  return {
    gate: carriedGateInput(overlay, next),
    accessOpen: same && overlay.access?.open === true,
    scrollTop: overlay.container.scrollTop,
    focusKey: same ? focusKey : null,
  };
}

function sameSession(current: DocumentOverlayView, next: DocumentOverlayView): boolean {
  return (
    current.presentation === 'active' &&
    next.presentation === 'active' &&
    current.sessionId === next.sessionId
  );
}

/** The typed phrase and caret, taken before a repaint, and only while the gate is the same one. */
function carriedGateInput(
  overlay: MountedOverlay,
  next: DocumentOverlayView,
): CarriedGateInput | null {
  const phrase: HTMLInputElement | null = overlay.gate?.phrase ?? null;
  if (phrase === null || gateIdentityOf(overlay.view) !== gateIdentityOf(next)) return null;
  return {
    value: phrase.value,
    focused: overlay.root.activeElement === phrase,
    selectionStart: phrase.selectionStart,
    selectionEnd: phrase.selectionEnd,
  };
}

/** Puts the phrase back, and answers whether it also owns the focus this repaint should keep. */
function restoreGateInput(overlay: MountedOverlay, carried: CarriedGateInput | null): boolean {
  const phrase: HTMLInputElement | null = overlay.gate?.phrase ?? null;
  if (carried === null || phrase === null) return false;
  phrase.value = carried.value;
  const view: DocumentOverlayView = overlay.view;
  if (view.presentation === 'active') updateGate(overlay, view, Date.now());
  if (!carried.focused) return false;
  phrase.focus({ preventScroll: true });
  phrase.setSelectionRange(carried.selectionStart, carried.selectionEnd);
  return true;
}

/**
 * Focus after a repaint, in order: the phrase that had it, the chooser that has it, the successor
 * of the control that had it, the return control while the page still owns first focus, and the
 * dialog itself so focus never leaves the overlay.
 */
function restoreFocus(overlay: MountedOverlay, carried: CarriedState): void {
  if (restoreGateInput(overlay, carried.gate)) return;
  const active: Element | null = overlay.root.activeElement;
  if (overlay.picker !== null) {
    // The chooser owns focus while it is open, and the panel behind it is inert.
    if (!overlay.picker.element.contains(active)) {
      overlay.picker.element
        .querySelector<HTMLInputElement>('.work-picker-search')
        ?.focus({ preventScroll: true });
    }
    return;
  }
  if (carried.focusKey !== null) {
    const successor: HTMLElement | null = overlay.root.querySelector<HTMLElement>(
      `[data-focus="${carried.focusKey}"]`,
    );
    if (successor !== null && !successor.hidden && !successor.matches(':disabled')) {
      successor.focus({ preventScroll: true });
      return;
    }
  }
  if (overlay.initialFocus) {
    focusInitialControl(overlay.root, overlay.container);
    return;
  }
  if (overlay.root.activeElement === null) overlay.container.focus({ preventScroll: true });
}

/**
 * The identity of the gate a view is showing, matching what the popup keys its panel on. A gate
 * reopened with new bounds or a new phrase is a different gate and must not inherit typed text.
 */
function gateIdentityOf(view: DocumentOverlayView): string | null {
  if (view.presentation !== 'active' || view.gate === null) return null;
  const gate: GateState = view.gate;
  return JSON.stringify([gate.kind, gate.host, gate.openedAt, gate.readyAt, gate.requiredPhrase]);
}

export function clearDocumentOverlay(): void {
  const overlay: MountedOverlay | null = mountedOverlay();
  if (overlay === null) return;
  closeWorkPicker(overlay, false);
  window.clearInterval(overlay.timer);
  unmountOverlayHost(overlay.host);
  setMountedOverlay(null);
}

function mountOverlay(view: DocumentOverlayView, verdict: Verdict): MountedOverlay {
  const elements: OverlayHostElements = mountOverlayHost({
    onEscape: (): boolean => {
      const overlay: MountedOverlay | null = mountedOverlay();
      if (overlay === null || overlay.picker === null) return false;
      closeWorkPicker(overlay, true);
      return true;
    },
    onInteraction: (): void => {
      const overlay: MountedOverlay | null = mountedOverlay();
      if (overlay !== null) overlay.initialFocus = false;
    },
  });
  const overlay: MountedOverlay = {
    ...elements,
    timer: window.setInterval(tick, OVERLAY_TICK_MS),
    view,
    verdict,
    clock: null,
    bankLabel: null,
    meterFill: null,
    access: null,
    spends: [],
    gate: null,
    work: null,
    actionGeneration: 0,
    actionPending: false,
    actionError: null,
    initialFocus: true,
    targetGeneration: 0,
    target: null,
    targetPending: true,
    targetError: null,
    picker: null,
    settle: (): void => {},
  };
  overlay.settle = (): void => settle(overlay);
  return overlay;
}

/** After an action settles, every control's enabled state is derived again from what is known. */
function settle(overlay: MountedOverlay): void {
  const view: DocumentOverlayView = overlay.view;
  if (view.presentation === 'active') updateAccess(overlay, view, Date.now());
  updateTarget(overlay);
}

function renderPanel(overlay: MountedOverlay, accessOpen: boolean): void {
  const now: number = Date.now();
  const view: DocumentOverlayView = overlay.view;
  overlay.clock = null;
  overlay.bankLabel = null;
  overlay.meterFill = null;
  overlay.access = null;
  overlay.spends = [];
  overlay.gate = null;
  overlay.work = null;
  overlay.container.className = view.stoppedPage ? 'backdrop opaque' : 'backdrop';
  const panel: HTMLElement = document.createElement('div');
  panel.className = 'panel';
  panel.appendChild(padlockSvg());
  if (view.presentation === 'starting') appendStartingPage(panel, view);
  else appendActivePage(overlay, panel, view, now, accessOpen);
  if (overlay.actionError !== null) panel.appendChild(actionErrorElement(overlay.actionError));
  // The chooser is a sibling of the panel, so a repaint replaces the panel and leaves it be.
  const previous: Element | null = overlay.container.querySelector(':scope > .panel');
  if (previous === null) overlay.container.prepend(panel);
  else previous.replaceWith(panel);
}

/** The starting page borrows the strong and muted type scales. It owns no clock and no control. */
function appendStartingPage(panel: HTMLElement, view: StartingOverlayView): void {
  appendLine(panel, 'intention', t('shared_overlay_starting_title'));
  appendLine(panel, 'until', t('shared_overlay_starting_detail'));
  appendLine(panel, 'provenance', view.copy.verdictProvenance);
  if (view.copy.stoppedPage !== null) {
    appendLine(panel, 'notloaded', t('shared_overlay_stopped_page'));
  }
}

/**
 * The next step leads the page: a small heading, the intention as the main text, the provenance
 * line under it, then the calm time line and the progress bar for this focus block, the return
 * control with its status, and the collapsed site access drawer. A timed page keeps the wall
 * clock it is locked until as the smaller half of the time line, and an until-stopped page reads
 * its still status text there. `copy.lockedUntil` is the bare wall clock behind the timed
 * sentence, so it is never rendered on its own: rendering it would drop the label the worker
 * already wrote.
 */
function appendActivePage(
  overlay: MountedOverlay,
  panel: HTMLElement,
  view: ActiveOverlayView,
  now: number,
  accessOpen: boolean,
): void {
  appendLine(panel, 'next-step', t('shared_overlay_next_step'));
  appendHeading(panel, view.copy.intention);
  appendLine(panel, 'provenance', view.copy.verdictProvenance);
  appendTimeLine(overlay, panel, view, now);
  appendProgress(overlay, panel, view, now);
  buildWorkTarget(overlay, view, panel);
  if (view.copy.stoppedPage !== null) {
    appendLine(panel, 'notloaded', t('shared_overlay_stopped_page'));
  }
  panel.appendChild(buildAccessDrawer(overlay, view, now, accessOpen, requestAction));
}

function appendHeading(panel: HTMLElement, intention: string): void {
  const heading: HTMLHeadingElement = document.createElement('h1');
  heading.className = 'intention';
  heading.textContent = intention;
  panel.appendChild(heading);
}

/** The remaining minutes tick locally, the wall clock beside them is the worker's sentence. */
function appendTimeLine(
  overlay: MountedOverlay,
  panel: HTMLElement,
  view: ActiveOverlayView,
  now: number,
): void {
  const line: HTMLElement = document.createElement('p');
  line.className = 'clock';
  const remaining: HTMLSpanElement = document.createElement('span');
  remaining.className = 'remaining';
  remaining.textContent = remainingLabel(view, now);
  line.appendChild(remaining);
  if (view.copy.status.kind === 'timed') {
    const until: HTMLSpanElement = document.createElement('span');
    until.className = 'until';
    until.textContent = view.copy.status.text;
    line.appendChild(until);
  }
  overlay.clock = remaining;
  panel.appendChild(line);
}

function appendProgress(
  overlay: MountedOverlay,
  panel: HTMLElement,
  view: ActiveOverlayView,
  now: number,
): void {
  const meter: HTMLElement = document.createElement('div');
  meter.className = 'meter';
  const fill: HTMLElement = document.createElement('div');
  fill.className = 'meter-fill';
  meter.appendChild(fill);
  panel.appendChild(meter);
  overlay.meterFill = fill;
  updateProgress(overlay, view, now);
}

function updateProgress(overlay: MountedOverlay, view: ActiveOverlayView, now: number): void {
  if (overlay.meterFill === null) return;
  overlay.meterFill.style.width = `${focusProgress(view, now) * 100}%`;
}

function tick(): void {
  const overlay: MountedOverlay | null = mountedOverlay();
  if (overlay !== null) refresh(overlay);
}

/** Repaints only what the document may recompute on its own: time, progress, credit, and gate. */
function refresh(overlay: MountedOverlay): void {
  const view: DocumentOverlayView = overlay.view;
  if (view.presentation !== 'active') return;
  const now: number = Date.now();
  if (overlay.clock !== null) overlay.clock.textContent = remainingLabel(view, now);
  updateProgress(overlay, view, now);
  updateAccess(overlay, view, now);
  if (overlay.actionPending) disableAllActions(overlay);
}
