// @vitest-environment jsdom
/** Master's scale suite for the chooser, driven through the v2 renderer. */
import { afterEach, expect, it, type Mock, vi } from 'vitest';
import { clearDocumentOverlay, renderDocumentOverlay } from '../../../src/content/overlay-v2';
import { WORK_PICKER_CSS } from '../../../src/content/work-tab-picker';
import { formatNumber, tPlural } from '../../../src/shared/i18n';
import type { WorkTab } from '../../../src/shared/work-target';
import { activeView, root, SESSION_ID, VERDICT } from './overlay-v2-fixtures';

function search(): HTMLInputElement {
  return root().querySelector('.work-picker-search') as HTMLInputElement;
}
function rows(): HTMLButtonElement[] {
  return Array.from(root().querySelectorAll<HTMLButtonElement>('.work-tab-option'));
}
function key(element: Element, value: string): void {
  element.dispatchEvent(
    new KeyboardEvent('keydown', { key: value, bubbles: true, composed: true, cancelable: true }),
  );
}
/** The count line the chooser writes, so a wording change is not a test change. */
function countLine(matches: number, total: number): string {
  return tPlural('overlay_picker_count', total, { MATCHES: formatNumber(matches) });
}
function query(value: string): void {
  search().value = value;
  search().dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}
async function open(count: number, icons?: (tabId: number) => Promise<unknown>): Promise<Mock> {
  const tabs: WorkTab[] = Array.from(
    { length: count },
    (_value: unknown, index: number): WorkTab => ({
      tabId: index,
      title: `Report ${index}`,
      hostname: index % 2 === 0 ? 'work.example' : 'notes.example',
    }),
  );
  const sendMessage: Mock = vi.fn(
    async (request: { type: string; tabId?: number }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: SESSION_ID, state: 'missing', title: null };
      if (request.type === 'getWorkTabs') return { ok: true, tabs };
      if (request.type === 'getWorkTabIcon')
        return icons?.(request.tabId as number) ?? { ok: true, icon: null };
      return { ok: false, error: 'Unavailable' };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor(
    (): void =>
      expect(root().querySelector('.work-picker-body')?.getAttribute('aria-busy')).toBe('false'),
    { timeout: 15000 },
  );
  return sendMessage;
}
afterEach((): void => {
  clearDocumentOverlay();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps ten thousand candidates bounded to the viewport and reaches unrendered rows by keyboard', async (): Promise<void> => {
  await open(10000);
  expect(rows().length).toBeLessThan(30);
  expect(root().querySelector('.work-picker-count')?.textContent).toBe(countLine(10000, 10000));
  key(search(), 'ArrowDown');
  key(root().activeElement as Element, 'End');
  expect(root().activeElement?.textContent).toContain('Report 9999');
  expect(rows().length).toBeLessThan(30);
  key(root().activeElement as Element, 'Home');
  expect(root().activeElement?.textContent).toContain('Report 0');
}, 20000);

it('cancels obsolete large searches and preserves focus when scrolling removes the focused row', async (): Promise<void> => {
  await open(10000);
  query('9999');
  query('report 3333');
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-picker-count')?.textContent).toBe(countLine(1, 10000)),
  );
  expect(rows()[0]?.textContent).toContain('Report 3333');
  query('');
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-picker-count')?.textContent).toBe(countLine(10000, 10000)),
  );
  key(search(), 'ArrowDown');
  const viewport: HTMLElement = root().querySelector('.work-picker-list') as HTMLElement;
  viewport.scrollTop = 400000;
  viewport.dispatchEvent(new Event('scroll'));
  await vi.waitFor((): void => expect(rows()[0]?.textContent).not.toContain('Report 0work'));
  expect(root().activeElement).toBe(search());
  expect(rows().length).toBeLessThan(30);
}, 20000);

it('loads at most four visible icons concurrently and discards obsolete queued work', async (): Promise<void> => {
  const started: number[] = [];
  const releases: Array<() => void> = [];
  await open(1000, async (tabId: number): Promise<unknown> => {
    started.push(tabId);
    return new Promise<unknown>((resolve: (value: unknown) => void): void => {
      releases.push((): void => resolve({ ok: true, icon: null }));
    });
  });
  await vi.waitFor((): void => expect(started).toHaveLength(4));
  expect(rows()[0]?.querySelector('.work-tab-icon')?.textContent).toBe('W');
  const firstColour: string | undefined = rows()[0]?.style.getPropertyValue('--tab-colour');
  expect(firstColour).not.toBe('');
  expect(rows()[2]?.style.getPropertyValue('--tab-colour')).toBe(firstColour);
  query('report 999');
  await vi.waitFor((): void => expect(rows()).toHaveLength(1));
  for (const release of releases.slice()) release();
  await vi.waitFor((): void => expect(started).toEqual([0, 1, 2, 3, 999]));
  (root().querySelector('.work-picker-cancel') as HTMLButtonElement).click();
  for (const release of releases.slice()) release();
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toHaveLength(5);
});

it('makes the lock screen inert behind the chooser and names the saved destination in the back button', async (): Promise<void> => {
  await open(5);
  const primary: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
  expect(primary.closest('[inert]')).not.toBeNull();
  const cancel: HTMLButtonElement = root().querySelector(
    '.work-picker-cancel',
  ) as HTMLButtonElement;
  cancel.focus();
  key(cancel, 'Tab');
  expect(root().activeElement).not.toBe(primary);
  cancel.click();
  expect(primary.closest('[inert]')).toBeNull();
  expect(root().activeElement).toBe(primary);
});

it('keeps the same focused row connected during a scroll inside the overscan window', async (): Promise<void> => {
  await open(1000);
  key(search(), 'ArrowDown');
  const focused: Element = root().activeElement as Element;
  const viewport: HTMLElement = root().querySelector('.work-picker-list') as HTMLElement;
  const removed: Node[] = [];
  const observer: MutationObserver = new MutationObserver((records: MutationRecord[]): void => {
    for (const record of records) removed.push(...Array.from(record.removedNodes));
  });
  observer.observe(viewport, { childList: true, subtree: true });
  viewport.scrollTop = 40;
  viewport.dispatchEvent(new Event('scroll'));
  await new Promise<void>((resolve: () => void): void => {
    window.requestAnimationFrame((): void => resolve());
  });
  expect(root().activeElement).toBe(focused);
  expect(removed).not.toContain(focused);
  observer.disconnect();
});

it.each([
  { title: 'Report', hostname: 'work.example', label: 'Back to work: Report (work.example)' },
  { title: 'Legacy report', label: 'Back to work: Legacy report' },
  {
    title: `${'Long title '.repeat(1000)}end`,
    label: `Back to work: ${'Long title '.repeat(1000)}end`,
  },
])(
  'puts the full destination directly in the return button',
  async (target: { title: string; hostname?: string; label: string }): Promise<void> => {
    const sendMessage: Mock = vi.fn().mockResolvedValue({
      ok: true,
      sessionId: SESSION_ID,
      state: 'ready',
      title: target.title,
      ...(target.hostname === undefined ? {} : { hostname: target.hostname }),
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    renderDocumentOverlay(activeView(), VERDICT);
    await vi.waitFor((): void =>
      expect(root().querySelector('.return-work')?.getAttribute('aria-label')).toBe(target.label),
    );
    expect(root().querySelector('.return-work')?.textContent).toContain(target.title);
    if (target.hostname !== undefined)
      expect(root().querySelector('.return-work')?.textContent).toContain(target.hostname);
  },
);

const PNG: string =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Tf8AAAAASUVORK5CYII=';

it('refreshes cached icons for a same-host tab while retaining icons during search', async (): Promise<void> => {
  let calls: number = 0;
  await open(1, async (): Promise<unknown> => {
    calls += 1;
    return { ok: true, icon: calls === 1 ? null : PNG };
  });
  query('report');
  query('');
  expect(calls).toBe(1);
  (
    Array.from(root().querySelectorAll('button')).find(
      (button: HTMLButtonElement): boolean => button.textContent === 'Refresh tabs',
    ) as HTMLButtonElement
  ).click();
  await vi.waitFor((): void => expect(calls).toBe(2));
  await vi.waitFor((): void => expect(rows()[0]?.querySelector('img')?.src).toBe(PNG));
});

it('discards icons pending from metadata before a refresh', async (): Promise<void> => {
  let release: ((value: unknown) => void) | undefined;
  let calls: number = 0;
  await open(1, async (): Promise<unknown> => {
    calls += 1;
    if (calls === 1)
      return new Promise<unknown>((resolve: (value: unknown) => void): void => {
        release = resolve;
      });
    return { ok: true, icon: null };
  });
  (
    Array.from(root().querySelectorAll('button')).find(
      (button: HTMLButtonElement): boolean => button.textContent === 'Refresh tabs',
    ) as HTMLButtonElement
  ).click();
  await vi.waitFor((): void => expect(calls).toBe(2));
  release?.({ ok: true, icon: PNG });
  await Promise.resolve();
  await Promise.resolve();
  expect(rows()[0]?.querySelector('img')).toBeNull();
});

it('caps long destination titles at three visible lines', (): void => {
  const titleRule: string =
    WORK_PICKER_CSS.match(/\.return-work \.work-action-title \{([^}]+)\}/)?.[1] ?? '';
  expect(titleRule).toContain('-webkit-line-clamp: 3');
  expect(titleRule).toContain('overflow: hidden');
  expect(titleRule).toContain('-webkit-box-orient: vertical');
});
