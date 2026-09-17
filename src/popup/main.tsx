import { render } from 'preact';
import { applyDocumentLocale } from '../shared/i18n';
import { App } from './App';
import '../shared/theme-control.css';
import './popup.css';

applyDocumentLocale(document);
render(<App />, document.getElementById('app') as HTMLElement);
