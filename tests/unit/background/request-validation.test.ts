import { describe, expect, it } from 'vitest';
import { LISTS_SPLIT_THRESHOLD_BYTES } from '../../../src/background/list-sync-codec';
import { parseRequest } from '../../../src/background/request-validation';
import { syncItemBytes } from '../../../src/background/sync-quota';
import {
  CATEGORY_IDS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import { SYNC_LISTS } from '../../../src/shared/storage-keys';
import type {
  GateState,
  ListsConfig,
  OnboardingDraft,
  SessionConfig,
  Settings,
} from '../../../src/shared/types';

describe('captured gate request binding', (): void => {
  const expectedGate: GateState = {
    kind: 'unlockSite',
    host: 'reddit.com',
    openedAt: 1,
    readyAt: 2,
    requiredPhrase: null,
    forceEndAvailable: false,
  };
  it.each(['confirmGate', 'abandonGate'])(
    'requires a complete detached gate for %s',
    (type: string): void => {
      const request: Record<string, unknown> = {
        type,
        ...(type === 'confirmGate' ? { typedPhrase: null } : {}),
      };
      expect(parseRequest(request)).toBeNull();
      const invalidGates: unknown[] = [
        null,
        {},
        { ...expectedGate, extra: true },
        { ...expectedGate, host: null },
      ];
      for (const invalid of invalidGates) {
        expect(parseRequest({ ...request, expectedGate: invalid })).toBeNull();
      }
      const parsed: Request | null = parseRequest({ ...request, expectedGate });
      expect(parsed).toEqual({ ...request, expectedGate });
      if (parsed?.type === 'confirmGate' || parsed?.type === 'abandonGate')
        expect(parsed.expectedGate).not.toBe(expectedGate);
    },
  );
});

type RequestByType = {
  [Type in Request['type']]: Extract<Request, { type: Type }>;
};

const SESSION_CONFIG: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'timed', minutes: 25 },
  cycling: {
    focusMin: 25,
    shortBreakMin: 5,
    longBreakMin: 15,
    longEvery: 4,
  },
  intention: 'Ship the parser',
  source: 'manual',
  scheduleOccurrence: null,
  rules: rulesFromLists(DEFAULT_LISTS),
};

const WORK_SESSION_ID: string = '10000000-0000-4000-8000-000000000001';
const SETTINGS: Settings = structuredClone(DEFAULT_SETTINGS);
const LISTS: ListsConfig = structuredClone(DEFAULT_LISTS);
const DAY_MS: number = 86_400_000;
const DATE_MAX_MS: number = 8_640_000_000_000_000;
const MINUTE_MS: number = 60_000;
const MAX_RELATIVE_DURATION_MS: number = DATE_MAX_MS / 2;
const ONBOARDING_DRAFT: OnboardingDraft = {
  version: 1,
  revision: 3,
  step: 2,
  settings: SETTINGS,
  lists: LISTS,
  websiteAccessChoice: 'denied',
  syncEnabled: true,
};

const VALID_REQUESTS: RequestByType = {
  getSnapshot: { type: 'getSnapshot' },
  getSetupState: { type: 'getSetupState' },
  openOnboarding: { type: 'openOnboarding' },
  getOnboardingDraft: { type: 'getOnboardingDraft' },
  cleanupOnboardingDraft: { type: 'cleanupOnboardingDraft' },
  saveOnboardingDraft: { type: 'saveOnboardingDraft', draft: ONBOARDING_DRAFT },
  completeOnboarding: { type: 'completeOnboarding', revision: 3, storageMode: 'local' },
  reconcileWebsiteAccess: { type: 'reconcileWebsiteAccess' },
  dismissWebsiteAccessNotice: { type: 'dismissWebsiteAccessNotice' },
  completeSetup: {
    type: 'completeSetup',
    storageMode: 'local',
    settings: SETTINGS,
    lists: LISTS,
  },
  setStorageMode: { type: 'setStorageMode', storageMode: 'local', deleteRemote: false },
  retrySync: { type: 'retrySync' },
  getBootFailure: { type: 'getBootFailure' },
  retryBoot: { type: 'retryBoot' },
  resetLocalRuntime: { type: 'resetLocalRuntime' },
  clearFocusLockData: { type: 'clearFocusLockData', scope: 'local-history' },
  getBlockState: {
    type: 'getBlockState',
    url: 'https://news.example/story',
    docState: 'fresh',
  },
  startSession: { type: 'startSession', config: SESSION_CONFIG },
  openGate: { type: 'openGate', gate: 'unlockSite', host: 'news.example' },
  confirmGate: {
    type: 'confirmGate',
    typedPhrase: null,
    expectedGate: {
      kind: 'pause',
      host: null,
      openedAt: 1,
      readyAt: 2,
      requiredPhrase: null,
      forceEndAvailable: false,
    },
  },
  requestSessionEnd: { type: 'requestSessionEnd' },
  openEndGate: { type: 'openEndGate' },
  forceEndGate: { type: 'forceEndGate' },
  abandonGate: {
    type: 'abandonGate',
    expectedGate: {
      kind: 'pause',
      host: null,
      openedAt: 1,
      readyAt: 2,
      requiredPhrase: null,
      forceEndAvailable: false,
    },
  },
  retryTransitionCleanup: { type: 'retryTransitionCleanup' },
  retryClosureCleanup: { type: 'retryClosureCleanup' },
  retryDataClear: { type: 'retryDataClear' },
  resumeFromPause: { type: 'resumeFromPause' },
  startNextFocusEarly: { type: 'startNextFocusEarly' },
  updateSettings: { type: 'updateSettings', settings: SETTINGS },
  updateTheme: { type: 'updateTheme', theme: 'auto' },
  updateLists: { type: 'updateLists', lists: LISTS },
  getSettings: { type: 'getSettings' },
  getLists: { type: 'getLists' },
  getPendingChanges: { type: 'getPendingChanges' },
  cancelPendingChange: { type: 'cancelPendingChange', path: 'settings.gate.delayMs' },
  getStats: { type: 'getStats', days: 30 },
  exportEvents: { type: 'exportEvents' },
  previewSound: { type: 'previewSound', sound: 'breakStart' },
  getWorkTabs: { type: 'getWorkTabs', sessionId: WORK_SESSION_ID },
  getWorkTabIcon: { type: 'getWorkTabIcon', sessionId: WORK_SESSION_ID, tabId: 4 },
  getWorkTarget: { type: 'getWorkTarget' },
  setWorkTarget: { type: 'setWorkTarget', sessionId: WORK_SESSION_ID, tabId: 4 },
  returnToWork: { type: 'returnToWork', sessionId: WORK_SESSION_ID },
};

function replaceNested(
  request: Record<string, unknown>,
  key: string,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const nested: unknown = request[key];
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
    throw new TypeError(`${key} is not a record`);
  }
  return { ...request, [key]: { ...nested, ...update } };
}

describe('parseRequest', (): void => {
  it('accepts only the exact retry Sync request', (): void => {
    expect(parseRequest({ type: 'retrySync' })).toEqual({ type: 'retrySync' });
    expect(parseRequest({ type: 'retrySync', storageMode: 'sync' })).toBeNull();
  });

  it.each([
    { type: 'openOnboarding' },
    { type: 'getOnboardingDraft' },
    { type: 'cleanupOnboardingDraft' },
    { type: 'saveOnboardingDraft', draft: ONBOARDING_DRAFT },
    { type: 'completeOnboarding', revision: 3, storageMode: 'sync' },
  ])('accepts the serialized onboarding request %#', (request: unknown): void => {
    expect(parseRequest(request)).toEqual(request);
  });

  it.each([
    { type: 'openOnboarding', extra: true },
    { type: 'getOnboardingDraft', revision: 1 },
    { type: 'cleanupOnboardingDraft', force: true },
    { type: 'saveOnboardingDraft', draft: { ...ONBOARDING_DRAFT, revision: -1 } },
    { type: 'saveOnboardingDraft', draft: { ...ONBOARDING_DRAFT, extra: true } },
    { type: 'completeOnboarding', revision: 0, storageMode: 'sync' },
    { type: 'completeOnboarding', revision: 3, storageMode: 'cloud' },
    { type: 'completeOnboarding', revision: 3, storageMode: 'local', extra: true },
  ])('rejects the invalid serialized onboarding request %#', (request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });

  it.each([
    { type: 'getSetupState' },
    { type: 'reconcileWebsiteAccess' },
    { type: 'dismissWebsiteAccessNotice' },
    {
      type: 'completeSetup',
      storageMode: 'sync',
      settings: SETTINGS,
      lists: LISTS,
    },
    { type: 'setStorageMode', storageMode: 'local', deleteRemote: false },
    { type: 'setStorageMode', storageMode: 'local', deleteRemote: true },
    { type: 'setStorageMode', storageMode: 'sync', deleteRemote: false },
    { type: 'clearFocusLockData', scope: 'local-history' },
    { type: 'clearFocusLockData', scope: 'synced-policy' },
    { type: 'clearFocusLockData', scope: 'all' },
  ])('accepts the onboarding request %#', (request: unknown): void => {
    expect(parseRequest(request)).toEqual(request);
  });

  it.each([
    { type: 'getSetupState', extra: true },
    { type: 'reconcileWebsiteAccess', granted: true },
    { type: 'dismissWebsiteAccessNotice', notice: null },
    { type: 'completeSetup', storageMode: null, settings: SETTINGS, lists: LISTS },
    { type: 'completeSetup', storageMode: 'cloud', settings: SETTINGS, lists: LISTS },
    { type: 'completeSetup', storageMode: 'local', settings: {}, lists: LISTS },
    { type: 'completeSetup', storageMode: 'local', settings: SETTINGS, lists: {} },
    { type: 'completeSetup', storageMode: 'local', settings: SETTINGS, lists: LISTS, extra: true },
    { type: 'setStorageMode', storageMode: 'sync', deleteRemote: true },
    { type: 'setStorageMode', storageMode: 'local', deleteRemote: 'yes' },
    { type: 'setStorageMode', storageMode: null, deleteRemote: false },
    { type: 'clearFocusLockData', scope: 'settings' },
    { type: 'clearFocusLockData', scope: 'all', extra: true },
  ])('rejects the malformed onboarding request %#', (request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });

  it('accepts only the exact requestSessionEnd shape', (): void => {
    expect(parseRequest({ type: 'requestSessionEnd' })).toEqual({ type: 'requestSessionEnd' });
    expect(parseRequest({ type: 'requestSessionEnd', extra: true })).toBeNull();
  });

  it.each(['auto', 'light', 'dark'])('accepts the %s theme mode', (theme: string): void => {
    expect(parseRequest({ type: 'updateTheme', theme })).toEqual({
      type: 'updateTheme',
      theme,
    });
  });

  it('rejects an unknown theme mode', (): void => {
    expect(parseRequest({ type: 'updateTheme', theme: 'sepia' })).toBeNull();
  });

  it('accepts lists above the unsplit threshold when category sharding fits', (): void => {
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions,
    };

    expect(syncItemBytes(SYNC_LISTS, lists)).toBeGreaterThan(LISTS_SPLIT_THRESHOLD_BYTES);
    expect(parseRequest({ type: 'updateLists', lists })).toEqual({ type: 'updateLists', lists });
  });

  it.each(Object.entries(VALID_REQUESTS))(
    'accepts the %s request',
    (_type: string, request: Request): void => {
      expect(parseRequest(request)).toEqual(request);
    },
  );

  it.each([null, undefined, true, 1, 'getSnapshot', [], { type: 'unknown' }, {}])(
    'rejects a non-request root value %#',
    (value: unknown): void => {
      expect(parseRequest(value)).toBeNull();
    },
  );

  it.each(Object.values(VALID_REQUESTS))(
    'rejects extra top-level fields from $type',
    (request: Request): void => {
      expect(parseRequest({ ...request, extra: true })).toBeNull();
    },
  );

  it.each([
    { type: 'getBlockState', url: '', docState: 'fresh' },
    { type: 'getBlockState', url: 'not a URL', docState: 'fresh' },
    { type: 'getBlockState', url: 'https://example.com', docState: 'stale' },
    { type: 'getBlockState', url: 'https://example.com' },
    { type: 'getStats', days: 0 },
    { type: 'getStats', days: -1 },
    { type: 'getStats', days: 1.5 },
    { type: 'getStats', days: Number.NaN },
    { type: 'getStats', days: Number.POSITIVE_INFINITY },
    { type: 'previewSound', sound: 'other' },
    { type: 'confirmGate', typedPhrase: 1 },
  ])('rejects malformed scalar payloads %#', (request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });

  it.each([
    { type: 'openGate', gate: 'unlockSite', host: null },
    { type: 'openGate', gate: 'unlockSite', host: '' },
    { type: 'openGate', gate: 'unlockSite', host: 'not a host' },
    { type: 'openGate', gate: 'pause', host: 'example.com' },
    { type: 'openGate', gate: 'cancel', host: 'example.com' },
    { type: 'openGate', gate: 'pause', host: undefined },
    { type: 'openGate', gate: 'other', host: null },
  ])('rejects malformed gate and host combinations %#', (request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });

  it('accepts null hosts for gates that do not target a site', (): void => {
    expect(parseRequest({ type: 'openGate', gate: 'pause', host: null })).not.toBeNull();
    expect(parseRequest({ type: 'openGate', gate: 'cancel', host: null })).toBeNull();
  });

  it.each(['localhost', 'intranet', '[::1]', '[2001:db8::1]'])(
    'accepts the browser hostname %s for a site unlock',
    (host: string): void => {
      expect(parseRequest({ type: 'openGate', gate: 'unlockSite', host })).toEqual({
        type: 'openGate',
        gate: 'unlockSite',
        host,
      });
    },
  );

  it.each([
    'example.com:443',
    'example.com/path',
    ' example.com',
    'example.com ',
    'example .com',
    '[::1',
    '::1',
  ])('rejects the non-hostname site unlock value %s', (host: string): void => {
    expect(parseRequest({ type: 'openGate', gate: 'unlockSite', host })).toBeNull();
  });

  it.each([
    replaceNested(VALID_REQUESTS.startSession, 'config', { mode: 'other' }),
    replaceNested(VALID_REQUESTS.startSession, 'config', { strictness: 'other' }),
    replaceNested(VALID_REQUESTS.startSession, 'config', {
      duration: { kind: 'timed', minutes: -1 },
    }),
    replaceNested(VALID_REQUESTS.startSession, 'config', {
      duration: { kind: 'timed', minutes: Number.NaN },
    }),
    replaceNested(VALID_REQUESTS.startSession, 'config', {
      duration: { kind: 'timed', minutes: Number.POSITIVE_INFINITY },
    }),
    replaceNested(VALID_REQUESTS.startSession, 'config', {
      source: 'manual',
      scheduleOccurrence: {
        version: 1,
        token: 'entry@2026-09-03',
        entryId: 'entry',
        localStartDate: '2026-09-03',
      },
    }),
    replaceNested(VALID_REQUESTS.startSession, 'config', {
      source: 'schedule',
      scheduleOccurrence: null,
    }),
    replaceNested(VALID_REQUESTS.startSession, 'config', { cycling: [] }),
    replaceNested(VALID_REQUESTS.startSession, 'config', { extra: true }),
  ])('rejects malformed session configurations %#', (request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });

  it('requires a complete rules snapshot for manual starts', (): void => {
    const config: Record<string, unknown> = structuredClone(SESSION_CONFIG) as unknown as Record<
      string,
      unknown
    >;
    delete config.rules;

    expect(parseRequest({ type: 'startSession', config })).toBeNull();
  });

  it('normalizes session host additions at the request boundary', (): void => {
    const request: Record<string, unknown> = replaceNested(VALID_REQUESTS.startSession, 'config', {
      rules: {
        ...SESSION_CONFIG.rules,
        sessionAllowlist: [{ kind: 'host', pattern: '  HTTPS://Docs.Python.org/3/library/  ' }],
      },
    });

    expect(parseRequest(request)).toMatchObject({
      config: {
        rules: {
          sessionAllowlist: [{ kind: 'host', pattern: 'docs.python.org' }],
        },
      },
    });
  });

  it.each(['\n', '\t', '\r', '\v', '\f'])(
    'rejects session hosts with leading or trailing %j controls',
    (control: string): void => {
      for (const pattern of [`${control}docs.python.org`, `docs.python.org${control}`]) {
        const request: Record<string, unknown> = replaceNested(
          VALID_REQUESTS.startSession,
          'config',
          {
            rules: {
              ...SESSION_CONFIG.rules,
              sessionAllowlist: [{ kind: 'host', pattern }],
            },
          },
        );

        expect(parseRequest(request)).toBeNull();
      }
    },
  );

  it('deduplicates equivalent Unicode, punycode, and trailing-dot session hosts', (): void => {
    const request: Record<string, unknown> = replaceNested(VALID_REQUESTS.startSession, 'config', {
      rules: {
        ...SESSION_CONFIG.rules,
        sessionBlacklist: [
          { kind: 'host', pattern: 'BÜCHER.EXAMPLE' },
          { kind: 'host', pattern: 'xn--bcher-kva.example.' },
        ],
      },
    });

    expect(parseRequest(request)).toMatchObject({
      config: {
        rules: {
          sessionBlacklist: [{ kind: 'host', pattern: 'xn--bcher-kva.example' }],
        },
      },
    });
  });

  it.each([
    { sessionAllowlist: [{ kind: 'regex', pattern: '.*' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: 'ftp://example.com/' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: 'https://user@example.com/' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: 'https://example.com:8443/' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: 'https://example.com:443/' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: '//example.com/path' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: 'https:\\example.com' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: 'mailto:user@example.com' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: 'example.com\u007f' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: '127.0.0.1' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: '0127.0.0.1' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: '[2001:db8::1]' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: 'localhost' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: 'intranet' }] },
    { sessionBlacklist: [{ kind: 'host', pattern: 'not a host/path' }] },
    { baselineCategories: { ...DEFAULT_LISTS.categories, social: 'yes' } },
    { baselineCategories: { ...DEFAULT_LISTS.categories, unknown: true } },
    { categories: { ...DEFAULT_LISTS.categories, unknown: true } },
    { permanentBlacklist: [{ kind: 'regex', pattern: '(' }] },
  ])('rejects malformed nested session rules %#', (rulesUpdate: Record<string, unknown>): void => {
    const request: Record<string, unknown> = replaceNested(VALID_REQUESTS.startSession, 'config', {
      rules: { ...SESSION_CONFIG.rules, ...rulesUpdate },
    });

    expect(parseRequest(request)).toBeNull();
  });

  it('rejects sparse session rule arrays', (): void => {
    const sparse: Array<{ kind: 'host'; pattern: string }> = new Array(1);
    const request: Record<string, unknown> = replaceNested(VALID_REQUESTS.startSession, 'config', {
      rules: { ...SESSION_CONFIG.rules, sessionBlacklist: sparse },
    });

    expect(parseRequest(request)).toBeNull();
  });

  it('rejects extra session snapshot keys', (): void => {
    const request: Record<string, unknown> = replaceNested(VALID_REQUESTS.startSession, 'config', {
      rules: { ...SESSION_CONFIG.rules, extra: true },
    });

    expect(parseRequest(request)).toBeNull();
  });

  it('rejects popup-originated scheduled session requests', (): void => {
    const config: SessionConfig = {
      ...SESSION_CONFIG,
      source: 'schedule',
      scheduleOccurrence: {
        version: 1,
        token: 'weekday-morning@2026-09-03',
        entryId: 'weekday-morning',
        localStartDate: '2026-09-03',
      },
    };
    expect(parseRequest({ type: 'startSession', config })).toBeNull();
  });

  it.each([
    { focusMin: -1 },
    { shortBreakMin: Number.NaN },
    { longBreakMin: Number.POSITIVE_INFINITY },
    { longEvery: 0 },
    { longEvery: 1.5 },
    { extra: true },
  ])('rejects malformed cycle configuration fields %#', (update: Record<string, unknown>): void => {
    const cycling: Record<string, unknown> = {
      ...(SESSION_CONFIG.cycling as NonNullable<SessionConfig['cycling']>),
      ...update,
    };
    const request: Record<string, unknown> = replaceNested(VALID_REQUESTS.startSession, 'config', {
      cycling,
    });
    expect(parseRequest(request)).toBeNull();
  });

  it('accepts positive fractional cycle durations', (): void => {
    const config: SessionConfig = {
      ...SESSION_CONFIG,
      cycling: {
        focusMin: 0.25,
        shortBreakMin: 0.05,
        longBreakMin: 1.25,
        longEvery: 4,
      },
    };

    expect(parseRequest({ type: 'startSession', config })).toEqual({
      type: 'startSession',
      config,
    });
  });

  it('rejects the stored predecessor rule shape at the live request boundary', (): void => {
    const predecessor: Record<string, unknown> = structuredClone(
      SESSION_CONFIG.rules,
    ) as unknown as Record<string, unknown>;
    delete predecessor.baselineCategories;
    const request: Record<string, unknown> = replaceNested(VALID_REQUESTS.startSession, 'config', {
      rules: predecessor,
    });

    expect(parseRequest(request)).toBeNull();
  });

  it('accepts editable freeze cadence and completion-notification settings', (): void => {
    const settings: Record<string, unknown> = {
      ...SETTINGS,
      streakFreezeIntervalDays: 7,
      sessionCompleteNotification: false,
    };

    expect(parseSettingsRequest(settings)).not.toBeNull();
  });

  it('accepts Flexible as the default strictness', (): void => {
    expect(parseSettingsRequest({ ...SETTINGS, defaultStrictness: 'flexible' })).not.toBeNull();
  });

  it('accepts the force end bypass setting in either state', (): void => {
    expect(
      parseSettingsRequest({ ...SETTINGS, gate: { ...SETTINGS.gate, allowForceEnd: true } }),
    ).not.toBeNull();
    expect(
      parseSettingsRequest({ ...SETTINGS, gate: { ...SETTINGS.gate, allowForceEnd: false } }),
    ).not.toBeNull();
  });

  it.each([
    { presetsMin: [15, 25] },
    { presetsMin: [15, -1, 50] },
    { defaultMode: 'other' },
    { defaultStrictness: 'other' },
    { defaultCycling: { ...SETTINGS.defaultCycling, longEvery: 1.5 } },
    { cyclingOnByDefault: 'yes' },
    { pause: { ...SETTINGS.pause, capMs: -1 } },
    { pause: { ...SETTINGS.pause, earnRatio: Number.NaN } },
    { pause: { ...SETTINGS.pause, extra: true } },
    { gate: { ...SETTINGS.gate, delayMs: 1.5 } },
    { gate: { ...SETTINGS.gate, extra: true } },
    { gate: { ...SETTINGS.gate, allowForceEnd: 'yes' } },
    {
      gate: {
        delayMs: SETTINGS.gate.delayMs,
        requireTypedPhrase: SETTINGS.gate.requireTypedPhrase,
      },
    },
    { badgeCountdown: 1 },
    { sounds: { ...SETTINGS.sounds, masterVolume: 1.1 } },
    { sounds: { ...SETTINGS.sounds, extra: true } },
    { schedule: [{}] },
    { streakGoalMin: -1 },
    { streakFreezeIntervalDays: 0 },
    { streakFreezeIntervalDays: 1.5 },
    { sessionCompleteNotification: 'yes' },
    { retentionDays: 1.5 },
    { extra: true },
  ])('rejects malformed settings payload fields %#', (update: Record<string, unknown>): void => {
    expect(
      parseRequest({
        type: 'updateSettings',
        settings: { ...SETTINGS, ...update },
      }),
    ).toBeNull();
  });

  it.each([
    { id: ' ' },
    { days: [] },
    { days: [7] },
    { days: [1.5] },
    { start: '9:00' },
    { end: '24:00' },
    { mode: 'other' },
    { strictness: 'other' },
    { cycling: { ...SETTINGS.defaultCycling, longEvery: 0 } },
    { intention: null },
    { enabled: 1 },
    { extra: true },
  ])('rejects malformed schedule entries %#', (update: Record<string, unknown>): void => {
    const scheduleEntry: Record<string, unknown> = {
      id: 'weekday',
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '17:00',
      mode: 'blacklist',
      strictness: 'hard',
      cycling: null,
      intention: '',
      enabled: true,
      ...update,
    };
    expect(
      parseRequest({
        type: 'updateSettings',
        settings: { ...SETTINGS, schedule: [scheduleEntry] },
      }),
    ).toBeNull();
  });

  it('rejects overnight schedules while schedules use same-day semantics', (): void => {
    const scheduleEntry: Record<string, unknown> = {
      id: 'overnight',
      days: [1],
      start: '22:00',
      end: '06:00',
      mode: 'blacklist',
      strictness: 'hard',
      cycling: null,
      intention: '',
      enabled: true,
    };
    expect(
      parseRequest({
        type: 'updateSettings',
        settings: { ...SETTINGS, schedule: [scheduleEntry] },
      }),
    ).toBeNull();
  });

  it('rejects duplicate schedule IDs', (): void => {
    const first: Record<string, unknown> = scheduleEntry({ id: 'duplicate', start: '09:00' });
    const second: Record<string, unknown> = scheduleEntry({ id: 'duplicate', start: '13:00' });
    expect(parseSettingsRequest({ schedule: [first, second] })).toBeNull();
  });

  it('rejects duplicate days within one schedule entry', (): void => {
    expect(parseSettingsRequest({ schedule: [scheduleEntry({ days: [1, 1] })] })).toBeNull();
  });

  it('rejects overlapping enabled schedule entries on a shared day', (): void => {
    const first: Record<string, unknown> = scheduleEntry({
      id: 'first',
      days: [1, 2],
      start: '09:00',
      end: '12:00',
    });
    const second: Record<string, unknown> = scheduleEntry({
      id: 'second',
      days: [2, 3],
      start: '11:00',
      end: '13:00',
    });
    expect(parseSettingsRequest({ schedule: [first, second] })).toBeNull();
  });

  it('accepts adjacent, disabled, and disjoint-day schedule windows', (): void => {
    const base: Record<string, unknown> = scheduleEntry({
      id: 'base',
      days: [1],
      start: '09:00',
      end: '12:00',
    });
    const adjacent: Record<string, unknown> = scheduleEntry({
      id: 'adjacent',
      days: [1],
      start: '12:00',
      end: '13:00',
    });
    const disabled: Record<string, unknown> = scheduleEntry({
      id: 'disabled',
      days: [1],
      start: '10:00',
      end: '11:00',
      enabled: false,
    });
    const disjoint: Record<string, unknown> = scheduleEntry({
      id: 'disjoint',
      days: [2],
      start: '10:00',
      end: '11:00',
    });
    expect(parseSettingsRequest({ schedule: [base, adjacent, disabled, disjoint] })).not.toBeNull();
  });

  it.each([
    ['rules', { custom: sparseArray(1) }],
    ['presets', { presetsMin: sparseArray(3, { 0: 15, 2: 50 }) }],
    ['schedule', { schedule: sparseArray(1) }],
    ['schedule days', { schedule: [scheduleEntry({ days: sparseArray(2, { 0: 1 }) })] }],
  ])('rejects sparse %s arrays', (_label: string, update: Record<string, unknown>): void => {
    expect(parseSettingsOrListsRequest(update)).toBeNull();
  });

  it('rejects sparse exclusion host arrays', (): void => {
    expect(
      parseRequest({
        type: 'updateLists',
        lists: { ...LISTS, exclusions: { social: sparseArray(1) } },
      }),
    ).toBeNull();
  });

  it('rejects oversized settings before quadratic schedule overlap validation', (): void => {
    let enabledReads: number = 0;
    const entryCount: number = 120;
    const schedule: Record<string, unknown>[] = Array.from(
      { length: entryCount },
      (_value: unknown, index: number): Record<string, unknown> => {
        const entry: Record<string, unknown> = scheduleEntry({
          id: `oversized-${index}`,
          intention: 'x'.repeat(100),
        });
        Object.defineProperty(entry, 'enabled', {
          configurable: true,
          enumerable: true,
          get: (): boolean => {
            enabledReads += 1;
            return false;
          },
        });
        return entry;
      },
    );

    expect(parseSettingsRequest({ schedule })).toBeNull();
    expect(enabledReads).toBe(entryCount);
  });

  it('rejects oversized lists before compiling every custom rule', (): void => {
    let patternReads: number = 0;
    const ruleCount: number = 30;
    const custom: Record<string, unknown>[] = Array.from(
      { length: ruleCount },
      (): Record<string, unknown> => {
        const rule: Record<string, unknown> = { kind: 'regex' };
        Object.defineProperty(rule, 'pattern', {
          configurable: true,
          enumerable: true,
          get: (): string => {
            patternReads += 1;
            return 'a'.repeat(400);
          },
        });
        return rule;
      },
    );

    expect(
      parseRequest({
        type: 'updateLists',
        lists: { ...LISTS, custom },
      }),
    ).toBeNull();
    expect(patternReads).toBe(ruleCount);
  });

  it('rejects list items oversized only after Chromium escaping', (): void => {
    expect(
      parseRequest({
        type: 'updateLists',
        lists: {
          ...LISTS,
          custom: [{ kind: 'regex', pattern: '<\u2028\u2029'.repeat(500) }],
        },
      }),
    ).toBeNull();
  });

  it.each([
    [
      'zero session duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        duration: { kind: 'timed', minutes: 0 },
      }),
    ],
    [
      'sub-millisecond session duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        duration: { kind: 'timed', minutes: 0.000_001 },
      }),
    ],
    [
      'unsafe session duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        duration: { kind: 'timed', minutes: Number.MAX_SAFE_INTEGER },
      }),
    ],
    [
      'zero focus cycle',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: { ...SESSION_CONFIG.cycling, focusMin: 0 },
      }),
    ],
    [
      'zero short break cycle',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: { ...SESSION_CONFIG.cycling, shortBreakMin: 0 },
      }),
    ],
    [
      'zero long break cycle',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: { ...SESSION_CONFIG.cycling, longBreakMin: 0 },
      }),
    ],
    [
      'unsafe cycle count',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: { ...SESSION_CONFIG.cycling, longEvery: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ],
  ])('rejects %s', (_label: string, request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });

  it.each([
    ['zero preset', { presetsMin: [0, 25, 50] }],
    ['unsafe preset', { presetsMin: [15, Number.MAX_SAFE_INTEGER, 50] }],
    ['zero streak goal', { streakGoalMin: 0 }],
    ['unsafe streak goal', { streakGoalMin: Number.MAX_SAFE_INTEGER }],
    ['unsafe pause cap', { pause: { ...SETTINGS.pause, capMs: Number.MAX_SAFE_INTEGER + 1 } }],
    // A safe integer is not a duration: the bank cap is a relative millisecond span like every
    // other cost in this record, so nine quadrillion milliseconds is out of range.
    ['out-of-range pause cap', { pause: { ...SETTINGS.pause, capMs: 9e15 } }],
    ['unsafe pause length', { pause: { ...SETTINGS.pause, pauseMs: Number.MAX_SAFE_INTEGER + 1 } }],
    [
      'unsafe unlock length',
      { pause: { ...SETTINGS.pause, unlockMs: Number.MAX_SAFE_INTEGER + 1 } },
    ],
    ['unsafe gate delay', { gate: { ...SETTINGS.gate, delayMs: Number.MAX_SAFE_INTEGER + 1 } }],
    ['unsafe freeze cadence', { streakFreezeIntervalDays: Number.MAX_SAFE_INTEGER }],
    [
      'unsafe retention date range',
      { retentionDays: Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS) + 1 },
    ],
  ])('rejects %s', (_label: string, update: Record<string, unknown>): void => {
    expect(parseSettingsRequest(update)).toBeNull();
  });

  it('rejects a stats range whose date-day multiplication is unsafe', (): void => {
    const days: number = Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS) + 1;
    expect(parseRequest({ type: 'getStats', days })).toBeNull();
  });

  it('rejects day counts beyond the JavaScript Date range', (): void => {
    const days: number = Math.floor(DATE_MAX_MS / DAY_MS) + 1;
    expect(parseRequest({ type: 'getStats', days })).toBeNull();
    expect(parseSettingsRequest({ streakFreezeIntervalDays: days })).toBeNull();
    expect(parseSettingsRequest({ retentionDays: days })).toBeNull();
  });

  it('accepts the exact Date-range freeze cadence boundary', (): void => {
    const days: number = DATE_MAX_MS / DAY_MS;
    expect(parseSettingsRequest({ streakFreezeIntervalDays: days })).not.toBeNull();
  });

  it('accepts the exact fixed half-Date-range relative-duration cap', (): void => {
    const capMin: number = MAX_RELATIVE_DURATION_MS / MINUTE_MS;
    const config: SessionConfig = {
      ...SESSION_CONFIG,
      duration: { kind: 'timed', minutes: capMin },
      cycling: {
        focusMin: capMin,
        shortBreakMin: capMin,
        longBreakMin: capMin,
        longEvery: 1,
      },
    };
    expect(parseRequest({ type: 'startSession', config })).not.toBeNull();
    expect(
      parseSettingsRequest({
        presetsMin: [15, capMin, 50],
        defaultCycling: config.cycling,
        gate: { ...SETTINGS.gate, delayMs: MAX_RELATIVE_DURATION_MS },
        pause: {
          ...SETTINGS.pause,
          pauseMs: MAX_RELATIVE_DURATION_MS,
          unlockMs: MAX_RELATIVE_DURATION_MS,
        },
      }),
    ).not.toBeNull();
  });

  it.each([
    [
      'session duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        duration: { kind: 'timed', minutes: (MAX_RELATIVE_DURATION_MS + 1) / MINUTE_MS },
      }),
    ],
    [
      'focus duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: {
          ...SESSION_CONFIG.cycling,
          focusMin: (MAX_RELATIVE_DURATION_MS + MINUTE_MS) / MINUTE_MS,
        },
      }),
    ],
    [
      'short break duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: {
          ...SESSION_CONFIG.cycling,
          shortBreakMin: (MAX_RELATIVE_DURATION_MS + MINUTE_MS) / MINUTE_MS,
        },
      }),
    ],
    [
      'long break duration',
      replaceNested(VALID_REQUESTS.startSession, 'config', {
        cycling: {
          ...SESSION_CONFIG.cycling,
          longBreakMin: (MAX_RELATIVE_DURATION_MS + MINUTE_MS) / MINUTE_MS,
        },
      }),
    ],
  ])(
    'rejects a %s above the fixed relative-duration cap',
    (_label: string, request: unknown): void => {
      expect(parseRequest(request)).toBeNull();
    },
  );

  it.each([
    ['preset duration', { presetsMin: [15, (MAX_RELATIVE_DURATION_MS + 1) / MINUTE_MS, 50] }],
    ['gate delay', { gate: { ...SETTINGS.gate, delayMs: MAX_RELATIVE_DURATION_MS + 1 } }],
    ['pause duration', { pause: { ...SETTINGS.pause, pauseMs: MAX_RELATIVE_DURATION_MS + 1 } }],
    ['unlock duration', { pause: { ...SETTINGS.pause, unlockMs: MAX_RELATIVE_DURATION_MS + 1 } }],
  ])(
    'rejects a %s above the fixed relative-duration cap',
    (_label: string, update: Record<string, unknown>): void => {
      expect(parseSettingsRequest(update)).toBeNull();
    },
  );

  it.each([
    { custom: [{ kind: 'host', pattern: '' }] },
    { custom: [{ kind: 'host', pattern: 'not a host' }] },
    { custom: [{ kind: 'regex', pattern: '[' }] },
    { custom: [{ kind: 'unknown', pattern: 'example.com' }] },
    { custom: [{ kind: 'host', pattern: 'example.com', extra: true }] },
    { whitelist: [null] },
    { categories: { ...LISTS.categories, social: 'yes' } },
    { categories: { ...LISTS.categories, other: false } },
    { exclusions: { social: [''] } },
    { exclusions: { social: ['not a host'] } },
    { exclusions: { other: ['example.com'] } },
    { extra: true },
  ])('rejects malformed list payload fields %#', (update: Record<string, unknown>): void => {
    expect(
      parseRequest({
        type: 'updateLists',
        lists: { ...LISTS, ...update },
      }),
    ).toBeNull();
  });
});

function scheduleEntry(update: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'weekday',
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '17:00',
    duration: { kind: 'window' },
    mode: 'blacklist',
    strictness: 'hard',
    cycling: null,
    intention: '',
    enabled: true,
    ...update,
  };
}

function sparseArray(length: number, values: Record<number, unknown> = {}): unknown[] {
  const array: unknown[] = new Array<unknown>(length);
  for (const [index, value] of Object.entries(values)) {
    array[Number(index)] = value;
  }
  return array;
}

function parseSettingsRequest(update: Record<string, unknown>): Request | null {
  return parseRequest({ type: 'updateSettings', settings: { ...SETTINGS, ...update } });
}

function parseSettingsOrListsRequest(update: Record<string, unknown>): Request | null {
  return Object.hasOwn(update, 'custom')
    ? parseRequest({ type: 'updateLists', lists: { ...LISTS, ...update } })
    : parseSettingsRequest(update);
}

describe('work target requests', (): void => {
  const popupTabs: Record<string, unknown> = {
    type: 'getWorkTabs',
    mode: 'blacklist',
    windowId: 3,
  };
  it('accepts the popup listing with or without the draft rules and detaches the result', (): void => {
    expect(parseRequest(popupTabs)).toEqual(popupTabs);
    const withRules: Record<string, unknown> = { ...popupTabs, rules: rulesFromLists(LISTS) };
    const parsed: Request | null = parseRequest(withRules);
    expect(parsed).toEqual(withRules);
    expect(parsed).not.toBe(withRules);
    if (parsed?.type === 'getWorkTabs' && 'rules' in parsed)
      expect(parsed.rules).not.toBe(withRules.rules);
  });
  it('normalises session host additions in the popup listing rules', (): void => {
    const parsed: Request | null = parseRequest({
      ...popupTabs,
      rules: {
        ...rulesFromLists(LISTS),
        sessionAllowlist: [{ kind: 'host', pattern: '  HTTPS://Docs.Python.org/3/  ' }],
      },
    });
    expect(parsed).toMatchObject({
      rules: { sessionAllowlist: [{ kind: 'host', pattern: 'docs.python.org' }] },
    });
  });
  it.each([
    { ...popupTabs, mode: 'other' },
    { ...popupTabs, windowId: -1 },
    { ...popupTabs, windowId: 1.5 },
    { ...popupTabs, windowId: '3' },
    { ...popupTabs, rules: null },
    { ...popupTabs, rules: {} },
    { ...popupTabs, rules: { ...rulesFromLists(LISTS), extra: true } },
    { type: 'getWorkTabs', mode: 'blacklist' },
    { type: 'getWorkTabs', sessionId: 'not-a-uuid' },
    { type: 'getWorkTabs', sessionId: '' },
    { type: 'getWorkTabs', sessionId: WORK_SESSION_ID, windowId: 3 },
    { type: 'getWorkTabIcon', sessionId: WORK_SESSION_ID, tabId: -1 },
    { type: 'getWorkTabIcon', sessionId: WORK_SESSION_ID, tabId: 1.5 },
    { type: 'getWorkTabIcon', sessionId: WORK_SESSION_ID },
    { type: 'getWorkTabIcon', sessionId: 'session', tabId: 4 },
    { type: 'getWorkTarget', windowId: null },
    { type: 'getWorkTarget', windowId: -2 },
    { type: 'setWorkTarget', sessionId: WORK_SESSION_ID, tabId: '4' },
    { type: 'setWorkTarget', sessionId: WORK_SESSION_ID, tabId: 4, windowId: undefined },
    { type: 'setWorkTarget', sessionId: WORK_SESSION_ID, tabId: 4, windowId: Number.NaN },
    { type: 'setWorkTarget', sessionId: 'x', tabId: 4 },
    { type: 'returnToWork', sessionId: WORK_SESSION_ID, windowId: '1' },
    { type: 'returnToWork', sessionId: 7 },
    { type: 'returnToWork' },
  ])('rejects the malformed work target request %#', (request: unknown): void => {
    expect(parseRequest(request)).toBeNull();
  });
  it('accepts the optional popup window on the shared requests', (): void => {
    for (const request of [
      { type: 'getWorkTarget', windowId: 0 },
      { type: 'setWorkTarget', sessionId: WORK_SESSION_ID, tabId: 4, windowId: 2 },
      { type: 'returnToWork', sessionId: WORK_SESSION_ID, windowId: 2 },
    ]) {
      const parsed: Request | null = parseRequest(request);
      expect(parsed).toEqual(request);
      expect(parsed).not.toBe(request);
    }
  });
  it('rejects accessor-backed fields without invoking their getters', (): void => {
    for (const type of ['getWorkTabs', 'getWorkTabIcon', 'setWorkTarget', 'returnToWork']) {
      let getterCalls: number = 0;
      const request: Record<string, unknown> = { type, tabId: 4 };
      Object.defineProperty(request, 'sessionId', {
        enumerable: true,
        get: (): string => {
          getterCalls += 1;
          return WORK_SESSION_ID;
        },
      });
      expect(parseRequest(request)).toBeNull();
      expect(getterCalls).toBe(0);
    }
    const revocable: { proxy: object; revoke: () => void } = Proxy.revocable<object>({}, {});
    revocable.revoke();
    expect(
      parseRequest({ type: 'getWorkTabs', mode: 'blacklist', windowId: 1, rules: revocable.proxy }),
    ).toBeNull();
  });
});
