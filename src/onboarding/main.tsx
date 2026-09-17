import { render } from 'preact';
import { applyDocumentLocale, t } from '../shared/i18n';
import { sendRequest } from '../shared/messages';
import { isSessionSnapshot, isSettings } from '../shared/runtime-validation';
import { applyTheme } from '../shared/theme';
import type { ThemeMode } from '../shared/types';
import { App } from './App';
import './onboarding.css';

applyTheme(document.documentElement, 'auto');
let latestTheme: ThemeMode | null = null;
const onBroadcast = (message: unknown): void => {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'stateChanged' ||
    !('snapshot' in message) ||
    !isSessionSnapshot(message.snapshot)
  ) {
    return;
  }
  latestTheme = message.snapshot.theme;
  applyTheme(document.documentElement, latestTheme);
};
chrome.runtime.onMessage?.addListener(onBroadcast);
void sendRequest({ type: 'getSettings' })
  .then((settings: unknown): void => {
    if (latestTheme === null && isSettings(settings)) {
      applyTheme(document.documentElement, settings.theme);
    }
  })
  .catch((): void => undefined);

applyDocumentLocale(document);
document.title = t('onboarding_page_title');

render(<App />, document.getElementById('app') as HTMLElement);
