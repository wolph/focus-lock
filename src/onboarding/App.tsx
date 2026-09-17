import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { formatNumber, t } from '../shared/i18n';
import { sendRequest } from '../shared/messages';
import { WEBSITE_ORIGINS } from '../shared/permissions';
import {
  isListsConfig,
  isSettings,
  isSetupState,
  isWebsiteAccessReconciliation,
} from '../shared/runtime-validation';
import type { ListsConfig, Settings, SetupState } from '../shared/types';
import { type WebsiteAccessOutcome, websiteAccessOutcome } from '../shared/website-access-state';
import {
  completeOnboardingDraft,
  createOnboardingDraft,
  type DraftLoadResult,
  loadOnboardingDraft,
  type OnboardingDraft,
  OnboardingDraftConflictError,
  type OnboardingStep,
  removeOnboardingDraft,
  saveOnboardingDraft,
} from './draft-storage';
import { StartingListsStep } from './StartingListsStep';
import { SyncChoiceStep } from './SyncChoiceStep';
import { WebsiteAccessStep } from './WebsiteAccessStep';

type PageState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'complete' }
  | { kind: 'draft'; draft: OnboardingDraft; recovered: boolean };

function SetupComplete(): VNode {
  return (
    <main class="onboarding-card onboarding-complete">
      <p class="eyebrow">{t('app_name')}</p>
      <h1>{t('onboarding_complete_heading')}</h1>
      <p>{t('onboarding_complete_body')}</p>
    </main>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }): VNode {
  return (
    <main class="onboarding-card onboarding-error">
      <p class="eyebrow">{t('app_name')}</p>
      <h1>{t('onboarding_error_heading')}</h1>
      <p role="alert">{t('onboarding_error_body')}</p>
      <button type="button" class="primary-button" onClick={onRetry}>
        {t('onboarding_retry_button')}
      </button>
    </main>
  );
}

/** The number of steps the setup page walks through, which the progress line reads out. */
const STEP_COUNT: number = 3;

function Progress({ step }: { step: OnboardingStep }): VNode {
  return (
    <p class="progress">
      {t('onboarding_progress', { STEP: formatNumber(step), TOTAL: formatNumber(STEP_COUNT) })}
    </p>
  );
}

export function App(): VNode {
  const [page, setPage]: [PageState, Dispatch<StateUpdater<PageState>>] = useState<PageState>({
    kind: 'loading',
  });
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [actionError, setActionError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const [loadAttempt, setLoadAttempt]: [number, Dispatch<StateUpdater<number>>] =
    useState<number>(0);
  const actionInFlight: { current: boolean } = useRef<boolean>(false);

  const beginAction: () => boolean = (): boolean => {
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    setPending(true);
    setActionError(null);
    return true;
  };

  const endAction: () => void = (): void => {
    actionInFlight.current = false;
    setPending(false);
  };

  const reloadAuthoritativeSetup: () => void = (): void => {
    setPage({ kind: 'loading' });
    setLoadAttempt((value: number): number => value + 1);
  };

  useEffect((): (() => void) => {
    let active: boolean = true;
    const load: () => Promise<void> = async (): Promise<void> => {
      setPage({ kind: 'loading' });
      setActionError(null);
      try {
        const setup: SetupState = await sendRequest({ type: 'getSetupState' });
        if (!isSetupState(setup)) throw new Error('invalid setup response');
        if (setup.completed) {
          try {
            await removeOnboardingDraft();
          } catch (error: unknown) {
            console.error('could not remove stale onboarding draft', error);
          }
          if (active) setPage({ kind: 'complete' });
          return;
        }
        const [settings, lists, storedDraft]: [Settings, ListsConfig, DraftLoadResult] =
          await Promise.all([
            sendRequest({ type: 'getSettings' }),
            sendRequest({ type: 'getLists' }),
            loadOnboardingDraft(),
          ]);
        if (!isSettings(settings) || !isListsConfig(lists)) {
          throw new Error('invalid setup policy response');
        }
        let draft: OnboardingDraft = storedDraft.draft ?? createOnboardingDraft(settings, lists);
        if (storedDraft.draft === null) {
          try {
            draft = await saveOnboardingDraft(draft);
          } catch (error: unknown) {
            if (error instanceof OnboardingDraftConflictError && error.completed) {
              if (active) setPage({ kind: 'complete' });
              return;
            }
            if (!(error instanceof OnboardingDraftConflictError) || error.draft === null) {
              throw error;
            }
            draft = error.draft;
          }
        }
        if (active) setPage({ kind: 'draft', draft, recovered: storedDraft.invalid });
      } catch {
        if (active) setPage({ kind: 'error' });
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [loadAttempt]);

  const visibleStep: OnboardingStep | null = page.kind === 'draft' ? page.draft.step : null;
  useEffect((): void => {
    if (visibleStep === null) return;
    const headingIds: Record<OnboardingStep, string> = {
      1: 'starting-lists-heading',
      2: 'website-access-heading',
      3: 'sync-choice-heading',
    };
    document.getElementById(headingIds[visibleStep])?.focus();
  }, [visibleStep]);

  const commitDraft: (draft: OnboardingDraft) => Promise<boolean> = async (
    draft: OnboardingDraft,
  ): Promise<boolean> => {
    try {
      const saved: OnboardingDraft = await saveOnboardingDraft(draft);
      setPage(
        (current: PageState): PageState =>
          current.kind === 'draft' ? { ...current, draft: saved } : current,
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof OnboardingDraftConflictError) {
        if (error.draft === null) {
          reloadAuthoritativeSetup();
          return false;
        }
        if (error.completed) setPage({ kind: 'complete' });
        else if (error.draft !== null) {
          const authoritative: OnboardingDraft = error.draft;
          setPage(
            (current: PageState): PageState =>
              current.kind === 'draft' ? { ...current, draft: authoritative } : current,
          );
        }
        setActionError(error.message);
      } else {
        setActionError(t('onboarding_save_error'));
      }
      return false;
    }
  };

  const persist: (draft: OnboardingDraft) => Promise<boolean> = async (
    draft: OnboardingDraft,
  ): Promise<boolean> => {
    if (!beginAction()) return false;
    try {
      return await commitDraft(draft);
    } finally {
      endAction();
    }
  };

  if (page.kind === 'loading') {
    return <main class="onboarding-card" aria-busy="true" />;
  }
  if (page.kind === 'error') {
    return <LoadError onRetry={(): void => setLoadAttempt((value: number): number => value + 1)} />;
  }
  if (page.kind === 'complete') return <SetupComplete />;

  const navigate: (
    step: OnboardingStep,
    choice?: OnboardingDraft['websiteAccessChoice'],
  ) => Promise<void> = async (
    step: OnboardingStep,
    choice?: OnboardingDraft['websiteAccessChoice'],
  ): Promise<void> => {
    const next: OnboardingDraft = {
      ...page.draft,
      step,
      websiteAccessChoice: choice ?? page.draft.websiteAccessChoice,
    };
    await persist(next);
  };

  const enableWebsiteAccess: () => Promise<void> = async (): Promise<void> => {
    if (!beginAction()) return;
    try {
      await chrome.permissions.request({ origins: [...WEBSITE_ORIGINS] });
      const response: unknown = await sendRequest({
        type: 'reconcileWebsiteAccess',
      });
      if (!isWebsiteAccessReconciliation(response)) {
        setActionError(t('onboarding_enable_error'));
        return;
      }
      const outcome: WebsiteAccessOutcome = websiteAccessOutcome(response);
      if (outcome.kind === 'denied') {
        if (!(await commitDraft({ ...page.draft, websiteAccessChoice: 'denied' }))) return;
        if (outcome.error !== null) setActionError(outcome.error);
        return;
      }
      if (outcome.kind === 'registration-error') {
        const failed: OnboardingDraft = {
          ...page.draft,
          websiteAccessChoice: 'registration-error',
        };
        if (!(await commitDraft(failed))) return;
        setActionError(outcome.error);
        return;
      }
      if (outcome.kind === 'error') {
        setActionError(outcome.error);
        return;
      }
      const next: OnboardingDraft = {
        ...page.draft,
        step: 3,
        websiteAccessChoice: 'granted',
      };
      await commitDraft(next);
    } catch {
      setActionError(t('onboarding_enable_error'));
    } finally {
      endAction();
    }
  };

  const completeSetup: () => Promise<void> = async (): Promise<void> => {
    if (!beginAction()) return;
    try {
      await completeOnboardingDraft(page.draft.revision, page.draft.syncEnabled ? 'sync' : 'local');
      try {
        await removeOnboardingDraft();
      } catch (error: unknown) {
        console.error('could not remove completed onboarding draft', error);
      }
      setPage({ kind: 'complete' });
    } catch (error: unknown) {
      if (error instanceof OnboardingDraftConflictError) {
        if (error.draft === null) {
          reloadAuthoritativeSetup();
          return;
        }
        if (error.completed) setPage({ kind: 'complete' });
        else if (error.draft !== null) {
          const authoritative: OnboardingDraft = error.draft;
          setPage(
            (current: PageState): PageState =>
              current.kind === 'draft' ? { ...current, draft: authoritative } : current,
          );
        }
        setActionError(error.message);
      } else {
        setActionError(t('onboarding_finish_error'));
      }
    } finally {
      endAction();
    }
  };

  return (
    <main class="onboarding-card">
      <p class="eyebrow">{t('onboarding_eyebrow')}</p>
      <Progress step={page.draft.step} />
      {page.recovered ? (
        <p class="recovery-notice" role="status">
          {t('onboarding_recovery_notice')}
        </p>
      ) : null}
      {page.draft.step === 1 ? (
        <StartingListsStep
          lists={page.draft.lists}
          pending={pending}
          onListsChange={async (lists: ListsConfig): Promise<void> =>
            void (await persist({ ...page.draft, lists }))
          }
          onContinue={async (): Promise<void> => navigate(2)}
        />
      ) : page.draft.step === 2 ? (
        <WebsiteAccessStep
          choice={page.draft.websiteAccessChoice}
          pending={pending}
          error={actionError}
          onEnable={enableWebsiteAccess}
          onDefer={async (): Promise<void> => navigate(3, 'deferred')}
        />
      ) : (
        <SyncChoiceStep
          syncEnabled={page.draft.syncEnabled}
          pending={pending}
          error={actionError}
          onSyncChange={async (syncEnabled: boolean): Promise<void> =>
            void (await persist({ ...page.draft, syncEnabled }))
          }
          onComplete={completeSetup}
        />
      )}
      {page.draft.step === 1 && actionError !== null ? <p role="alert">{actionError}</p> : null}
    </main>
  );
}
