import { describe, expect, it } from 'vitest';
import type { RuntimePortsV2 } from '../../../src/background/runtime-ports-v2';
import type {
  RuntimeStateV2,
  SessionStartCandidate,
} from '../../../src/background/runtime-v2-types';
import {
  nextScheduleInfoV2,
  pruneHandledOccurrencesOnTickV2,
  runScheduleCheckV2,
  type ScheduleRunnerPortsV2,
  scheduleWindowBody,
} from '../../../src/background/schedule-runner-v2';
import {
  localStartDateForV2,
  type ResolvedScheduleOccurrenceV2,
  resolveOpenScheduleOccurrencesV2,
  scheduleOccurrenceTokenV2,
} from '../../../src/core/schedule-v2';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../../src/shared/constants';
import { CoreError } from '../../../src/shared/errors';
import { t } from '../../../src/shared/i18n';
import {
  SCHEDULE_STARTED_TITLE,
  SCHEDULE_UNTIL_STOPPED_BODY,
} from '../../../src/shared/session-copy';
import type {
  HandledScheduleOccurrence,
  ListsConfig,
  ScheduleEntryV2,
  SettingsV2,
} from '../../../src/shared/types';
import { createRuntimePortsFakeV2, type RuntimePortsFakeV2 } from './runtime-ports-fake';
import {
  ACTIVE_OPERATION_ID,
  CLEANUP_OPERATION_ID,
  emptyRuntimeV2,
  handledOccurrence,
  OTHER_OPERATION_ID,
  pendingTransition,
  preparedClosure,
  SESSION_ID,
  STARTING_OPERATION_ID,
  TRANSITION_ID,
  timedFocusSession,
} from './runtime-v2-fixtures';

interface ScheduleHarness {
  ports: RuntimePortsFakeV2;
  schedule: ScheduleRunnerPortsV2;
  notices: Array<{ title: string; body: string }>;
  sounds: string[];
}

/** The four IDs preparation reserves, then the two a cleanup batch would take. */
const IDS: readonly string[] = [
  SESSION_ID,
  TRANSITION_ID,
  STARTING_OPERATION_ID,
  ACTIVE_OPERATION_ID,
  CLEANUP_OPERATION_ID,
  OTHER_OPERATION_ID,
];
const DAY_MS: number = 86_400_000;
const MINUTE_MS: number = 60_000;
const RETENTION_MS: number = 14 * DAY_MS;
const ENTRY_ID: string = 'weekday';
const OTHER_ENTRY_ID: string = 'evening';
/** Local 2026-09-03 09:30, inside a 09:00 to 17:00 window on that weekday. */
const NOW: number = new Date(2026, 8, 3, 9, 30, 0, 0).getTime();
const LOCAL_DATE: string = '2026-09-03';
const WINDOW_STARTS_AT: number = new Date(2026, 8, 3, 9, 0, 0, 0).getTime();
const WINDOW_ENDS_AT: number = new Date(2026, 8, 3, 17, 0, 0, 0).getTime();
const TOKEN: string = `${ENTRY_ID}@${LOCAL_DATE}`;
const UNAVAILABLE_TITLE: string = t('notify_schedule_unavailable_title');

function everyDay(): number[] {
  return [0, 1, 2, 3, 4, 5, 6];
}

function windowEntry(overrides: Partial<ScheduleEntryV2> = {}): ScheduleEntryV2 {
  return {
    id: ENTRY_ID,
    days: everyDay(),
    start: '09:00',
    end: '17:00',
    duration: { kind: 'window' },
    mode: 'blacklist',
    strictness: 'friction',
    cycling: null,
    intention: 'Ship the release',
    enabled: true,
    ...overrides,
  };
}

function untilStoppedEntry(overrides: Partial<ScheduleEntryV2> = {}): ScheduleEntryV2 {
  return windowEntry({
    duration: { kind: 'until-stopped' },
    // Stored cycling that an indefinite session may not carry. The type it stores is kept.
    strictness: 'friction',
    cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    ...overrides,
  });
}

function settingsWith(entries: readonly ScheduleEntryV2[]): SettingsV2 {
  return { ...DEFAULT_SETTINGS, schedule: [...entries] };
}

function harness(
  runtime: RuntimeStateV2,
  entries: readonly ScheduleEntryV2[] = [windowEntry()],
  options: {
    websiteBlockingReady?: boolean;
    now?: number;
    audit?: 'ready' | 'website-access-lost' | 'content-registration-failed';
    lists?: ListsConfig;
  } = {},
): ScheduleHarness {
  const notices: Array<{ title: string; body: string }> = [];
  const sounds: string[] = [];
  const ports: RuntimePortsFakeV2 = createRuntimePortsFakeV2(runtime, {
    now: options.now ?? NOW,
    ids: [...IDS],
    tabs: [],
    audit: options.audit ?? 'ready',
  });
  const schedule: ScheduleRunnerPortsV2 = {
    settings: (): SettingsV2 => settingsWith(entries),
    lists: (): ListsConfig => options.lists ?? DEFAULT_LISTS,
    websiteBlockingReady: (): boolean => options.websiteBlockingReady ?? true,
    notify: (title: string, body: string): void => {
      notices.push({ title, body });
    },
    playSound: (sound: 'scheduleStart'): void => {
      sounds.push(sound);
    },
  };
  return { ports, schedule, notices, sounds };
}

function idleRuntime(overrides: Partial<RuntimeStateV2> = {}): RuntimeStateV2 {
  return emptyRuntimeV2({ runtimeRevision: 0, date: LOCAL_DATE, ...overrides });
}

function handledFor(
  token: string,
  overrides: Partial<HandledScheduleOccurrence> = {},
): HandledScheduleOccurrence {
  const [entryId, localStartDate]: string[] = token.split('@');
  return handledOccurrence({
    token,
    entryId: entryId ?? ENTRY_ID,
    localStartDate: localStartDate ?? LOCAL_DATE,
    handledAt: NOW - MINUTE_MS,
    reason: 'started',
    expiresAt: NOW - MINUTE_MS + RETENTION_MS,
    ...overrides,
  });
}

/** The candidate the runner prepared, read from the first durable write it made. */
function preparedCandidate(ports: RuntimePortsFakeV2): SessionStartCandidate {
  const candidate: SessionStartCandidate | null | undefined =
    ports.writes[0]?.pendingEnforcementTransition?.candidate;
  expect(candidate).toBeDefined();
  if (candidate === null || candidate === undefined) {
    throw new Error('expected the schedule check to prepare a start candidate');
  }
  return candidate;
}

describe('schedule check guards', (): void => {
  it('does nothing while a session, transition, or closure exists', async (): Promise<void> => {
    const busy: readonly RuntimeStateV2[] = [
      idleRuntime({ session: timedFocusSession(), basePolicyRevision: 1, runtimeRevision: 1 }),
      idleRuntime({
        pendingEnforcementTransition: pendingTransition('start', 'prepared'),
        basePolicyRevision: 3,
        runtimeRevision: 0,
      }),
      idleRuntime({
        session: timedFocusSession(),
        pendingClosure: preparedClosure(),
        basePolicyRevision: 1,
        runtimeRevision: 1,
      }),
    ];

    for (const runtime of busy) {
      const test: ScheduleHarness = harness(runtime, [windowEntry({ strictness: 'hard' })]);

      const result: { runtime: RuntimeStateV2; started: boolean } = await runScheduleCheckV2(
        test.ports,
        test.schedule,
      );

      expect(result.started).toBe(false);
      expect(result.runtime).toEqual(runtime);
      expect(test.ports.writes).toHaveLength(0);
      expect(test.notices).toEqual([]);
      expect(test.sounds).toEqual([]);
    }
  });

  it('writes the notice over the runtime as it stands, not the one the check read', async (): Promise<void> => {
    // The notice write used the runtime the check read at its start. Nothing awaits between those
    // two points today, so the copy is current and the write is safe by that absence rather than
    // by construction: the day an await appears in between, this write silently reverts whatever
    // landed in the gap, including fields a commit checkpoint is describing.
    const test: ScheduleHarness = harness(idleRuntime({ scheduleUnavailableNoticeToken: TOKEN }), [
      windowEntry({ enabled: false }),
    ]);
    const drifted: RuntimeStateV2 = { ...test.ports.current(), accruedFocusMs: 5_000 };
    let reads: number = 0;
    const ports: RuntimePortsV2 = {
      ...test.ports,
      runtime: (): RuntimeStateV2 => {
        reads += 1;
        return reads === 1 ? test.ports.current() : drifted;
      },
    };

    await runScheduleCheckV2(ports, test.schedule);

    expect(test.ports.current().scheduleUnavailableNoticeToken).toBeNull();
    expect(test.ports.current().accruedFocusMs).toBe(5_000);
  });

  it('never rewrites a committed session config when a stronger entry opens', async (): Promise<void> => {
    const session: RuntimeStateV2 = idleRuntime({
      session: timedFocusSession(),
      basePolicyRevision: 1,
      runtimeRevision: 1,
    });
    const test: ScheduleHarness = harness(session, [
      windowEntry({ strictness: 'hard', mode: 'whitelist' }),
    ]);

    await runScheduleCheckV2(test.ports, test.schedule);

    expect(test.ports.current().session?.config).toEqual(session.session?.config);
    expect(test.ports.writes).toHaveLength(0);
  });

  it('clears a stale unavailable notice when no candidate is open', async (): Promise<void> => {
    const stale: ScheduleHarness = harness(idleRuntime({ scheduleUnavailableNoticeToken: TOKEN }), [
      windowEntry({ enabled: false }),
    ]);

    const result: { runtime: RuntimeStateV2; started: boolean } = await runScheduleCheckV2(
      stale.ports,
      stale.schedule,
    );

    expect(result.started).toBe(false);
    expect(result.runtime.scheduleUnavailableNoticeToken).toBeNull();
    expect(stale.ports.writes).toHaveLength(1);

    const quiet: ScheduleHarness = harness(idleRuntime(), [windowEntry({ enabled: false })]);
    await runScheduleCheckV2(quiet.ports, quiet.schedule);

    expect(quiet.ports.writes).toHaveLength(0);
  });
});

describe('schedule check without website blocking', (): void => {
  it('notifies once per occurrence token and starts nothing', async (): Promise<void> => {
    const test: ScheduleHarness = harness(idleRuntime(), [windowEntry()], {
      websiteBlockingReady: false,
    });

    const first: { started: boolean } = await runScheduleCheckV2(test.ports, test.schedule);
    const second: { started: boolean } = await runScheduleCheckV2(test.ports, test.schedule);

    expect(first.started).toBe(false);
    expect(second.started).toBe(false);
    expect(test.notices).toHaveLength(1);
    expect(test.notices[0]?.title).toBe(UNAVAILABLE_TITLE);
    expect(test.ports.current().scheduleUnavailableNoticeToken).toBe(TOKEN);
    expect(test.ports.writes).toHaveLength(1);
    expect(test.ports.current().session).toBeNull();
  });

  it('notifies again for a different occurrence token', async (): Promise<void> => {
    const test: ScheduleHarness = harness(
      idleRuntime({ scheduleUnavailableNoticeToken: `${ENTRY_ID}@2026-09-02` }),
      [windowEntry()],
      { websiteBlockingReady: false },
    );

    await runScheduleCheckV2(test.ports, test.schedule);

    expect(test.notices).toHaveLength(1);
    expect(test.ports.current().scheduleUnavailableNoticeToken).toBe(TOKEN);
  });
});

describe('schedule start', (): void => {
  it('builds a window candidate from the entry and the captured bounds', async (): Promise<void> => {
    const test: ScheduleHarness = harness(idleRuntime());

    const result: { started: boolean } = await runScheduleCheckV2(test.ports, test.schedule);

    expect(result.started).toBe(true);
    expect(preparedCandidate(test.ports)).toEqual({
      mode: 'blacklist',
      strictness: 'friction',
      duration: { kind: 'schedule-window' },
      cycling: null,
      intention: 'Ship the release',
      source: 'schedule',
      scheduleOccurrence: {
        version: 1,
        token: TOKEN,
        entryId: ENTRY_ID,
        localStartDate: LOCAL_DATE,
      },
      scheduleWindow: { windowStartsAt: WINDOW_STARTS_AT, windowEndsAt: WINDOW_ENDS_AT },
      rules: rulesFromLists(DEFAULT_LISTS),
    });
    expect(test.ports.writes[0]?.pendingEnforcementTransition?.trigger).toBe('schedule');
  });

  it('keeps the session type of an indefinite entry and turns cycling off', async (): Promise<void> => {
    const test: ScheduleHarness = harness(idleRuntime(), [untilStoppedEntry()]);

    await runScheduleCheckV2(test.ports, test.schedule);
    const candidate: SessionStartCandidate = preparedCandidate(test.ports);

    expect(candidate.duration).toEqual({ kind: 'until-stopped' });
    expect(candidate.strictness).toBe('friction');
    expect(candidate.cycling).toBeNull();
    expect(candidate.scheduleWindow).toEqual({
      windowStartsAt: WINDOW_STARTS_AT,
      windowEndsAt: WINDOW_ENDS_AT,
    });
  });

  it('plays the schedule sound and notifies with the window body', async (): Promise<void> => {
    const test: ScheduleHarness = harness(idleRuntime());

    const result: { started: boolean } = await runScheduleCheckV2(test.ports, test.schedule);

    expect(result.started).toBe(true);
    expect(test.sounds).toEqual(['scheduleStart']);
    expect(test.notices).toEqual([
      { title: SCHEDULE_STARTED_TITLE, body: scheduleWindowBody(windowEntry()) },
    ]);
    expect(scheduleWindowBody(windowEntry())).toBe('Locked until 17:00.');
  });

  it('notifies with the indefinite body for an until-stopped entry', async (): Promise<void> => {
    const test: ScheduleHarness = harness(idleRuntime(), [untilStoppedEntry()]);

    await runScheduleCheckV2(test.ports, test.schedule);

    expect(test.notices).toEqual([
      { title: SCHEDULE_STARTED_TITLE, body: SCHEDULE_UNTIL_STOPPED_BODY },
    ]);
  });

  it('announces nothing when the start falls into cleanup', async (): Promise<void> => {
    const test: ScheduleHarness = harness(idleRuntime(), [windowEntry()], {
      audit: 'website-access-lost',
    });

    const result: { runtime: RuntimeStateV2; started: boolean } = await runScheduleCheckV2(
      test.ports,
      test.schedule,
    );

    expect(result.started).toBe(false);
    expect(result.runtime.pendingEnforcementTransition?.stage).toBe('cleanup');
    expect(test.sounds).toEqual([]);
    expect(test.notices).toEqual([]);
  });

  it('clears the unavailable notice when the same window starts', async (): Promise<void> => {
    const test: ScheduleHarness = harness(idleRuntime({ scheduleUnavailableNoticeToken: TOKEN }));

    const result: { runtime: RuntimeStateV2; started: boolean } = await runScheduleCheckV2(
      test.ports,
      test.schedule,
    );

    expect(result.started).toBe(true);
    expect(result.runtime.scheduleUnavailableNoticeToken).toBeNull();
  });

  /**
   * The Settings editor stores what the user typed, so a capitalized host or a trailing root dot
   * reaches the schedule runner verbatim. The runtime validator only accepts the normalized form,
   * so before the producer canonicalized, this start threw out of every tick forever.
   */
  it('starts over a stored list carrying a capitalized host and a trailing dot', async (): Promise<void> => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [
        { kind: 'host', pattern: 'Facebook.com' },
        { kind: 'host', pattern: 'news.example.com.' },
      ],
      whitelist: [{ kind: 'host', pattern: 'Docs.Example.com' }],
    };
    const test: ScheduleHarness = harness(idleRuntime(), [windowEntry()], { lists });

    const result: { runtime: RuntimeStateV2; started: boolean } = await runScheduleCheckV2(
      test.ports,
      test.schedule,
    );

    expect(result.started).toBe(true);
    expect(result.runtime.session?.config.rules.permanentBlacklist).toEqual([
      { kind: 'host', pattern: 'facebook.com' },
      { kind: 'host', pattern: 'news.example.com' },
    ]);
    expect(result.runtime.session?.config.rules.permanentAllowlist).toEqual([
      { kind: 'host', pattern: 'docs.example.com' },
    ]);
    expect(preparedCandidate(test.ports).rules).toEqual(rulesFromLists(lists));
    expect(test.notices).toEqual([
      { title: SCHEDULE_STARTED_TITLE, body: scheduleWindowBody(windowEntry()) },
    ]);
  });
});

describe('handled occurrence suppression', (): void => {
  it('never selects a live handled token, whatever handled it', async (): Promise<void> => {
    for (const reason of ['started', 'closure-overlap'] as const) {
      const test: ScheduleHarness = harness(
        idleRuntime({ handledScheduleOccurrences: [handledFor(TOKEN, { reason })] }),
      );

      const result: { started: boolean } = await runScheduleCheckV2(test.ports, test.schedule);

      expect(result.started).toBe(false);
      expect(test.ports.writes).toHaveLength(0);
      expect(test.notices).toEqual([]);
    }
  });

  it('selects an occurrence whose handled record has expired', async (): Promise<void> => {
    const expired: HandledScheduleOccurrence = handledFor(TOKEN, {
      handledAt: NOW - RETENTION_MS - MINUTE_MS,
      expiresAt: NOW - MINUTE_MS,
    });
    const test: ScheduleHarness = harness(idleRuntime({ handledScheduleOccurrences: [expired] }));

    const result: { started: boolean } = await runScheduleCheckV2(test.ports, test.schedule);

    expect(result.started).toBe(true);
  });

  it('keeps a handled record when its entry is edited or deleted', async (): Promise<void> => {
    const handled: HandledScheduleOccurrence[] = [handledFor(TOKEN)];
    const deleted: ScheduleHarness = harness(
      idleRuntime({ handledScheduleOccurrences: handled }),
      [],
    );

    const result: { runtime: RuntimeStateV2 } = await runScheduleCheckV2(
      deleted.ports,
      deleted.schedule,
    );

    expect(result.runtime.handledScheduleOccurrences).toEqual(handled);

    const reused: ScheduleHarness = harness(idleRuntime({ handledScheduleOccurrences: handled }), [
      windowEntry({ strictness: 'hard', intention: 'Rewritten entry' }),
    ]);
    const after: { started: boolean } = await runScheduleCheckV2(reused.ports, reused.schedule);

    expect(after.started).toBe(false);
    expect(reused.ports.current().handledScheduleOccurrences).toEqual(handled);
  });

  it('does not restart a window whose transition is still committed', async (): Promise<void> => {
    const committed: ScheduleHarness = harness(
      idleRuntime({
        session: timedFocusSession(),
        pendingEnforcementTransition: pendingTransition('start', 'committed-pending-verification'),
        basePolicyRevision: 4,
        runtimeRevision: 1,
      }),
    );

    const during: { started: boolean } = await runScheduleCheckV2(
      committed.ports,
      committed.schedule,
    );

    expect(during.started).toBe(false);
    expect(committed.ports.writes).toHaveLength(0);

    const closed: ScheduleHarness = harness(
      idleRuntime({ handledScheduleOccurrences: [handledFor(TOKEN)] }),
    );
    const after: { started: boolean } = await runScheduleCheckV2(closed.ports, closed.schedule);

    expect(after.started).toBe(false);
  });
});

describe('next schedule read model', (): void => {
  it('reports the earliest future start of an enabled entry', (): void => {
    const info: { entryId: string; startsAt: number } | null = nextScheduleInfoV2(
      [
        windowEntry({ id: OTHER_ENTRY_ID, start: '20:00', end: '22:00' }),
        windowEntry({ start: '11:00', end: '12:00' }),
        windowEntry({ id: 'disabled', start: '10:00', end: '10:30', enabled: false }),
      ],
      [],
      NOW,
    );

    expect(info).toEqual({
      entryId: ENTRY_ID,
      startsAt: new Date(2026, 8, 3, 11, 0, 0, 0).getTime(),
    });
  });

  it('skips a live handled occurrence and reports the following start', (): void => {
    const tomorrow: number = new Date(2026, 8, 4, 9, 0, 0, 0).getTime();
    const entries: readonly ScheduleEntryV2[] = [windowEntry({ start: '09:00', end: '17:00' })];
    const beforeStart: number = new Date(2026, 8, 3, 8, 0, 0, 0).getTime();

    expect(nextScheduleInfoV2(entries, [handledFor(TOKEN)], beforeStart)).toEqual({
      entryId: ENTRY_ID,
      startsAt: tomorrow,
    });
    expect(
      nextScheduleInfoV2(
        entries,
        [handledFor(TOKEN, { handledAt: 0, expiresAt: beforeStart - 1 })],
        beforeStart,
      ),
    ).toEqual({ entryId: ENTRY_ID, startsAt: WINDOW_STARTS_AT });
  });

  it('derives the same token the resolver stores for that start', (): void => {
    const entries: readonly ScheduleEntryV2[] = [windowEntry({ start: '09:00', end: '17:00' })];
    const beforeStart: number = new Date(2026, 8, 3, 8, 0, 0, 0).getTime();
    // The handled record comes from the resolver itself, so this compares the runner's derived
    // token with a stored one instead of two copies of a hand-built constant.
    const resolved: readonly ResolvedScheduleOccurrenceV2[] = resolveOpenScheduleOccurrencesV2(
      entries,
      NOW,
    );
    const stored: string | undefined = resolved[0]?.occurrence.token;

    expect(stored).toBeDefined();
    expect(nextScheduleInfoV2(entries, [handledFor(stored ?? '')], beforeStart)).toEqual({
      entryId: ENTRY_ID,
      startsAt: new Date(2026, 8, 4, 9, 0, 0, 0).getTime(),
    });
  });

  it('skips two consecutive handled starts and reports the third', (): void => {
    const entries: readonly ScheduleEntryV2[] = [windowEntry({ start: '09:00', end: '17:00' })];
    const beforeStart: number = new Date(2026, 8, 3, 8, 0, 0, 0).getTime();
    const first: string = scheduleOccurrenceTokenV2(
      ENTRY_ID,
      localStartDateForV2(WINDOW_STARTS_AT),
    );
    const second: string = scheduleOccurrenceTokenV2(
      ENTRY_ID,
      localStartDateForV2(WINDOW_STARTS_AT + DAY_MS),
    );

    expect(
      nextScheduleInfoV2(entries, [handledFor(first), handledFor(second)], beforeStart),
    ).toEqual({
      entryId: ENTRY_ID,
      startsAt: new Date(2026, 8, 5, 9, 0, 0, 0).getTime(),
    });
  });

  it('reports nothing when no entry is enabled', (): void => {
    expect(nextScheduleInfoV2([windowEntry({ enabled: false })], [], NOW)).toBeNull();
    expect(nextScheduleInfoV2([], [], NOW)).toBeNull();
  });
});

describe('handled occurrence pruning on the tick', (): void => {
  it('drops expired records and keeps the same runtime when nothing changed', (): void => {
    const live: HandledScheduleOccurrence = handledFor(TOKEN);
    const expired: HandledScheduleOccurrence = handledFor(`${OTHER_ENTRY_ID}@2026-08-01`, {
      handledAt: NOW - RETENTION_MS - DAY_MS,
      expiresAt: NOW - DAY_MS,
    });
    const runtime: RuntimeStateV2 = idleRuntime({
      handledScheduleOccurrences: [expired, live],
    });

    const pruned: RuntimeStateV2 = pruneHandledOccurrencesOnTickV2(runtime, NOW);

    expect(pruned.handledScheduleOccurrences).toEqual([live]);
    expect(pruned).not.toBe(runtime);
    expect(pruneHandledOccurrencesOnTickV2(pruned, NOW)).toBe(pruned);
    // An empty runtime returns the same object rather than an equal one, which is the claim worth
    // making: pruning nothing must not allocate. Asserting it equalled a fresh `idleRuntime()`
    // could not fail for any implementation, because both sides held no occurrences either way.
    const empty: RuntimeStateV2 = idleRuntime();
    expect(pruneHandledOccurrencesOnTickV2(empty, NOW)).toBe(empty);
  });
});

describe('schedule check hostile settings', (): void => {
  it('refuses two open candidates that share one occurrence token', async (): Promise<void> => {
    const test: ScheduleHarness = harness(idleRuntime(), [windowEntry(), windowEntry()]);

    await expect(runScheduleCheckV2(test.ports, test.schedule)).rejects.toThrow(CoreError);
    expect(test.ports.writes).toHaveLength(0);
    expect(test.notices).toEqual([]);
  });
});
