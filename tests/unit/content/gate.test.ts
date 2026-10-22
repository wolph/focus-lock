// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  claimContentLifecycle,
  docStateFor,
  installPersistedPageShow,
  markDocumentStopped,
  recoverRestoredOverlay,
  shouldStop,
} from '../../../src/content/gate';

describe('claimContentLifecycle', () => {
  it('allows only one content-script instance to own a document', () => {
    const scope: Record<string, unknown> = {};

    expect(claimContentLifecycle(scope)).toBe(true);
    expect(claimContentLifecycle(scope)).toBe(false);
  });
});

describe('docStateFor', () => {
  it('is fresh while loading, loaded after', () => {
    expect(docStateFor('loading')).toBe('fresh');
    expect(docStateFor('interactive')).toBe('loaded');
    expect(docStateFor('complete')).toBe('loaded');
  });
});

describe('shouldStop', () => {
  it('stops only blocked fresh documents', () => {
    expect(shouldStop(true, 'fresh')).toBe(true);
    expect(shouldStop(true, 'loaded')).toBe(false);
    expect(shouldStop(false, 'fresh')).toBe(false);
  });
});

describe('installPersistedPageShow', () => {
  it('reevaluates exactly once for a persisted restore and ignores normal pageshow', () => {
    const reevaluate = vi.fn<() => void>();
    const remove: () => void = installPersistedPageShow(window, reevaluate);

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));

    expect(reevaluate).toHaveBeenCalledTimes(1);
    remove();
  });
});

describe('recoverRestoredOverlay', () => {
  it('removes stale hosts and does not trust a page-set title', () => {
    document.title = 'Locked - Focus Lock';
    document.documentElement.append(
      document.createElement('focus-lock-overlay'),
      document.createElement('focus-lock-overlay'),
    );

    expect(recoverRestoredOverlay(document, {})).toBe(false);
    expect(document.querySelectorAll('focus-lock-overlay')).toHaveLength(0);
  });

  it('reports the stopped state this scope recorded', () => {
    const scope: Record<string, unknown> = {};
    markDocumentStopped(scope);

    expect(recoverRestoredOverlay(document, scope)).toBe(true);
  });
});
