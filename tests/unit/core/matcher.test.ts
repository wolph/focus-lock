import { describe, expect, it, vi } from 'vitest';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import {
  buildMatcherCache,
  compileMatcher,
  compileSessionMatcher,
  evaluateUrl,
  listsFromSessionRules,
  normalizeSessionHostInput,
  normalizeStoredSessionRules,
  registrableHost,
  restoreMatcherCache,
  validateRule,
} from '../../../src/core/matcher';
import { DEFAULT_LISTS, rulesFromLists } from '../../../src/shared/constants';
import { validateDetachedVerdict } from '../../../src/shared/enforcement-v2-validation';
import type {
  CategoryList,
  ListsConfig,
  Rule,
  SessionRuleSnapshot,
  SiteUnlock,
  Verdict,
} from '../../../src/shared/types';

const CATS: CategoryList[] = [{ id: 'social', title: 'Social', hosts: ['facebook.com', 'x.com'] }];

function lists(partial: Partial<ListsConfig>): ListsConfig {
  return { ...DEFAULT_LISTS, categories: { ...DEFAULT_LISTS.categories }, ...partial };
}

const NOW = 1_000_000;
const NONE: SiteUnlock[] = [];

describe('host rules', () => {
  const m = compileMatcher(
    lists({ custom: [{ kind: 'host', pattern: 'reddit.com' }] }),
    [],
    'blacklist',
  );
  it('blocks the domain and all subdomains', () => {
    expect(evaluateUrl(m, 'https://reddit.com/r/all', NONE, NOW).blocked).toBe(true);
    expect(evaluateUrl(m, 'https://old.reddit.com/', NONE, NOW).blocked).toBe(true);
  });
  it('does not match substrings or other hosts', () => {
    expect(evaluateUrl(m, 'https://notreddit.com/', NONE, NOW).blocked).toBe(false);
    expect(evaluateUrl(m, 'https://reddit.com.evil.example/', NONE, NOW).blocked).toBe(false);
  });
  it('ignores ports and case', () => {
    expect(evaluateUrl(m, 'https://REDDIT.com:8443/x', NONE, NOW).blocked).toBe(true);
  });
  it('a subdomain rule blocks only its subtree', () => {
    const sub = compileMatcher(
      lists({ custom: [{ kind: 'host', pattern: 'news.ycombinator.com' }] }),
      [],
      'blacklist',
    );
    expect(evaluateUrl(sub, 'https://news.ycombinator.com/item?id=1', NONE, NOW).blocked).toBe(
      true,
    );
    expect(evaluateUrl(sub, 'https://ycombinator.com/', NONE, NOW).blocked).toBe(false);
  });

  it('treats Unicode and punycode spellings as the same IDN host', () => {
    const idn = compileMatcher(
      lists({ custom: [{ kind: 'host', pattern: 'xn--bcher-kva.example' }] }),
      [],
      'blacklist',
    );

    expect(evaluateUrl(idn, 'https://bücher.example/catalog', NONE, NOW)).toEqual({
      blocked: true,
      reason: 'custom',
      categoryId: null,
      matchedPattern: 'xn--bcher-kva.example',
    });
    expect(evaluateUrl(idn, 'https://xn--bcher-kva.example/catalog', NONE, NOW).blocked).toBe(true);
  });

  it('does not confuse an IDN rule with a prefixed or Unicode-lookalike host', () => {
    const idn = compileMatcher(
      lists({ custom: [{ kind: 'host', pattern: 'bücher.example' }] }),
      [],
      'blacklist',
    );

    expect(evaluateUrl(idn, 'https://bücher.example/catalog', NONE, NOW).blocked).toBe(true);
    expect(evaluateUrl(idn, 'https://xn--bcher-kva.example/catalog', NONE, NOW).blocked).toBe(true);
    expect(evaluateUrl(idn, 'https://notbücher.example/', NONE, NOW).blocked).toBe(false);
    expect(evaluateUrl(idn, 'https://bӵcher.example/', NONE, NOW).blocked).toBe(false);
  });

  it.each(['BÜCHER.EXAMPLE', 'xn--bcher-kva.example', 'xn--bcher-kva.example.'])(
    'normalizes the %s spelling before matching',
    (pattern: string): void => {
      const idn: ReturnType<typeof compileMatcher> = compileMatcher(
        lists({ custom: [{ kind: 'host', pattern }] }),
        [],
        'blacklist',
      );

      expect(evaluateUrl(idn, 'https://bücher.example./catalog', NONE, NOW)).toEqual({
        blocked: true,
        reason: 'custom',
        categoryId: null,
        matchedPattern: 'xn--bcher-kva.example',
      });
    },
  );
});

describe('regex rules', () => {
  const m = compileMatcher(
    lists({ custom: [{ kind: 'regex', pattern: 'youtube\\.com/shorts' }] }),
    [],
    'blacklist',
  );
  it('matches against the full URL, case-insensitive', () => {
    expect(evaluateUrl(m, 'https://www.youtube.com/shorts/abc', NONE, NOW).blocked).toBe(true);
    expect(evaluateUrl(m, 'https://www.youtube.com/watch?v=abc', NONE, NOW).blocked).toBe(false);
  });

  it('skips nested repetition and finishes a catastrophic probe quickly', () => {
    const bad = compileMatcher(
      lists({
        custom: [
          { kind: 'regex', pattern: '(.*\\.)*reddit\\.com' },
          { kind: 'regex', pattern: '(www\\.)?reddit\\.com/r/(all|popular)' },
        ],
      }),
      [],
      'blacklist',
    );
    expect(bad.regexes.map((r) => r.source)).toEqual(['(www\\.)?reddit\\.com/r/(all|popular)']);
    const url: string = `https://${'a.'.repeat(24)}example.org/`;
    const start: number = performance.now();
    expect(evaluateUrl(bad, url, NONE, NOW).blocked).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
    expect(evaluateUrl(bad, 'https://www.reddit.com/r/all', NONE, NOW).blocked).toBe(true);
  });

  it('tests regexes against at most the first 256 characters of the URL', () => {
    const slow = compileMatcher(
      lists({ custom: [{ kind: 'regex', pattern: 'a.*a.*b' }] }),
      [],
      'blacklist',
    );
    const start: number = performance.now();
    evaluateUrl(slow, `https://example.org/${'a'.repeat(4000)}`, NONE, NOW);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('categories and exclusions', () => {
  const m = compileMatcher(
    lists({
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: { social: ['facebook.com'] },
    }),
    CATS,
    'blacklist',
  );
  it('blocks enabled category entries with reason category', () => {
    const v = evaluateUrl(m, 'https://x.com/home', NONE, NOW);
    expect(m.hosts.get('x.com')).toEqual({ via: 'category', categoryId: 'social' });
    expect(v).toEqual({
      blocked: true,
      reason: 'category',
      categoryId: 'social',
      matchedPattern: 'x.com',
    });
  });
  it('excluded entries are allowed, subdomains included', () => {
    expect(evaluateUrl(m, 'https://www.facebook.com/work', NONE, NOW).reason).toBe('excluded');
  });

  it('lets an exact custom host rule override a category exception', (): void => {
    const matcher = compileMatcher(
      lists({
        categories: { ...DEFAULT_LISTS.categories, social: true },
        exclusions: { social: ['facebook.com'] },
        custom: [{ kind: 'host', pattern: 'facebook.com' }],
      }),
      CATS,
      'blacklist',
    );

    expect(evaluateUrl(matcher, 'https://www.facebook.com/work', NONE, NOW)).toEqual({
      blocked: true,
      reason: 'custom',
      categoryId: null,
      matchedPattern: 'facebook.com',
    });
  });

  it('lets a matching custom regex override a category exception only for matching URLs', (): void => {
    const pattern: string = '^https://(?:www\\.)?facebook\\.com/private';
    const matcher = compileMatcher(
      lists({
        categories: { ...DEFAULT_LISTS.categories, social: true },
        exclusions: { social: ['facebook.com'] },
        custom: [{ kind: 'regex', pattern }],
      }),
      CATS,
      'blacklist',
    );

    expect(evaluateUrl(matcher, 'https://www.facebook.com/private/report', NONE, NOW)).toEqual({
      blocked: true,
      reason: 'custom',
      categoryId: null,
      matchedPattern: pattern,
    });
    expect(evaluateUrl(matcher, 'https://www.facebook.com/work', NONE, NOW).reason).toBe(
      'excluded',
    );
  });

  it.each(['BÜCHER.EXAMPLE', 'xn--bcher-kva.example', 'xn--bcher-kva.example.'])(
    'normalizes the %s spelling before applying category exclusions',
    (excludedHost: string): void => {
      const idnCategories: CategoryList[] = [
        { id: 'social', title: 'Social', hosts: ['bücher.example'] },
      ];
      const matcher: ReturnType<typeof compileMatcher> = compileMatcher(
        lists({
          categories: { ...DEFAULT_LISTS.categories, social: true },
          exclusions: { social: [excludedHost] },
        }),
        idnCategories,
        'blacklist',
      );

      expect(evaluateUrl(matcher, 'https://xn--bcher-kva.example./work', NONE, NOW).reason).toBe(
        'excluded',
      );
    },
  );
});

describe('session-local rule snapshots', (): void => {
  it('accepts only the exact stored predecessor and copies its categories into the baseline', (): void => {
    const current: SessionRuleSnapshot = {
      ...rulesFromLists(DEFAULT_LISTS),
      sessionBlacklist: [{ kind: 'host', pattern: 'session-only.example' }],
    };
    const predecessor: Record<string, unknown> = structuredClone(current) as unknown as Record<
      string,
      unknown
    >;
    delete predecessor.baselineCategories;

    expect(normalizeStoredSessionRules(predecessor)).toEqual({
      ...current,
      baselineCategories: current.categories,
    });
    expect(normalizeStoredSessionRules({ ...predecessor, unexpected: true })).toBeNull();
    expect(
      normalizeStoredSessionRules({
        ...predecessor,
        categories: { ...current.categories, social: 'yes' },
      }),
    ).toBeNull();
  });

  it.each(['\n', '\t', '\r', '\v', '\f'])(
    'rejects leading and trailing %j controls before trimming',
    (control: string): void => {
      expect(normalizeSessionHostInput(`${control}docs.python.org`)).toBeNull();
      expect(normalizeSessionHostInput(`docs.python.org${control}`)).toBeNull();
    },
  );

  it('converts an isolated snapshot into permanent and session list rules', (): void => {
    const rules: SessionRuleSnapshot = {
      ...rulesFromLists({
        ...DEFAULT_LISTS,
        custom: [{ kind: 'host', pattern: 'permanent-block.example' }],
        whitelist: [{ kind: 'host', pattern: 'permanent-allow.example' }],
      }),
      sessionBlacklist: [{ kind: 'host', pattern: 'session-block.example' }],
      sessionAllowlist: [{ kind: 'host', pattern: 'session-allow.example' }],
    };

    expect(listsFromSessionRules(rules)).toEqual({
      custom: [
        { kind: 'host', pattern: 'permanent-block.example' },
        { kind: 'host', pattern: 'session-block.example' },
      ],
      whitelist: [
        { kind: 'host', pattern: 'permanent-allow.example' },
        { kind: 'host', pattern: 'session-allow.example' },
      ],
      categories: DEFAULT_LISTS.categories,
      exclusions: {},
    });
  });

  it('compiles category exceptions from the session snapshot', (): void => {
    const rules: SessionRuleSnapshot = {
      ...rulesFromLists({
        ...DEFAULT_LISTS,
        categories: { ...DEFAULT_LISTS.categories, social: true },
        exclusions: { social: ['facebook.com'] },
      }),
      sessionBlacklist: [],
    };
    const matcher = compileSessionMatcher(rules, CATS, 'blacklist');

    expect(evaluateUrl(matcher, 'https://facebook.com/work', NONE, NOW).reason).toBe('excluded');
    expect(evaluateUrl(matcher, 'https://x.com/home', NONE, NOW).reason).toBe('category');
  });

  it('compiles a session-added whitelist host without mutating the snapshot', (): void => {
    const rules: SessionRuleSnapshot = {
      ...rulesFromLists(DEFAULT_LISTS),
      sessionAllowlist: [{ kind: 'host', pattern: 'docs.python.org' }],
    };
    const before: SessionRuleSnapshot = structuredClone(rules);
    const matcher = compileSessionMatcher(rules, CATS, 'whitelist');

    expect(matcher.hosts.has('docs.python.org')).toBe(true);
    expect(evaluateUrl(matcher, 'https://docs.python.org/3/', NONE, NOW).blocked).toBe(false);
    expect(rules).toEqual(before);
  });
});

describe('custom-list block provenance', () => {
  const SESSION_HOST: string = 'reddit.com';
  const PERMANENT_HOST: string = 'news.ycombinator.com';
  const PERMANENT_REGEX: string = 'youtube\\.com/shorts';

  function sessionRules(partial: Partial<SessionRuleSnapshot>): SessionRuleSnapshot {
    return { ...rulesFromLists(DEFAULT_LISTS), ...partial };
  }

  it('names the session blacklist entry that matched', (): void => {
    const matcher = compileSessionMatcher(
      sessionRules({ sessionBlacklist: [{ kind: 'host', pattern: SESSION_HOST }] }),
      CATS,
      'blacklist',
    );

    for (const url of [`https://${SESSION_HOST}/r/all`, `https://old.${SESSION_HOST}/`]) {
      const verdict: Verdict = evaluateUrl(matcher, url, NONE, NOW);

      expect(verdict).toEqual({
        blocked: true,
        reason: 'custom',
        categoryId: null,
        matchedPattern: SESSION_HOST,
      });
      expect(typeof verdict.matchedPattern).toBe('string');
    }
  });

  it('names the permanent blacklist entry that matched, host or regex', (): void => {
    const matcher = compileSessionMatcher(
      sessionRules({
        permanentBlacklist: [
          { kind: 'host', pattern: PERMANENT_HOST },
          { kind: 'regex', pattern: PERMANENT_REGEX },
        ],
      }),
      CATS,
      'blacklist',
    );

    expect(evaluateUrl(matcher, `https://${PERMANENT_HOST}/item?id=1`, NONE, NOW)).toEqual({
      blocked: true,
      reason: 'custom',
      categoryId: null,
      matchedPattern: PERMANENT_HOST,
    });
    expect(evaluateUrl(matcher, 'https://www.youtube.com/shorts/abc', NONE, NOW)).toEqual({
      blocked: true,
      reason: 'custom',
      categoryId: null,
      matchedPattern: PERMANENT_REGEX,
    });
  });

  /**
   * The v2 enforcement boundary freezes this verdict into a document command, and its validator
   * rejects an absent or non-string `matchedPattern`. A custom-list block must therefore never
   * report the field as undefined.
   */
  it('produces a v2-valid verdict for every custom-list block shape', (): void => {
    const session = compileSessionMatcher(
      sessionRules({
        sessionBlacklist: [{ kind: 'host', pattern: SESSION_HOST }],
        permanentBlacklist: [
          { kind: 'host', pattern: PERMANENT_HOST },
          { kind: 'regex', pattern: PERMANENT_REGEX },
        ],
      }),
      CATS,
      'blacklist',
    );
    const listed = compileMatcher(
      lists({ custom: [{ kind: 'host', pattern: SESSION_HOST }] }),
      CATS,
      'blacklist',
    );
    const blocks: ReadonlyArray<readonly [ReturnType<typeof compileMatcher>, string]> = [
      [session, `https://${SESSION_HOST}/r/all`],
      [session, `https://old.${SESSION_HOST}/`],
      [session, `https://${PERMANENT_HOST}/item?id=1`],
      [session, 'https://www.youtube.com/shorts/abc'],
      [listed, `https://${SESSION_HOST}/`],
    ];

    for (const [matcher, url] of blocks) {
      const verdict: Verdict = evaluateUrl(matcher, url, NONE, NOW);

      expect(verdict.reason).toBe('custom');
      expect(verdict.blocked).toBe(true);
      expect(verdict.matchedPattern).not.toBeUndefined();
      expect(validateDetachedVerdict(verdict)).toBe(true);
    }
  });
});

describe('malformed custom-list entries', () => {
  /** The reported reproduction: a session blacklist holding bare strings instead of host rules. */
  function malformedRules(): SessionRuleSnapshot {
    return {
      ...rulesFromLists(DEFAULT_LISTS),
      categories: {
        social: false,
        video: false,
        news: false,
        mail: false,
        shopping: false,
        gaming: false,
        forums: false,
      },
      sessionBlacklist: ['example.com'] as unknown as SessionRuleSnapshot['sessionBlacklist'],
    };
  }

  it('never compiles a malformed entry into a catch-all regex', (): void => {
    const matcher = compileSessionMatcher(malformedRules(), ALL_CATEGORIES, 'blacklist');

    expect(matcher.hosts.get('example.com')).toBeUndefined();
    for (const entry of matcher.regexes) {
      expect(typeof entry.source).toBe('string');
      expect(entry.re.test('https://unrelated.example.org/')).toBe(false);
    }
    expect(evaluateUrl(matcher, 'https://unrelated.example.org/', NONE, NOW).blocked).toBe(false);
  });

  it('reports no custom block with an undefined pattern', (): void => {
    const matcher = compileSessionMatcher(malformedRules(), ALL_CATEGORIES, 'blacklist');
    const verdict: Verdict = evaluateUrl(matcher, 'https://example.com/path', NONE, NOW);

    expect(verdict.matchedPattern).not.toBeUndefined();
    expect(validateDetachedVerdict(verdict)).toBe(true);
  });

  it('reproduces the same drop through a plain lists config', (): void => {
    const matcher = compileMatcher(
      lists({ custom: ['example.com'] as unknown as ListsConfig['custom'] }),
      ALL_CATEGORIES,
      'blacklist',
    );
    const verdict: Verdict = evaluateUrl(matcher, 'https://example.com/path', NONE, NOW);

    expect(matcher.regexes).toEqual([]);
    expect(verdict.matchedPattern).not.toBeUndefined();
    expect(validateDetachedVerdict(verdict)).toBe(true);
    expect(evaluateUrl(matcher, 'https://unrelated.example.org/', NONE, NOW).blocked).toBe(false);
  });

  it('rejects a rule whose kind or pattern is not a rule at all', (): void => {
    const malformed: readonly unknown[] = [
      'example.com',
      { kind: 'host' },
      { kind: 'regex' },
      { kind: 'glob', pattern: 'example.com' },
      { kind: 'regex', pattern: 42 },
      {},
    ];

    for (const rule of malformed) {
      expect(validateRule(rule as Rule)).not.toBeNull();
    }
  });

  it('drops an empty or whitespace-only regex entry instead of blocking everything', (): void => {
    for (const pattern of ['', '   ', '\t\n']) {
      const matcher = compileMatcher(
        lists({ custom: [{ kind: 'regex', pattern }] }),
        ALL_CATEGORIES,
        'blacklist',
      );
      const verdict: Verdict = evaluateUrl(matcher, 'https://unrelated.example.org/', NONE, NOW);

      expect(validateRule({ kind: 'regex', pattern })).not.toBeNull();
      expect(matcher.regexes).toEqual([]);
      expect(verdict.blocked).toBe(false);
      expect(validateDetachedVerdict(verdict)).toBe(true);
    }
  });

  /** A deliberately broad regex is user intent, so only the empty pattern is rejected. */
  it('keeps a broad but deliberate regex', (): void => {
    for (const pattern of ['(?:)', '.*']) {
      const matcher = compileMatcher(
        lists({ custom: [{ kind: 'regex', pattern }] }),
        ALL_CATEGORIES,
        'blacklist',
      );

      expect(validateRule({ kind: 'regex', pattern })).toBeNull();
      expect(evaluateUrl(matcher, 'https://unrelated.example.org/', NONE, NOW)).toEqual({
        blocked: true,
        reason: 'custom',
        categoryId: null,
        matchedPattern: pattern,
      });
    }
  });

  it('still accepts and names a well-formed session blacklist host', (): void => {
    const matcher = compileSessionMatcher(
      {
        ...malformedRules(),
        sessionBlacklist: [{ kind: 'host', pattern: 'example.com' }],
      },
      ALL_CATEGORIES,
      'blacklist',
    );

    expect(matcher.hosts.get('example.com')).toBe('custom');
    expect(evaluateUrl(matcher, 'https://example.com/path', NONE, NOW)).toEqual({
      blocked: true,
      reason: 'custom',
      categoryId: null,
      matchedPattern: 'example.com',
    });
  });
});

describe('always-allow and unlocks', () => {
  const m = compileMatcher(
    lists({ custom: [{ kind: 'host', pattern: 'facebook.com' }] }),
    [],
    'blacklist',
  );
  it('never blocks internal pages or local hosts', () => {
    expect(evaluateUrl(m, 'chrome://extensions/', NONE, NOW).reason).toBe('always-allow');
    expect(evaluateUrl(m, 'http://localhost:3000/', NONE, NOW).reason).toBe('always-allow');
    expect(evaluateUrl(m, 'http://myapp.test/', NONE, NOW).reason).toBe('always-allow');
  });
  it('an active unlock allows, an expired one does not', () => {
    const unlocks: SiteUnlock[] = [{ host: 'facebook.com', until: NOW + 1 }];
    expect(evaluateUrl(m, 'https://m.facebook.com/', unlocks, NOW).reason).toBe('unlock');
    expect(evaluateUrl(m, 'https://m.facebook.com/', unlocks, NOW + 2).blocked).toBe(true);
  });
});

describe('whitelist mode', () => {
  const m = compileMatcher(
    lists({ whitelist: [{ kind: 'host', pattern: 'github.com' }] }),
    CATS,
    'whitelist',
  );
  it('allows listed hosts, blocks everything else', () => {
    expect(evaluateUrl(m, 'https://github.com/pulls', NONE, NOW).reason).toBe('whitelist');
    expect(evaluateUrl(m, 'https://example.com/', NONE, NOW)).toEqual({
      blocked: true,
      reason: 'whitelist-miss',
      categoryId: null,
      matchedPattern: null,
    });
  });
  it('always-allow still wins in whitelist mode', () => {
    expect(evaluateUrl(m, 'http://localhost:5173/', NONE, NOW).blocked).toBe(false);
  });
});

describe('validateRule', () => {
  it('accepts hosts, rejects garbage and bad regexes', () => {
    expect(validateRule({ kind: 'host', pattern: 'nu.nl' })).toBeNull();
    expect(validateRule({ kind: 'host', pattern: 'bücher.example' })).toBeNull();
    expect(validateRule({ kind: 'host', pattern: 'not a host!' })).toMatch(/host/i);
    expect(validateRule({ kind: 'regex', pattern: '(' })).toMatch(/regex/i);
  });
});

describe('registrableHost', () => {
  it('returns eTLD+1, null for IPs', () => {
    expect(registrableHost('https://old.reddit.com/x')).toBe('reddit.com');
    expect(registrableHost('https://a.b.co.uk/')).toBe('b.co.uk');
    expect(registrableHost('http://127.0.0.1/')).toBeNull();
  });
});

describe('persisted matcher cache', () => {
  const cacheLists: ListsConfig = lists({
    custom: [
      { kind: 'host', pattern: 'bücher.example' },
      { kind: 'regex', pattern: 'youtube\\.com/shorts' },
    ],
    whitelist: [
      { kind: 'host', pattern: 'github.com' },
      { kind: 'regex', pattern: 'docs\\.example/allowed' },
      { kind: 'regex', pattern: 'docs\\.example' },
    ],
    categories: { ...DEFAULT_LISTS.categories, social: true },
    exclusions: { social: ['facebook.com'] },
  });

  it('round-trips both modes as plain data without changing verdicts or provenance', () => {
    const built = buildMatcherCache(cacheLists, CATS);
    const stored = JSON.parse(JSON.stringify(built.stored)) as unknown;
    const restored = restoreMatcherCache(stored, cacheLists, CATS);

    expect(restored).not.toBeNull();
    expect(JSON.parse(JSON.stringify(built.stored))).toEqual(built.stored);
    expect(Array.isArray(built.stored.modes.blacklist.hosts)).toBe(true);
    expect(Array.isArray(built.stored.modes.blacklist.regexes)).toBe(true);
    expect(Array.isArray(built.stored.modes.blacklist.excluded)).toBe(true);
    expect(built.stored.modes.blacklist.hosts).toContainEqual([
      'x.com',
      { via: 'category', categoryId: 'social' },
    ]);
    expect(
      built.stored.modes.whitelist.regexes.map(
        (entry: { source: string; via: 'custom' | 'whitelist' }): string => entry.source,
      ),
    ).toEqual(['docs\\.example/allowed', 'docs\\.example']);
    expect(
      evaluateUrl(
        restored?.blacklist as ReturnType<typeof compileMatcher>,
        'https://x.com/home',
        NONE,
        NOW,
      ),
    ).toEqual({
      blocked: true,
      reason: 'category',
      categoryId: 'social',
      matchedPattern: 'x.com',
    });
    expect(
      evaluateUrl(
        restored?.blacklist as ReturnType<typeof compileMatcher>,
        'https://www.facebook.com/work',
        NONE,
        NOW,
      ).reason,
    ).toBe('excluded');
    expect(
      evaluateUrl(
        restored?.blacklist as ReturnType<typeof compileMatcher>,
        'https://xn--bcher-kva.example/catalog',
        NONE,
        NOW,
      ),
    ).toEqual({
      blocked: true,
      reason: 'custom',
      categoryId: null,
      matchedPattern: 'xn--bcher-kva.example',
    });
    expect(
      evaluateUrl(
        restored?.blacklist as ReturnType<typeof compileMatcher>,
        'https://youtube.com/shorts/one',
        NONE,
        NOW,
      ),
    ).toEqual({
      blocked: true,
      reason: 'custom',
      categoryId: null,
      matchedPattern: 'youtube\\.com/shorts',
    });
    expect(
      evaluateUrl(
        restored?.whitelist as ReturnType<typeof compileMatcher>,
        'https://docs.example/allowed/page',
        NONE,
        NOW,
      ),
    ).toEqual({
      blocked: false,
      reason: 'whitelist',
      categoryId: null,
      matchedPattern: 'docs\\.example/allowed',
    });
  });

  it('uses a deterministic source signature and invalidates changed inputs', () => {
    const reordered: ListsConfig = {
      whitelist: cacheLists.whitelist,
      custom: cacheLists.custom,
      exclusions: { social: ['facebook.com'] },
      categories: {
        forums: false,
        gaming: false,
        shopping: false,
        mail: false,
        news: false,
        video: false,
        social: true,
      },
    };
    const stored = buildMatcherCache(cacheLists, CATS).stored;

    expect(buildMatcherCache(reordered, CATS).stored.sourceSignature).toBe(stored.sourceSignature);
    expect(
      restoreMatcherCache(
        stored,
        { ...cacheLists, custom: [...cacheLists.custom, { kind: 'host', pattern: 'new.example' }] },
        CATS,
      ),
    ).toBeNull();
    expect(
      restoreMatcherCache(stored, cacheLists, [
        { ...(CATS[0] as CategoryList), hosts: ['facebook.com', 'x.com', 'new.example'] },
      ]),
    ).toBeNull();
  });

  it('hydrates cached regexes without rebuilding matchers from source', () => {
    const regexOnlyLists: ListsConfig = lists({
      custom: [
        { kind: 'regex', pattern: 'one' },
        { kind: 'regex', pattern: 'two' },
      ],
      whitelist: [{ kind: 'regex', pattern: 'three' }],
    });
    const stored = buildMatcherCache(regexOnlyLists, []).stored;
    const NativeRegExp: RegExpConstructor = RegExp;
    let constructions: number = 0;
    const CountingRegExp: RegExpConstructor = new Proxy(NativeRegExp, {
      construct(
        target: RegExpConstructor,
        argumentsList: [pattern: string | RegExp, flags?: string],
      ): RegExp {
        constructions += 1;
        return Reflect.construct(target, argumentsList) as RegExp;
      },
    });
    vi.stubGlobal('RegExp', CountingRegExp);

    try {
      expect(restoreMatcherCache(stored, regexOnlyLists, [])).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(constructions).toBe(3);
  });

  type CacheMutation = (value: Record<string, unknown>) => void;
  const malformedCacheCases: Array<[string, CacheMutation]> = [
    [
      'wrong version',
      (value: Record<string, unknown>): void => {
        value.version = 1;
      },
    ],
    [
      'missing mode',
      (value: Record<string, unknown>): void => {
        const modes = value.modes as Record<string, unknown>;
        delete modes.whitelist;
      },
    ],
    [
      'malformed host tuple',
      (value: Record<string, unknown>): void => {
        const modes = value.modes as { blacklist: { hosts: unknown[] } };
        modes.blacklist.hosts = [['x.com', 'invalid']];
      },
    ],
    [
      'obsolete category provenance',
      (value: Record<string, unknown>): void => {
        const modes = value.modes as { blacklist: { hosts: unknown[] } };
        modes.blacklist.hosts = [['x.com', 'category']];
      },
    ],
    [
      'added valid host',
      (value: Record<string, unknown>): void => {
        const modes = value.modes as { blacklist: { hosts: unknown[] } };
        modes.blacklist.hosts.push(['extra.example', 'custom']);
      },
    ],
    [
      'changed valid host',
      (value: Record<string, unknown>): void => {
        const modes = value.modes as { blacklist: { hosts: unknown[][] } };
        const customIndex: number = modes.blacklist.hosts.findIndex(
          (entry: unknown[]): boolean => entry[1] === 'custom',
        );
        modes.blacklist.hosts[customIndex] = ['changed.example', 'custom'];
      },
    ],
    [
      'invalid regex',
      (value: Record<string, unknown>): void => {
        const modes = value.modes as { blacklist: { regexes: unknown[] } };
        modes.blacklist.regexes = [{ source: '(', via: 'custom' }];
      },
    ],
    [
      'invalid regex provenance',
      (value: Record<string, unknown>): void => {
        const modes = value.modes as { blacklist: { regexes: unknown[] } };
        modes.blacklist.regexes = [{ source: 'example', via: 'whitelist' }];
      },
    ],
    [
      'reordered valid regexes',
      (value: Record<string, unknown>): void => {
        const modes = value.modes as { whitelist: { regexes: unknown[] } };
        modes.whitelist.regexes.reverse();
      },
    ],
    [
      'partial mode data',
      (value: Record<string, unknown>): void => {
        const modes = value.modes as { blacklist: Record<string, unknown> };
        delete modes.blacklist.excluded;
      },
    ],
  ];

  it.each(malformedCacheCases)(
    'returns null without throwing for %s',
    (_name: string, mutate: CacheMutation): void => {
      const raw = JSON.parse(JSON.stringify(buildMatcherCache(cacheLists, CATS).stored)) as Record<
        string,
        unknown
      >;
      mutate(raw);

      expect(() => restoreMatcherCache(raw, cacheLists, CATS)).not.toThrow();
      expect(restoreMatcherCache(raw, cacheLists, CATS)).toBeNull();
    },
  );

  /**
   * The production compiled signature is a key-sorted stringification of `modes`, so a
   * mutated cache needs its own signature recomputed the same way. Without this the
   * mutation is rejected by the signature check and the guard under test never runs.
   */
  function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const record: Record<string, unknown> = value as Record<string, unknown>;
    const members: string[] = Object.keys(record)
      .sort()
      .map((key: string): string => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${members.join(',')}}`;
  }

  it('refuses a self-consistent cache whose stored regex source is empty', (): void => {
    const raw = JSON.parse(JSON.stringify(buildMatcherCache(cacheLists, CATS).stored)) as Record<
      string,
      unknown
    >;
    const modes = raw.modes as { blacklist: { regexes: Array<{ source: string; via: string }> } };
    modes.blacklist.regexes = [{ source: '', via: 'custom' }];
    raw.compiledSignature = stableJson(raw.modes);

    expect(restoreMatcherCache(raw, cacheLists, CATS)).toBeNull();
  });

  it('still restores a cache whose signature was recomputed without other edits', (): void => {
    const raw = JSON.parse(JSON.stringify(buildMatcherCache(cacheLists, CATS).stored)) as Record<
      string,
      unknown
    >;
    raw.compiledSignature = stableJson(raw.modes);

    expect(restoreMatcherCache(raw, cacheLists, CATS)).not.toBeNull();
  });

  /**
   * The cache gate used to read `Object.keys`, which sees neither of these, so both restored as a
   * cache with the exact key set. It reads `Reflect.ownKeys` now, like every other exact-key gate.
   */
  it('refuses a cache carrying a symbol or a non-enumerable own key', (): void => {
    const symbolKeyed = JSON.parse(
      JSON.stringify(buildMatcherCache(cacheLists, CATS).stored),
    ) as Record<string, unknown>;
    (symbolKeyed as Record<symbol, unknown>)[Symbol('smuggled')] = true;

    const hiddenKeyed = JSON.parse(
      JSON.stringify(buildMatcherCache(cacheLists, CATS).stored),
    ) as Record<string, unknown>;
    Object.defineProperty(hiddenKeyed, 'smuggled', { enumerable: false, value: true });

    expect(restoreMatcherCache(symbolKeyed, cacheLists, CATS)).toBeNull();
    expect(restoreMatcherCache(hiddenKeyed, cacheLists, CATS)).toBeNull();
  });
});
