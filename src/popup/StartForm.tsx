import type { VNode } from 'preact';
import {
  type Dispatch,
  type StateUpdater,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import { ForcedControl } from '../shared/ForcedControl';
import { formatNumber, t } from '../shared/i18n';
import {
  STALE_SESSION_RULES_ERROR,
  type StartSessionResponseV2,
  sendRequest,
} from '../shared/messages';
import { isListsConfig } from '../shared/runtime-validation';
import {
  FORCED_CYCLES_LABEL,
  HARD_UNAVAILABLE_REASON,
  MODE_LABELS,
  timedDurationHint,
  UNTIL_STOPPED_DISCLOSURE,
  untilStoppedHint,
} from '../shared/session-copy';
import type {
  CategoryId,
  CycleConfig,
  ListsConfig,
  SessionConfigV2,
  SessionMode,
  SettingsV2,
  Strictness,
} from '../shared/types';
import type { WorkTab } from '../shared/work-target';
import { START_FAILED_COPY, startErrorMessage, startedWithoutWorkTarget } from './command-errors';
import { DomainInput } from './DomainInput';
import { DraftSummary } from './DraftSummary';
import { DurationControl } from './DurationControl';
import { RadioRow } from './form-controls';
import { RuleSummary } from './RuleSummary';
import { SessionTypeControl } from './SessionTypeControl';
import {
  addDraftAllowHost,
  type DraftUpdate,
  rebaseSessionDraft,
  toggleDraftCategory,
} from './session-draft';
import {
  createStartDraft,
  type DraftDuration,
  effectiveCycling,
  effectiveStrictness,
  effectiveTimedMinutes,
  restoreTimedDuration,
  type StartDraft,
  selectTimedPreset,
  selectUntilStopped,
  setCustomMinutes,
  setTimedCycling,
  setTimedStrictness,
  startLabel,
  toSessionConfigV2,
} from './start-draft';
import { useWorkTabs, type WorkTabsState } from './use-work-tabs';

interface ModeChoice {
  value: SessionMode;
  label: string;
  hint: string;
}

const MODE_CHOICES: readonly ModeChoice[] = [
  {
    value: 'blacklist',
    label: MODE_LABELS.blacklist,
    hint: t('popup_mode_blacklist_hint'),
  },
  {
    value: 'whitelist',
    label: MODE_LABELS.whitelist,
    hint: t('popup_mode_whitelist_hint'),
  },
];
const INVALID_DURATION_ERROR: string = t('popup_invalid_duration_error');
const STALE_LISTS_UNAVAILABLE_COPY: string = t('popup_stale_lists_unavailable');

/** Receives a start message that must outlive the form, or null when a new start begins. */
export type StartFeedback = (message: string | null) => void;

const NO_WORK_TAB_OPTION: string = t('popup_no_work_tab_option');
const WORK_TAB_UNAVAILABLE_OPTION: string = t('popup_work_tab_unavailable_option');
const WORK_TAB_SELECT_LABEL: string = t('popup_work_tab_select_label');
/**
 * The work tab picker is revealed by its accessible name, which is translated, so the selector
 * is built from the same message and its quotes are escaped for the attribute matcher.
 */
const WORK_TAB_SELECTOR: string = `[aria-label="${WORK_TAB_SELECT_LABEL.replace(/["\\]/g, '\\$&')}"]`;

export interface StartFormProps {
  settings: SettingsV2;
  lists: ListsConfig;
  categoriesEditable?: boolean;
  /**
   * Where a start that succeeded except for its work tab reports. The session has started, so
   * the next snapshot replaces this form, and the message has to live in the view that stays.
   * Without it the form shows the message inline.
   */
  onStartFeedback?: StartFeedback;
}

/**
 * Routes the duration control's next value onto the reversible draft helpers. Every timed
 * value returns the stored timed duration first, so the pressed Until stopped chip lands
 * on `restoreTimedDuration` and a preset or a typed minute is the edit that follows it.
 */
function applyDraftDuration(draft: StartDraft, next: DraftDuration): StartDraft {
  if (next.kind === 'until-stopped') return selectUntilStopped(draft);
  const restored: StartDraft = restoreTimedDuration(draft);
  if (next.presetMin !== null && next.customMin === '') {
    return selectTimedPreset(restored, next.presetMin);
  }
  return setCustomMinutes(restored, next.customMin);
}

export function StartForm({
  settings,
  lists,
  categoriesEditable = true,
  onStartFeedback,
}: StartFormProps): VNode {
  const [draft, setDraft]: [StartDraft, Dispatch<StateUpdater<StartDraft>>] = useState<StartDraft>(
    (): StartDraft => createStartDraft(settings, lists),
  );
  const formRef: { current: HTMLElement | null } = useRef<HTMLElement | null>(null);
  const settingsRef: { current: HTMLDetailsElement | null } = useRef<HTMLDetailsElement>(null);
  const [focusField, setFocusField]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const revealField: (selector: string) => void = (selector: string): void => {
    const disclosure: HTMLDetailsElement | null =
      formRef.current?.querySelector(selector)?.closest('details') ?? null;
    if (disclosure !== null) disclosure.open = true;
    setFocusField(selector);
  };
  /** Listed under the draft's rules, so the proposal matches what the start will capture. */
  const work: WorkTabsState = useWorkTabs(draft.mode, draft.rules);
  useLayoutEffect((): void => {
    if (focusField === null) return;
    const field: HTMLElement | null =
      formRef.current?.querySelector<HTMLElement>(focusField) ?? null;
    if (field?.matches(':disabled')) return;
    field?.focus();
    field?.scrollIntoView?.({ block: 'nearest' });
    setFocusField(null);
  }, [focusField, work.loading]);
  const [workTabId, setWorkTabId]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  /** Once the user has chosen, a refreshed listing no longer re-proposes the active tab. */
  const explicitChoice: { current: boolean } = useRef<boolean>(false);
  useEffect((): void => {
    if (explicitChoice.current) return;
    const activeTabId: number | null = work.context?.activeTabId ?? null;
    setWorkTabId(
      work.tabs.some((tab: WorkTab): boolean => tab.tabId === activeTabId)
        ? String(activeTabId)
        : '',
    );
  }, [work]);
  /** The lists the draft is rebased onto, which a stale start refreshes from the worker. */
  const [activeLists, setActiveLists]: [ListsConfig, Dispatch<StateUpdater<ListsConfig>>] =
    useState<ListsConfig>(lists);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [domainError, setDomainError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const [starting, setStarting]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);

  useEffect((): void => {
    setActiveLists(lists);
    setDraft((current: StartDraft): StartDraft => rebaseSessionDraft(current, lists));
  }, [lists]);

  const indefinite: boolean = draft.duration.kind === 'until-stopped';
  const strictness: Strictness = effectiveStrictness(draft);
  const timedMinutes: number | null = effectiveTimedMinutes(draft);
  /**
   * The plan beside Start. Hard never survives an indefinite draft, so the until-stopped
   * branch only ever names the other two types. An unusable timed length shows no hint.
   */
  const durationHint: string | null = indefinite
    ? strictness === 'hard'
      ? null
      : untilStoppedHint(strictness, draft.frictionGate)
    : timedMinutes === null
      ? null
      : timedDurationHint(timedMinutes, effectiveCycling(draft));
  const cycle: CycleConfig = settings.defaultCycling;
  const cyclingLabel: string = t('popup_cycles_label', {
    FOCUS: formatNumber(cycle.focusMin),
    SHORT_BREAK: formatNumber(cycle.shortBreakMin),
    LONG_BREAK: formatNumber(cycle.longBreakMin),
    LONG_EVERY: formatNumber(cycle.longEvery),
  });

  const rebaseFromWorker: () => Promise<void> = async (): Promise<void> => {
    const refreshed: unknown = await sendRequest({ type: 'getLists' });
    if (!isListsConfig(refreshed)) {
      setError(STALE_LISTS_UNAVAILABLE_COPY);
      return;
    }
    setActiveLists(refreshed);
    setDraft((current: StartDraft): StartDraft => rebaseSessionDraft(current, refreshed));
    setError(STALE_SESSION_RULES_ERROR);
  };

  const start: () => Promise<void> = async (): Promise<void> => {
    if (starting) return;
    const config: SessionConfigV2 | null = toSessionConfigV2(draft);
    if (config === null) {
      setError(INVALID_DURATION_ERROR);
      revealField('.custom-min');
      return;
    }

    setError(null);
    onStartFeedback?.(null);
    setStarting(true);
    try {
      // The chosen tab travels beside the config, never inside it: the worker saves it for the
      // session the start mints, in the privacy context of this popup's window.
      const response: StartSessionResponseV2 = await sendRequest(
        workTabId !== '' && work.context !== null
          ? {
              type: 'startSession',
              config,
              workTabId: Number(workTabId),
              windowId: work.context.windowId,
            }
          : { type: 'startSession', config },
      );
      const message: string | null = startErrorMessage(response);
      if (message === STALE_SESSION_RULES_ERROR) {
        await rebaseFromWorker();
        return;
      }
      if (message !== null && startedWithoutWorkTarget(response) && onStartFeedback !== undefined) {
        onStartFeedback(message);
        return;
      }
      if (message !== null) {
        setError(message);
        return;
      }
      setDraft(createStartDraft(settings, activeLists));
    } catch {
      setError(START_FAILED_COPY);
    } finally {
      setStarting(false);
    }
  };

  const addAllowedDomain: (raw: string) => string | null = (raw: string): string | null => {
    const update: DraftUpdate<StartDraft> = addDraftAllowHost(draft, raw);
    if (update.draft !== draft) setDraft(update.draft);
    return update.error;
  };

  const openPermanentSettings: () => Promise<void> = async (): Promise<void> => {
    setError(null);
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      setError(t('popup_open_settings_failed'));
    }
  };

  const sessionType: VNode = (
    <SessionTypeControl
      value={strictness}
      frictionDelayMs={draft.frictionGate.delayMs}
      requireTypedPhrase={draft.frictionGate.requireTypedPhrase}
      hardUnavailableReason={indefinite ? HARD_UNAVAILABLE_REASON : undefined}
      onChange={(next: Strictness): void => setDraft(setTimedStrictness(draft, next))}
    />
  );

  const cycleRow: VNode = (
    <label class="check-row">
      <input
        type="checkbox"
        checked={effectiveCycling(draft) !== null}
        onChange={(event: Event): void => {
          const enabled: boolean = (event.currentTarget as HTMLInputElement).checked;
          setDraft(setTimedCycling(draft, enabled ? cycle : null));
        }}
      />
      <span>{cyclingLabel}</span>
    </label>
  );

  const currentTab: WorkTab | undefined = work.tabs.find(
    (tab: WorkTab): boolean => tab.tabId === work.context?.activeTabId,
  );

  return (
    <section class="view start-form" ref={formRef}>
      <div class="start-form__actions">
        <button
          type="button"
          class="start-button"
          disabled={starting}
          onClick={(): void => void start()}
        >
          {startLabel(draft)}
        </button>
        <DraftSummary draft={draft} durationHint={durationHint} />
        {domainError !== null ? (
          <p id="session-allow-domain-error" class="form-error" role="alert">
            {domainError}
          </p>
        ) : null}
        {work.error !== null ? <p class="form-error">{work.error}</p> : null}
        {error !== null ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div class="start-form__scroll">
        <div class="field-control">
          <span class="field-label">{t('popup_session_length_label')}</span>
          <DurationControl
            presets={settings.presetsMin}
            value={draft.duration}
            onChange={(next: DraftDuration): void =>
              setDraft((current: StartDraft): StartDraft => applyDraftDuration(current, next))
            }
          />
        </div>
        <div class="field-control">
          <label class="field-label" for="session-intention">
            {t('popup_intention_label')}
          </label>
          <input
            id="session-intention"
            class="intention-input"
            type="text"
            placeholder={t('popup_intention_placeholder')}
            value={draft.intention}
            onInput={(event: Event): void =>
              setDraft({ ...draft, intention: (event.currentTarget as HTMLInputElement).value })
            }
          />
        </div>

        <div class="selected-work-tab">
          <p class="work-target">
            {t('popup_work_tab_named', {
              TITLE:
                work.tabs.find((tab: WorkTab): boolean => String(tab.tabId) === workTabId)?.title ??
                (workTabId === '' ? NO_WORK_TAB_OPTION : WORK_TAB_UNAVAILABLE_OPTION),
            })}
          </p>
          <button
            type="button"
            class="text-button"
            disabled={starting}
            onClick={(): void => revealField(WORK_TAB_SELECTOR)}
          >
            {t('popup_change_button')}
          </button>
        </div>
        <details class="session-disclosure" ref={settingsRef}>
          <summary>{t('popup_session_settings_summary')}</summary>
          <div class="session-disclosure__content">
            <label class="work-tab-label">
              {t('popup_choose_work_tab_label')}
              <select
                aria-label={WORK_TAB_SELECT_LABEL}
                value={workTabId}
                disabled={work.context === null || starting || work.loading}
                onChange={(event: Event): void => {
                  explicitChoice.current = true;
                  setWorkTabId((event.currentTarget as HTMLSelectElement).value);
                }}
              >
                {currentTab !== undefined ? (
                  <option value={currentTab.tabId}>
                    {t('popup_work_tab_current_option', { TITLE: currentTab.title })}
                  </option>
                ) : null}
                <option value="">{NO_WORK_TAB_OPTION}</option>
                {workTabId !== '' &&
                !work.tabs.some((tab: WorkTab): boolean => String(tab.tabId) === workTabId) ? (
                  <option value={workTabId}>{WORK_TAB_UNAVAILABLE_OPTION}</option>
                ) : null}
                {work.tabs
                  .filter((tab: WorkTab): boolean => tab.tabId !== currentTab?.tabId)
                  .map(
                    (tab: WorkTab): VNode => (
                      <option key={tab.tabId} value={tab.tabId}>
                        {tab.title}
                      </option>
                    ),
                  )}
              </select>
            </label>

            {sessionType}

            <fieldset class="mode-control" aria-label={t('popup_blocking_mode_legend')}>
              <legend>{t('popup_blocking_mode_legend')}</legend>
              {MODE_CHOICES.map(
                (choice: ModeChoice): VNode => (
                  <RadioRow
                    key={choice.value}
                    name="mode"
                    label={choice.label}
                    hint={choice.hint}
                    checked={draft.mode === choice.value}
                    onSelect={(): void => setDraft({ ...draft, mode: choice.value })}
                  />
                ),
              )}
            </fieldset>

            {draft.mode === 'whitelist' ? (
              <DomainInput onAdd={addAllowedDomain} onError={setDomainError} />
            ) : null}

            <RuleSummary
              draft={draft}
              lists={activeLists}
              categoriesEditable={categoriesEditable}
              onCategoryToggle={(id: CategoryId): void => {
                if (categoriesEditable) setDraft(toggleDraftCategory(draft, id));
              }}
              onOpenSettings={(): void => void openPermanentSettings()}
            />

            {indefinite ? (
              <ForcedControl label={FORCED_CYCLES_LABEL} explanation={UNTIL_STOPPED_DISCLOSURE}>
                {cycleRow}
              </ForcedControl>
            ) : (
              cycleRow
            )}
          </div>
        </details>
      </div>
    </section>
  );
}
