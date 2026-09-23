/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingPolicyChange } from '../../../src/background/pending-policy-changes';
import { App } from '../../../src/options/App';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { ChromeFake } from './chrome-fake';
import { installChromeFake } from './chrome-fake';

let fake: ChromeFake;

const HELD_LIST_EDIT: PendingPolicyChange = {
  path: 'lists',
  intent: {
    kind: 'lists-delta',
    removeCustom: ['host:reddit.com'],
    addWhitelist: [],
    disableCategories: [],
    addExclusions: {},
  },
  reasonKey: 'notify_guard_lists_remove_blocked',
  at: 1_000,
};

const HELD_DELAY_EDIT: PendingPolicyChange = {
  path: 'settings.gate.delayMs',
  intent: { kind: 'value', value: 5_000 },
  reasonKey: 'notify_guard_settings_shorten_delay',
  at: 1_000,
};

describe('a held edit in Settings', (): void => {
  beforeEach((): void => {
    fake = installChromeFake();
    fake.respond('getSettings', {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 20_000 },
    });
    fake.respond('getLists', {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'reddit.com' }],
    });
    fake.respond('getSnapshot', emptySnapshot(0));
    fake.respond('cancelPendingChange', { ok: true });
  });

  afterEach((): void => {
    cleanup();
  });

  it('shows what was asked for and why it is waiting, with the control unchanged', async (): Promise<void> => {
    fake.respond('getPendingChanges', { changes: [HELD_LIST_EDIT] });
    window.location.hash = '#blocking';
    const { getByRole, getByText } = render(<App />);

    await waitFor((): void =>
      expect(getByText('Waiting for the hard lock to end: reddit.com')).toBeTruthy(),
    );
    expect(
      getByText('a hard session is running: removing blocked sites unlocks when it ends'),
    ).toBeTruthy();
    // The rule the lock is still enforcing is the one the editor still lists.
    expect(getByRole('cell', { name: 'reddit.com' })).toBeTruthy();
  });

  it('reads a held number in the same terms as the control above it', async (): Promise<void> => {
    fake.respond('getPendingChanges', { changes: [HELD_DELAY_EDIT] });
    const { getByLabelText, getByRole, getByText } = render(<App />);
    await waitFor((): void => expect(getByRole('link', { name: 'Session behavior' })).toBeTruthy());
    fireEvent.click(getByRole('link', { name: 'Session behavior' }));

    await waitFor((): void =>
      expect(getByText('Waiting for the hard lock to end: a 5-second wait')).toBeTruthy(),
    );
    // The wait the lock is still enforcing is the one the control shows.
    expect((getByLabelText('Custom delay (seconds)') as HTMLInputElement).value).toBe('20');
  });

  it('drops a held edit when it is cancelled', async (): Promise<void> => {
    fake.respond('getPendingChanges', { changes: [HELD_LIST_EDIT] });
    window.location.hash = '#blocking';
    const { getAllByRole, queryByText } = render(<App />);
    await waitFor((): void =>
      expect(getAllByRole('button', { name: 'Cancel this change' })[0]).toBeTruthy(),
    );

    fake.respond('getPendingChanges', { changes: [] });
    await act(async (): Promise<void> => {
      fireEvent.click(getAllByRole('button', { name: 'Cancel this change' })[0] as HTMLElement);
      await Promise.resolve();
    });

    expect(fake.sent).toContainEqual({ type: 'cancelPendingChange', path: 'lists' });
    await waitFor((): void =>
      expect(queryByText('Waiting for the hard lock to end: reddit.com')).toBeNull(),
    );
  });

  it('shows nothing when the profile owes no edits', async (): Promise<void> => {
    fake.respond('getPendingChanges', { changes: [] });
    window.location.hash = '#blocking';
    const { queryByRole, getByRole } = render(<App />);
    await waitFor((): void => expect(getByRole('heading', { name: 'Blocking' })).toBeTruthy());

    expect(queryByRole('button', { name: 'Cancel this change' })).toBeNull();
  });
});
