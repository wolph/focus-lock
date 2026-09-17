// @vitest-environment jsdom
/**
 * The blocked-page shell, driven directly. These cases were ported from the deleted
 * `tests/unit/content/overlay.test.ts` (39113e9), which reached the same code through the v1
 * `showOverlay`. The renderer is gone and the shell is not: `overlay-v2.ts` mounts through
 * `mountOverlayHost` on every blocked page, so the host style reset, the RTL isolation, the
 * dialog name, the interaction trap, and the shared stylesheet keep their guards here.
 */
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  buildRing,
  focusInitialControl,
  mountOverlayHost,
  type OverlayHostElements,
  RING_CIRCUMFERENCE,
  unmountOverlayHost,
} from '../../../src/content/overlay-host';
import { OVERLAY_STYLES, OVERLAY_TICK_MS } from '../../../src/content/overlay-styles';
import { WORK_PICKER_CSS } from '../../../src/content/work-tab-picker-view';
import { t } from '../../../src/shared/i18n';

function shadowHandle(): ShadowRoot | undefined {
  return (globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow;
}

function keydown(key: string, extra: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...extra,
  });
}

function button(label: string): HTMLButtonElement {
  const control: HTMLButtonElement = document.createElement('button');
  control.textContent = label;
  return control;
}

/** The editable and native-control targets the scroll trap has to leave alone. */
function scrollTarget(kind: string): HTMLElement {
  if (kind === 'textarea') return document.createElement('textarea');
  if (kind === 'select') return document.createElement('select');
  if (kind === 'button') return document.createElement('button');
  if (kind === 'contenteditable') {
    const editable: HTMLElement = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    return editable;
  }
  const input: HTMLInputElement = document.createElement('input');
  if (kind === 'range') input.type = 'range';
  return input;
}

afterEach((): void => {
  for (const host of Array.from(document.querySelectorAll('focus-lock-overlay'))) {
    unmountOverlayHost(host as HTMLElement);
  }
  document.documentElement.removeAttribute('dir');
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('overlay host', (): void => {
  it('resets the host styles while preserving the fixed overlay', (): void => {
    const { host }: OverlayHostElements = mountOverlayHost();

    expect(host.style.getPropertyValue('all')).toBe('initial');
    expect(host.style.getPropertyPriority('all')).toBe('important');
    expect(host.style.getPropertyValue('position')).toBe('fixed');
    expect(host.style.getPropertyPriority('position')).toBe('important');
    expect(host.style.getPropertyValue('inset')).toBe('0px');
    expect(host.style.getPropertyPriority('inset')).toBe('important');
    expect(host.style.getPropertyValue('z-index')).toBe('2147483647');
    expect(host.style.getPropertyPriority('z-index')).toBe('important');
    expect(host.style.getPropertyValue('display')).toBe('block');
    expect(host.style.getPropertyPriority('display')).toBe('important');
  });

  it('does not inherit right-to-left text direction from the blocked page', (): void => {
    document.documentElement.dir = 'rtl';

    const { host, container }: OverlayHostElements = mountOverlayHost();

    expect(host.style.getPropertyValue('direction')).toBe('ltr');
    expect(host.style.getPropertyPriority('direction')).toBe('important');
    expect(host.style.getPropertyValue('unicode-bidi')).toBe('isolate');
    expect(host.style.getPropertyPriority('unicode-bidi')).toBe('important');
    expect(container.dir).toBe('ltr');
  });

  it('reads right to left when the browser UI language does, whatever the page does', (): void => {
    document.documentElement.dir = 'ltr';
    vi.stubGlobal('chrome', {
      i18n: {
        getMessage: (key: string): string => (key === '@@bidi_dir' ? 'rtl' : ''),
        getUILanguage: (): string => 'he',
      },
    });

    const { host, container }: OverlayHostElements = mountOverlayHost();

    expect(host.style.getPropertyValue('direction')).toBe('rtl');
    expect(host.style.getPropertyPriority('direction')).toBe('important');
    expect(container.dir).toBe('rtl');
  });

  it('gives the dialog an accessible name', (): void => {
    const { root }: OverlayHostElements = mountOverlayHost();
    const dialog: HTMLElement = root.querySelector('[role="dialog"]') as HTMLElement;

    expect(dialog.getAttribute('aria-label')).toBe(t('overlay_dialog_label'));
    expect(dialog.getAttribute('aria-label')).toBe('Focus Lock');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.classList.contains('backdrop')).toBe(true);
    expect(dialog.tabIndex).toBe(-1);
  });

  it('mounts one closed root carrying the shared styles, and unmounts it', (): void => {
    const { host, root, container }: OverlayHostElements = mountOverlayHost();

    expect(document.querySelectorAll('focus-lock-overlay')).toHaveLength(1);
    expect(host.shadowRoot).toBeNull();
    expect(root.querySelector('style')?.textContent).toBe(OVERLAY_STYLES);
    expect(root.contains(container)).toBe(true);
    expect(shadowHandle()).toBe(root);

    unmountOverlayHost(host);

    expect(document.querySelectorAll('focus-lock-overlay')).toHaveLength(0);
    expect(shadowHandle()).toBeUndefined();
  });

  it('allows wheel and touch scrolling inside its closed shadow root', (): void => {
    const { container }: OverlayHostElements = mountOverlayHost();

    for (const type of ['wheel', 'touchmove']) {
      const event: Event = new Event(type, { bubbles: true, composed: true, cancelable: true });
      container.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('reports interaction and hands Escape to the hook that consumes it', (): void => {
    const onInteraction: Mock<() => void> = vi.fn<() => void>();
    const onEscape: Mock<() => boolean> = vi.fn<() => boolean>().mockReturnValue(true);
    const { container }: OverlayHostElements = mountOverlayHost({ onInteraction, onEscape });

    container.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(onInteraction).toHaveBeenCalledTimes(1);

    const escapeKey: KeyboardEvent = keydown('Escape');
    container.dispatchEvent(escapeKey);

    expect(onInteraction).toHaveBeenCalledTimes(2);
    expect(onEscape).toHaveBeenCalledOnce();
    expect(escapeKey.defaultPrevented).toBe(true);
  });

  it('leaves Escape alone when no hook consumes it', (): void => {
    const onEscape: Mock<() => boolean> = vi.fn<() => boolean>().mockReturnValue(false);
    const { container }: OverlayHostElements = mountOverlayHost({ onEscape });

    const escapeKey: KeyboardEvent = keydown('Escape');
    container.dispatchEvent(escapeKey);

    expect(escapeKey.defaultPrevented).toBe(false);
  });
});

describe('overlay host focus trap', (): void => {
  it('owns focus and traps Tab when hard mode has no enabled controls', (): void => {
    const outside: HTMLButtonElement = button('outside');
    document.body.appendChild(outside);
    outside.focus();
    const { host, root, container }: OverlayHostElements = mountOverlayHost();

    const tab: KeyboardEvent = keydown('Tab');
    container.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(host);
    expect(root.activeElement).toBe(container);
  });

  it('ignores a disabled control when deciding the trap has nothing to focus', (): void => {
    const { host, root, container }: OverlayHostElements = mountOverlayHost();
    const disabled: HTMLButtonElement = button('End session');
    disabled.disabled = true;
    container.appendChild(disabled);

    const tab: KeyboardEvent = keydown('Tab');
    container.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(host);
    expect(root.activeElement).toBe(container);
  });

  it('wraps Tab from the last control back to the first', (): void => {
    const { root, container }: OverlayHostElements = mountOverlayHost();
    const first: HTMLButtonElement = button('Unlock this site');
    const last: HTMLButtonElement = button('End session');
    container.append(first, last);
    last.focus();

    const tab: KeyboardEvent = keydown('Tab');
    last.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(first);
  });

  it('wraps Shift+Tab from the first control back to the last', (): void => {
    const { root, container }: OverlayHostElements = mountOverlayHost();
    const first: HTMLButtonElement = button('Unlock this site');
    const last: HTMLButtonElement = button('End session');
    container.append(first, last);
    first.focus();

    const tab: KeyboardEvent = keydown('Tab', { shiftKey: true });
    first.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(last);
  });

  it('pulls an unfocused overlay onto its first control on Tab', (): void => {
    const { root, container }: OverlayHostElements = mountOverlayHost();
    const first: HTMLButtonElement = button('Unlock this site');
    const last: HTMLButtonElement = button('End session');
    container.append(first, last);

    const tab: KeyboardEvent = keydown('Tab');
    container.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(first);
  });

  it('leaves an interior Tab to the browser', (): void => {
    const { root, container }: OverlayHostElements = mountOverlayHost();
    const first: HTMLButtonElement = button('Unlock this site');
    const last: HTMLButtonElement = button('End session');
    container.append(first, last);
    first.focus();

    const tab: KeyboardEvent = keydown('Tab');
    first.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(false);
    expect(root.activeElement).toBe(first);
  });

  it('focuses the enabled return control on mount and the dialog otherwise', (): void => {
    const bare: OverlayHostElements = mountOverlayHost();
    focusInitialControl(bare.root, bare.container);
    expect(bare.root.activeElement).toBe(bare.container);
    unmountOverlayHost(bare.host);

    // A spend control inside the collapsed drawer must not receive the page's first focus.
    const controls: OverlayHostElements = mountOverlayHost();
    const spend: HTMLButtonElement = button('Unlock this site');
    const pending: HTMLButtonElement = button('Checking');
    pending.className = 'return-work';
    pending.disabled = true;
    controls.container.append(pending, spend);

    focusInitialControl(controls.root, controls.container);

    expect(controls.root.activeElement).toBe(controls.container);
    pending.disabled = false;
    controls.container.focus();
    focusInitialControl(controls.root, controls.container);
    expect(controls.root.activeElement).toBe(pending);
  });

  it('cycles Tab through summary and skips inert subtrees and closed details', (): void => {
    const { root, container }: OverlayHostElements = mountOverlayHost();
    const first: HTMLButtonElement = button('Back to work');
    const inert: HTMLElement = document.createElement('div');
    inert.setAttribute('inert', '');
    inert.appendChild(button('Change work tab'));
    const details: HTMLDetailsElement = document.createElement('details');
    const summary: HTMLElement = document.createElement('summary');
    summary.textContent = 'Need a break or site access?';
    const hidden: HTMLButtonElement = button('Unlock this site');
    details.append(summary, hidden);
    container.append(first, inert, details);
    summary.focus();

    const forward: KeyboardEvent = keydown('Tab');
    summary.dispatchEvent(forward);

    expect(forward.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(first);

    details.open = true;
    summary.focus();
    const interior: KeyboardEvent = keydown('Tab');
    summary.dispatchEvent(interior);

    expect(interior.defaultPrevented).toBe(false);

    hidden.focus();
    const wrap: KeyboardEvent = keydown('Tab');
    hidden.dispatchEvent(wrap);

    expect(wrap.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(first);
  });

  it('pulls Tab from the focused dialog onto the first control', (): void => {
    const { root, container }: OverlayHostElements = mountOverlayHost();
    const first: HTMLButtonElement = button('Back to work');
    const last: HTMLButtonElement = button('End session');
    container.append(first, last);
    container.focus();

    const back: KeyboardEvent = keydown('Tab', { shiftKey: true });
    container.dispatchEvent(back);

    expect(back.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(last);
  });

  it('leaves an already focused control alone', (): void => {
    const { root, container }: OverlayHostElements = mountOverlayHost();
    const first: HTMLButtonElement = button('Unlock this site');
    const typed: HTMLInputElement = document.createElement('input');
    container.append(first, typed);
    typed.focus();

    focusInitialControl(root, container);

    expect(root.activeElement).toBe(typed);
  });
});

describe('overlay host keyboard scrolling', (): void => {
  it.each([
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
  ])('prevents %s background scrolling without stopping propagation', (key: string): void => {
    const { container }: OverlayHostElements = mountOverlayHost();
    const observed: Mock<(event: KeyboardEvent) => void> = vi.fn<(event: KeyboardEvent) => void>();
    document.addEventListener('keydown', observed);
    const event: KeyboardEvent = keydown(key);

    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(observed).toHaveBeenCalledOnce();
    document.removeEventListener('keydown', observed);
  });

  it.each([
    ['input', 'ArrowLeft'],
    ['textarea', 'ArrowDown'],
    ['select', 'Home'],
    ['select', 'ArrowDown'],
    ['contenteditable', 'End'],
    ['button', ' '],
    ['button', 'Spacebar'],
    ['range', 'ArrowRight'],
    ['range', 'Home'],
    ['range', 'End'],
    ['range', 'PageUp'],
    ['range', 'PageDown'],
  ])('preserves native %s behavior for %s', (kind: string, key: string): void => {
    const { container }: OverlayHostElements = mountOverlayHost();
    const target: HTMLElement = scrollTarget(kind);
    container.appendChild(target);
    const event: KeyboardEvent = keydown(key);

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['PageUp', 'PageDown'])(
    'prevents %s from scrolling the background when a text input is focused',
    (key: string): void => {
      const { container }: OverlayHostElements = mountOverlayHost();
      const phrase: HTMLInputElement = document.createElement('input');
      phrase.className = 'phrase';
      container.appendChild(phrase);
      phrase.focus();
      const event: KeyboardEvent = keydown(key);

      phrase.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    },
  );

  it.each([
    ['range', ' '],
    ['range', 'Spacebar'],
    ['textarea', 'PageUp'],
    ['textarea', 'PageDown'],
    ['contenteditable', 'PageUp'],
    ['contenteditable', 'PageDown'],
  ])('prevents %s %s from leaking background scroll', (kind: string, key: string): void => {
    const { container }: OverlayHostElements = mountOverlayHost();
    const target: HTMLElement = scrollTarget(kind);
    container.appendChild(target);
    target.focus();
    const event: KeyboardEvent = keydown(key);

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a non-scrolling key alone', (): void => {
    const { container }: OverlayHostElements = mountOverlayHost();
    const event: KeyboardEvent = keydown('a');

    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves Space on a summary to the native toggle', (): void => {
    const { container }: OverlayHostElements = mountOverlayHost();
    const details: HTMLDetailsElement = document.createElement('details');
    const summary: HTMLElement = document.createElement('summary');
    details.appendChild(summary);
    container.appendChild(details);
    const event: KeyboardEvent = keydown(' ');

    summary.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('redirects scroll keys into the backdrop, or the picker list when one is open', (): void => {
    const { container }: OverlayHostElements = mountOverlayHost();

    container.dispatchEvent(keydown('ArrowDown'));
    expect(container.scrollTop).toBe(40);
    container.dispatchEvent(keydown('ArrowUp'));
    expect(container.scrollTop).toBe(0);
    container.scrollTop = 120;
    container.dispatchEvent(keydown('Home'));
    expect(container.scrollTop).toBe(0);

    const list: HTMLElement = document.createElement('div');
    list.className = 'work-picker-list';
    container.appendChild(list);
    container.dispatchEvent(keydown('ArrowDown'));

    expect(list.scrollTop).toBe(40);
    expect(container.scrollTop).toBe(0);
  });
});

describe('OVERLAY_STYLES', (): void => {
  it('ships distinct light and dark color schemes', (): void => {
    expect(OVERLAY_STYLES).toContain('--overlay-bg: rgba(248, 250, 252, 0.98);');
    expect(OVERLAY_STYLES).toContain('--overlay-text: #0f172a;');
    expect(OVERLAY_STYLES).toContain(':host([data-theme="dark"])');
    expect(OVERLAY_STYLES).toContain(':host([data-theme="auto"])');
    expect(OVERLAY_STYLES).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*--overlay-bg: rgba\(15, 23, 42, 0\.97\);/,
    );
    expect(OVERLAY_STYLES).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*--overlay-text: #f8fafc;/,
    );
    expect(OVERLAY_STYLES).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*--overlay-subtle: #94a3b8;/,
    );
    expect(OVERLAY_STYLES).toContain('.backdrop:focus { outline: none; }');
    // The force end bypass is destructive in both schemes, so each block names its own pair.
    expect(OVERLAY_STYLES).toContain('--overlay-danger: #a4251b;');
    expect(OVERLAY_STYLES).toContain('--overlay-danger-soft: #fce8e6;');
    expect(OVERLAY_STYLES).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*--overlay-danger: #ff8a80;/,
    );
    expect(OVERLAY_STYLES).toMatch(
      /:host\(\[data-theme="dark"\]\)[\s\S]*--overlay-danger-soft: #3d2422;/,
    );
    expect(OVERLAY_STYLES).toMatch(/\.force-end\s*\{[^}]*var\(--overlay-danger\)/s);
  });

  it('styles a pending primary gate control as inactive', (): void => {
    expect(OVERLAY_STYLES).toMatch(/\.primary:hover:not\(:disabled\)\s*\{/);
    expect(OVERLAY_STYLES).toMatch(/\.primary:disabled\s*\{[^}]*cursor:\s*default/s);
    expect(OVERLAY_STYLES).toMatch(/\.primary:disabled\s*\{[^}]*opacity:\s*0\.55/s);
    expect(OVERLAY_STYLES).toMatch(/\.pill:hover:not\(:disabled\)\s*\{/);
    expect(OVERLAY_STYLES).toMatch(/\.pill:disabled\s*\{[^}]*opacity:\s*0\.55/s);
    expect(OVERLAY_STYLES).toMatch(/button:disabled\s*\{[^}]*cursor:\s*default/s);
  });

  it('keeps the quiet provenance line readable at any pattern length', (): void => {
    expect(OVERLAY_STYLES).toMatch(
      /\.provenance\s*\{[^}]*color:\s*var\(--overlay-subtle\)[^}]*overflow-wrap:\s*anywhere/s,
    );
  });

  it('never animates past the next local repaint', (): void => {
    expect(OVERLAY_STYLES).toContain(`transition: width ${OVERLAY_TICK_MS}ms linear;`);
    expect(OVERLAY_STYLES).toContain(`transition: stroke-dashoffset ${OVERLAY_TICK_MS}ms linear;`);
    expect(OVERLAY_STYLES).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none;/,
    );
  });

  it('lets the backdrop scroll on its own and keeps the clock still', (): void => {
    expect(OVERLAY_STYLES).toMatch(
      /\.backdrop\s*\{[^}]*align-items:\s*flex-start[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s,
    );
    expect(OVERLAY_STYLES).not.toContain('@keyframes pulse');
    expect(OVERLAY_STYLES).not.toContain('animation:');
    expect(OVERLAY_STYLES).toMatch(/\.padlock\s*\{[^}]*1\.5rem/s);
  });

  it('carries the work tab picker styles in the one mounted sheet', (): void => {
    expect(OVERLAY_STYLES.endsWith(WORK_PICKER_CSS)).toBe(true);
    expect(WORK_PICKER_CSS).toMatch(/\.work-picker\s*\{[^}]*position:\s*fixed/s);
  });

  it('builds the gate ring empty against the shared circumference', (): void => {
    const ring: { ringFill: SVGCircleElement } = buildRing();

    expect(ring.ringFill.getAttribute('stroke-dasharray')).toBe(String(RING_CIRCUMFERENCE));
    expect(ring.ringFill.getAttribute('stroke-dashoffset')).toBe(String(RING_CIRCUMFERENCE));
  });

  it('keeps the ring inside the viewBox the svg declares', (): void => {
    // The assertion above and RING_CIRCUMFERENCE both derive from the same radius, so a radius
    // that outgrew the viewBox would clip the ring on every gate and still pass. These read the
    // geometry back off the element instead.
    const ring: { waitWrap: HTMLElement; ringFill: SVGCircleElement } = buildRing();
    const svg: SVGSVGElement | null = ring.waitWrap.querySelector('svg');
    const viewBox: string = svg?.getAttribute('viewBox') ?? '';
    const [minX, minY, width, height]: number[] = viewBox.split(' ').map(Number);
    const cx: number = Number(ring.ringFill.getAttribute('cx'));
    const cy: number = Number(ring.ringFill.getAttribute('cy'));
    const r: number = Number(ring.ringFill.getAttribute('r'));

    expect(viewBox).not.toBe('');
    expect(r).toBeGreaterThan(0);
    expect(cx - r).toBeGreaterThanOrEqual(minX as number);
    expect(cy - r).toBeGreaterThanOrEqual(minY as number);
    expect(cx + r).toBeLessThanOrEqual((minX as number) + (width as number));
    expect(cy + r).toBeLessThanOrEqual((minY as number) + (height as number));
    expect(Number(ring.ringFill.getAttribute('stroke-dasharray'))).toBeCloseTo(2 * Math.PI * r, 10);
  });
});
