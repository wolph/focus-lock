import { getDomain } from 'tldts';
import {
  ALWAYS_ALLOW_HOST_SUFFIXES,
  ALWAYS_ALLOW_HOSTS,
  ALWAYS_ALLOW_SCHEMES,
  CATEGORY_IDS,
} from '../shared/constants';
import { hasExactKeys, isDenseArray, isRecord as isPlainRecord } from '../shared/exact-data';
import { normalizeHost } from '../shared/host-normalization';
import type {
  CategoryId,
  CategoryList,
  HostRule,
  ListsConfig,
  Rule,
  SessionMode,
  SessionRuleSnapshot,
  SiteUnlock,
  Verdict,
} from '../shared/types';

export interface CompiledMatcher {
  mode: SessionMode;
  /** host suffix rules mapped to their provenance, drives Verdict.reason */
  hosts: ReadonlyMap<string, HostProvenance>;
  /** compiled full-URL regexes with their sources */
  regexes: ReadonlyArray<{ source: string; re: RegExp; via: 'custom' | 'whitelist' }>;
  /** hosts excluded from enabled categories */
  excluded: ReadonlySet<string>;
}

export interface CategoryHostProvenance {
  via: 'category';
  categoryId: CategoryId;
}

type HostProvenance = CategoryHostProvenance | 'custom' | 'whitelist';
type RegexProvenance = 'custom' | 'whitelist';
type BlacklistHostProvenance = Exclude<HostProvenance, 'whitelist'>;

export interface StoredBlacklistMatcher {
  mode: 'blacklist';
  hosts: Array<[string, BlacklistHostProvenance]>;
  regexes: Array<{ source: string; via: 'custom' }>;
  excluded: string[];
}

export interface StoredWhitelistMatcher {
  mode: 'whitelist';
  hosts: Array<[string, 'whitelist']>;
  regexes: Array<{ source: string; via: 'whitelist' }>;
  excluded: [];
}

export type StoredCompiledMatcher = StoredBlacklistMatcher | StoredWhitelistMatcher;

export interface StoredMatcherCache {
  version: 2;
  sourceSignature: string;
  compiledSignature: string;
  modes: {
    blacklist: StoredBlacklistMatcher;
    whitelist: StoredWhitelistMatcher;
  };
}

export interface CompiledMatcherSet {
  blacklist: CompiledMatcher;
  whitelist: CompiledMatcher;
}

export interface MatcherCacheBundle {
  stored: StoredMatcherCache;
  compiled: CompiledMatcherSet;
}

const HOST_RE: RegExp = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const SCHEME_RE: RegExp = /^([a-z][a-z0-9+.-]*):\/\//i;
const ANY_SCHEME_RE: RegExp = /^[a-z][a-z0-9+.-]*:/i;
const NUMERIC_HOST_RE: RegExp = /^\d+(?:\.\d+)+$/;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint: number = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function hasUnsafeHostCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint: number = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || character === '\\') return true;
  }
  return false;
}

/** Regexes are tested against at most this many leading characters of the URL. */
export const MAX_REGEX_INPUT_LENGTH: number = 256;

/** Marks the innermost open group as holding a quantifier or an alternation. */
function markTopRisky(open: Array<{ risky: boolean }>): void {
  const top: { risky: boolean } | undefined = open[open.length - 1];
  if (top !== undefined) top.risky = true;
}

/**
 * Reports whether a pattern repeats a group that itself holds a quantifier or an alternation,
 * as in (.*\.)* or (a|a)+. Such shapes backtrack exponentially, so compileMatcher skips them.
 */
export function hasNestedRepetition(pattern: string): boolean {
  const open: Array<{ risky: boolean }> = [];
  let lastGroupRisky: boolean = false;
  for (let i: number = 0; i < pattern.length; i++) {
    const c: string = pattern.charAt(i);
    const brace: RegExpExecArray | null =
      c === '{' ? /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i)) : null;
    if (c === '*' || c === '+' || c === '?' || brace !== null) {
      const repeats: boolean =
        c === '*' ||
        c === '+' ||
        (brace !== null && (brace[2] !== undefined || Number(brace[1]) > 1));
      if (repeats && lastGroupRisky) return true;
      markTopRisky(open);
      lastGroupRisky = false;
      if (brace !== null) i += brace[0].length - 1;
      if (pattern.charAt(i + 1) === '?') i++;
      continue;
    }
    lastGroupRisky = false;
    if (c === '\\') {
      i++;
    } else if (c === '[') {
      for (i++; i < pattern.length && pattern.charAt(i) !== ']'; i++) {
        if (pattern.charAt(i) === '\\') i++;
      }
    } else if (c === '(') {
      open.push({ risky: false });
      const prefix: RegExpExecArray | null = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(
        pattern.slice(i + 1),
      );
      if (prefix !== null) i += prefix[0].length;
    } else if (c === '|') {
      markTopRisky(open);
    } else if (c === ')') {
      const group: { risky: boolean } | undefined = open.pop();
      if (group === undefined) return false;
      if (group.risky) markTopRisky(open);
      lastGroupRisky = group.risky;
    }
  }
  return false;
}

/** Returns an error message for an invalid rule, null when valid. */
export function validateRule(rule: Rule): string | null {
  if (!isRecord(rule) || typeof rule.pattern !== 'string') return 'not a valid rule';
  if (rule.kind === 'host') {
    const host: string | null = normalizeHost(rule.pattern);
    if (host === null || !HOST_RE.test(host)) return `not a valid host name: ${rule.pattern}`;
    return null;
  }
  if (rule.kind !== 'regex') return `not a valid rule kind: ${String(rule.kind)}`;
  if (rule.pattern.trim() === '') return 'not a valid regex: the pattern is empty';
  try {
    new RegExp(rule.pattern, 'i');
    return null;
  } catch (e: unknown) {
    return `not a valid regex: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Parses popup host input without silently discarding authority details. */
export function normalizeSessionHostInput(value: string): string | null {
  if (hasControlCharacter(value)) return null;
  const input: string = value.trim();
  if (input.length === 0 || hasUnsafeHostCharacter(input) || input.startsWith('//')) return null;
  const schemeMatch: RegExpExecArray | null = SCHEME_RE.exec(input);
  if (schemeMatch !== null) {
    const scheme: string = (schemeMatch[1] ?? '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
  } else if (ANY_SCHEME_RE.test(input)) {
    return null;
  }

  const urlText: string = schemeMatch === null ? `http://${input}` : input;
  const authorityStart: number = urlText.indexOf('//') + 2;
  const authorityEndCandidate: number = urlText.slice(authorityStart).search(/[/?#]/);
  const authorityEnd: number =
    authorityEndCandidate === -1 ? urlText.length : authorityStart + authorityEndCandidate;
  const authority: string = urlText.slice(authorityStart, authorityEnd);
  if (authority.length === 0 || authority.includes('@') || authority.includes(':')) return null;

  try {
    const parsed: URL = new URL(urlText);
    if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null;
    const host: string | null = normalizeHost(parsed.hostname);
    if (host === null || !HOST_RE.test(host) || NUMERIC_HOST_RE.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * The rules live once, in `shared/exact-data.ts`, which imports nothing and so can be reached from
 * here without inverting the layer direction. The catch stays because this module normalizes raw
 * stored and messaged values, where `Array.isArray` throws on a revoked proxy and `Reflect.ownKeys`
 * throws on a hostile `ownKeys` trap.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return isPlainRecord(value);
  } catch {
    return false;
  }
}

function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try {
    return hasExactKeys(value, keys);
  } catch {
    return false;
  }
}

function normalizePermanentRule(value: unknown): Rule | null {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['kind', 'pattern'])) return null;
  if (value.kind !== 'host' && value.kind !== 'regex') return null;
  if (typeof value.pattern !== 'string') return null;
  if (value.kind === 'regex') {
    const rule: Rule = { kind: 'regex', pattern: value.pattern };
    return validateRule(rule) === null ? rule : null;
  }
  const host: string | null = normalizeHost(value.pattern);
  if (host === null || !HOST_RE.test(host)) return null;
  return { kind: 'host', pattern: host };
}

function normalizePermanentRules(value: unknown): Rule[] | null {
  if (!isDenseArray(value)) return null;
  const result: Rule[] = [];
  for (const candidate of value) {
    const rule: Rule | null = normalizePermanentRule(candidate);
    if (rule === null) return null;
    result.push(rule);
  }
  return result;
}

function normalizeHostRules(value: unknown): HostRule[] | null {
  if (!isDenseArray(value)) return null;
  const result: HostRule[] = [];
  const seen: Set<string> = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactOwnKeys(candidate, ['kind', 'pattern']) ||
      candidate.kind !== 'host' ||
      typeof candidate.pattern !== 'string'
    ) {
      return null;
    }
    const host: string | null = normalizeSessionHostInput(candidate.pattern);
    if (host === null) return null;
    if (!seen.has(host)) result.push({ kind: 'host', pattern: host });
    seen.add(host);
  }
  return result;
}

function normalizeCategories(value: unknown): Record<CategoryId, boolean> | null {
  if (!isRecord(value) || !hasExactOwnKeys(value, CATEGORY_IDS)) return null;
  const categories: Record<CategoryId, boolean> = {} as Record<CategoryId, boolean>;
  for (const id of CATEGORY_IDS) {
    if (typeof value[id] !== 'boolean') return null;
    categories[id] = value[id];
  }
  return categories;
}

function normalizeExclusions(value: unknown): Partial<Record<CategoryId, string[]>> | null {
  if (!isRecord(value)) return null;
  const exclusions: Partial<Record<CategoryId, string[]>> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !CATEGORY_IDS.includes(key as CategoryId)) return null;
  }
  for (const key of CATEGORY_IDS) {
    if (!Object.hasOwn(value, key)) continue;
    const candidates: unknown = value[key];
    if (!isDenseArray(candidates)) return null;
    const hosts: string[] = [];
    const seen: Set<string> = new Set<string>();
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') return null;
      const host: string | null = normalizeHost(candidate);
      if (host === null || !HOST_RE.test(host)) return null;
      if (!seen.has(host)) hosts.push(host);
      seen.add(host);
    }
    exclusions[key] = hosts;
  }
  return exclusions;
}

/** Validates exact nested keys and returns a newly allocated canonical snapshot. */
export function normalizeSessionRules(value: unknown): SessionRuleSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, [
      'baselineRevision',
      'baselineCategories',
      'categories',
      'exclusions',
      'permanentBlacklist',
      'permanentAllowlist',
      'sessionBlacklist',
      'sessionAllowlist',
    ]) ||
    typeof value.baselineRevision !== 'string' ||
    value.baselineRevision.trim() === ''
  ) {
    return null;
  }
  const baselineCategories: Record<CategoryId, boolean> | null = normalizeCategories(
    value.baselineCategories,
  );
  const categories: Record<CategoryId, boolean> | null = normalizeCategories(value.categories);
  const exclusions: Partial<Record<CategoryId, string[]>> | null = normalizeExclusions(
    value.exclusions,
  );
  const permanentBlacklist: Rule[] | null = normalizePermanentRules(value.permanentBlacklist);
  const permanentAllowlist: Rule[] | null = normalizePermanentRules(value.permanentAllowlist);
  const sessionBlacklist: HostRule[] | null = normalizeHostRules(value.sessionBlacklist);
  const sessionAllowlist: HostRule[] | null = normalizeHostRules(value.sessionAllowlist);
  if (
    baselineCategories === null ||
    categories === null ||
    exclusions === null ||
    permanentBlacklist === null ||
    permanentAllowlist === null ||
    sessionBlacklist === null ||
    sessionAllowlist === null
  ) {
    return null;
  }
  return {
    baselineRevision: value.baselineRevision,
    baselineCategories,
    categories,
    exclusions,
    permanentBlacklist,
    permanentAllowlist,
    sessionBlacklist,
    sessionAllowlist,
  };
}

/** Accepts current snapshots plus the exact persisted predecessor without baselineCategories. */
export function normalizeStoredSessionRules(value: unknown): SessionRuleSnapshot | null {
  const current: SessionRuleSnapshot | null = normalizeSessionRules(value);
  if (current !== null) return current;
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, [
      'baselineRevision',
      'categories',
      'exclusions',
      'permanentBlacklist',
      'permanentAllowlist',
      'sessionBlacklist',
      'sessionAllowlist',
    ])
  ) {
    return null;
  }
  return normalizeSessionRules({
    ...value,
    baselineCategories: value.categories,
  });
}

export function listsFromSessionRules(rules: SessionRuleSnapshot): ListsConfig {
  return {
    custom: structuredClone([...rules.permanentBlacklist, ...rules.sessionBlacklist]),
    whitelist: structuredClone([...rules.permanentAllowlist, ...rules.sessionAllowlist]),
    categories: { ...rules.categories },
    exclusions: structuredClone(rules.exclusions),
  };
}

export function compileSessionMatcher(
  rules: SessionRuleSnapshot,
  categories: CategoryList[],
  mode: SessionMode,
): CompiledMatcher {
  return compileMatcher(listsFromSessionRules(rules), categories, mode);
}

function hostInSet(
  host: string,
  set: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): string | null {
  const has: (h: string) => boolean = (h: string): boolean =>
    set instanceof Map ? set.has(h) : (set as ReadonlySet<string>).has(h);
  let probe: string = host;
  for (;;) {
    if (has(probe)) return probe;
    const dot: number = probe.indexOf('.');
    if (dot === -1) return null;
    probe = probe.slice(dot + 1);
  }
}

function hostWithProvenance(
  host: string,
  hosts: ReadonlyMap<string, HostProvenance>,
  provenance: 'custom' | 'whitelist',
): string | null {
  let probe: string = host;
  for (;;) {
    if (hosts.get(probe) === provenance) return probe;
    const dot: number = probe.indexOf('.');
    if (dot === -1) return null;
    probe = probe.slice(dot + 1);
  }
}

function categoryHostWithProvenance(
  host: string,
  hosts: ReadonlyMap<string, HostProvenance>,
): { matchedPattern: string; categoryId: CategoryId } | null {
  let probe: string = host;
  for (;;) {
    const provenance: HostProvenance | undefined = hosts.get(probe);
    if (typeof provenance === 'object' && provenance.via === 'category') {
      return { matchedPattern: probe, categoryId: provenance.categoryId };
    }
    const dot: number = probe.indexOf('.');
    if (dot === -1) return null;
    probe = probe.slice(dot + 1);
  }
}

/** True only when a custom host rule covers the complete category host. */
export function hostRuleCoversHost(rule: Rule, hostValue: string): boolean {
  if (rule.kind !== 'host' || validateRule(rule) !== null) return false;
  const host: string | null = normalizeHost(hostValue);
  const pattern: string | null = normalizeHost(rule.pattern);
  return host !== null && pattern !== null && hostInSet(host, new Set<string>([pattern])) !== null;
}

export function compileMatcher(
  lists: ListsConfig,
  categories: CategoryList[],
  mode: SessionMode,
): CompiledMatcher {
  const hosts: Map<string, HostProvenance> = new Map();
  const regexes: Array<{ source: string; re: RegExp; via: 'custom' | 'whitelist' }> = [];
  const excluded: Set<string> = new Set();

  const addRules: (rules: Rule[], via: 'custom' | 'whitelist') => void = (
    rules: Rule[],
    via: 'custom' | 'whitelist',
  ): void => {
    for (const rule of rules) {
      if (validateRule(rule) !== null) continue;
      if (rule.kind === 'host') {
        const host: string | null = normalizeHost(rule.pattern);
        if (host !== null && (via === 'custom' || !hosts.has(host))) hosts.set(host, via);
      } else if (rule.kind === 'regex') {
        if (hasNestedRepetition(rule.pattern)) continue;
        regexes.push({ source: rule.pattern, re: new RegExp(rule.pattern, 'i'), via });
      }
    }
  };

  if (mode === 'whitelist') {
    addRules(lists.whitelist, 'whitelist');
  } else {
    for (const cat of categories) {
      if (!lists.categories[cat.id]) continue;
      const excludedHere: Set<string> = new Set<string>();
      for (const raw of lists.exclusions[cat.id] ?? []) {
        const host: string | null = normalizeHost(raw);
        if (host !== null) excludedHere.add(host);
      }
      for (const raw of cat.hosts) {
        const host: string | null = normalizeHost(raw);
        if (host === null) continue;
        if (excludedHere.has(host)) excluded.add(host);
        else if (!hosts.has(host)) hosts.set(host, { via: 'category', categoryId: cat.id });
      }
    }
    addRules(lists.custom, 'custom');
  }
  return { mode, hosts, regexes, excluded };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  const members: string[] = Object.keys(record)
    .sort()
    .map((key: string): string => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${members.join(',')}}`;
}

function sourceSignature(lists: ListsConfig, categories: CategoryList[]): string {
  return stableJson({ categories, lists });
}

function storeBlacklistMatcher(matcher: CompiledMatcher): StoredBlacklistMatcher {
  const hosts: Array<[string, BlacklistHostProvenance]> = [];
  for (const [host, provenance] of matcher.hosts) {
    if (provenance === 'whitelist') throw new Error('blacklist matcher has whitelist provenance');
    hosts.push([host, provenance]);
  }
  const regexes: Array<{ source: string; via: 'custom' }> = matcher.regexes.map(
    (entry: { source: string; via: RegexProvenance }): { source: string; via: 'custom' } => {
      if (entry.via !== 'custom') throw new Error('blacklist matcher has whitelist regex');
      return { source: entry.source, via: 'custom' };
    },
  );
  return {
    mode: 'blacklist',
    hosts,
    regexes,
    excluded: [...matcher.excluded],
  };
}

function storeWhitelistMatcher(matcher: CompiledMatcher): StoredWhitelistMatcher {
  const hosts: Array<[string, 'whitelist']> = [];
  for (const [host, provenance] of matcher.hosts) {
    if (provenance !== 'whitelist') throw new Error('whitelist matcher has blacklist provenance');
    hosts.push([host, provenance]);
  }
  const regexes: Array<{ source: string; via: 'whitelist' }> = matcher.regexes.map(
    (entry: { source: string; via: RegexProvenance }): { source: string; via: 'whitelist' } => {
      if (entry.via !== 'whitelist') throw new Error('whitelist matcher has custom regex');
      return { source: entry.source, via: 'whitelist' };
    },
  );
  if (matcher.excluded.size !== 0) throw new Error('whitelist matcher has exclusions');
  return {
    mode: 'whitelist',
    hosts,
    regexes,
    excluded: [],
  };
}

export function buildMatcherCache(
  lists: ListsConfig,
  categories: CategoryList[],
): MatcherCacheBundle {
  const compiled: CompiledMatcherSet = {
    blacklist: compileMatcher(lists, categories, 'blacklist'),
    whitelist: compileMatcher(lists, categories, 'whitelist'),
  };
  const modes: StoredMatcherCache['modes'] = {
    blacklist: storeBlacklistMatcher(compiled.blacklist),
    whitelist: storeWhitelistMatcher(compiled.whitelist),
  };
  return {
    stored: {
      version: 2,
      sourceSignature: sourceSignature(lists, categories),
      compiledSignature: stableJson(modes),
      modes,
    },
    compiled,
  };
}

function isNormalizedHost(value: unknown): value is string {
  return typeof value === 'string' && HOST_RE.test(value) && normalizeHost(value) === value;
}

function validHostProvenance(value: unknown, mode: SessionMode): value is HostProvenance {
  if (mode === 'whitelist') return value === 'whitelist';
  if (value === 'custom') return true;
  return (
    isRecord(value) &&
    hasExactKeys(value, ['via', 'categoryId']) &&
    value.via === 'category' &&
    typeof value.categoryId === 'string' &&
    CATEGORY_IDS.includes(value.categoryId as CategoryId)
  );
}

function validRegexProvenance(value: unknown, mode: SessionMode): value is RegexProvenance {
  return mode === 'blacklist' ? value === 'custom' : value === 'whitelist';
}

function restoreStoredMatcher(value: unknown, mode: SessionMode): CompiledMatcher | null {
  if (!isRecord(value) || !hasExactKeys(value, ['mode', 'hosts', 'regexes', 'excluded'])) {
    return null;
  }
  if (value.mode !== mode || !Array.isArray(value.hosts) || !Array.isArray(value.regexes)) {
    return null;
  }
  if (!Array.isArray(value.excluded)) return null;

  const hosts: Map<string, HostProvenance> = new Map();
  for (const candidate of value.hosts) {
    if (!Array.isArray(candidate) || candidate.length !== 2) return null;
    const [host, provenance]: unknown[] = candidate;
    if (!isNormalizedHost(host) || !validHostProvenance(provenance, mode) || hosts.has(host)) {
      return null;
    }
    hosts.set(host, provenance);
  }

  const regexes: Array<{ source: string; re: RegExp; via: RegexProvenance }> = [];
  for (const candidate of value.regexes) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ['source', 'via'])) return null;
    if (typeof candidate.source !== 'string' || !validRegexProvenance(candidate.via, mode)) {
      return null;
    }
    // The compiler rejects an empty pattern, so a stored empty source was never validated.
    // Restoring it would install a regex that matches every URL.
    if (candidate.source.trim() === '') return null;
    try {
      regexes.push({
        source: candidate.source,
        re: new RegExp(candidate.source, 'i'),
        via: candidate.via,
      });
    } catch {
      return null;
    }
  }

  const excluded: Set<string> = new Set();
  for (const host of value.excluded) {
    if (!isNormalizedHost(host) || excluded.has(host)) return null;
    excluded.add(host);
  }
  if (mode === 'whitelist' && excluded.size !== 0) return null;
  return { mode, hosts, regexes, excluded };
}

export function restoreMatcherCache(
  value: unknown,
  lists: ListsConfig,
  categories: CategoryList[],
): CompiledMatcherSet | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'sourceSignature', 'compiledSignature', 'modes'])
  ) {
    return null;
  }
  if (
    value.version !== 2 ||
    value.sourceSignature !== sourceSignature(lists, categories) ||
    typeof value.compiledSignature !== 'string' ||
    !isRecord(value.modes) ||
    !hasExactKeys(value.modes, ['blacklist', 'whitelist']) ||
    value.compiledSignature !== stableJson(value.modes)
  ) {
    return null;
  }
  const blacklist: CompiledMatcher | null = restoreStoredMatcher(
    value.modes.blacklist,
    'blacklist',
  );
  const whitelist: CompiledMatcher | null = restoreStoredMatcher(
    value.modes.whitelist,
    'whitelist',
  );
  return blacklist === null || whitelist === null ? null : { blacklist, whitelist };
}

/** eTLD+1 via tldts, null for IPs and unparseable input (callers fall back to hostname). */
export function registrableHost(url: string): string | null {
  return getDomain(url);
}

/** First match wins: always-allow, unlocks, custom rules, exclusions, categories, then default. */
export function evaluateUrl(
  matcher: CompiledMatcher,
  url: string,
  unlocks: SiteUnlock[],
  now: number,
): Verdict {
  const allow: (reason: Verdict['reason'], matchedPattern?: string | null) => Verdict = (
    reason: Verdict['reason'],
    matchedPattern: string | null = null,
  ): Verdict => ({
    blocked: false,
    reason,
    categoryId: null,
    matchedPattern,
  });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return allow('default');
  }
  if (ALWAYS_ALLOW_SCHEMES.includes(parsed.protocol)) return allow('always-allow');
  const host: string = normalizeHost(parsed.hostname) ?? parsed.hostname;
  if (
    ALWAYS_ALLOW_HOSTS.includes(host) ||
    ALWAYS_ALLOW_HOST_SUFFIXES.some((s: string): boolean => host.endsWith(s))
  ) {
    return allow('always-allow');
  }
  const domain: string = registrableHost(url) ?? host;
  for (const u of unlocks) {
    if (u.until > now && (u.host === domain || u.host === host)) return allow('unlock');
  }
  const regexInput: string = url.slice(0, MAX_REGEX_INPUT_LENGTH);
  if (matcher.mode === 'whitelist') {
    const hit: string | null = hostInSet(host, matcher.hosts);
    if (hit !== null) return allow('whitelist', hit);
    for (const r of matcher.regexes) {
      if (r.re.test(regexInput)) return allow('whitelist', r.source);
    }
    return { blocked: true, reason: 'whitelist-miss', categoryId: null, matchedPattern: null };
  }
  const customHit: string | null = hostWithProvenance(host, matcher.hosts, 'custom');
  if (customHit !== null) {
    return {
      blocked: true,
      reason: 'custom',
      categoryId: null,
      matchedPattern: customHit,
    };
  }
  for (const r of matcher.regexes) {
    if (r.re.test(regexInput)) {
      return { blocked: true, reason: 'custom', categoryId: null, matchedPattern: r.source };
    }
  }
  if (hostInSet(host, matcher.excluded) !== null) return allow('excluded');
  const categoryHit: { matchedPattern: string; categoryId: CategoryId } | null =
    categoryHostWithProvenance(host, matcher.hosts);
  if (categoryHit !== null) {
    return {
      blocked: true,
      reason: 'category',
      categoryId: categoryHit.categoryId,
      matchedPattern: categoryHit.matchedPattern,
    };
  }
  return allow('default');
}
