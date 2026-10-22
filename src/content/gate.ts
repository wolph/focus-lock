/** Pure decision helpers for the document_start gate. Kept out of
 * index.ts so tests never execute the entry's top-level evaluate(). */
import { t } from '../shared/i18n';

const CONTENT_LIFECYCLE_KEY: string = '__focusLockContentLifecycle';

export function claimContentLifecycle(scope: Record<string, unknown>): boolean {
  if (scope[CONTENT_LIFECYCLE_KEY] === true) return false;
  scope[CONTENT_LIFECYCLE_KEY] = true;
  return true;
}

export function docStateFor(readyState: DocumentReadyState): 'fresh' | 'loaded' {
  return readyState === 'loading' ? 'fresh' : 'loaded';
}

export function shouldStop(blocked: boolean, docState: 'fresh' | 'loaded'): boolean {
  return blocked && docState === 'fresh';
}

export function installPersistedPageShow(target: Window, reevaluate: () => void): () => void {
  const onPageShow: (event: PageTransitionEvent) => void = (event: PageTransitionEvent): void => {
    if (event.persisted) reevaluate();
  };
  target.addEventListener('pageshow', onPageShow);
  return (): void => target.removeEventListener('pageshow', onPageShow);
}

/**
 * A stopped document wears this title. The title only labels the tab: whether this document was
 * stopped is the content script's own memory, because the page can set the title and plant a
 * `focus-lock-overlay` element of its own.
 */
export const STOPPED_DOCUMENT_TITLE: string = t('overlay_stopped_title');

const DOCUMENT_STOPPED_KEY: string = '__focusLockDocumentStopped';

export function markDocumentStopped(scope: Record<string, unknown>): void {
  scope[DOCUMENT_STOPPED_KEY] = true;
}

/**
 * Removes every leftover overlay host, which this content script never mounted, and reports
 * whether this scope already stopped the document. Page elements and the title never decide it.
 */
export function recoverRestoredOverlay(
  document: Document,
  scope: Record<string, unknown>,
): boolean {
  for (const host of Array.from(document.querySelectorAll('focus-lock-overlay'))) host.remove();
  return scope[DOCUMENT_STOPPED_KEY] === true;
}
