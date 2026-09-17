/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/onboarding/App';
import type { OnboardingDraft } from '../../../src/onboarding/draft-storage';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, DEFAULT_SETUP } from '../../../src/shared/constants';
import { t } from '../../../src/shared/i18n';
import type { Request } from '../../../src/shared/messages';
import { isOnboardingDraft } from '../../../src/shared/runtime-validation';
import { LOCAL_ONBOARDING_DRAFT } from '../../../src/shared/storage-keys';
import type { SetupState, StorageMode } from '../../../src/shared/types';

const sendMessageMock = vi.fn<(request: Request) => Promise<unknown>>();
const permissionRequestMock = vi.fn<() => Promise<boolean>>();
let localState: Record<string, unknown> = {};
let setupState: SetupState = DEFAULT_SETUP;

function installChromeFake(): void {
  vi.stubGlobal('chrome', {
    permissions: {
      request: permissionRequestMock,
    },
    runtime: {
      getURL: (path: string): string => `chrome-extension://fake-id/${path}`,
      sendMessage: sendMessageMock,
    },
  });
}

function loadStoredDraft(): OnboardingDraft | null {
  const stored: unknown = localState[LOCAL_ONBOARDING_DRAFT];
  return isOnboardingDraft(stored) ? structuredClone(stored) : null;
}

function saveDraftResponse(draft: OnboardingDraft): unknown {
  const current: OnboardingDraft | null = loadStoredDraft();
  if (setupState.completed) {
    return {
      ok: false,
      error: 'Setup was completed in another tab.',
      conflict: true,
      completed: true,
      draft: current,
    };
  }
  const expectedRevision: number = current?.revision ?? 0;
  const canSave: boolean =
    (current === null && draft.revision === 0) ||
    (current !== null && draft.revision === current.revision);
  if (!canSave) {
    return {
      ok: false,
      error: 'Setup changed in another tab. The latest choices were reloaded.',
      conflict: true,
      completed: false,
      draft: current,
    };
  }
  const saved: OnboardingDraft = { ...structuredClone(draft), revision: expectedRevision + 1 };
  localState[LOCAL_ONBOARDING_DRAFT] = saved;
  return { ok: true, draft: structuredClone(saved) };
}

function completeOnboardingResponse(revision: number, storageMode: StorageMode): unknown {
  const current: OnboardingDraft | null = loadStoredDraft();
  if (
    setupState.completed ||
    current === null ||
    current.revision !== revision ||
    current.step !== 3 ||
    storageMode !== (current.syncEnabled ? 'sync' : 'local')
  ) {
    return {
      ok: false,
      error: 'Setup changed in another tab. Reload the latest choices.',
      conflict: true,
      completed: setupState.completed,
      draft: current,
    };
  }
  setupState = { ...setupState, completed: true, storageMode };
  delete localState[LOCAL_ONBOARDING_DRAFT];
  return { ok: true };
}

async function persistedDraft(): Promise<OnboardingDraft> {
  await waitFor((): void => {
    expect(localState[LOCAL_ONBOARDING_DRAFT]).toBeDefined();
  });
  return structuredClone(localState[LOCAL_ONBOARDING_DRAFT]) as OnboardingDraft;
}

function moveFocusToDocumentBody(): void {
  const focusSink: HTMLButtonElement = document.createElement('button');
  document.body.append(focusSink);
  focusSink.focus();
  focusSink.remove();
  expect(document.activeElement).toBe(document.body);
}

beforeEach((): void => {
  localState = {};
  setupState = structuredClone(DEFAULT_SETUP);
  sendMessageMock.mockReset();
  permissionRequestMock.mockReset();
  permissionRequestMock.mockResolvedValue(false);
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
    if (request.type === 'getSetupState') return structuredClone(setupState);
    if (request.type === 'getSettings') return structuredClone(DEFAULT_SETTINGS);
    if (request.type === 'getLists') return structuredClone(DEFAULT_LISTS);
    if (request.type === 'getOnboardingDraft') {
      const draft: OnboardingDraft | null = loadStoredDraft();
      return {
        ok: true,
        draft,
        invalid: Object.hasOwn(localState, LOCAL_ONBOARDING_DRAFT) && draft === null,
      };
    }
    if (request.type === 'saveOnboardingDraft') return saveDraftResponse(request.draft);
    if (request.type === 'cleanupOnboardingDraft') {
      if (!setupState.completed) return { ok: false, error: 'Setup is not complete.' };
      delete localState[LOCAL_ONBOARDING_DRAFT];
      return { ok: true };
    }
    if (request.type === 'completeOnboarding') {
      return completeOnboardingResponse(request.revision, request.storageMode);
    }
    if (request.type === 'reconcileWebsiteAccess') {
      return { ok: true, granted: false, registration: 'unavailable' };
    }
    return { ok: true };
  });
  installChromeFake();
});

afterEach((): void => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('onboarding page state', (): void => {
  it('persists Step 1 choices before navigating and restores Step 2 on reload', async (): Promise<void> => {
    const first = render(<App />);
    expect(
      await first.findByText(t('onboarding_progress', { STEP: '1', TOTAL: '3' })),
    ).toBeTruthy();
    expect(first.getByRole('heading', { name: t('onboarding_lists_heading') })).toBeTruthy();

    fireEvent.click(first.getByRole('checkbox', { name: 'Social media' }));
    await waitFor((): void => {
      expect((localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft).lists.categories.social).toBe(
        true,
      );
    });
    fireEvent.click(first.getByRole('button', { name: t('onboarding_continue_button') }));
    expect(
      await first.findByText(t('onboarding_progress', { STEP: '2', TOTAL: '3' })),
    ).toBeTruthy();
    const draft: OnboardingDraft = await persistedDraft();
    expect(draft.step).toBe(2);
    expect(draft.lists.categories.social).toBe(true);
    expect(
      sendMessageMock.mock.calls.map(([request]: [Request]): Request['type'] => request.type),
    ).not.toContain('completeSetup');

    first.unmount();
    const reloaded = render(<App />);
    expect(
      await reloaded.findByRole('heading', { name: t('onboarding_access_heading') }),
    ).toBeTruthy();
    expect(reloaded.getByText(t('onboarding_progress', { STEP: '2', TOTAL: '3' }))).toBeTruthy();
    expect(permissionRequestMock).not.toHaveBeenCalled();
  });

  it('persists a denied permission attempt without advancing', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 1,
      step: 2,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'pending',
      syncEnabled: true,
    } satisfies OnboardingDraft;

    const view = render(<App />);
    const enable: HTMLElement = await view.findByRole('button', {
      name: t('onboarding_access_enable_button'),
    });
    fireEvent.click(enable);

    await waitFor((): void => {
      const draft: OnboardingDraft = localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft;
      expect(draft.step).toBe(2);
      expect(draft.websiteAccessChoice).toBe('denied');
    });
    expect(permissionRequestMock).toHaveBeenCalledOnce();
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'reconcileWebsiteAccess' });
    expect(view.getByText(t('onboarding_progress', { STEP: '2', TOTAL: '3' }))).toBeTruthy();
  });

  it('focuses Retry after a denied permission action settles', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 1,
      step: 2,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'pending',
      syncEnabled: true,
    } satisfies OnboardingDraft;
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    const reconciliationGate: { resolve: (() => void) | null } = { resolve: null };
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type !== 'reconcileWebsiteAccess') return normalImplementation(request);
      await new Promise<void>((resolve: () => void): void => {
        reconciliationGate.resolve = resolve;
      });
      return { ok: true, granted: false, registration: 'unavailable' };
    });

    const view = render(<App />);
    const enable: HTMLButtonElement = (await view.findByRole('button', {
      name: t('onboarding_access_enable_button'),
    })) as HTMLButtonElement;
    enable.focus();
    fireEvent.click(enable);
    await waitFor((): void => expect(enable.disabled).toBe(true));
    moveFocusToDocumentBody();

    const resolveReconciliation: (() => void) | null = reconciliationGate.resolve;
    if (resolveReconciliation === null) throw new Error('reconciliation request did not start');
    resolveReconciliation();
    const retry: HTMLButtonElement = (await view.findByRole('button', {
      name: t('onboarding_retry_button'),
    })) as HTMLButtonElement;
    await waitFor((): void => expect(document.activeElement).toBe(retry));
  });

  it('focuses the heading after each onboarding step change', async (): Promise<void> => {
    const view = render(<App />);
    const firstHeading: HTMLElement = await view.findByRole('heading', {
      name: t('onboarding_lists_heading'),
    });
    await waitFor((): void => expect(document.activeElement).toBe(firstHeading));

    fireEvent.click(view.getByRole('button', { name: t('onboarding_continue_button') }));
    const secondHeading: HTMLElement = await view.findByRole('heading', {
      name: t('onboarding_access_heading'),
    });
    await waitFor((): void => expect(document.activeElement).toBe(secondHeading));

    fireEvent.click(view.getByRole('button', { name: t('onboarding_access_defer_button') }));
    const thirdHeading: HTMLElement = await view.findByRole('heading', {
      name: t('onboarding_sync_heading'),
    });
    await waitFor((): void => expect(document.activeElement).toBe(thirdHeading));
  });

  it('submits setup only once while completion is pending', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 4,
      step: 3,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'deferred',
      syncEnabled: false,
    } satisfies OnboardingDraft;
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    const finishGate: { resolve: (() => void) | null } = { resolve: null };
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type !== 'completeOnboarding') return normalImplementation(request);
      await new Promise<void>((resolve: () => void): void => {
        finishGate.resolve = resolve;
      });
      return completeOnboardingResponse(request.revision, request.storageMode);
    });
    const view = render(<App />);
    const finish: HTMLButtonElement = (await view.findByRole('button', {
      name: t('onboarding_sync_finish_disabled'),
    })) as HTMLButtonElement;

    fireEvent.click(finish);
    fireEvent.click(finish);

    await waitFor((): void => {
      expect(
        sendMessageMock.mock.calls.filter(
          ([request]: [Request]): boolean => request.type === 'completeOnboarding',
        ),
      ).toHaveLength(1);
      expect(finish.disabled).toBe(true);
    });
    const finishRequest: (() => void) | null = finishGate.resolve;
    if (finishRequest === null) throw new Error('completion request did not start');
    finishRequest();
    expect(
      await view.findByRole('heading', { name: t('onboarding_complete_heading') }),
    ).toBeTruthy();
  });

  it('treats denied reconciliation after a granted prompt as denied across reload', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 1,
      step: 2,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'pending',
      syncEnabled: true,
    } satisfies OnboardingDraft;
    permissionRequestMock.mockResolvedValue(true);

    const first = render(<App />);
    fireEvent.click(
      await first.findByRole('button', { name: t('onboarding_access_enable_button') }),
    );

    await waitFor((): void => {
      const draft: OnboardingDraft = localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft;
      expect(draft.step).toBe(2);
      expect(draft.websiteAccessChoice).toBe('denied');
    });
    expect(first.getByText(t('onboarding_access_denied'))).toBeTruthy();
    expect(first.queryByText(/Website access is available/)).toBeNull();

    first.unmount();
    const reloaded = render(<App />);
    expect(
      await reloaded.findByText(t('onboarding_progress', { STEP: '2', TOTAL: '3' })),
    ).toBeTruthy();
    expect(reloaded.getByText(t('onboarding_access_denied'))).toBeTruthy();
  });

  it.each([
    {
      promptGranted: true,
      response: {
        ok: false,
        error: 'Registration failed after permission changed.',
        granted: false,
        registration: 'error',
      },
      expectedChoice: 'denied' as const,
      expectedCopy: t('onboarding_access_denied'),
      absentCopy: t('onboarding_access_registration_error'),
    },
    {
      promptGranted: false,
      response: {
        ok: false,
        error: 'Registration failed after permission changed.',
        granted: true,
        registration: 'error',
      },
      expectedChoice: 'registration-error' as const,
      expectedCopy: t('onboarding_access_registration_error'),
      absentCopy: t('onboarding_access_denied'),
    },
  ])(
    'uses authoritative reconciliation instead of prompt result %#',
    async ({
      promptGranted,
      response,
      expectedChoice,
      expectedCopy,
      absentCopy,
    }): Promise<void> => {
      const lists = {
        ...structuredClone(DEFAULT_LISTS),
        categories: { ...DEFAULT_LISTS.categories, social: true },
      };
      localState[LOCAL_ONBOARDING_DRAFT] = {
        version: 1,
        revision: 2,
        step: 2,
        settings: DEFAULT_SETTINGS,
        lists,
        websiteAccessChoice: 'pending',
        syncEnabled: true,
      } satisfies OnboardingDraft;
      permissionRequestMock.mockResolvedValue(promptGranted);
      const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
        sendMessageMock.getMockImplementation();
      if (normalImplementation === undefined) throw new Error('missing normal worker fake');
      sendMessageMock.mockImplementation(
        async (request: Request): Promise<unknown> =>
          request.type === 'reconcileWebsiteAccess' ? response : normalImplementation(request),
      );
      const first = render(<App />);

      fireEvent.click(
        await first.findByRole('button', { name: t('onboarding_access_enable_button') }),
      );

      await waitFor((): void => {
        const draft: OnboardingDraft = localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft;
        expect(draft.websiteAccessChoice).toBe(expectedChoice);
        expect(draft.lists.categories.social).toBe(true);
      });
      expect(first.getByText(expectedCopy)).toBeTruthy();
      expect(first.queryByText(absentCopy)).toBeNull();

      first.unmount();
      const reloaded = render(<App />);
      expect(await reloaded.findByText(expectedCopy)).toBeTruthy();
      expect(reloaded.queryByText(absentCopy)).toBeNull();
      expect((localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft).lists.categories.social).toBe(
        true,
      );
    },
  );

  it.each([
    {},
    { ok: true, granted: true },
    { ok: true, granted: true, registration: 'ready', extra: true },
    { ok: true, granted: 'yes', registration: 'ready' },
    { ok: true, granted: true, registration: 'bogus' },
    { ok: true, granted: true, registration: 'error' },
    { ok: true, granted: false, registration: 'ready' },
    { ok: false },
    { ok: false, error: '' },
    { ok: false, error: 'failed', registration: 'ready' },
    { ok: false, error: 'failed', registration: 'error', extra: true },
  ])(
    'retains Step 2 for malformed website reconciliation response %#',
    async (response: unknown): Promise<void> => {
      localState[LOCAL_ONBOARDING_DRAFT] = {
        version: 1,
        revision: 2,
        step: 2,
        settings: DEFAULT_SETTINGS,
        lists: DEFAULT_LISTS,
        websiteAccessChoice: 'pending',
        syncEnabled: true,
      } satisfies OnboardingDraft;
      permissionRequestMock.mockResolvedValue(true);
      const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
        sendMessageMock.getMockImplementation();
      if (normalImplementation === undefined) throw new Error('missing normal worker fake');
      sendMessageMock.mockImplementation(
        async (request: Request): Promise<unknown> =>
          request.type === 'reconcileWebsiteAccess' ? response : normalImplementation(request),
      );
      const view = render(<App />);

      fireEvent.click(
        await view.findByRole('button', { name: t('onboarding_access_enable_button') }),
      );

      expect((await view.findByRole('alert')).textContent).toBe(t('onboarding_enable_error'));
      expect(view.getByText(t('onboarding_progress', { STEP: '2', TOTAL: '3' }))).toBeTruthy();
      const current: OnboardingDraft = localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft;
      expect(current.revision).toBe(2);
      expect(current.websiteAccessChoice).toBe('pending');
    },
  );

  it('persists Not now before advancing to Step 3', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 1,
      step: 2,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'pending',
      syncEnabled: true,
    } satisfies OnboardingDraft;

    const view = render(<App />);
    fireEvent.click(await view.findByRole('button', { name: t('onboarding_access_defer_button') }));

    expect(await view.findByText(t('onboarding_progress', { STEP: '3', TOTAL: '3' }))).toBeTruthy();
    const draft: OnboardingDraft = await persistedDraft();
    expect(draft.step).toBe(3);
    expect(draft.websiteAccessChoice).toBe('deferred');
    expect(permissionRequestMock).not.toHaveBeenCalled();
  });

  it('restores switch focus after its persisted toggle settles', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 4,
      step: 3,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'deferred',
      syncEnabled: true,
    } satisfies OnboardingDraft;
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    const saveGate: { resolve: (() => void) | null } = { resolve: null };
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type !== 'saveOnboardingDraft' || request.draft.syncEnabled) {
        return normalImplementation(request);
      }
      await new Promise<void>((resolve: () => void): void => {
        saveGate.resolve = resolve;
      });
      return normalImplementation(request);
    });

    const view = render(<App />);
    const sync: HTMLInputElement = (await view.findByRole('switch', {
      name: t('onboarding_sync_switch_label'),
    })) as HTMLInputElement;
    sync.focus();
    fireEvent.click(sync);
    await waitFor((): void => expect(sync.disabled).toBe(true));
    moveFocusToDocumentBody();

    const resolveSave: (() => void) | null = saveGate.resolve;
    if (resolveSave === null) throw new Error('draft save did not start');
    resolveSave();
    expect(
      await view.findByRole('button', { name: t('onboarding_sync_finish_disabled') }),
    ).toBeTruthy();
    await waitFor((): void => expect(document.activeElement).toBe(sync));
  });

  it('commits settings and lists only through the final setup action', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 4,
      step: 3,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'deferred',
      syncEnabled: false,
    } satisfies OnboardingDraft;

    const view = render(<App />);
    fireEvent.click(
      await view.findByRole('button', { name: t('onboarding_sync_finish_disabled') }),
    );

    expect(
      await view.findByRole('heading', { name: t('onboarding_complete_heading') }),
    ).toBeTruthy();
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'completeOnboarding',
      revision: 4,
      storageMode: 'local',
    });
    expect(localState[LOCAL_ONBOARDING_DRAFT]).toBeUndefined();
  });

  it('ignores and removes a stale draft when setup is complete', async (): Promise<void> => {
    setupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 1,
      step: 2,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'denied',
      syncEnabled: true,
    } satisfies OnboardingDraft;

    const view = render(<App />);

    expect(
      await view.findByRole('heading', { name: t('onboarding_complete_heading') }),
    ).toBeTruthy();
    await waitFor((): void => expect(localState[LOCAL_ONBOARDING_DRAFT]).toBeUndefined());
  });

  it('shows completed setup and removes its draft without loading editable policy', async (): Promise<void> => {
    setupState = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    localState[LOCAL_ONBOARDING_DRAFT] = { invalid: true };
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSetupState') return structuredClone(setupState);
      if (request.type === 'cleanupOnboardingDraft') {
        delete localState[LOCAL_ONBOARDING_DRAFT];
        return { ok: true };
      }
      throw new Error('editable policy unavailable');
    });

    const view = render(<App />);

    expect(
      await view.findByRole('heading', { name: t('onboarding_complete_heading') }),
    ).toBeTruthy();
    await waitFor((): void => expect(localState[LOCAL_ONBOARDING_DRAFT]).toBeUndefined());
  });

  it('recovers an invalid draft from loaded defaults with a visible notice', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = { version: 1, step: 8, syncEnabled: 'yes' };

    const view = render(<App />);

    expect((await view.findByRole('status')).textContent).toBe(
      'Your saved setup progress could not be restored. Starting again with your current defaults.',
    );
    expect(view.getByText(t('onboarding_progress', { STEP: '1', TOTAL: '3' }))).toBeTruthy();
    const draft: OnboardingDraft = await persistedDraft();
    expect(draft.step).toBe(1);
    expect(draft.settings).toEqual(DEFAULT_SETTINGS);
    expect(draft.lists).toEqual(DEFAULT_LISTS);
  });

  it('renders a retryable load error as the only page state', async (): Promise<void> => {
    sendMessageMock.mockRejectedValue(new Error('worker unavailable'));

    const view = render(<App />);

    expect((await view.findByRole('alert')).textContent).toBe('Could not load setup. Try again.');
    expect(view.getByRole('button', { name: t('onboarding_retry_button') })).toBeTruthy();
    expect(view.queryByText(/Step \d of 3/)).toBeNull();
  });

  it.each([
    { ok: false, error: 'storage get failed' },
    { ok: true, invalid: false },
  ])('keeps an operational or malformed draft load retryable %#', async (response: unknown) => {
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    sendMessageMock.mockImplementation(
      async (request: Request): Promise<unknown> =>
        request.type === 'getOnboardingDraft' ? response : normalImplementation(request),
    );

    const view = render(<App />);

    expect((await view.findByRole('alert')).textContent).toBe('Could not load setup. Try again.');
    expect(view.getByRole('button', { name: t('onboarding_retry_button') })).toBeTruthy();
    expect(view.queryByText(/Step \d of 3/)).toBeNull();
  });

  it('retains the current draft after an operational save failure', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 1,
      step: 1,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'pending',
      syncEnabled: true,
    } satisfies OnboardingDraft;
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    sendMessageMock.mockImplementation(
      async (request: Request): Promise<unknown> =>
        request.type === 'saveOnboardingDraft'
          ? { ok: false, error: 'storage set failed' }
          : normalImplementation(request),
    );
    const view = render(<App />);
    const social: HTMLElement = await view.findByRole('checkbox', { name: 'Social media' });

    fireEvent.click(social);

    expect((await view.findByRole('alert')).textContent).toBe(t('onboarding_save_error'));
    expect(view.getByText(t('onboarding_progress', { STEP: '1', TOTAL: '3' }))).toBeTruthy();
    expect((view.getByRole('checkbox', { name: 'Social media' }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect((localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft).revision).toBe(1);
  });

  it('reloads incomplete setup after a save conflict has no authoritative draft', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 3,
      step: 1,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'pending',
      syncEnabled: true,
    } satisfies OnboardingDraft;
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    let conflictPending: boolean = true;
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'saveOnboardingDraft' && conflictPending) {
        conflictPending = false;
        delete localState[LOCAL_ONBOARDING_DRAFT];
        return {
          ok: false,
          error: 'Setup changed in another tab.',
          conflict: true,
          completed: false,
          draft: null,
        };
      }
      return normalImplementation(request);
    });
    const view = render(<App />);

    fireEvent.click(await view.findByRole('checkbox', { name: 'Social media' }));

    await waitFor((): void => {
      const current: OnboardingDraft = localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft;
      expect(current.revision).toBe(1);
      expect(current.lists.categories.social).toBe(false);
    });
    expect(view.getByText(t('onboarding_progress', { STEP: '1', TOTAL: '3' }))).toBeTruthy();
  });

  it('confirms completed setup after a save conflict has no authoritative draft', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 3,
      step: 1,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'pending',
      syncEnabled: true,
    } satisfies OnboardingDraft;
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'saveOnboardingDraft') {
        setupState = { ...setupState, completed: true, storageMode: 'local' };
        delete localState[LOCAL_ONBOARDING_DRAFT];
        return {
          ok: false,
          error: 'Setup changed in another tab.',
          conflict: true,
          completed: false,
          draft: null,
        };
      }
      return normalImplementation(request);
    });
    const view = render(<App />);

    fireEvent.click(await view.findByRole('checkbox', { name: 'Social media' }));

    expect(
      await view.findByRole('heading', { name: t('onboarding_complete_heading') }),
    ).toBeTruthy();
  });

  it('makes a failed reload retryable after a completion conflict has no draft', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = {
      version: 1,
      revision: 4,
      step: 3,
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      websiteAccessChoice: 'deferred',
      syncEnabled: false,
    } satisfies OnboardingDraft;
    const normalImplementation: ((request: Request) => Promise<unknown>) | undefined =
      sendMessageMock.getMockImplementation();
    if (normalImplementation === undefined) throw new Error('missing normal worker fake');
    let reloadDraftFails: boolean = false;
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'completeOnboarding') {
        delete localState[LOCAL_ONBOARDING_DRAFT];
        reloadDraftFails = true;
        return {
          ok: false,
          error: 'Setup changed in another tab.',
          conflict: true,
          completed: false,
          draft: null,
        };
      }
      if (request.type === 'getOnboardingDraft' && reloadDraftFails) {
        reloadDraftFails = false;
        return { ok: false, error: 'storage get failed' };
      }
      return normalImplementation(request);
    });
    const view = render(<App />);

    fireEvent.click(
      await view.findByRole('button', { name: t('onboarding_sync_finish_disabled') }),
    );

    expect((await view.findByRole('alert')).textContent).toBe('Could not load setup. Try again.');
    fireEvent.click(view.getByRole('button', { name: t('onboarding_retry_button') }));
    await waitFor((): void => {
      expect((localState[LOCAL_ONBOARDING_DRAFT] as OnboardingDraft).revision).toBe(1);
    });
    expect(await view.findByText(t('onboarding_progress', { STEP: '1', TOTAL: '3' }))).toBeTruthy();
  });
});
