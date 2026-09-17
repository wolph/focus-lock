import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ArchiveEntryFixture,
  createFixture,
  distArchiveEntries,
  readSubmissionManifest,
  runValidator,
  validManifest,
  validSubmissionManifest,
  write,
  writeArchive,
  writeJson,
  writePackageManifest,
  writePng,
} from './store-package-fixture';

const SCRIPT_PATH: string = resolve('scripts/validate-store-package.mjs');
/**
 * Every test here builds a fixture on disk and spawns the script under test, which costs about a
 * second on an idle machine and five to ten seconds when the full suite runs this file alongside
 * everything else. The default budget is five seconds, so these tests passed alone and failed in
 * full runs. The budget is stated once for the file rather than per test, and it is thirty times
 * the measured idle cost, which is the contention headroom the release gate needs.
 */
vi.setConfig({ testTimeout: 30_000 });

const fixtures: string[] = [];

function fixture(): string {
  const path: string = mkdtempSync(join(tmpdir(), 'focus-lock-store-package-'));
  fixtures.push(path);
  createFixture(path);
  return path;
}

function validate(cwd: string, args: string[] = []): ReturnType<typeof runValidator> {
  return runValidator(SCRIPT_PATH, cwd, args);
}

function output(result: ReturnType<typeof runValidator>): string {
  return `${result.stdout}\n${result.stderr}`;
}

function expectValidationFailure(cwd: string, message: RegExp, args: string[] = []): void {
  const result: ReturnType<typeof runValidator> = validate(cwd, args);
  expect(result.status).not.toBe(0);
  expect(output(result)).not.toMatch(/MODULE_NOT_FOUND/u);
  expect(output(result)).toMatch(message);
}

function mutateSubmission(
  root: string,
  mutate: (submission: Record<string, unknown>) => void,
): void {
  const submission: Record<string, unknown> = readSubmissionManifest(root) as unknown as Record<
    string,
    unknown
  >;
  mutate(submission);
  writeJson(join(root, 'store', 'submission-manifest.json'), submission);
}

function mutateManifest(root: string, mutate: (manifest: Record<string, unknown>) => void): void {
  const manifest: Record<string, unknown> = validManifest();
  mutate(manifest);
  writeJson(join(root, 'dist', 'manifest.json'), manifest);
}

function packageArchive(root: string, entries: ArchiveEntryFixture[]): void {
  const zipPath: string = writeArchive(root, entries);
  writePackageManifest(root, zipPath);
}

afterEach((): void => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('submission manifest and assets', (): void => {
  // Builds a complete release fixture on disk, so it needs more than the default timeout.
  it('accepts a valid release fixture with optional all-sites access and no key', (): void => {
    const result: ReturnType<typeof runValidator> = validate(fixture());
    expect(result.status, output(result)).toBe(0);
  });

  it.each(['public-extension-identity', '', null])(
    'rejects any manifest key field (%s)',
    (key: unknown): void => {
      const root: string = fixture();
      mutateManifest(root, (manifest: Record<string, unknown>): void => {
        manifest.key = key;
      });
      const result: ReturnType<typeof runValidator> = validate(root);
      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('manifest key is forbidden');
    },
  );

  it('allows the optional marquee asset to be omitted', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      delete submission.marquee;
    });
    rmSync(join(root, 'store', 'assets', 'marquee-1400x560.png'));
    const result: ReturnType<typeof runValidator> = validate(root);
    expect(result.status, output(result)).toBe(0);
  });

  it.each([
    ['schemaVersion', '1'],
    ['version', 1],
    ['shortDescription', null],
    ['privacyPolicyUrl', []],
    ['permissions', 'storage'],
    ['optionalHostPermissions', {}],
    ['screenshots', null],
    ['smallPromo', 440],
    ['marquee', true],
    ['icon128', false],
    ['transportAllowlist', {}],
  ])('rejects an invalid %s type', (key: string, value: unknown): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission[key] = value;
    });
    expectValidationFailure(root, new RegExp(key, 'i'));
  });

  it.each([
    'schemaVersion',
    'version',
    'shortDescription',
    'privacyPolicyUrl',
    'permissions',
    'optionalHostPermissions',
    'screenshots',
    'smallPromo',
    'icon128',
    'transportAllowlist',
  ])('rejects a missing %s key', (key: string): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      delete submission[key];
    });
    expectValidationFailure(root, new RegExp(key, 'i'));
  });

  it('rejects an extra submission manifest key', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.supportUrl = 'https://example.com';
    });
    expectValidationFailure(root, /keys|extra|supportUrl/i);
  });

  it('rejects an unsupported submission schema version', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.schemaVersion = 2;
    });
    expectValidationFailure(root, /schemaVersion/i);
  });

  it('rejects malformed transport allowlist entries', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.transportAllowlist = [
        {
          file: 'src/background/index.ts',
          identifier: 'fetch',
          justification: 'reviewed',
          extra: true,
        },
      ];
    });
    expectValidationFailure(root, /transportAllowlist/i);
  });

  it('rejects a missing screenshot', (): void => {
    const root: string = fixture();
    rmSync(join(root, 'store', 'assets', 'screenshots', '03-onboarding.png'));
    expectValidationFailure(root, /03-onboarding\.png|screenshot/i);
  });

  it('rejects an extra screenshot in the manifest', (): void => {
    const root: string = fixture();
    writePng(join(root, 'store', 'assets', 'screenshots', '06-extra.png'), 1280, 800);
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.screenshots = [
        ...(submission.screenshots as string[]),
        'store/assets/screenshots/06-extra.png',
      ];
    });
    expectValidationFailure(root, /screenshots/i);
  });

  it('rejects an unlisted screenshot file', (): void => {
    const root: string = fixture();
    writePng(join(root, 'store', 'assets', 'screenshots', '06-extra.png'), 1280, 800);
    expectValidationFailure(root, /06-extra\.png|screenshots/i);
  });

  it('rejects reordered screenshots', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      const screenshots: string[] = submission.screenshots as string[];
      submission.screenshots = [screenshots[1], screenshots[0], ...screenshots.slice(2)];
    });
    expectValidationFailure(root, /screenshots/i);
  });

  it.each([
    ['screenshot', 'store/assets/screenshots/02-blocked-page.png', 1279, 800],
    ['small promo', 'store/assets/small-promo-440x280.png', 441, 280],
    ['marquee', 'store/assets/marquee-1400x560.png', 1400, 559],
    ['icon', 'assets/icons/idle-128.png', 128, 127],
  ])(
    'rejects wrong %s dimensions',
    (_asset: string, path: string, width: number, height: number): void => {
      const root: string = fixture();
      writePng(join(root, path), width, height);
      expectValidationFailure(root, /dimensions|width|height/i);
    },
  );

  it.each(['crc', 'truncated', 'trailing'])('rejects a PNG with %s data', (fault: string): void => {
    const root: string = fixture();
    const path: string = join(root, 'store', 'assets', 'small-promo-440x280.png');
    const original: Buffer = readFileSync(path);
    if (fault === 'crc') {
      const corrupt: Buffer = Buffer.from(original);
      corrupt[29] = (corrupt[29] ?? 0) ^ 1;
      write(path, corrupt);
    } else if (fault === 'truncated') {
      write(path, original.subarray(0, original.length - 8));
    } else {
      write(path, Buffer.concat([original, Buffer.from('trailing')]));
    }
    expectValidationFailure(root, /PNG|CRC|trailing|truncated|asset/i);
  });

  it('rejects an asset path that escapes the project root', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.icon128 = '../outside.png';
    });
    expectValidationFailure(root, /icon128|outside|relative|escape/i);
  });

  it('rejects a symbolic-link asset', (): void => {
    const root: string = fixture();
    const iconPath: string = join(root, 'assets', 'icons', 'idle-128.png');
    const targetPath: string = join(root, 'outside.png');
    writePng(targetPath, 128, 128);
    rmSync(iconPath);
    symlinkSync(targetPath, iconPath);
    expectValidationFailure(root, /symbolic link|symlink/i);
  });

  it('rejects a hard-linked asset', (): void => {
    const root: string = fixture();
    const iconPath: string = join(root, 'assets', 'icons', 'idle-128.png');
    const targetPath: string = join(root, 'outside.png');
    rmSync(iconPath);
    writePng(targetPath, 128, 128);
    linkSync(targetPath, iconPath);
    expectValidationFailure(root, /hard link/i);
  });
});

describe('built manifest and transport policy', (): void => {
  it('rejects a version mismatch', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.version = '0.2.0';
    });
    expectValidationFailure(root, /version/i);
  });

  it('rejects a non-Chrome version before it reaches the ZIP path', (): void => {
    const root: string = fixture();
    mutateManifest(root, (manifest: Record<string, unknown>): void => {
      manifest.version = '../outside';
    });
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.version = '../outside';
    });
    expectValidationFailure(root, /version.*numeric|Chrome.*version/i);
  });

  it('resolves a localised description through the default locale catalogue', (): void => {
    const root: string = fixture();
    const description: string = validManifest().description as string;
    mutateManifest(root, (manifest: Record<string, unknown>): void => {
      manifest.description = '__MSG_app_description__';
      manifest.default_locale = 'en';
    });
    mkdirSync(join(root, 'dist', '_locales', 'en'), { recursive: true });
    writeJson(join(root, 'dist', '_locales', 'en', 'messages.json'), {
      app_description: { message: description },
    });
    const result: ReturnType<typeof runValidator> = validate(root);
    expect(output(result)).not.toMatch(/shortDescription/u);
  });

  it('rejects a localised description the default locale does not define', (): void => {
    const root: string = fixture();
    mutateManifest(root, (manifest: Record<string, unknown>): void => {
      manifest.description = '__MSG_app_description__';
      manifest.default_locale = 'en';
    });
    mkdirSync(join(root, 'dist', '_locales', 'en'), { recursive: true });
    writeJson(join(root, 'dist', '_locales', 'en', 'messages.json'), {});
    expectValidationFailure(root, /app_description/u);
  });

  it('rejects a short-description mismatch', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.shortDescription = 'Stale description';
    });
    expectValidationFailure(root, /shortDescription|description/i);
  });

  it('rejects an absent or wrong privacy URL', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.privacyPolicyUrl = '';
    });
    expectValidationFailure(root, /privacyPolicyUrl|privacy/i);
  });

  it.each(['permissions', 'optionalHostPermissions'])(
    'rejects a %s mismatch',
    (field: string): void => {
      const root: string = fixture();
      mutateSubmission(root, (submission: Record<string, unknown>): void => {
        submission[field] = [...(submission[field] as string[]), 'bookmarks'];
      });
      expectValidationFailure(root, new RegExp(field, 'i'));
    },
  );

  it('rejects required all-sites host permissions', (): void => {
    const root: string = fixture();
    mutateManifest(root, (manifest: Record<string, unknown>): void => {
      manifest.host_permissions = ['<all_urls>'];
    });
    expectValidationFailure(root, /required.*all-sites|host_permissions|optional/i);
  });

  it('rejects static content scripts with all-sites matches', (): void => {
    const root: string = fixture();
    mutateManifest(root, (manifest: Record<string, unknown>): void => {
      manifest.content_scripts = [{ matches: ['http://*/*', 'https://*/*'], js: ['content.js'] }];
    });
    expectValidationFailure(root, /content_scripts|all-sites|optional/i);
  });

  it.each([
    ['host_permissions', '<all_urls>'],
    ['content_scripts', {}],
    ['icons', []],
  ])('rejects an invalid built manifest %s container', (field: string, value: unknown): void => {
    const root: string = fixture();
    mutateManifest(root, (manifest: Record<string, unknown>): void => {
      manifest[field] = value;
    });
    expectValidationFailure(root, new RegExp(`${field}.*(array|object)`, 'i'));
  });

  it.each([
    ['fetch', "fetch('https://example.com/data');"],
    ['XMLHttpRequest', 'new XMLHttpRequest();'],
    ['WebSocket', "new WebSocket('wss://example.com/socket');"],
    ['EventSource', "new EventSource('https://example.com/events');"],
    ['sendBeacon', "navigator.sendBeacon('https://example.com/data', 'x');"],
  ])('rejects authored source transport %s', (identifier: string, source: string): void => {
    const root: string = fixture();
    write(join(root, 'src', 'transport.ts'), `${source}\n`);
    expectValidationFailure(root, new RegExp(identifier, 'i'));
  });

  it.each([
    ['fetch', "fetch('https://example.com/data');"],
    ['XMLHttpRequest', 'new XMLHttpRequest();'],
    ['WebSocket', "new WebSocket('wss://example.com/socket');"],
    ['EventSource', "new EventSource('https://example.com/events');"],
    ['sendBeacon', "navigator.sendBeacon('https://example.com/data', 'x');"],
  ])('rejects shipped JavaScript transport %s', (identifier: string, source: string): void => {
    const root: string = fixture();
    write(join(root, 'dist', 'assets', 'transport.js'), `${source}\n`);
    expectValidationFailure(root, new RegExp(identifier, 'i'));
  });

  const FAVICON_SOURCE: string = [
    'const ports = {',
    '  url: (pageUrl: string): string => {',
    "    const url: URL = new URL(chrome.runtime.getURL('/_favicon/'));",
    "    url.searchParams.set('pageUrl', pageUrl);",
    '    return url.href;',
    '  },',
    '  fetch: (url: string, signal: AbortSignal): Promise<Response> =>',
    "    fetch(url, { signal, credentials: 'omit', redirect: 'error' }),",
    '};',
    'export function icon(pageUrl: string, signal: AbortSignal): Promise<Response> {',
    '  return ports.fetch(ports.url(pageUrl), signal);',
    '}',
    '',
  ].join('\n');
  const FAVICON_BUNDLE: string = [
    'const p = {',
    '  url: (u) => { const x = new URL(chrome.runtime.getURL("/_favicon/")); x.searchParams.set("pageUrl", u); return x.href; },',
    '  fetch: (u, s) => fetch(u, { signal: s, credentials: "omit", redirect: "error" }),',
    '};',
    'export function icon(u, s) { return p.fetch(p.url(u), s); }',
    '',
  ].join('\n');
  const FAVICON_FILE: string = 'src/background/work-tab-icons.ts';

  function exemptFavicon(root: string, source: string = FAVICON_SOURCE): void {
    write(join(root, 'src', 'background', 'work-tab-icons.ts'), source);
    write(join(root, 'dist', 'assets', 'background.js'), FAVICON_BUNDLE);
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.extensionOriginFetch = [
        { file: FAVICON_FILE, reason: 'Reads favicons through the extension origin.' },
      ];
    });
  }

  it('accepts a listed extension-origin favicon fetch in source and bundle', (): void => {
    const root: string = fixture();
    exemptFavicon(root);
    const result: ReturnType<typeof runValidator> = validate(root);
    expect(result.status, output(result)).toBe(0);
  });

  it('rejects the favicon fetch when the source file is not listed', (): void => {
    const root: string = fixture();
    exemptFavicon(root);
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      delete submission.extensionOriginFetch;
    });
    expectValidationFailure(
      root,
      /Forbidden product-data transport identifier: src\/background\/work-tab-icons\.ts:fetch/u,
    );
  });

  it('rejects a listed file that carries a remote URL', (): void => {
    const root: string = fixture();
    exemptFavicon(root, `const mirror = 'https://example.com/icons';\n${FAVICON_SOURCE}`);
    expectValidationFailure(root, /must not carry a remote URL/u);
  });

  it.each([
    ['credentials', "fetch(url, { signal, redirect: 'error' })"],
    ['redirect', "fetch(url, { signal, credentials: 'omit' })"],
    ['an options object', 'fetch(url)'],
  ])('rejects a listed file whose fetch lacks %s', (_case: string, call: string): void => {
    const root: string = fixture();
    exemptFavicon(
      root,
      FAVICON_SOURCE.replace(
        "fetch(url, { signal, credentials: 'omit', redirect: 'error' })",
        call,
      ),
    );
    expectValidationFailure(root, /credentials 'omit' and redirect 'error'/u);
  });

  it('rejects a listed file that also uses another transport', (): void => {
    const root: string = fixture();
    exemptFavicon(root, `${FAVICON_SOURCE}new XMLHttpRequest();\n`);
    expectValidationFailure(root, /may only use fetch/u);
  });

  it('rejects a listed file that never builds the favicon address', (): void => {
    const root: string = fixture();
    exemptFavicon(root, FAVICON_SOURCE.replace("'/_favicon/'", "'/icons/'"));
    expectValidationFailure(root, /must build chrome\.runtime\.getURL/u);
  });

  it('rejects a listed file that does not exist', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.extensionOriginFetch = [
        { file: 'src/background/missing.ts', reason: 'Reads favicons.' },
      ];
    });
    expectValidationFailure(root, /does not exist/u);
  });

  it('rejects a shipped bundle with more fetch call sites than the listed sources', (): void => {
    const root: string = fixture();
    exemptFavicon(root);
    write(join(root, 'dist', 'assets', 'popup.js'), FAVICON_BUNDLE);
    expectValidationFailure(root, /fetch call sites/u);
  });

  it('rejects a shipped fetch that is not the favicon read even when a source is listed', (): void => {
    const root: string = fixture();
    exemptFavicon(root);
    write(
      join(root, 'dist', 'assets', 'background.js'),
      "fetch('https://example.com/data', { credentials: 'omit', redirect: 'error' });\n",
    );
    expectValidationFailure(root, /not the extension-origin favicon read/u);
  });

  it.each([
    ['a non-array', {}],
    ['an entry with extra keys', [{ file: 'src/a.ts', reason: 'x', extra: true }]],
    ['an entry without a reason', [{ file: 'src/a.ts' }]],
    ['a file outside src', [{ file: 'scripts/a.mjs', reason: 'x' }]],
    ['a traversal path', [{ file: 'src/../a.ts', reason: 'x' }]],
    [
      'too many entries',
      Array.from({ length: 5 }, (_value: unknown, index: number) => ({
        file: `src/${index}.ts`,
        reason: 'x',
      })),
    ],
  ])('rejects extensionOriginFetch as %s', (_case: string, value: unknown): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.extensionOriginFetch = value;
    });
    expectValidationFailure(root, /extensionOriginFetch/u);
  });

  it('rejects transport code in shipped inline scripts', (): void => {
    const root: string = fixture();
    write(
      join(root, 'dist', 'src', 'popup', 'popup.html'),
      '<!doctype html><html><body><script>navigator.sendBeacon("/data")</script></body></html>',
    );
    expectValidationFailure(root, /sendBeacon/i);
  });

  it.each(['globalThis', 'window', 'self'])(
    'rejects %s computed access to a forbidden transport API',
    (receiver: string): void => {
      const root: string = fixture();
      write(join(root, 'src', 'computed-transport.ts'), `${receiver}['fetch']('/data');\n`);
      expectValidationFailure(root, /fetch/i);
    },
  );

  it.each([
    [
      'an aliased global receiver with a computed property',
      "const browserGlobal = globalThis; browserGlobal['fetch']('/data');\n",
    ],
    ['a template-literal property', "globalThis[`fetch`]('/data');\n"],
    ['an escaped identifier', "f\\u0065tch('/data');\n"],
    ['a called property on an arbitrary receiver', "labels['fetch']('/data');\n"],
  ])('rejects transport through %s', (_case: string, source: string): void => {
    const root: string = fixture();
    write(join(root, 'src', 'transport.ts'), source);
    expectValidationFailure(root, /fetch|transport/i);
  });

  it.each([
    ['a destructured global alias', "const { fetch: request } = globalThis; request('/data');\n"],
    [
      'a destructured global alias with a default',
      "const { fetch: request = () => undefined } = globalThis; request('/data');\n",
    ],
  ])('rejects transport through %s', (_case: string, source: string): void => {
    const root: string = fixture();
    write(join(root, 'src', 'destructured-transport.ts'), source);
    expectValidationFailure(root, /fetch|transport/i);
  });

  it('allows a harmless computed transport label', (): void => {
    const root: string = fixture();
    write(join(root, 'src', 'labels.ts'), "const label = labels['fetch'];\n");
    const result: ReturnType<typeof runValidator> = validate(root);
    expect(result.status, output(result)).toBe(0);
  });

  it('rejects transport code after a string ending in an escaped backslash', (): void => {
    const root: string = fixture();
    write(join(root, 'src', 'escaped-string.ts'), "const slash = '\\\\'; fetch('/data');\n");
    expectValidationFailure(root, /fetch/i);
  });

  it('rejects transport code inside a template interpolation', (): void => {
    const root: string = fixture();
    const source: string = ['const data = `', '$', "{fetch('/data')}`;\n"].join('');
    write(join(root, 'src', 'template-transport.ts'), source);
    expectValidationFailure(root, /fetch/i);
  });

  it('rejects transport code after a regular expression containing slashes', (): void => {
    const root: string = fixture();
    write(
      join(root, 'src', 'regex-transport.ts'),
      "const url = /https?:\\/\\//u; fetch('/data');\n",
    );
    expectValidationFailure(root, /fetch/i);
  });

  it('rejects every non-empty transport allowlist', (): void => {
    const root: string = fixture();
    write(
      join(root, 'src', 'reviewed-navigation.ts'),
      "fetch('https://example.com/navigation');\n",
    );
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.transportAllowlist = [
        {
          file: 'src/reviewed-navigation.ts',
          identifier: 'fetch',
          justification: 'Reviewed browser navigation only',
        },
      ];
    });
    expectValidationFailure(root, /transportAllowlist.*empty|transport.*forbidden/i);
  });

  it('rejects a stale transport allowlist entry', (): void => {
    const root: string = fixture();
    mutateSubmission(root, (submission: Record<string, unknown>): void => {
      submission.transportAllowlist = [
        {
          file: 'src/background/index.ts',
          identifier: 'fetch',
          justification: 'No longer present',
        },
      ];
    });
    expectValidationFailure(root, /stale|not observed|transportAllowlist/i);
  });

  it('does not scan tests, scripts, Markdown, CSS, or harmless literals', (): void => {
    const root: string = fixture();
    const harmless: string =
      "const labels = 'fetch XMLHttpRequest WebSocket EventSource sendBeacon https://example.com';\n";
    write(join(root, 'src', 'labels.ts'), harmless);
    write(join(root, 'src', 'template-labels.ts'), 'const labels = `fetch WebSocket`;\n');
    write(
      join(root, 'src', 'remote-code-copy.ts'),
      "const example = \"import('https://example.com/app.js')\";\n// import('https://example.com/comment.js')\n",
    );
    write(join(root, 'tests', 'transport.test.ts'), "fetch('https://example.com');\n");
    write(join(root, 'scripts', 'transport.mjs'), "fetch('https://example.com');\n");
    write(join(root, 'README.md'), 'fetch XMLHttpRequest WebSocket EventSource sendBeacon\n');
    write(
      join(root, 'src', 'style.css'),
      '/* fetch XMLHttpRequest WebSocket EventSource sendBeacon */\n',
    );
    const result: ReturnType<typeof runValidator> = validate(root);
    expect(result.status, output(result)).toBe(0);
  });

  it.each(['manifest worker', 'remote script', 'dynamic import'])(
    'rejects remote executable code in %s',
    (kind: string): void => {
      const root: string = fixture();
      if (kind === 'manifest worker') {
        mutateManifest(root, (manifest: Record<string, unknown>): void => {
          manifest.background = { service_worker: 'https://example.com/worker.js' };
        });
      } else if (kind === 'remote script') {
        write(
          join(root, 'dist', 'src', 'popup', 'popup.html'),
          '<!doctype html><html><body><script src="https://example.com/app.js"></script></body></html>',
        );
      } else {
        write(join(root, 'dist', 'assets', 'popup.js'), "import('https://example.com/app.js');\n");
      }
      expectValidationFailure(root, /remote executable|remote code|https:\/\//i);
    },
  );

  it('rejects a bare static HTTPS import', (): void => {
    const root: string = fixture();
    write(join(root, 'dist', 'assets', 'remote.js'), "import 'https://example.com/app.js';\n");
    expectValidationFailure(root, /remote executable|remote code|https:\/\//i);
  });

  it('rejects a multiline static HTTPS import', (): void => {
    const root: string = fixture();
    write(
      join(root, 'dist', 'assets', 'remote.js'),
      "import {\n  remoteFeature,\n} from 'https://example.com/app.js';\n",
    );
    expectValidationFailure(root, /remote executable|remote code|https:\/\//i);
  });

  it('rejects an interpolated remote dynamic import', (): void => {
    const root: string = fixture();
    const source: string = [
      "const host = 'example.com'; import(`https://",
      '$',
      '{host}/app.js`);\n',
    ].join('');
    write(join(root, 'dist', 'assets', 'remote.js'), source);
    expectValidationFailure(root, /remote executable|remote code|https:\/\//i);
  });

  it('rejects a protocol-relative remote executable URL', (): void => {
    const root: string = fixture();
    mutateManifest(root, (manifest: Record<string, unknown>): void => {
      manifest.background = { service_worker: '//example.com/worker.js' };
    });
    expectValidationFailure(root, /remote executable|remote code|example\.com/i);
  });

  it('rejects a remote dynamic import through a const URL', (): void => {
    const root: string = fixture();
    write(
      join(root, 'dist', 'assets', 'remote.js'),
      "const remoteUrl = 'https://example.com/app.js';\nvoid import(remoteUrl);\n",
    );
    expectValidationFailure(root, /remote executable|remote code|remoteUrl/i);
  });

  it('rejects a remote Worker through a const URL', (): void => {
    const root: string = fixture();
    write(
      join(root, 'dist', 'assets', 'remote.js'),
      "const remoteUrl = 'https://example.com/worker.js';\nnew Worker(remoteUrl);\n",
    );
    expectValidationFailure(root, /remote executable|remote code|remoteUrl/i);
  });

  it.each([
    [
      'a destructured global alias',
      "const { Worker: W } = globalThis; new W('https://example.com/worker.js');\n",
    ],
    [
      'a destructured global alias with a default',
      "const { Worker: W = class {} } = globalThis; new W('https://example.com/worker.js');\n",
    ],
  ])('rejects a remote Worker through %s', (_case: string, source: string): void => {
    const root: string = fixture();
    write(join(root, 'dist', 'assets', 'remote.js'), source);
    expectValidationFailure(root, /remote executable|remote code|Worker/i);
  });

  it('rejects a remote Worker URL created with new URL', (): void => {
    const root: string = fixture();
    write(
      join(root, 'dist', 'assets', 'remote.js'),
      "const workerUrl = new URL('https://example.com/worker.js', import.meta.url);\nnew Worker(workerUrl);\n",
    );
    expectValidationFailure(root, /remote executable|remote code|workerUrl/i);
  });

  it('rejects a local path resolved against a remote URL base', (): void => {
    const root: string = fixture();
    write(
      join(root, 'dist', 'assets', 'remote.js'),
      "new Worker(new URL('./worker.js', 'https://example.com/'));\n",
    );
    expectValidationFailure(root, /remote executable|remote code|Worker/i);
  });

  it.each([
    ['dynamic import', "let modulePath = './module.js'; void import(modulePath);\n"],
    ['importScripts', "let scriptPath = './helper.js'; importScripts(scriptPath);\n"],
    ['missing importScripts', 'importScripts();\n'],
    ['Worker', "let workerPath = './worker.js'; new Worker(workerPath);\n"],
    ['SharedWorker', "let workerPath = './worker.js'; new SharedWorker(workerPath);\n"],
    ['member operand', "const paths = { worker: './worker.js' }; new Worker(paths.worker);\n"],
  ])('rejects an unknown %s executable operand', (_case: string, source: string): void => {
    const root: string = fixture();
    write(join(root, 'dist', 'assets', 'unknown.js'), source);
    expectValidationFailure(root, /unknown|unverifiable|executable.*operand|cannot prove/i);
  });

  it('rejects any remote importScripts argument', (): void => {
    const root: string = fixture();
    write(
      join(root, 'dist', 'assets', 'remote.js'),
      "importScripts('./local.js', 'https://example.com/remote.js');\n",
    );
    expectValidationFailure(root, /remote executable|remote code|importScripts/i);
  });

  it('resolves shadowed executable bindings in lexical scope', (): void => {
    const root: string = fixture();
    write(
      join(root, 'dist', 'assets', 'local.js'),
      "function start() { const workerUrl = './worker.js'; new Worker(workerUrl); }\nconst workerUrl = 'https://example.com/remote.js';\nvoid start;\nvoid workerUrl;\n",
    );
    const result: ReturnType<typeof runValidator> = validate(root);
    expect(result.status, output(result)).toBe(0);
  });

  it('allows executable operands only when they are proven local', (): void => {
    const root: string = fixture();
    write(
      join(root, 'dist', 'assets', 'local.js'),
      "const workerUrl = new URL('./worker.js', import.meta.url);\nconst modulePath = './module.js';\nnew Worker(workerUrl);\nnew SharedWorker('./shared-worker.js');\nvoid import(modulePath);\nimportScripts('./helper.js');\n",
    );
    const result: ReturnType<typeof runValidator> = validate(root);
    expect(result.status, output(result)).toBe(0);
  });
});

describe('dist tree and ZIP validation', (): void => {
  it.each([
    '.env',
    'signing.pem',
    'private.key',
    'bundle.js.map',
    'feature.test.js',
    'feature.spec.js',
  ])('rejects forbidden dist file %s', (name: string): void => {
    const root: string = fixture();
    write(join(root, 'dist', name), 'forbidden\n');
    expectValidationFailure(root, /forbidden|secret|source map|test/i);
  });

  it('rejects Chrome Web Store listing assets copied into dist', (): void => {
    const root: string = fixture();
    write(join(root, 'dist', 'store', 'assets', 'small-promo-440x280.png'), 'listing asset');
    expectValidationFailure(root, /forbidden|store asset|listing asset/i);
  });

  it('rejects a symbolic link in dist', (): void => {
    const root: string = fixture();
    write(join(root, 'outside.js'), 'outside\n');
    symlinkSync(join(root, 'outside.js'), join(root, 'dist', 'linked.js'));
    expectValidationFailure(root, /symbolic link|symlink/i);
  });

  it('rejects a hard link in dist', (): void => {
    const root: string = fixture();
    linkSync(join(root, 'dist', 'assets', 'background.js'), join(root, 'dist', 'linked.js'));
    expectValidationFailure(root, /hard link/i);
  });

  it('rejects a symbolic-link ancestor in dist', (): void => {
    const root: string = fixture();
    const target: string = join(root, 'outside-assets');
    write(join(target, 'outside.js'), 'outside\n');
    rmSync(join(root, 'dist', 'assets'), { recursive: true });
    symlinkSync(target, join(root, 'dist', 'assets'));
    expectValidationFailure(root, /symbolic link|symlink|outside/i);
  });

  it('validates an exact regular-file ZIP inventory and matching package manifest', (): void => {
    const root: string = fixture();
    packageArchive(root, distArchiveEntries(root));
    const result: ReturnType<typeof runValidator> = validate(root);
    expect(result.status, output(result)).toBe(0);
  });

  it('rejects a package manifest that points at a missing ZIP', (): void => {
    const root: string = fixture();
    writeJson(join(root, 'release', 'package-manifest.json'), {
      version: '0.1.0',
      zipPath: 'release/focus-lock-0.1.0.zip',
      sha256: '0'.repeat(64),
    });
    expectValidationFailure(root, /missing.*ZIP|focus-lock-0\.1\.0\.zip/i);
  });

  it('rejects a current-version ZIP without its package manifest', (): void => {
    const root: string = fixture();
    writeArchive(root, distArchiveEntries(root));
    expectValidationFailure(root, /missing.*package manifest|package-manifest\.json/i);
  });

  it('rejects a ZIP whose entries are not sorted', (): void => {
    const root: string = fixture();
    packageArchive(root, distArchiveEntries(root).reverse());
    expectValidationFailure(root, /ZIP.*order|sorted/i);
  });

  it('rejects a ZIP entry without the fixed 100644 mode', (): void => {
    const root: string = fixture();
    const entries: ArchiveEntryFixture[] = distArchiveEntries(root);
    entries[0] = { ...(entries[0] as ArchiveEntryFixture), mode: 0o100600 };
    packageArchive(root, entries);
    expectValidationFailure(root, /ZIP.*mode|100644/i);
  });

  it.each([
    ['timestamp', { lastModFileDate: ((2001 - 1980) << 9) | (1 << 5) | 1 }],
    ['compression method', { compress: false }],
    ['general-purpose flags', { generalPurposeBitFlag: 0 }],
    ['local extra field', { localExtra: Buffer.from([0xfe, 0xca, 0, 0]) }],
    ['central extra field', { centralExtra: Buffer.from([0xfe, 0xca, 0, 0]) }],
    ['file comment', { fileComment: 'comment' }],
  ])(
    'rejects a ZIP entry with non-generator %s metadata',
    (_case: string, mutation: Partial<ArchiveEntryFixture>): void => {
      const root: string = fixture();
      const entries: ArchiveEntryFixture[] = distArchiveEntries(root);
      entries[0] = { ...(entries[0] as ArchiveEntryFixture), ...mutation };
      packageArchive(root, entries);
      expectValidationFailure(
        root,
        /ZIP.*(timestamp|compression|flag|extra|comment|metadata)|deterministic/i,
      );
    },
  );

  it.each([
    ['version', '0.2.0'],
    ['zipPath', 'release/other.zip'],
    ['sha256', '0'.repeat(64)],
  ])('rejects a package manifest %s mismatch', (key: string, value: string): void => {
    const root: string = fixture();
    const zipPath: string = writeArchive(root, distArchiveEntries(root));
    writePackageManifest(root, zipPath);
    const packagePath: string = join(root, 'release', 'package-manifest.json');
    const packageManifest: Record<string, unknown> = JSON.parse(
      readFileSync(packagePath, 'utf8'),
    ) as Record<string, unknown>;
    packageManifest[key] = value;
    writeJson(packagePath, packageManifest);
    expectValidationFailure(root, new RegExp(key, 'i'));
  });

  it.each([
    ['missing key', { version: '0.1.0', zipPath: 'release/focus-lock-0.1.0.zip' }],
    [
      'extra key',
      {
        version: '0.1.0',
        zipPath: 'release/focus-lock-0.1.0.zip',
        sha256: '0'.repeat(64),
        size: 1,
      },
    ],
  ])('rejects a package manifest with a %s', (_case: string, value: object): void => {
    const root: string = fixture();
    writeJson(join(root, 'release', 'package-manifest.json'), value);
    expectValidationFailure(root, /package manifest|keys|sha256/i);
  });

  it.each([
    [
      'duplicate',
      (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] => [
        ...entries,
        entries[0] as ArchiveEntryFixture,
      ],
    ],
    [
      'absolute',
      (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] => [
        { ...(entries[0] as ArchiveEntryFixture), name: '/manifest.json' },
        ...entries.slice(1),
      ],
    ],
    [
      'dot-dot',
      (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] => [
        { ...(entries[0] as ArchiveEntryFixture), name: '../escape.js' },
        ...entries.slice(1),
      ],
    ],
    [
      'backslash',
      (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] => [
        { ...(entries[0] as ArchiveEntryFixture), name: 'assets\\background.js' },
        ...entries.slice(1),
      ],
    ],
    [
      'directory',
      (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] => [
        ...entries,
        { name: 'empty/', mode: 0o040755 },
      ],
    ],
    [
      'symlink',
      (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] => [
        ...entries,
        { name: 'linked.js', contents: 'target.js', mode: 0o120777 },
      ],
    ],
    [
      'non-regular',
      (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] => [
        ...entries,
        { name: 'pipe', mode: 0o010644 },
      ],
    ],
    [
      'nested root',
      (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] =>
        entries.map(
          (entry: ArchiveEntryFixture): ArchiveEntryFixture => ({
            ...entry,
            name: `dist/${entry.name}`,
          }),
        ),
    ],
    ['missing entry', (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] => entries.slice(1)],
    [
      'extra entry',
      (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] => [
        ...entries,
        { name: 'store/assets/promo.png', contents: 'extra' },
      ],
    ],
    [
      'byte mismatch',
      (entries: ArchiveEntryFixture[]): ArchiveEntryFixture[] =>
        entries.map(
          (entry: ArchiveEntryFixture, index: number): ArchiveEntryFixture =>
            index === 0 ? { ...entry, contents: 'stale bytes' } : entry,
        ),
    ],
  ])(
    'rejects a ZIP with %s',
    (_case: string, mutate: (entries: ArchiveEntryFixture[]) => ArchiveEntryFixture[]): void => {
      const root: string = fixture();
      packageArchive(root, mutate(distArchiveEntries(root)));
      expectValidationFailure(root, /ZIP|archive|entry|inventory|regular|match|unsafe|invalid/i);
    },
  );

  it('rejects an oversized ZIP entry before extraction', (): void => {
    const root: string = fixture();
    const entries: ArchiveEntryFixture[] = distArchiveEntries(root);
    entries[0] = {
      ...(entries[0] as ArchiveEntryFixture),
      contents: 'x',
      declaredUncompressedSize: 17 * 1024 * 1024,
    };
    packageArchive(root, entries);
    expectValidationFailure(root, /size|large|limit|ZIP/i);
  });

  it('rejects an oversized compressed ZIP before reading it', (): void => {
    const root: string = fixture();
    const zipPath: string = join(root, 'release', 'focus-lock-0.1.0.zip');
    write(zipPath, '');
    truncateSync(zipPath, 64 * 1024 * 1024 + 1);
    writeJson(join(root, 'release', 'package-manifest.json'), {
      version: '0.1.0',
      zipPath: 'release/focus-lock-0.1.0.zip',
      sha256: '0'.repeat(64),
    });

    expectValidationFailure(root, /ZIP.*compressed size|ZIP.*size limit/i);
  });

  it('rejects a suspicious ZIP compression ratio', (): void => {
    const root: string = fixture();
    const entries: ArchiveEntryFixture[] = distArchiveEntries(root);
    entries[0] = {
      ...(entries[0] as ArchiveEntryFixture),
      contents: Buffer.alloc(2 * 1024 * 1024),
      compress: true,
    };
    packageArchive(root, entries);
    expectValidationFailure(root, /compression|ratio|ZIP/i);
  });

  it('rejects a ZIP entry with a mismatched CRC-32 checksum', (): void => {
    const root: string = fixture();
    const entries: ArchiveEntryFixture[] = distArchiveEntries(root);
    entries[0] = {
      ...(entries[0] as ArchiveEntryFixture),
      declaredCrc32: 0,
    };
    packageArchive(root, entries);
    expectValidationFailure(root, /CRC|checksum|ZIP/i);
  });
});

describe('package creation and repository integration', (): void => {
  it('rejects unknown CLI arguments', (): void => {
    expectValidationFailure(fixture(), /unknown.*argument|usage/i, ['--output', 'release.zip']);
  });

  it('rejects a release-directory symlink before creating external files', (): void => {
    const root: string = fixture();
    const outside: string = mkdtempSync(join(tmpdir(), 'focus-lock-store-package-outside-'));
    fixtures.push(outside);
    symlinkSync(outside, join(root, 'release'));

    const result: ReturnType<typeof runValidator> = validate(root, ['--zip']);

    expect(result.status).not.toBe(0);
    expect(output(result)).toMatch(/release|output|symbolic link|symlink/i);
    expect(existsSync(join(outside, 'focus-lock-0.1.0.zip'))).toBe(false);
    expect(existsSync(join(outside, 'package-manifest.json'))).toBe(false);
    expect(lstatSync(join(root, 'release')).isSymbolicLink()).toBe(true);
  });

  it.each([
    ['focus-lock-0.1.0.zip', 'ZIP'],
    ['package-manifest.json', 'package manifest'],
  ])(
    'rejects a symlinked %s output without replacing it',
    (fileName: string, label: string): void => {
      const root: string = fixture();
      const outside: string = mkdtempSync(join(tmpdir(), 'focus-lock-store-package-target-'));
      fixtures.push(outside);
      const externalTarget: string = join(outside, fileName);
      write(externalTarget, 'user data\n');
      write(join(root, 'release', '.keep'), '');
      const outputPath: string = join(root, 'release', fileName);
      symlinkSync(externalTarget, outputPath);

      const result: ReturnType<typeof runValidator> = validate(root, ['--zip']);

      expect(result.status).not.toBe(0);
      expect(output(result)).toMatch(new RegExp(`${label}|output|symbolic link|symlink`, 'i'));
      expect(readFileSync(externalTarget, 'utf8')).toBe('user data\n');
      expect(lstatSync(outputPath).isSymbolicLink()).toBe(true);
    },
  );

  it('creates byte-reproducible validated ZIPs and exact package metadata', (): void => {
    const root: string = fixture();
    const first: ReturnType<typeof runValidator> = runValidator(SCRIPT_PATH, root, ['--zip'], {
      TZ: 'UTC',
    });
    expect(first.status, output(first)).toBe(0);
    const zipPath: string = join(root, 'release', 'focus-lock-0.1.0.zip');
    const firstZip: Buffer = readFileSync(zipPath);
    const firstHash: string = createHash('sha256').update(firstZip).digest('hex');

    const second: ReturnType<typeof runValidator> = runValidator(SCRIPT_PATH, root, ['--zip'], {
      TZ: 'America/Los_Angeles',
    });
    expect(second.status, output(second)).toBe(0);
    const secondZip: Buffer = readFileSync(zipPath);
    const secondHash: string = createHash('sha256').update(secondZip).digest('hex');
    expect(secondZip).toEqual(firstZip);
    expect(secondHash).toBe(firstHash);
    expect(
      JSON.parse(readFileSync(join(root, 'release', 'package-manifest.json'), 'utf8')),
    ).toEqual({
      version: '0.1.0',
      zipPath: 'release/focus-lock-0.1.0.zip',
      sha256: firstHash,
    });
  });

  it('defines exact package scripts, release ignore, and Vite polyfill configuration', (): void => {
    const packageJson: Record<string, unknown> = JSON.parse(
      readFileSync(resolve('package.json'), 'utf8'),
    ) as Record<string, unknown>;
    const scripts: Record<string, unknown> = packageJson.scripts as Record<string, unknown>;
    expect(scripts.build).toBe('npm run gen-icons && npm run gen-locales && vite build');
    expect(scripts['build:store']).toBe('npm run gen-icons && npm run gen-locales && vite build --mode store');
    expect(scripts.check).toBe(
      'biome check . && tsc --noEmit && npm run check-locales && vitest run && npm run build:store',
    );
    expect(scripts['store:validate']).toBe('node scripts/validate-store-package.mjs');
    expect(scripts['store:package']).toBe(
      'npm run build:store && node scripts/validate-store-package.mjs --zip',
    );
    expect(readFileSync(resolve('.gitignore'), 'utf8').split(/\r?\n/u)).toContain('release/');
    expect(readFileSync(resolve('vite.config.ts'), 'utf8')).toMatch(
      /modulePreload:\s*\{\s*polyfill:\s*false\s*\}/u,
    );
  });

  it('keeps the repository submission transport allowlist empty', (): void => {
    expect(validSubmissionManifest().transportAllowlist).toEqual([]);
    const actual: Record<string, unknown> = JSON.parse(
      readFileSync(resolve('store/submission-manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(actual.transportAllowlist).toEqual([]);
  });
});
