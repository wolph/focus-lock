/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/options/App';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import type { ChromeFake } from './chrome-fake';
import { installChromeFake } from './chrome-fake';

let fake: ChromeFake;

function settingsWrites(): Extract<Request, { type: 'updateSettings' }>[] {
  return fake.sent.filter(
    (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
      request.type === 'updateSettings',
  );
}

describe('Settings autosave', (): void => {
  beforeEach((): void => {
    fake = installChromeFake();
    fake.respond('getSettings', DEFAULT_SETTINGS);
    fake.respond('getLists', DEFAULT_LISTS);
    fake.respond('getSnapshot', emptySnapshot(0));
    fake.respond('updateSettings', { ok: true });
    fake.respond('updateLists', { ok: true });
  });

  afterEach((): void => {
    cleanup();
  });

  it('writes a typed number once rather than once per keystroke', async (): Promise<void> => {
    const { getByLabelText, getByRole } = render(<App />);
    await waitFor((): void => expect(getByRole('link', { name: 'Session behavior' })).toBeTruthy());
    fireEvent.click(getByRole('link', { name: 'Session behavior' }));
    await waitFor((): void =>
      expect(getByLabelText('Short session preset (minutes)')).toBeTruthy(),
    );

    const preset: HTMLElement = getByLabelText('Short session preset (minutes)');
    fireEvent.input(preset, { target: { value: '1' } });
    fireEvent.input(preset, { target: { value: '12' } });
    fireEvent.input(preset, { target: { value: '120' } });

    await waitFor((): void => expect(settingsWrites()).toHaveLength(1));
    expect(settingsWrites()[0]?.settings.presetsMin[0]).toBe(120);
  });

  it('writes what is waiting when the page goes away', async (): Promise<void> => {
    const { getByLabelText, getByRole } = render(<App />);
    await waitFor((): void => expect(getByRole('link', { name: 'Session behavior' })).toBeTruthy());
    fireEvent.click(getByRole('link', { name: 'Session behavior' }));
    await waitFor((): void =>
      expect(getByLabelText('Short session preset (minutes)')).toBeTruthy(),
    );
    fireEvent.input(getByLabelText('Short session preset (minutes)'), { target: { value: '12' } });

    // Nothing has been written yet: the debounce is still holding it.
    expect(settingsWrites()).toHaveLength(0);

    await act(async (): Promise<void> => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });

    await waitFor((): void => expect(settingsWrites()).toHaveLength(1));
    expect(settingsWrites()[0]?.settings.presetsMin[0]).toBe(12);
  });
});
