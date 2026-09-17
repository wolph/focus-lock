import { expect, startTestSession, test } from './fixtures';

/**
 * The standing popup rules, measured in the real toolbar popup rather than an emulated viewport.
 *
 * Each assertion here is a requirement the user has stated and that has regressed at least once
 * after being satisfied, which is why it is pinned rather than left to review. The rules and their
 * provenance are in docs/superpowers/specs/2026-09-17-popup-visibility-rules.md.
 */

interface PopupAudit {
  scrollers: string[];
  selects: number;
  disclosures: number;
  viewport: number;
  contentBottom: number;
  visible: Record<string, boolean>;
}

/** Everything the rules care about, read in one pass so the popup is measured in one layout. */
function auditPopup(): PopupAudit {
  const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
  if (popup === undefined) throw new Error('the toolbar popup is not open');
  const doc: Document = popup.document;

  const describe = (element: Element): string => {
    const classes: string = element.className.toString().trim().split(/\s+/).join('.');
    return classes === ''
      ? element.tagName.toLowerCase()
      : `${element.tagName.toLowerCase()}.${classes}`;
  };

  // A scroller the user must operate to reach a control. One pixel of slack absorbs subpixel
  // rounding, which reports a scrollHeight a hair over clientHeight on fractional display scales.
  const scrollers: string[] = Array.from(doc.querySelectorAll<HTMLElement>('body, body *'))
    .filter((element: HTMLElement): boolean => {
      const style: CSSStyleDeclaration = popup.getComputedStyle(element);
      const scrolls: boolean = /auto|scroll/.test(`${style.overflowY} ${style.overflowX}`);
      const overflows: boolean =
        element.scrollHeight > element.clientHeight + 1 ||
        element.scrollWidth > element.clientWidth + 1;
      return scrolls && overflows;
    })
    .map(describe);

  const visibleNow = (selector: string): boolean => {
    const node: HTMLElement | null = doc.querySelector<HTMLElement>(selector);
    if (node === null) return false;
    const box: DOMRect = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  const boxes: number[] = Array.from(doc.querySelectorAll<HTMLElement>('.active-view *')).map(
    (element: HTMLElement): number => element.getBoundingClientRect().bottom,
  );

  return {
    scrollers,
    selects: doc.querySelectorAll('select').length,
    disclosures: doc.querySelectorAll('details').length,
    viewport: popup.innerHeight,
    contentBottom: boxes.length === 0 ? 0 : Math.max(...boxes),
    visible: {
      credit: visibleNow('.session-actions .meter-label'),
      actions: visibleNow('.session-actions .actions'),
      end: visibleNow('.end-session-button'),
    },
  };
}

async function openPopupOnSession(extPage: Parameters<typeof startTestSession>[0]): Promise<void> {
  await startTestSession(extPage, { duration: { kind: 'timed', minutes: 50 } });
  await extPage.evaluate(async (): Promise<void> => {
    await chrome.action.openPopup();
  });
  await expect
    .poll(async (): Promise<boolean> => {
      return await extPage.evaluate((): boolean => {
        const popup: Window | undefined = chrome.extension.getViews({ type: 'popup' })[0];
        return popup !== undefined && popup.document.querySelector('.end-session-button') !== null;
      });
    })
    .toBe(true);
}

test('the popup needs no scrollbar during a session', async ({ extPage }) => {
  await openPopupOnSession(extPage);
  const audit: PopupAudit = await extPage.evaluate(auditPopup);

  expect(audit.scrollers).toEqual([]);
  expect(audit.contentBottom).toBeLessThanOrEqual(audit.viewport);
});

test('the session actions are visible without opening anything', async ({ extPage }) => {
  await openPopupOnSession(extPage);
  const audit: PopupAudit = await extPage.evaluate(auditPopup);

  // Nothing was clicked between opening the popup and this measurement.
  expect(audit.visible.credit).toBe(true);
  expect(audit.visible.actions).toBe(true);
  expect(audit.visible.end).toBe(true);
  expect(audit.disclosures).toBe(0);
});

test('the popup offers no work tab dropdown', async ({ extPage }) => {
  await openPopupOnSession(extPage);
  const audit: PopupAudit = await extPage.evaluate(auditPopup);

  expect(audit.selects).toBe(0);
});
