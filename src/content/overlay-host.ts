/**
 * The shared blocked-page shell: one closed shadow host carrying the overlay styles, a dialog
 * backdrop, the interaction trap, initial focus, and the two SVG figures the renderer draws.
 *
 * This is a leaf on purpose. `DocumentOverlayView` mounts through here, and the cutover that
 * deleted the v1 renderer left this shell and its tests standing. Nothing here reads session
 * state, a verdict, or a view.
 */

import { bidiDir, t } from '../shared/i18n';
import { OVERLAY_STYLES } from './overlay-styles';

const RING_RADIUS: number = 28;
export const RING_CIRCUMFERENCE: number = 2 * Math.PI * RING_RADIUS;

const SCROLL_KEYS: ReadonlySet<string> = new Set<string>([
  ' ',
  'Spacebar',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
const RANGE_KEYS: ReadonlySet<string> = new Set<string>([
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export interface OverlayHostElements {
  host: HTMLElement;
  root: ShadowRoot;
  container: HTMLElement;
}

/** What the renderer wants to hear about from the shell's own key and pointer handling. */
export interface OverlayHostHooks {
  /** Escape pressed inside the root. Answers true when it consumed the key. */
  onEscape?(): boolean;
  /** Any pointer or key interaction inside the root, before the shell's own handling. */
  onInteraction?(): void;
}

const SVG_NS: 'http://www.w3.org/2000/svg' = 'http://www.w3.org/2000/svg';

const PADLOCK_PATH: string =
  'M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 ' +
  '2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9zm3 4a1.5 1.5 ' +
  '0 0 1 .75 2.8V19a.75.75 0 0 1-1.5 0v-2.2A1.5 1.5 0 0 1 12 14z';

export function padlockSvg(): SVGSVGElement {
  const svg: SVGSVGElement = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'padlock');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', '#22c55e');
  svg.setAttribute('fill-rule', 'evenodd');
  svg.setAttribute('aria-hidden', 'true');
  const path: SVGPathElement = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PADLOCK_PATH);
  svg.appendChild(path);
  return svg;
}

/** The shared closed-shadow host: overlay styles, dialog backdrop, and interaction trap. */
export function mountOverlayHost(hooks: OverlayHostHooks = {}): OverlayHostElements {
  const direction: 'ltr' | 'rtl' = bidiDir();
  const host: HTMLElement = document.createElement('focus-lock-overlay');
  applyHostStyle(host, direction);
  const root: ShadowRoot = host.attachShadow({ mode: 'closed' });
  const style: HTMLStyleElement = document.createElement('style');
  style.textContent = OVERLAY_STYLES;
  const container: HTMLElement = document.createElement('div');
  container.className = 'backdrop';
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-modal', 'true');
  container.setAttribute('aria-label', t('overlay_dialog_label'));
  container.dir = direction;
  container.tabIndex = -1;
  root.append(style, container);
  trapInteraction(root, hooks);
  document.documentElement.appendChild(host);
  if (import.meta.env.MODE === 'test') {
    (globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow = root;
  }
  return { host, root, container };
}

/** Removes a mounted host and drops the closed-root handle the tests read. */
export function unmountOverlayHost(host: HTMLElement): void {
  host.remove();
  if (import.meta.env.MODE === 'test') {
    (globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow = undefined;
  }
}

/**
 * The overlay reads in the browser's UI language, never the blocked page's: the direction is the
 * one Chrome reports for that language and `unicode-bidi: isolate` keeps the page from bending it.
 */
function applyHostStyle(host: HTMLElement, direction: 'ltr' | 'rtl'): void {
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('inset', '0', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('display', 'block', 'important');
  host.style.setProperty('direction', direction, 'important');
  host.style.setProperty('unicode-bidi', 'isolate', 'important');
}

/**
 * The backdrop scrolls on its own and `overscroll-behavior: contain` keeps the page behind it
 * still. A wheel or touch whose path reaches the backdrop is the overlay scrolling and is left
 * alone. The listener sits on the root because a closed root hides its path from the host.
 */
function trapInteraction(root: ShadowRoot, hooks: OverlayHostHooks): void {
  const stopOutsideScroll: (event: Event) => void = (event: Event): void => {
    const insideBackdrop: boolean = event
      .composedPath()
      .some(
        (target: EventTarget): boolean =>
          target instanceof Element && target.classList.contains('backdrop'),
      );
    if (!insideBackdrop) event.preventDefault();
  };
  root.addEventListener('wheel', stopOutsideScroll, { passive: false });
  root.addEventListener('touchmove', stopOutsideScroll, { passive: false });
  root.addEventListener('pointerdown', (): void => {
    hooks.onInteraction?.();
  });
  root.addEventListener('keydown', (event: Event): void => {
    hooks.onInteraction?.();
    const ev: KeyboardEvent = event as KeyboardEvent;
    if (ev.defaultPrevented) return;
    if (ev.key === 'Escape') {
      if (hooks.onEscape?.() === true) ev.preventDefault();
      return;
    }
    if (ev.key !== 'Tab') {
      if (shouldPreventKeyboardScroll(ev)) {
        ev.preventDefault();
        redirectKeyboardScroll(root, ev.key);
      }
      return;
    }
    cycleFocus(root, ev);
  });
}

/** Scroll keys move the picker list when one is open, otherwise the backdrop itself. */
function redirectKeyboardScroll(root: ShadowRoot, key: string): void {
  const container: HTMLElement | null =
    root.querySelector<HTMLElement>('.work-picker-list') ??
    root.querySelector<HTMLElement>('.backdrop');
  if (container === null) return;
  const page: boolean = key === 'PageDown' || key === 'PageUp' || key === ' ' || key === 'Spacebar';
  const step: number = page ? container.clientHeight * 0.8 : 40;
  if (key === 'Home') container.scrollTop = 0;
  else if (key === 'End') container.scrollTop = container.scrollHeight;
  else container.scrollTop += (key === 'ArrowUp' || key === 'PageUp' ? -1 : 1) * step;
}

/**
 * Tab cycles over what a person can actually reach: enabled buttons, inputs, and summaries that
 * are not inside an inert subtree, and inside a details only while it is open.
 */
function cycleFocus(root: ShadowRoot, ev: KeyboardEvent): void {
  const focusables: HTMLElement[] = Array.from(
    root.querySelectorAll<HTMLElement>('button:not([disabled]):not([hidden]), input, summary'),
  ).filter((element: HTMLElement): boolean => {
    if (element.closest('[inert]') !== null || element.matches(':disabled')) return false;
    const details: HTMLDetailsElement | null = element.closest('details');
    return details === null || details.open || element.tagName === 'SUMMARY';
  });
  if (focusables.length === 0) {
    ev.preventDefault();
    root.querySelector<HTMLElement>('[role="dialog"]')?.focus();
    return;
  }
  const first: HTMLElement = focusables[0] as HTMLElement;
  const last: HTMLElement = focusables[focusables.length - 1] as HTMLElement;
  const active: Element | null = root.activeElement;
  const outside: boolean = active === null || active.getAttribute('role') === 'dialog';
  if (ev.shiftKey && (active === first || outside)) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (active === last || outside)) {
    ev.preventDefault();
    first.focus();
  }
}

function shouldPreventKeyboardScroll(event: KeyboardEvent): boolean {
  if (!SCROLL_KEYS.has(event.key)) return false;
  const path: EventTarget[] = event.composedPath();
  const effectiveTarget: EventTarget | null = path[0] ?? event.target;
  if (!(effectiveTarget instanceof Element)) return true;
  const editable: Element | null = effectiveTarget.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
  );
  if (editable instanceof HTMLInputElement) {
    if (editable.type === 'range') return !RANGE_KEYS.has(event.key);
    return event.key === 'PageUp' || event.key === 'PageDown';
  }
  if (editable instanceof HTMLSelectElement) return false;
  if (editable !== null) return event.key === 'PageUp' || event.key === 'PageDown';
  const space: boolean = event.key === ' ' || event.key === 'Spacebar';
  return !(space && effectiveTarget.closest('button, summary') !== null);
}

/**
 * Focuses the enabled return control, or the dialog itself while it is pending or absent. The
 * spend controls sit inside a collapsed drawer, so the first enabled button is never the answer.
 */
export function focusInitialControl(root: ShadowRoot, fallback: HTMLElement): void {
  if (root.activeElement !== null && root.activeElement !== fallback) return;
  const target: HTMLElement | null = root.querySelector<HTMLElement>(
    '.return-work:not([disabled])',
  );
  (target ?? fallback).focus({ preventScroll: true });
}

/** The gate countdown ring. Both renderers read the same stroke geometry from the shared CSS. */
export function buildRing(): {
  waitWrap: HTMLElement;
  ringFill: SVGCircleElement;
  count: HTMLElement;
} {
  const waitWrap: HTMLElement = document.createElement('div');
  waitWrap.className = 'ring-wrap';
  const svg: SVGSVGElement = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', '64');
  svg.setAttribute('height', '64');
  const track: SVGCircleElement = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'ring-track');
  const ringFill: SVGCircleElement = document.createElementNS(SVG_NS, 'circle');
  ringFill.setAttribute('class', 'ring-fill');
  for (const circle of [track, ringFill]) {
    circle.setAttribute('cx', '32');
    circle.setAttribute('cy', '32');
    circle.setAttribute('r', String(RING_RADIUS));
  }
  ringFill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
  svg.append(track, ringFill);
  const count: HTMLElement = document.createElement('div');
  count.className = 'ring-count';
  waitWrap.append(svg, count);
  return { waitWrap, ringFill, count };
}
