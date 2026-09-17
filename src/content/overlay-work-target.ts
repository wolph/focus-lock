/**
 * The primary control of the blocked page: Back to work, naming the chosen tab on itself, or
 * Choose a work tab when none is chosen, with a status line under it and the inline chooser. The
 * lookup is a renderer-owned round trip and its results are lookup labels, not session state:
 * the session id every request carries is the frozen view's.
 */
import { t } from '../shared/i18n';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import { parseWorkTargetResult, type WorkTargetResult } from '../shared/work-target';
import { clearActionError, isCurrentAction, sendAction } from './overlay-actions';
import { type MountedOverlay, mountedOverlay, type WorkTargetControls } from './overlay-state';
import type { ActiveOverlayView } from './overlay-timing';
import { createWorkTabPicker } from './work-tab-picker';
import { WORK_TARGET_COPY } from './work-tab-picker-view';

/** The button, the status line and the change control, in the order the page shows them. */
export function buildWorkTarget(
  overlay: MountedOverlay,
  view: ActiveOverlayView,
  panel: HTMLElement,
): void {
  const button: HTMLButtonElement = document.createElement('button');
  button.type = 'button';
  button.className = 'primary return-work';
  button.dataset.focus = 'return-work';
  button.addEventListener('click', (): void => {
    if (workTargetReady(overlay)) void returnToWork(overlay, view.sessionId);
    else if (usableTarget(view, overlay.target)) openWorkPicker(overlay, button);
    else {
      overlay.actionGeneration += 1;
      void loadWorkTarget(overlay, button);
    }
  });
  const status: HTMLElement = document.createElement('p');
  status.className = 'work-target';
  const change: HTMLButtonElement = document.createElement('button');
  change.type = 'button';
  change.className = 'change-work';
  change.dataset.focus = 'change-work';
  change.textContent = t('shared_overlay_change_work_tab');
  change.addEventListener('click', (): void => openWorkPicker(overlay, change));
  panel.append(button, status, change);
  overlay.work = { button, status, change };
  updateTarget(overlay);
}

/** Forgets the previous session's lookup so the next paint starts from a pending target. */
export function resetWorkTarget(overlay: MountedOverlay): void {
  overlay.target = null;
  overlay.targetPending = true;
  overlay.targetError = null;
}

/** A reply is usable only when the worker names the very session this page was frozen for. */
function usableTarget(view: ActiveOverlayView, target: WorkTargetResult | null): boolean {
  return target?.ok === true && target.sessionId === view.sessionId;
}

function workTargetReady(overlay: MountedOverlay): boolean {
  const view: MountedOverlay['view'] = overlay.view;
  const target: WorkTargetResult | null = overlay.target;
  return (
    view.presentation === 'active' &&
    target?.ok === true &&
    usableTarget(view, target) &&
    target.state === 'ready' &&
    Boolean(target.title?.trim() || target.hostname)
  );
}

/** Repaints the three controls from the lookup state. Safe to call at any time. */
export function updateTarget(overlay: MountedOverlay): void {
  const controls: WorkTargetControls | null = overlay.work;
  const view: MountedOverlay['view'] = overlay.view;
  if (controls === null || view.presentation !== 'active') return;
  const target: WorkTargetResult | null = overlay.target;
  const ready: boolean = workTargetReady(overlay);
  const usable: boolean = usableTarget(view, target);
  const title: string | null = ready && target?.ok ? target.title : null;
  const hostname: string | undefined = ready && target?.ok ? target.hostname : undefined;
  updateReturnButton(controls.button, title, hostname);
  controls.button.disabled = overlay.actionPending || (overlay.targetPending && !usable);
  controls.button.setAttribute('aria-busy', String(overlay.targetPending));
  if (ready && overlay.initialFocus && overlay.root.activeElement === overlay.container) {
    controls.button.focus({ preventScroll: true });
  }
  controls.status.textContent = ready
    ? (title ?? '')
    : overlay.targetPending
      ? WORK_TARGET_COPY.checking
      : (overlay.targetError ??
        (usable ? WORK_TARGET_COPY.pickOne : WORK_TARGET_COPY.sessionUnavailable));
  if (!ready && overlay.root.activeElement === controls.change) {
    (controls.button.disabled ? overlay.container : controls.button).focus({
      preventScroll: true,
    });
  }
  controls.change.hidden = !ready;
}

/** The action and its destination in one sentence, naming the website when the title hides it. */
function returnLabel(destination: string, hostname: string | undefined): string {
  const action: string = t('shared_overlay_back_to_work');
  return hostname === undefined || hostname === destination
    ? t('overlay_return_label', { ACTION: action, DESTINATION: destination })
    : t('overlay_return_label_host', {
        ACTION: action,
        DESTINATION: destination,
        HOSTNAME: hostname,
      });
}

/** The destination lives on the button itself, and the whole of it in its accessible name. */
function updateReturnButton(
  button: HTMLButtonElement,
  title: string | null,
  hostname: string | undefined,
): void {
  const destination: string = title?.trim() || hostname || '';
  const label: string =
    destination === '' ? t('shared_overlay_choose_work_tab') : returnLabel(destination, hostname);
  if (button.getAttribute('aria-label') === label) return;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.replaceChildren();
  const action: HTMLElement = document.createElement('span');
  action.className = 'work-action-label';
  action.textContent =
    destination === '' ? t('shared_overlay_choose_work_tab') : t('shared_overlay_back_to_work');
  button.append(action);
  if (destination === '') return;
  const text: HTMLElement = document.createElement('span');
  text.className = 'work-action-title';
  text.textContent = destination;
  button.append(text);
  if (hostname !== undefined && hostname !== destination) {
    const host: HTMLElement = document.createElement('span');
    host.className = 'work-action-host';
    host.textContent = hostname;
    button.append(host);
  }
}

/** Re-reads the target for the mounted page, if there is one. The loop calls this on a push. */
export function refreshWorkTarget(): void {
  const overlay: MountedOverlay | null = mountedOverlay();
  if (overlay !== null) void loadWorkTarget(overlay);
}

/**
 * One lookup. A trigger means the person asked from a control, so a usable answer opens the
 * chooser and the scroll position is put back. Focus parked on the dialog during the lookup
 * returns to the control it left, unless the person moved it meanwhile.
 */
export async function loadWorkTarget(
  overlay: MountedOverlay,
  trigger: HTMLElement | null = null,
): Promise<void> {
  const view: MountedOverlay['view'] = overlay.view;
  if (view.presentation !== 'active') return;
  const generation: number = ++overlay.targetGeneration;
  const action: number = overlay.actionGeneration;
  const scrollTop: number = overlay.container.scrollTop;
  const active: Element | null = overlay.root.activeElement;
  const restoreTarget: HTMLButtonElement | null =
    active instanceof HTMLButtonElement &&
    (active === trigger ||
      (active.classList.contains('return-work') && !usableTarget(view, overlay.target)))
      ? active
      : null;
  if (restoreTarget !== null) overlay.container.focus({ preventScroll: true });
  overlay.targetPending = true;
  updateTarget(overlay);
  let target: WorkTargetResult | null = null;
  let error: string | null = null;
  try {
    target = parseWorkTargetResult(await sendRequest({ type: 'getWorkTarget' }));
    if (!target?.ok) error = lookupError(target?.error);
  } catch (cause: unknown) {
    error = lookupError(cause instanceof Error ? cause.message : undefined);
  }
  if (mountedOverlay() !== overlay || generation !== overlay.targetGeneration) return;
  const wasUsable: boolean = usableTarget(view, overlay.target);
  overlay.target = target;
  overlay.targetPending = false;
  overlay.targetError = error;
  updateTarget(overlay);
  if (wasUsable && !usableTarget(view, target) && overlay.picker !== null) {
    closeWorkPicker(overlay, overlay.picker.element.contains(overlay.root.activeElement));
  }
  if (!isCurrentAction(overlay, action)) return;
  if (restoreTarget !== null && overlay.root.activeElement === overlay.container) {
    restoreTarget.focus({ preventScroll: true });
  }
  if (trigger === null) return;
  overlay.container.scrollTop = scrollTop;
  if (usableTarget(view, target)) openWorkPicker(overlay, trigger);
}

/**
 * The worker's own refusal is shown verbatim only for the one case both sides word identically,
 * so the two sides must stay on the same message key for the match to hold in every language.
 */
function lookupError(error: string | undefined): string {
  if (error === WORK_TARGET_COPY.pageChanged) return error;
  if (error?.includes('Extension context invalidated')) return WORK_TARGET_COPY.reconnect;
  return WORK_TARGET_COPY.lookupFailed;
}

/** Opens the chooser beside the panel and makes the panel inert until it closes. */
function openWorkPicker(overlay: MountedOverlay, trigger: HTMLElement): void {
  const view: MountedOverlay['view'] = overlay.view;
  if (view.presentation !== 'active' || !usableTarget(view, overlay.target)) return;
  if (overlay.picker !== null) {
    closeWorkPicker(overlay, true);
    return;
  }
  overlay.actionGeneration += 1;
  clearActionError(overlay);
  const sessionId: string = view.sessionId;
  overlay.picker = createWorkTabPicker(
    sessionId,
    trigger,
    overlay.container,
    (tabId: number): Promise<string | null> => selectWorkTab(overlay, sessionId, tabId),
    (): void => {
      overlay.picker = null;
      setPanelInert(overlay, false);
      overlay.actionGeneration += 1;
    },
  );
  overlay.container.appendChild(overlay.picker.element);
  setPanelInert(overlay, true);
  overlay.picker.element
    .querySelector<HTMLInputElement>('.work-picker-search')
    ?.focus({ preventScroll: true });
}

export function closeWorkPicker(overlay: MountedOverlay, restoreFocus: boolean): void {
  overlay.picker?.close(restoreFocus);
}

/** The lock screen behind an open chooser takes no focus and no clicks. */
export function setPanelInert(overlay: MountedOverlay, inert: boolean): void {
  const panel: HTMLElement | null = overlay.container.querySelector<HTMLElement>('.panel');
  if (panel === null) return;
  panel.inert = inert;
  panel.toggleAttribute('inert', inert);
}

/**
 * Saves the choice, then re-reads the target and returns to it. A refusal stays inside the
 * chooser as its own message, so the person can pick another tab.
 */
async function selectWorkTab(
  overlay: MountedOverlay,
  sessionId: string,
  tabId: number,
): Promise<string | null> {
  const generation: number = ++overlay.actionGeneration;
  let error: string | null;
  try {
    error = ackError(
      await sendRequest({ type: 'setWorkTarget', sessionId, tabId }),
      WORK_TARGET_COPY.transportError,
    );
  } catch {
    error = WORK_TARGET_COPY.transportError;
  }
  if (!isCurrentAction(overlay, generation)) return null;
  if (error !== null) return error;
  closeWorkPicker(overlay, true);
  void loadWorkTarget(overlay);
  await returnToWork(overlay, sessionId);
  return null;
}

/** The worker closes any open gate and activates the tab, then pushes this page's next view. */
async function returnToWork(overlay: MountedOverlay, sessionId: string): Promise<void> {
  if (mountedOverlay() !== overlay) return;
  await sendAction({ type: 'returnToWork', sessionId }, (error: string): string => error);
}
