// @vitest-environment jsdom
/**
 * Master's return-to-work suite on the v2 renderer. Where master re-fetched a snapshot after an
 * action, the worker now pushes the next view, so those cases render the pushed view by hand and
 * pin that the page never asks for one.
 */
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  clearDocumentOverlay,
  refreshWorkTarget,
  renderDocumentOverlay,
} from '../../../src/content/overlay-v2';
import {
  activeCopy,
  activeView,
  cancelGate,
  gatedView,
  OTHER_SESSION_ID,
  root,
  SESSION_ID,
  VERDICT,
} from './overlay-v2-fixtures';

function requestTypes(sendMessage: Mock<(req: { type: string }) => Promise<unknown>>): string[] {
  return sendMessage.mock.calls.map(([req]: [{ type: string }]): string => req.type);
}

afterEach((): void => {
  clearDocumentOverlay();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('return to work overlay', (): void => {
  it('shows a next step, open site access, and no attempts', (): void => {
    renderDocumentOverlay(activeView(), VERDICT);
    expect(root().querySelector('.intention')?.textContent).toBe('Continue your current task');
    expect(root().querySelector('summary')?.textContent).toBe('Need a break or site access?');
    expect(root().querySelector('details')?.open).toBe(true);
    expect(root().querySelector('.attempts')).toBeNull();
  });

  it('preserves the exact gate input, selection, focus and scroll on a repaint', (): void => {
    const view = gatedView();
    renderDocumentOverlay(view, VERDICT);
    const input: HTMLInputElement = root().querySelector('.phrase') as HTMLInputElement;
    input.value = 'I choose';
    input.focus();
    input.setSelectionRange(2, 5);
    const backdrop: HTMLElement = root().querySelector('.backdrop') as HTMLElement;
    backdrop.scrollTop = 50;
    renderDocumentOverlay({ ...view, theme: 'dark', attemptsToday: 4 }, VERDICT);
    const after: HTMLInputElement = root().querySelector('.phrase') as HTMLInputElement;
    expect(after.value).toBe('I choose');
    expect(after.selectionStart).toBe(2);
    expect(after.selectionEnd).toBe(5);
    expect(root().activeElement).toBe(after);
    expect(backdrop.scrollTop).toBe(50);
  });

  it('keeps the focused control and the scroll position across a repaint', (): void => {
    renderDocumentOverlay(activeView(), VERDICT);
    const backdrop: HTMLElement = root().querySelector('.backdrop') as HTMLElement;
    const summary: HTMLElement = root().querySelector('summary') as HTMLElement;
    backdrop.scrollTop = 80;
    summary.focus();
    renderDocumentOverlay(activeView({ attemptsToday: 5 }), VERDICT);
    expect(root().activeElement).toBe(root().querySelector('summary'));
    expect(root().activeElement).not.toBe(summary);
    expect(backdrop.scrollTop).toBe(80);
  });

  it('activates the saved target with the view session and never asks for block state', async (): Promise<void> => {
    const sendMessage: Mock<(req: { type: string }) => Promise<unknown>> = vi.fn(
      async (req: { type: string }): Promise<unknown> =>
        req.type === 'getWorkTarget'
          ? { ok: true, state: 'ready', title: 'Report', sessionId: SESSION_ID }
          : { ok: true },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    renderDocumentOverlay(activeView(), VERDICT);
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
    );
    (root().querySelector('.return-work') as HTMLButtonElement).click();
    await vi.waitFor((): void =>
      expect(sendMessage).toHaveBeenCalledWith({ type: 'returnToWork', sessionId: SESSION_ID }),
    );
    expect(requestTypes(sendMessage)).not.toContain('getBlockState');
    expect(requestTypes(sendMessage)).not.toContain('getSnapshot');
  });
});

it('moves initial focus to the ready work button without stealing deliberate focus', async (): Promise<void> => {
  let resolveTarget: (value: unknown) => void = (): void => {};
  const sendMessage: Mock<() => Promise<unknown>> = vi.fn(
    async (): Promise<unknown> =>
      new Promise<unknown>((resolve: (value: unknown) => void): void => {
        resolveTarget = resolve;
      }),
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  expect(root().activeElement).toBe(root().querySelector('[role="dialog"]'));
  resolveTarget({ ok: true, state: 'ready', title: 'Report', sessionId: SESSION_ID });
  await vi.waitFor((): void =>
    expect(root().activeElement).toBe(root().querySelector('.return-work')),
  );
});

it('leaves focus where the person put it once they have interacted', async (): Promise<void> => {
  let resolveTarget: (value: unknown) => void = (): void => {};
  const sendMessage: Mock<() => Promise<unknown>> = vi.fn(
    async (): Promise<unknown> =>
      new Promise<unknown>((resolve: (value: unknown) => void): void => {
        resolveTarget = resolve;
      }),
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  const summary: HTMLElement = root().querySelector('summary') as HTMLElement;
  summary.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
  summary.focus();
  resolveTarget({ ok: true, state: 'ready', title: 'Report', sessionId: SESSION_ID });
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
  );
  expect(root().activeElement).toBe(summary);
});

it('ignores an older target reply and never refreshes the target on timer ticks', async (): Promise<void> => {
  vi.useFakeTimers();
  const resolvers: Array<(value: unknown) => void> = [];
  const sendMessage: Mock<() => Promise<unknown>> = vi.fn(
    async (): Promise<unknown> =>
      new Promise<unknown>((resolve: (value: unknown) => void): void => {
        resolvers.push(resolve);
      }),
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  refreshWorkTarget();
  resolvers[1]?.({ ok: true, state: 'ready', title: 'New report', sessionId: SESSION_ID });
  await Promise.resolve();
  await Promise.resolve();
  resolvers[0]?.({ ok: true, state: 'ready', title: 'Old report', sessionId: SESSION_ID });
  await Promise.resolve();
  await Promise.resolve();
  expect(root().querySelector('.work-target')?.textContent).toBe('New report');
  await vi.advanceTimersByTimeAsync(1000);
  expect(sendMessage).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('does not re-read the target for a repaint of the same session', (): void => {
  const sendMessage: Mock<() => Promise<unknown>> = vi.fn(
    async (): Promise<unknown> => ({
      ok: true,
      sessionId: SESSION_ID,
      state: 'missing',
      title: null,
    }),
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  renderDocumentOverlay(activeView({ theme: 'dark' }), VERDICT);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  renderDocumentOverlay(activeView({ sessionId: OTHER_SESSION_ID }), VERDICT);
  expect(sendMessage).toHaveBeenCalledTimes(2);
});

it('updates action costs on a repaint while preserving expanded site access', (): void => {
  renderDocumentOverlay(activeView(), VERDICT);
  const details: HTMLDetailsElement = root().querySelector('details') as HTMLDetailsElement;
  details.open = true;
  renderDocumentOverlay(
    activeView({
      economy: { ...activeView().economy, unlockCostMs: 35_000 },
      copy: activeCopy({ unlockAction: 'Unlock this site 0:35 - costs 0:35 credit' }),
    }),
    VERDICT,
  );
  expect((root().querySelector('details') as HTMLDetailsElement).open).toBe(true);
  expect(root().querySelector('.buttons .pill')?.textContent).toContain(
    'Unlock this site 0:35 - costs 0:35 credit',
  );
});

it.each([{ ok: false, error: 'Old return failed' }, { ok: true }])(
  'ignores a stale return reply after a new session starts: %j',
  async (reply: { ok: boolean; error?: string }): Promise<void> => {
    let resolveReturn: (value: unknown) => void = (): void => {};
    let sessionId: string = SESSION_ID;
    const sendMessage: Mock<(req: { type: string }) => Promise<unknown>> = vi.fn(
      async (req: { type: string }): Promise<unknown> => {
        if (req.type === 'getWorkTarget')
          return { ok: true, state: 'ready', title: sessionId, sessionId };
        return new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveReturn = resolve;
        });
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    renderDocumentOverlay(activeView(), VERDICT);
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe(SESSION_ID),
    );
    (root().querySelector('.return-work') as HTMLButtonElement).click();
    sessionId = OTHER_SESSION_ID;
    renderDocumentOverlay(activeView({ sessionId: OTHER_SESSION_ID }), VERDICT);
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe(OTHER_SESSION_ID),
    );
    const requestCount: number = sendMessage.mock.calls.length;
    resolveReturn(reply);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(root().querySelector('.action-error')).toBeNull();
    expect(root().querySelector('.work-target')?.textContent).toBe(OTHER_SESSION_ID);
    expect(sendMessage).toHaveBeenCalledTimes(requestCount);
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false);
  },
);

it('allows wheel and touch scrolling inside its closed shadow root', (): void => {
  renderDocumentOverlay(activeView(), VERDICT);
  const backdrop: HTMLElement = root().querySelector('.backdrop') as HTMLElement;
  for (const type of ['wheel', 'touchmove']) {
    const event: Event = new Event(type, { bubbles: true, composed: true, cancelable: true });
    backdrop.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
});

it('keeps the gate until the worker pushes the next view after returning to work', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> =>
      request.type === 'getWorkTarget'
        ? { ok: true, state: 'ready', title: 'Report', sessionId: SESSION_ID }
        : { ok: true },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(gatedView(), VERDICT);
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
  );
  expect(root().querySelector('.phrase')).not.toBeNull();
  const primary: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
  primary.click();
  expect(primary.disabled).toBe(true);
  await vi.waitFor((): void => expect(primary.disabled).toBe(false));
  expect(sendMessage).toHaveBeenCalledWith({ type: 'returnToWork', sessionId: SESSION_ID });
  expect(root().querySelector('.phrase')).not.toBeNull();
  expect(requestTypes(sendMessage)).not.toContain('getSnapshot');
  renderDocumentOverlay(activeView(), VERDICT);
  expect(root().querySelector('.phrase')).toBeNull();
});

it('shows the worker refusal for a failed return and keeps the typed phrase', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> =>
      request.type === 'getWorkTarget'
        ? { ok: true, state: 'ready', title: 'Report', sessionId: SESSION_ID }
        : { ok: false, error: 'Work window unavailable' },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(gatedView(), VERDICT);
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
  );
  const input: HTMLInputElement = root().querySelector('.phrase') as HTMLInputElement;
  input.value = 'I choose';
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.action-error')?.textContent).toBe('Work window unavailable'),
  );
  expect(root().querySelector('.phrase')).toBe(input);
  expect(input.value).toBe('I choose');
});

it('shows the view transport error when the return channel throws', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, state: 'ready', title: 'Report', sessionId: SESSION_ID };
      throw new Error('receiving end does not exist');
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toBe('Report'),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.action-error')?.textContent).toBe(
      'Focus Lock could not update this action. Try again.',
    ),
  );
});

it('opens an inline picker, preserves gate editing on cancel, then saves and returns', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: SESSION_ID, state: 'missing', title: null };
      if (request.type === 'getWorkTabs')
        return {
          ok: true,
          tabs: [
            { tabId: 7, title: 'Report <script>safe title</script>' },
            { tabId: 8, title: 'Notes' },
          ],
        };
      return { ok: true };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(gatedView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  const input: HTMLInputElement = root().querySelector('.phrase') as HTMLInputElement;
  const details: HTMLDetailsElement = root().querySelector('details') as HTMLDetailsElement;
  input.value = 'I choose';
  input.setSelectionRange(2, 5);
  const primary: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
  primary.focus();
  primary.click();
  await vi.waitFor((): void => expect(root().querySelectorAll('.work-tab-option')).toHaveLength(2));
  expect(sendMessage).toHaveBeenCalledWith({ type: 'getWorkTabs', sessionId: SESSION_ID });
  const first: HTMLButtonElement = root().querySelector('.work-tab-option') as HTMLButtonElement;
  expect(first.textContent).toContain('Report <script>safe title</script>');
  expect(root().querySelector('script')).toBeNull();
  first.focus();
  first.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
  expect(root().activeElement?.textContent).toContain('Notes');
  first.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
  expect(root().querySelector('.work-picker')).toBeNull();
  expect(root().activeElement).toBe(primary);
  expect(root().querySelector('.phrase')).toBe(input);
  expect(input.value).toBe('I choose');
  expect(input.selectionStart).toBe(2);
  expect(root().querySelector('details')).toBe(details);
  expect(details.open).toBe(true);
  primary.click();
  await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
  (root().querySelector('.work-tab-option') as HTMLButtonElement).click();
  await vi.waitFor((): void =>
    expect(sendMessage).toHaveBeenCalledWith({ type: 'returnToWork', sessionId: SESSION_ID }),
  );
  expect(sendMessage).toHaveBeenCalledWith({
    type: 'setWorkTarget',
    sessionId: SESSION_ID,
    tabId: 7,
  });
  await vi.waitFor((): void => expect(root().querySelector('.work-picker')).toBeNull());
  // The selection re-reads the target, and the gate waits for the worker's next view.
  await vi.waitFor((): void =>
    expect(
      requestTypes(sendMessage).filter((type: string): boolean => type === 'getWorkTarget'),
    ).toHaveLength(2),
  );
  expect(root().querySelector('.phrase')).not.toBeNull();
});

it.each(['cancel', 'session'] as const)(
  'ignores deferred picker selections after %s',
  async (replacement: 'cancel' | 'session'): Promise<void> => {
    let resolveSave: (value: unknown) => void = (): void => {};
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (request: { type: string }): Promise<unknown> => {
        if (request.type === 'getWorkTarget')
          return { ok: true, sessionId: SESSION_ID, state: 'missing', title: null };
        if (request.type === 'getWorkTabs')
          return { ok: true, tabs: [{ tabId: 7, title: 'Report' }] };
        return new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveSave = resolve;
        });
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    renderDocumentOverlay(activeView(), VERDICT);
    await vi.waitFor((): void =>
      expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
    );
    (root().querySelector('.return-work') as HTMLButtonElement).click();
    await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
    (root().querySelector('.work-tab-option') as HTMLButtonElement).click();
    if (replacement === 'cancel')
      (root().querySelector('.work-picker-cancel') as HTMLButtonElement).click();
    else renderDocumentOverlay(activeView({ sessionId: OTHER_SESSION_ID }), VERDICT);
    resolveSave({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(requestTypes(sendMessage)).not.toContain('returnToWork');
    expect(root().querySelector('.work-picker')).toBeNull();
  },
);

it('offers retry for failed listing and handles an empty list without altering the session', async (): Promise<void> => {
  let list: unknown = { ok: false, error: 'Could not load tabs' };
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> =>
      request.type === 'getWorkTarget'
        ? { ok: true, sessionId: SESSION_ID, state: 'missing', title: null }
        : list,
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-picker [role="alert"]')).not.toBeNull(),
  );
  list = { ok: true, tabs: [] };
  (root().querySelector('.work-picker-retry') as HTMLButtonElement).click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-picker')?.textContent).toContain('No available work tabs'),
  );
  expect(root().querySelector('.work-tab-option')).toBeNull();
});

it('can keep focusing without a selected work tab, bound to the gate it abandons', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> =>
      request.type === 'getWorkTarget'
        ? { ok: true, sessionId: SESSION_ID, state: 'missing', title: null }
        : { ok: true },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(gatedView(), VERDICT);
  const keep: HTMLButtonElement | undefined = Array.from(root().querySelectorAll('button')).find(
    (button: HTMLButtonElement): boolean => button.textContent === 'Keep focusing',
  );
  expect(keep).toBeDefined();
  keep?.click();
  await vi.waitFor((): void =>
    expect(sendMessage).toHaveBeenCalledWith({ type: 'abandonGate', expectedGate: cancelGate() }),
  );
  expect(root().querySelector('.phrase')).not.toBeNull();
});

it('keeps the chooser open after a denied selection and never returns to that tab', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: SESSION_ID, state: 'ready', title: 'Previous' };
      if (request.type === 'getWorkTabs')
        return { ok: true, tabs: [{ tabId: 7, title: 'Report' }] };
      return { ok: false, error: 'That tab is no longer available.' };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.change-work') as HTMLButtonElement).hidden).toBe(false),
  );
  (root().querySelector('.change-work') as HTMLButtonElement).click();
  await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
  const row: HTMLButtonElement = root().querySelector('.work-tab-option') as HTMLButtonElement;
  row.click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-picker [role="alert"]')?.textContent).toBe(
      'That tab is no longer available.',
    ),
  );
  expect(row.disabled).toBe(false);
  expect(root().activeElement).toBe(row);
  expect(requestTypes(sendMessage)).not.toContain('returnToWork');
});

it('does not insert a deferred tab list after its chooser is cancelled', async (): Promise<void> => {
  let resolveList: (value: unknown) => void = (): void => {};
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> =>
      request.type === 'getWorkTarget'
        ? { ok: true, sessionId: SESSION_ID, state: 'missing', title: null }
        : new Promise<unknown>((resolve: (value: unknown) => void): void => {
            resolveList = resolve;
          }),
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  expect(root().querySelector('.work-picker')?.textContent).toContain('Finding available tabs...');
  (root().querySelector('.work-picker-cancel') as HTMLButtonElement).click();
  resolveList({ ok: true, tabs: [{ tabId: 7, title: 'Report' }] });
  await Promise.resolve();
  await Promise.resolve();
  expect(root().querySelector('.work-picker')).toBeNull();
});

it('keeps focus inside the overlay while retrying a failed list', async (): Promise<void> => {
  let pending: boolean = false;
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: SESSION_ID, state: 'missing', title: null };
      if (!pending) return { ok: false, error: 'Unavailable' };
      return new Promise<unknown>((): void => {});
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void =>
    expect((root().querySelector('.work-picker-retry') as HTMLButtonElement).disabled).toBe(false),
  );
  const retry: HTMLButtonElement = root().querySelector('.work-picker-retry') as HTMLButtonElement;
  retry.focus();
  pending = true;
  retry.click();
  expect(root().activeElement).toBe(root().querySelector('.work-picker-cancel'));
});

it('restores overlay focus before a selected work tab fails to activate', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: SESSION_ID, state: 'missing', title: null };
      if (request.type === 'getWorkTabs')
        return { ok: true, tabs: [{ tabId: 7, title: 'Report' }] };
      return request.type === 'setWorkTarget'
        ? { ok: true }
        : { ok: false, error: 'Activation failed' };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  const primary: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
  primary.click();
  await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
  const row: HTMLButtonElement = root().querySelector('.work-tab-option') as HTMLButtonElement;
  row.focus();
  row.click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.action-error')?.textContent).toBe('Activation failed'),
  );
  expect(root().activeElement).not.toBeNull();
});

it('focuses Cancel before disabling the selected row during a pending save', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: SESSION_ID, state: 'missing', title: null };
      if (request.type === 'getWorkTabs')
        return { ok: true, tabs: [{ tabId: 7, title: 'Report' }] };
      return new Promise<unknown>((): void => {});
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
  const row: HTMLButtonElement = root().querySelector('.work-tab-option') as HTMLButtonElement;
  row.focus();
  row.click();
  expect(row.disabled).toBe(true);
  expect(root().activeElement).toBe(root().querySelector('.work-picker-cancel'));
  root().activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
  expect(root().querySelector('.work-picker')).toBeNull();
});

it('restores focus to the primary action when the picker trigger becomes hidden', async (): Promise<void> => {
  let ready: boolean = true;
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> =>
      request.type === 'getWorkTarget'
        ? {
            ok: true,
            sessionId: SESSION_ID,
            state: ready ? 'ready' : 'unavailable',
            title: ready ? 'Report' : null,
          }
        : { ok: true, tabs: [{ tabId: 7, title: 'Notes' }] },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.change-work') as HTMLButtonElement).hidden).toBe(false),
  );
  const change: HTMLButtonElement = root().querySelector('.change-work') as HTMLButtonElement;
  const backdrop: HTMLElement = root().querySelector('.backdrop') as HTMLElement;
  backdrop.scrollTop = 50;
  change.focus();
  change.click();
  ready = false;
  refreshWorkTarget();
  await vi.waitFor((): void => expect(change.hidden).toBe(true));
  (root().querySelector('.work-picker-cancel') as HTMLButtonElement).click();
  expect(root().activeElement).toBe(root().querySelector('.return-work'));
  expect(backdrop.scrollTop).toBe(50);
});

it('lets a stopped page retry a transient work-target lookup before opening the chooser', async (): Promise<void> => {
  let lookups: number = 0;
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type === 'getWorkTarget') {
        lookups += 1;
        if (lookups === 1) throw new Error('Message port closed');
        return { ok: true, sessionId: SESSION_ID, state: 'missing', title: null };
      }
      if (request.type === 'getWorkTabs')
        return { ok: true, tabs: [{ tabId: 7, title: 'Report' }] };
      throw new Error('Unexpected request');
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(
    activeView({
      stoppedPage: true,
      copy: activeCopy({
        stoppedPage: 'This page did not load. It will load by itself when the session ends.',
      }),
    }),
    VERDICT,
  );
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toContain('Could not'),
  );
  const choose: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
  expect(choose.disabled).toBe(false);
  choose.click();
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-tab-option')?.textContent).toContain('Report'),
  );
  expect(requestTypes(sendMessage)).toEqual([
    'getWorkTarget',
    'getWorkTarget',
    'getWorkTabs',
    'getWorkTabIcon',
  ]);
});

it.each([
  {
    reply: { ok: false, error: 'The requesting page has changed. Reload the page.' },
    message: 'The requesting page has changed. Reload the page.',
  },
  {
    reply: { ok: true, sessionId: null, state: 'missing', title: null },
    message: 'Your focus session is not available. Try again, or reload this page.',
  },
  {
    reply: { ok: true, sessionId: OTHER_SESSION_ID, state: 'missing', title: null },
    message: 'Your focus session is not available. Try again, or reload this page.',
  },
])(
  'keeps retry available without inventing a session for %j',
  async ({ reply, message }): Promise<void> => {
    const sendMessage: Mock<() => Promise<unknown>> = vi.fn(async (): Promise<unknown> => reply);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    renderDocumentOverlay(activeView(), VERDICT);
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toBe(message),
    );
    const choose: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
    expect(choose.disabled).toBe(false);
    choose.click();
    await vi.waitFor((): void => expect(sendMessage).toHaveBeenCalledTimes(2));
    await vi.waitFor((): void => expect(choose.disabled).toBe(false));
    expect(root().querySelector('.work-picker')).toBeNull();
    expect(sendMessage.mock.calls).toEqual([
      [{ type: 'getWorkTarget' }],
      [{ type: 'getWorkTarget' }],
    ]);
  },
);

it('keeps failed retry focus and gate editing inside the stopped overlay', async (): Promise<void> => {
  let resolveRetry: (value: unknown) => void = (): void => {};
  const sendMessage: Mock<() => Promise<unknown>> = vi
    .fn()
    .mockRejectedValueOnce(new Error('Extension context invalidated.'))
    .mockImplementationOnce(
      async (): Promise<unknown> =>
        new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveRetry = resolve;
        }),
    );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(
    gatedView({
      stoppedPage: true,
      copy: activeCopy({
        gateTitle: 'End this session',
        gateConfirm: 'End the session',
        stoppedPage: 'This page did not load. It will load by itself when the session ends.',
      }),
    }),
    VERDICT,
  );
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toContain('Reload this page'),
  );
  const input: HTMLInputElement = root().querySelector('.phrase') as HTMLInputElement;
  input.value = 'I choose';
  input.setSelectionRange(2, 5);
  const backdrop: HTMLElement = root().querySelector('.backdrop') as HTMLElement;
  backdrop.scrollTop = 50;
  const choose: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
  choose.focus();
  choose.click();
  expect(choose.disabled).toBe(true);
  expect(root().activeElement).toBe(backdrop);
  resolveRetry({ ok: false, error: 'The requesting page has changed. Reload the page.' });
  await vi.waitFor((): void => expect(choose.disabled).toBe(false));
  expect(root().activeElement).toBe(choose);
  expect(root().querySelector('.phrase')).toBe(input);
  expect(input.value).toBe('I choose');
  expect(input.selectionStart).toBe(2);
  expect(root().querySelector('details')?.open).toBe(true);
  expect(backdrop.scrollTop).toBe(50);
});

it('does not open a chooser from a retry reply belonging to the previous session', async (): Promise<void> => {
  let resolveRetry: (value: unknown) => void = (): void => {};
  let lookups: number = 0;
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> => {
      if (request.type !== 'getWorkTarget') throw new Error('Unexpected request');
      lookups += 1;
      if (lookups === 1) throw new Error('Message port closed');
      if (lookups === 2)
        return new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveRetry = resolve;
        });
      return { ok: true, sessionId: OTHER_SESSION_ID, state: 'ready', title: 'New task' };
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toContain('Could not'),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  renderDocumentOverlay(activeView({ sessionId: OTHER_SESSION_ID }), VERDICT);
  await vi.waitFor((): void =>
    expect(root().querySelector('.work-target')?.textContent).toBe('New task'),
  );
  resolveRetry({ ok: true, sessionId: SESSION_ID, state: 'missing', title: null });
  await Promise.resolve();
  await Promise.resolve();
  expect(root().querySelector('.work-target')?.textContent).toBe('New task');
  expect(root().querySelector('.work-picker')).toBeNull();
  expect(sendMessage).toHaveBeenCalledTimes(3);
});

it.each([
  { ok: false, error: 'Unavailable' },
  { malformed: true },
  { ok: true, sessionId: null, state: 'missing', title: null },
])(
  'restores visible focus when a target refresh invalidates the change picker: %j',
  async (reply: unknown): Promise<void> => {
    let current: unknown = { ok: true, sessionId: SESSION_ID, state: 'ready', title: 'Report' };
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (request: { type: string }): Promise<unknown> =>
        request.type === 'getWorkTarget' ? current : { ok: true, tabs: [] },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    renderDocumentOverlay(activeView(), VERDICT);
    await vi.waitFor((): void =>
      expect((root().querySelector('.change-work') as HTMLButtonElement).hidden).toBe(false),
    );
    (root().querySelector('.change-work') as HTMLButtonElement).click();
    expect(root().activeElement).toBe(root().querySelector('.work-picker-search'));
    current = reply;
    refreshWorkTarget();
    await vi.waitFor((): void => expect(root().querySelector('.work-picker')).toBeNull());
    expect(root().activeElement).toBe(root().querySelector('.return-work'));
  },
);

it.each([false, true])(
  'preserves focus during a background retry lookup, deliberate focus move: %s',
  async (moveFocus: boolean): Promise<void> => {
    let resolveRefresh: (value: unknown) => void = (): void => {};
    const sendMessage: Mock<() => Promise<unknown>> = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockImplementationOnce(
        async (): Promise<unknown> =>
          new Promise<unknown>((resolve: (value: unknown) => void): void => {
            resolveRefresh = resolve;
          }),
      );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    renderDocumentOverlay(activeView(), VERDICT);
    await vi.waitFor((): void =>
      expect(root().querySelector('.work-target')?.textContent).toContain('Could not'),
    );
    const primary: HTMLButtonElement = root().querySelector('.return-work') as HTMLButtonElement;
    primary.focus();
    refreshWorkTarget();
    expect(primary.disabled).toBe(true);
    expect(root().activeElement).toBe(root().querySelector('[role="dialog"]'));
    const summary: HTMLElement = root().querySelector('summary') as HTMLElement;
    if (moveFocus) summary.focus();
    resolveRefresh({ ok: false, error: 'Unavailable' });
    await vi.waitFor((): void => expect(primary.disabled).toBe(false));
    expect(root().activeElement).toBe(moveFocus ? summary : primary);
  },
);

it.each([
  { ok: false, error: 'Unavailable' },
  { ok: true, sessionId: null, state: 'missing', title: null },
])(
  'moves focus off Change work tab before a reply hides it: %j',
  async (reply: unknown): Promise<void> => {
    let resolveRefresh: (value: unknown) => void = (): void => {};
    let lookups: number = 0;
    const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
      async (request: { type: string }): Promise<unknown> => {
        if (request.type !== 'getWorkTarget') return { ok: true, tabs: [] };
        lookups += 1;
        if (lookups === 1)
          return { ok: true, sessionId: SESSION_ID, state: 'ready', title: 'Report' };
        return new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveRefresh = resolve;
        });
      },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    renderDocumentOverlay(activeView(), VERDICT);
    await vi.waitFor((): void =>
      expect((root().querySelector('.change-work') as HTMLButtonElement).hidden).toBe(false),
    );
    const change: HTMLButtonElement = root().querySelector('.change-work') as HTMLButtonElement;
    change.click();
    refreshWorkTarget();
    change.focus();
    resolveRefresh(reply);
    await vi.waitFor((): void => expect(change.hidden).toBe(true));
    expect(root().activeElement).toBe(root().querySelector('.return-work'));
  },
);

it('keeps the picker open through a same-session repaint and closes it with Escape', async (): Promise<void> => {
  const sendMessage: Mock<(request: { type: string }) => Promise<unknown>> = vi.fn(
    async (request: { type: string }): Promise<unknown> =>
      request.type === 'getWorkTarget'
        ? { ok: true, sessionId: SESSION_ID, state: 'missing', title: null }
        : { ok: true, tabs: [{ tabId: 7, title: 'Report' }] },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  renderDocumentOverlay(activeView(), VERDICT);
  await vi.waitFor((): void =>
    expect((root().querySelector('.return-work') as HTMLButtonElement).disabled).toBe(false),
  );
  (root().querySelector('.return-work') as HTMLButtonElement).click();
  await vi.waitFor((): void => expect(root().querySelector('.work-tab-option')).not.toBeNull());
  const search: HTMLInputElement = root().querySelector('.work-picker-search') as HTMLInputElement;
  search.value = 'rep';
  search.focus();
  renderDocumentOverlay(activeView({ attemptsToday: 9 }), VERDICT);
  expect(root().querySelector('.work-picker-search')).toBe(search);
  expect(root().activeElement).toBe(search);
  expect(root().querySelector('.panel')?.hasAttribute('inert')).toBe(true);
  search.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
  );
  expect(root().querySelector('.work-picker')).toBeNull();
  expect(root().querySelector('.panel')?.hasAttribute('inert')).toBe(false);
  expect(root().activeElement).toBe(root().querySelector('.return-work'));
});
