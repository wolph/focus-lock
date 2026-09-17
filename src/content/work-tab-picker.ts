/**
 * The inline work tab chooser, ported from the retired renderer. It lists the live session's
 * eligible tabs, filters them locally, and hands one chosen tab id back to the lock screen.
 * Every label here is a lookup result, from the one constants block in the view module.
 */
import { formatNumber, tPlural } from '../shared/i18n';
import { sendRequest } from '../shared/messages';
import { parseWorkTabsResult, type WorkTab, type WorkTabsResult } from '../shared/work-target';
import { WorkTabList } from './work-tab-list';
import {
  type PickerControls,
  pickerControls,
  status,
  WORK_TARGET_COPY,
} from './work-tab-picker-view';
import { WorkTabSearch } from './work-tab-search';

export { WORK_PICKER_CSS } from './work-tab-picker-view';

export interface WorkTabPicker {
  element: HTMLElement;
  close(restoreFocus?: boolean): void;
}
interface PickerState {
  generation: number;
  closed: boolean;
  loading: boolean;
  saving: boolean;
  filtering: boolean;
  tabs: WorkTab[];
  error: string | null;
}

/**
 * Builds the chooser and starts its first listing. The caller attaches the element, makes the
 * lock screen behind it inert, and hears `onClose` before focus is restored to the trigger.
 */
export function createWorkTabPicker(
  sessionId: string,
  trigger: HTMLElement,
  container: HTMLElement,
  select: (tabId: number) => Promise<string | null>,
  onClose: () => void,
): WorkTabPicker {
  const state: PickerState = {
    generation: 0,
    closed: false,
    loading: false,
    saving: false,
    filtering: false,
    tabs: [],
    error: null,
  };
  const scrollTop: number = container.scrollTop;
  const controls: PickerControls = pickerControls();
  const { element, cancel, search, clear, refresh, count, body }: PickerControls = controls;
  const index: WorkTabSearch = new WorkTabSearch();
  const feedback: HTMLElement = status('');
  feedback.classList.add('work-picker-feedback');
  feedback.hidden = true;
  const list: WorkTabList = new WorkTabList(
    sessionId,
    search,
    (tabId: number, row: HTMLButtonElement): void => {
      void choose(tabId, row);
    },
  );
  body.append(feedback, list.element);
  const close: (restoreFocus?: boolean) => void = (restoreFocus: boolean = true): void => {
    if (state.closed) return;
    state.closed = true;
    state.generation += 1;
    index.cancel();
    list.close();
    element.remove();
    trigger.setAttribute('aria-expanded', 'false');
    onClose();
    if (restoreFocus) {
      restorePickerFocus(trigger, container);
      container.scrollTop = scrollTop;
    }
  };
  cancel.addEventListener('click', (): void => close());
  element.addEventListener('keydown', (event: KeyboardEvent): void => list.navigate(event));
  trigger.setAttribute('aria-expanded', 'true');

  const message: (text: string | null, alert?: boolean) => void = (
    text: string | null,
    alert: boolean = false,
  ): void => {
    feedback.textContent = text;
    feedback.hidden = text === null;
    feedback.setAttribute('role', alert ? 'alert' : 'status');
  };
  const renderMatches: () => void = (): void => {
    clear.disabled = state.saving || search.value.length === 0;
    if (state.closed || state.loading || state.saving) return;
    if (state.error !== null) {
      list.replace([]);
      message(state.error, true);
      count.textContent = '';
      return;
    }
    index.run(
      search.value,
      (): void => {
        state.filtering = true;
        list.replace([]);
        body.setAttribute('aria-busy', 'true');
        message(WORK_TARGET_COPY.searching);
      },
      (matches: WorkTab[]): void => {
        if (state.closed || state.saving) return;
        state.filtering = false;
        body.setAttribute('aria-busy', 'false');
        count.textContent = tPlural('overlay_picker_count', state.tabs.length, {
          MATCHES: formatNumber(matches.length),
        });
        message(
          matches.length > 0
            ? null
            : state.tabs.length === 0
              ? WORK_TARGET_COPY.noTabs
              : WORK_TARGET_COPY.noMatches,
        );
        list.replace(matches);
      },
    );
  };
  search.addEventListener('input', renderMatches);
  clear.addEventListener('click', (): void => {
    if (state.saving) return;
    search.value = '';
    search.focus({ preventScroll: true });
    renderMatches();
  });

  const load: () => Promise<void> = async (): Promise<void> => {
    if (state.closed || state.loading || state.saving) return;
    const request: number = ++state.generation;
    state.loading = true;
    list.invalidateIcons();
    index.cancel();
    state.filtering = false;
    const root: Node = element.getRootNode();
    if (
      root instanceof ShadowRoot &&
      (body.contains(root.activeElement) || root.activeElement === refresh)
    )
      cancel.focus({ preventScroll: true });
    refresh.disabled = true;
    list.replace([]);
    message(WORK_TARGET_COPY.finding);
    body.setAttribute('aria-busy', 'true');
    count.textContent = '';
    let result: WorkTabsResult | null = null;
    try {
      result = parseWorkTabsResult(await sendRequest({ type: 'getWorkTabs', sessionId }));
    } catch {
      /* A visible retry remains available. */
    }
    if (state.closed || request !== state.generation) return;
    state.loading = false;
    refresh.disabled = false;
    state.tabs = result?.ok ? result.tabs : [];
    state.error = result?.ok ? null : (result?.error ?? WORK_TARGET_COPY.loadFailed);
    index.setTabs(state.tabs);
    body.setAttribute('aria-busy', 'false');
    renderMatches();
  };
  refresh.addEventListener('click', (): void => {
    void load();
  });

  const choose: (tabId: number, row: HTMLButtonElement) => Promise<void> = async (
    tabId: number,
    row: HTMLButtonElement,
  ): Promise<void> => {
    if (state.closed || state.loading || state.saving || state.filtering) return;
    const request: number = ++state.generation;
    state.saving = true;
    index.cancel();
    body.setAttribute('aria-busy', 'true');
    cancel.focus({ preventScroll: true });
    search.disabled = true;
    clear.disabled = true;
    refresh.disabled = true;
    list.setDisabled(true);
    message(WORK_TARGET_COPY.saving);
    const error: string | null = await select(tabId);
    if (state.closed || request !== state.generation) return;
    state.saving = false;
    body.setAttribute('aria-busy', 'false');
    search.disabled = false;
    clear.disabled = search.value.length === 0;
    refresh.disabled = false;
    list.setDisabled(false);
    message(error, error !== null);
    if (error !== null) (row.isConnected ? row : search).focus({ preventScroll: true });
  };
  void load();
  return { element, close };
}

/** Back to the trigger, else the enabled return control, else the dialog itself. */
function restorePickerFocus(trigger: HTMLElement, container: HTMLElement): void {
  const available: boolean =
    trigger.isConnected &&
    trigger.closest('[hidden], [inert]') === null &&
    !trigger.matches(':disabled');
  const destination: HTMLElement = available
    ? trigger
    : (container.querySelector<HTMLElement>(
        '.return-work:not([disabled]):not([hidden]):not([inert])',
      ) ?? container);
  destination.focus({ preventScroll: true });
  const root: Node = container.getRootNode();
  if (root instanceof ShadowRoot && root.activeElement !== destination)
    container.focus({ preventScroll: true });
}
