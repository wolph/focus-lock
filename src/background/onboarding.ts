import { t } from '../shared/i18n';
import type {
  OnboardingDraftLoadResponse,
  OnboardingDraftWriteResponse,
  OnboardingOperationalFailure,
} from '../shared/messages';
import { isOnboardingDraft } from '../shared/runtime-validation';
import { LOCAL_ONBOARDING_DRAFT } from '../shared/storage-keys';
import type { OnboardingDraft, SetupState } from '../shared/types';
import { storageValuesEqual } from './storage-value-equality';

export type OnboardingDraftLoadResult = OnboardingDraftLoadResponse;
export type OnboardingDraftWriteResult = OnboardingDraftWriteResponse;

export interface OnboardingService {
  loadDraft(): Promise<OnboardingDraftLoadResult>;
  saveDraft(draft: OnboardingDraft): Promise<OnboardingDraftWriteResult>;
  removeDraft(): Promise<void>;
  open(): Promise<void>;
}

interface OnboardingServicePorts {
  loadSetup(): Promise<SetupState>;
}

interface OnboardingDraftSnapshot {
  draft: OnboardingDraft | null;
  invalid: boolean;
}

function operationalFailure(error: unknown): OnboardingOperationalFailure {
  const message: string = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: message.trim().length > 0 ? message : t('notify_onboarding_storage_failed'),
  };
}

function conflict(draft: OnboardingDraft | null, completed: boolean): OnboardingDraftWriteResult {
  return {
    ok: false,
    error: completed ? t('notify_setup_completed_elsewhere') : t('notify_setup_changed_reloaded'),
    conflict: true,
    completed,
    draft,
  };
}

async function readDraft(): Promise<OnboardingDraftSnapshot> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_ONBOARDING_DRAFT);
  if (!Object.hasOwn(stored, LOCAL_ONBOARDING_DRAFT)) return { draft: null, invalid: false };
  const value: unknown = stored[LOCAL_ONBOARDING_DRAFT];
  if (!isOnboardingDraft(value)) return { draft: null, invalid: true };
  return { draft: structuredClone(value), invalid: false };
}

export function createOnboardingService(ports: OnboardingServicePorts): OnboardingService {
  let draftTail: Promise<void> = Promise.resolve();
  let openTail: Promise<void> = Promise.resolve();

  const serializeDraft: <T>(operation: () => Promise<T>) => Promise<T> = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const requested: Promise<T> = draftTail.then(operation, operation);
    draftTail = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    return requested;
  };

  const loadDraft: () => Promise<OnboardingDraftLoadResult> =
    (): Promise<OnboardingDraftLoadResult> =>
      serializeDraft(async (): Promise<OnboardingDraftLoadResult> => {
        try {
          return { ok: true, ...(await readDraft()) };
        } catch (error: unknown) {
          return operationalFailure(error);
        }
      });

  const saveDraft: (draft: OnboardingDraft) => Promise<OnboardingDraftWriteResult> = (
    draft: OnboardingDraft,
  ): Promise<OnboardingDraftWriteResult> =>
    serializeDraft(async (): Promise<OnboardingDraftWriteResult> => {
      try {
        const [setup, current]: [SetupState, OnboardingDraftSnapshot] = await Promise.all([
          ports.loadSetup(),
          readDraft(),
        ]);
        if (setup.completed) return conflict(current.draft, true);
        const expectedRevision: number = current.draft?.revision ?? 0;
        const canCreate: boolean = current.draft === null && draft.revision === 0;
        const canUpdate: boolean = current.draft !== null && draft.revision === expectedRevision;
        if (!canCreate && !canUpdate) return conflict(current.draft, false);
        const next: OnboardingDraft = structuredClone({
          ...draft,
          revision: expectedRevision + 1,
        });
        if (!isOnboardingDraft(next)) throw new Error('invalid onboarding draft');
        await chrome.storage.local.set({ [LOCAL_ONBOARDING_DRAFT]: next });
        const verified: OnboardingDraftSnapshot = await readDraft();
        if (verified.draft === null || !storageValuesEqual(verified.draft, next)) {
          throw new Error('could not verify onboarding draft');
        }
        return { ok: true, draft: next };
      } catch (error: unknown) {
        return operationalFailure(error);
      }
    });

  const removeDraft: () => Promise<void> = (): Promise<void> =>
    serializeDraft(async (): Promise<void> => {
      await chrome.storage.local.remove(LOCAL_ONBOARDING_DRAFT);
    });

  const focusExisting: (tabs: chrome.tabs.Tab[]) => Promise<boolean> = async (
    tabs: chrome.tabs.Tab[],
  ): Promise<boolean> => {
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined)
          await chrome.windows.update(tab.windowId, { focused: true });
        return true;
      } catch {
        // The tab may close between query and update. Try another result or re-query.
      }
    }
    return false;
  };

  const openOnce: () => Promise<void> = async (): Promise<void> => {
    const url: string = chrome.runtime.getURL('src/onboarding/onboarding.html');
    const first: chrome.tabs.Tab[] = await chrome.tabs.query({ url });
    if (await focusExisting(first)) return;
    if (first.length > 0) {
      const refreshed: chrome.tabs.Tab[] = await chrome.tabs.query({ url });
      if (await focusExisting(refreshed)) return;
    }
    await chrome.tabs.create({ url });
  };

  const open: () => Promise<void> = (): Promise<void> => {
    const requested: Promise<void> = openTail.then(openOnce, openOnce);
    openTail = requested.catch((): void => undefined);
    return requested;
  };

  return { loadDraft, saveDraft, removeDraft, open };
}
