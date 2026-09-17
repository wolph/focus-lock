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
 * A stopped document wears this title, which is how a restored one recognizes itself. The
 * comparison is between two documents of the same browser, so reading it once in the browser's
 * UI language is enough for a restore to match.
 */
export const STOPPED_DOCUMENT_TITLE: string = t('overlay_stopped_title');

export function recoverRestoredOverlay(document: Document): boolean {
  const staleHosts: Element[] = Array.from(document.querySelectorAll('focus-lock-overlay'));
  const wasStopped: boolean = staleHosts.length > 0 && document.title === STOPPED_DOCUMENT_TITLE;
  for (const host of staleHosts) host.remove();
  return wasStopped;
}
