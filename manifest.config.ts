import { defineManifest } from '@crxjs/vite-plugin';
import type { ConfigEnv } from 'vite';
import { MANIFEST_KEY } from './src/shared/manifest-key';

type Manifest = Extract<Parameters<typeof defineManifest>[0], { manifest_version: number }>;

export default defineManifest(
  ({ mode }: ConfigEnv): Manifest => ({
    manifest_version: 3,
    name: '__MSG_app_name__',
    version: '0.1.1',
    description: '__MSG_app_description__',
    default_locale: 'en',
    ...(mode === 'store' ? {} : { key: MANIFEST_KEY }),
    icons: {
      16: 'assets/icons/idle-16.png',
      32: 'assets/icons/idle-32.png',
      48: 'assets/icons/idle-48.png',
      128: 'assets/icons/idle-128.png',
    },
    action: { default_popup: 'src/popup/popup.html' },
    options_page: 'src/options/options.html',
    background: { service_worker: 'src/background/index.ts', type: 'module' },
    permissions: [
      'storage',
      'alarms',
      'tabs',
      'favicon',
      'webNavigation',
      'offscreen',
      'notifications',
      'scripting',
    ],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    incognito: 'spanning',
  }),
);
