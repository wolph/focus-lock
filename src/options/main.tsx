import { render } from 'preact';
import { applyDocumentLocale, t } from '../shared/i18n';
import { App } from './App';
import '../shared/settings-nav.css';
import '../shared/theme-control.css';
import './options.css';

applyDocumentLocale(document);
document.title = t('options_page_title');

render(<App />, document.getElementById('app') as HTMLElement);
