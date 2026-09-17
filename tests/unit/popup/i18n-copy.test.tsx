/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GateState } from '../../../src/shared/types';

/**
 * Every other popup test runs without `chrome.i18n`, so it reads the en catalogue and asserts
 * English. This one installs a browser that answers, which is the path the extension itself
 * takes: it proves the popup asks Chrome for its copy instead of rendering a baked-in literal.
 */
const TRANSLATED: string = 'vertaald';

interface I18nFake {
  getMessage(key: string, substitutions?: string[]): string;
  getUILanguage(): string;
}

/** Marks every answer, and appends the substitutions so their order can be read back. */
const i18nFake: I18nFake = {
  getMessage: (key: string, substitutions?: string[]): string =>
    key === '@@bidi_dir' ? 'rtl' : [`${TRANSLATED}:${key}`, ...(substitutions ?? [])].join(' '),
  getUILanguage: (): string => 'nl-NL',
};

let GatePanel: typeof import('../../../src/popup/GatePanel').GatePanel;
let USE_THIS_TAB_LABEL: string;
let applyDocumentLocale: typeof import('../../../src/shared/i18n').applyDocumentLocale;

const GATE: GateState = {
  kind: 'cancel',
  host: null,
  openedAt: 1_000,
  readyAt: 11_000,
  requiredPhrase: null,
  forceEndAvailable: false,
};

beforeAll(async (): Promise<void> => {
  // The browser exists before the popup's modules load, so a constant that reads its copy at
  // import time reads the translation. The import has to follow the fake for the same reason.
  (globalThis as { chrome?: { i18n?: I18nFake } }).chrome = {
    ...(globalThis as { chrome?: object }).chrome,
    i18n: i18nFake,
  };
  ({ GatePanel } = await import('../../../src/popup/GatePanel'));
  ({ USE_THIS_TAB_LABEL } = await import('../../../src/popup/ThisTabButton'));
  ({ applyDocumentLocale } = await import('../../../src/shared/i18n'));
});

afterEach((): void => {
  cleanup();
});

describe('popup copy through chrome.i18n', (): void => {
  it('reads a label the module captured at import time', (): void => {
    expect(USE_THIS_TAB_LABEL).toBe(`${TRANSLATED}:popup_use_this_tab`);
  });

  it('renders a view from the browser catalogue, placeholders in declared order', (): void => {
    const view = render(
      h(GatePanel, {
        gate: GATE,
        now: 3_000,
        intention: 'write the report',
        sendCommand: async (): Promise<never> => {
          throw new Error('not sent in this test');
        },
        commandError: (): null => null,
      }),
    );

    // The confirm button is left out on purpose: its label is a published contract tag, mapped
    // to a message where the worker's copy is read, not here.
    expect(
      view.getByRole('button', { name: `${TRANSLATED}:popup_gate_keep_focusing` }),
    ).toBeTruthy();
    expect(view.container.textContent).toContain(
      `${TRANSLATED}:popup_gate_intention write the report`,
    );
    // TOTAL is the only placeholder of the countdown's closing half, so it arrives as $1.
    expect(view.container.textContent).toContain(`${TRANSLATED}:popup_gate_wait_remaining 10`);
  });

  it('stamps the document with the browser language and direction', (): void => {
    applyDocumentLocale(document);

    expect(document.documentElement.lang).toBe('nl-NL');
    expect(document.documentElement.dir).toBe('rtl');
  });
});
