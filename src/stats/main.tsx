import { render } from 'preact';
import { applyDocumentLocale, t } from '../shared/i18n';
import { App } from './App';
import '../shared/settings-nav.css';
import '../shared/theme-control.css';
import './stats.css';

applyDocumentLocale(document);
document.title = t('stats_document_title');

render(<App />, document.getElementById('app') as HTMLElement);
