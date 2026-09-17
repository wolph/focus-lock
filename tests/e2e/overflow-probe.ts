import type { BrowserContext, CDPSession, Page } from '@playwright/test';

/** One element whose text does not fit the box the layout gives it. */
export interface OverflowFinding {
  selector: string;
  text: string;
  scrollWidth: number;
  clientWidth: number;
  kind: 'horizontal' | 'clipped';
}

/**
 * Elements whose content is wider than their box, and text whose box escapes the nearest clipping
 * ancestor. A translation that does not fit shows up as one or the other, and both are invisible
 * in a full-page screenshot until someone reads the page character by character.
 *
 * This function is shipped to the browser as source, both through `page.evaluate` and, for the
 * overlay's closed shadow root, through `Runtime.callFunctionOn`. It therefore closes over
 * nothing: everything it needs is either an argument or a browser global.
 */
function collectOverflow(container: Element): OverflowFinding[] {
  const SLACK_PX: number = 1;
  const findings: OverflowFinding[] = [];

  const describe = (element: Element): string => {
    const id: string = element.id === '' ? '' : `#${element.id}`;
    const classes: string =
      typeof element.className === 'string' && element.className !== ''
        ? `.${element.className.trim().split(/\s+/).join('.')}`
        : '';
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  };

  const scrollable = (style: CSSStyleDeclaration): boolean =>
    style.overflowX === 'auto' ||
    style.overflowX === 'scroll' ||
    style.overflowY === 'auto' ||
    style.overflowY === 'scroll';

  const clippingAncestor = (element: Element): Element | null => {
    let parent: Element | null = element.parentElement;
    while (parent !== null) {
      const style: CSSStyleDeclaration = getComputedStyle(parent);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return parent;
      parent = parent.parentElement;
    }
    return null;
  };

  // The document element is the page's own scroller: a layout that overflows the window shows up
  // here rather than on any element inside the body.
  const root: Element | null = container.ownerDocument.documentElement;
  const elements: Element[] =
    root === null || root === container
      ? [container, ...container.querySelectorAll('*')]
      : [root, container, ...container.querySelectorAll('*')];
  for (const element of elements) {
    const style: CSSStyleDeclaration = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const box: DOMRect = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;

    if (element.scrollWidth > element.clientWidth + SLACK_PX && !scrollable(style)) {
      findings.push({
        selector: describe(element),
        text: (element.textContent ?? '').trim().slice(0, 80),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        kind: 'horizontal',
      });
      continue;
    }

    const hasOwnText: boolean = Array.prototype.some.call(
      element.childNodes,
      (node: ChildNode): boolean => node.nodeType === 3 && (node.textContent ?? '').trim() !== '',
    );
    if (!hasOwnText) continue;
    const clipper: Element | null = clippingAncestor(element);
    if (clipper === null) continue;
    if (scrollable(getComputedStyle(clipper))) continue;
    const clip: DOMRect = clipper.getBoundingClientRect();
    if (box.bottom > clip.bottom + SLACK_PX || box.right > clip.right + SLACK_PX) {
      findings.push({
        selector: describe(element),
        text: (element.textContent ?? '').trim().slice(0, 80),
        scrollWidth: Math.round(box.right),
        clientWidth: Math.round(clip.right),
        kind: 'clipped',
      });
    }
  }
  return findings;
}

/** Overflow anywhere under `rootSelector` in the page's own document. */
export async function overflowFindings(
  page: Page,
  rootSelector: string = 'body',
): Promise<OverflowFinding[]> {
  return await page.evaluate(
    ({ root, source }: { root: string; source: string }): OverflowFinding[] => {
      const container: Element | null = document.querySelector(root);
      if (container === null) return [];
      const collect = new Function(`return (${source});`)() as (
        element: Element,
      ) => OverflowFinding[];
      return collect(container);
    },
    { root: rootSelector, source: collectOverflow.toString() },
  );
}

/**
 * The same probe, inside the overlay's closed shadow root. A closed root refuses `.shadowRoot` to
 * page JavaScript, so the container is located through the CDP DOM domain with `pierce` and
 * resolved to a remote object the probe can be called on.
 */
export async function overlayOverflowFindings(
  page: Page,
  context: BrowserContext,
): Promise<OverflowFinding[]> {
  const session: CDPSession = await context.newCDPSession(page);
  try {
    await session.send('DOM.enable');
    const document = (await session.send('DOM.getDocument', {
      depth: -1,
      pierce: true,
    })) as unknown as { root: PiercedNode };
    const host: PiercedNode | undefined = findNode(
      document.root,
      (node: PiercedNode): boolean => node.nodeName === 'FOCUS-LOCK-OVERLAY',
    );
    if (host === undefined) throw new Error('overlay host was not found');
    const container: PiercedNode | undefined = findNode(host, hasBackdropClass);
    if (container === undefined) throw new Error('overlay container was not found');
    const resolved = (await session.send('DOM.resolveNode', {
      nodeId: container.nodeId,
    })) as unknown as { object: { objectId?: string } };
    if (resolved.object.objectId === undefined) {
      throw new Error('overlay container did not resolve');
    }
    const called = (await session.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      returnByValue: true,
      functionDeclaration: `function () { return (${collectOverflow.toString()})(this); }`,
    })) as unknown as { result: { value?: OverflowFinding[] } };
    return called.result.value ?? [];
  } finally {
    await session.detach();
  }
}

/** The overlay's own text direction, read from the host element that carries it. */
export async function overlayDirection(page: Page): Promise<string> {
  return await page.evaluate((): string => {
    const host: HTMLElement | null = document.querySelector('focus-lock-overlay');
    return host === null ? '' : getComputedStyle(host).direction;
  });
}

/** A readable failure message naming every element and the text that did not fit. */
export function describeOverflow(
  locale: string,
  surface: string,
  findings: OverflowFinding[],
): string {
  const lines: string[] = findings.map(
    (finding: OverflowFinding): string =>
      `  ${finding.kind} ${finding.selector}: ${finding.scrollWidth}px in ${finding.clientWidth}px - "${finding.text}"`,
  );
  return `${surface} does not fit in ${locale}:\n${lines.join('\n')}`;
}

interface PiercedNode {
  nodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: PiercedNode[];
  shadowRoots?: PiercedNode[];
  contentDocument?: PiercedNode;
}

function hasBackdropClass(node: PiercedNode): boolean {
  const attributes: string[] = node.attributes ?? [];
  for (let index = 0; index < attributes.length; index += 2) {
    const name: string | undefined = attributes[index];
    const value: string = attributes[index + 1] ?? '';
    if (name === 'class' && value.split(/\s+/).includes('backdrop')) return true;
  }
  return false;
}

function findNode(
  node: PiercedNode,
  match: (candidate: PiercedNode) => boolean,
): PiercedNode | undefined {
  if (match(node)) return node;
  const children: PiercedNode[] = [
    ...(node.children ?? []),
    ...(node.shadowRoots ?? []),
    ...(node.contentDocument === undefined ? [] : [node.contentDocument]),
  ];
  for (const child of children) {
    const found: PiercedNode | undefined = findNode(child, match);
    if (found !== undefined) return found;
  }
  return undefined;
}
