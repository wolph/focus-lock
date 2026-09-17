/**
 * The one round trip a blocked page makes for an action. The worker answers a committed change
 * with a newer command, so a successful action only unlocks the controls: nothing here invents
 * the next view. A dead channel and a refused session action read the same on screen, from the
 * view's transport copy. A refused work target action shows the worker's own sentence.
 */

import { t } from '../shared/i18n';
import type { Ack, Request } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { type MountedOverlay, mountedOverlay } from './overlay-state';

export type ActionRequest = Extract<
  Request,
  {
    type:
      | 'openGate'
      | 'confirmGate'
      | 'requestSessionEnd'
      | 'abandonGate'
      | 'openEndGate'
      | 'forceEndGate'
      | 'returnToWork';
  }
>;

export type ActionSender = (request: ActionRequest) => void;

export function requestAction(request: ActionRequest): void {
  void sendAction(request);
}

/**
 * Sends one action and waits. `rejectionText` turns a refusal into the sentence to show, and its
 * absence means the refusal reads like a dead channel.
 */
export async function sendAction(
  request: ActionRequest,
  rejectionText: ((error: string) => string) | null = null,
): Promise<void> {
  const overlay: MountedOverlay | null = mountedOverlay();
  if (overlay === null || overlay.actionPending) return;
  const generation: number = overlay.actionGeneration + 1;
  overlay.actionGeneration = generation;
  overlay.actionPending = true;
  disableAllActions(overlay);
  clearActionError(overlay);
  const ack: Ack | null = await requestAck(request);
  if (!isCurrentAction(overlay, generation)) return;
  finishAction(overlay);
  if (ack === null) showTransportError(overlay);
  else if (!ack.ok) {
    if (rejectionText === null) showTransportError(overlay);
    else showActionError(overlay, rejectionText(ack.error));
  }
}

/** null is a dead worker channel. */
async function requestAck(request: ActionRequest): Promise<Ack | null> {
  try {
    return await sendRequest(request);
  } catch {
    return null;
  }
}

export function isCurrentAction(overlay: MountedOverlay, generation: number): boolean {
  return mountedOverlay() === overlay && overlay.actionGeneration === generation;
}

function finishAction(overlay: MountedOverlay): void {
  overlay.actionPending = false;
  for (const button of overlay.root.querySelectorAll<HTMLButtonElement>(
    '.linkish, .primary, .keep-focusing, .force-end, .change-work',
  )) {
    button.disabled = false;
  }
  overlay.settle();
}

export function disableAllActions(overlay: MountedOverlay): void {
  for (const button of overlay.root.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = true;
  }
}

export function clearActionError(overlay: MountedOverlay): void {
  overlay.actionError = null;
  overlay.root.querySelector('.action-error')?.remove();
}

/** Only an active view carries transport copy, and only an active view renders an action. */
export function showTransportError(overlay: MountedOverlay): void {
  if (overlay.view.presentation !== 'active') return;
  showActionError(overlay, t('shared_overlay_transport_error'));
}

export function showActionError(overlay: MountedOverlay, message: string): void {
  clearActionError(overlay);
  overlay.actionError = message;
  overlay.container.querySelector('.panel')?.appendChild(actionErrorElement(message));
}

export function actionErrorElement(message: string): HTMLElement {
  const alert: HTMLElement = document.createElement('div');
  alert.className = 'action-error';
  alert.setAttribute('role', 'alert');
  alert.textContent = message;
  return alert;
}
