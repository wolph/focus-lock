import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Comments explain the rules below and name the units they avoid, so they are stripped first. */
const css: string = readFileSync(resolve('src/popup/popup.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function block(selector: string): string {
  const match: RegExpMatchArray | null = new RegExp(
    `(?:^|\\n)${selector.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(css);
  if (match?.[1] === undefined) throw new Error(`no ${selector} block in popup.css`);
  return match[1];
}

/**
 * Chrome measures the toolbar popup before its first layout. A maximum size in viewport units
 * reads that pre-layout viewport and clamps the popup, which the sizing e2e spec measures on the
 * real popup window. This pin keeps the rule readable without a browser.
 */
describe('popup.css sizing', (): void => {
  it('fixes the popup at 480 by 600 with no viewport-unit maximum', (): void => {
    const body: string = block('body');
    expect(body).toMatch(/width:\s*480px/);
    expect(body).toMatch(/max-inline-size:\s*100%/);
    expect(body).toMatch(/block-size:\s*600px/);
    expect(body).not.toMatch(/100vw|100vh/);

    // The block clamp stays in viewport units: it only bites in a short tab viewport, and the
    // body's fixed 600 px keeps the popup's intrinsic height independent of it.
    const app: string = block('.app');
    expect(app).toMatch(/max-inline-size:\s*100%/);
    expect(app).toMatch(/max-block-size:\s*100vh/);
    expect(app).not.toMatch(/100vw/);
  });

  it('never makes the active view or the session actions a scroll container', (): void => {
    // This was a scroller twice and was rejected twice. Content that does not fit is compacted,
    // not scrolled: docs/superpowers/specs/2026-09-17-popup-visibility-rules.md.
    for (const selector of ['.active-view', '.session-actions']) {
      expect(block(selector)).not.toMatch(/overflow-y:\s*(auto|scroll)/);
    }
    expect(block('.active-view')).toMatch(/min-block-size:\s*0/);
    expect(block('.active-view')).toMatch(/flex:\s*1 1 auto/);
  });

  it('paints the work tab chooser with the primary tokens, so it reads as the green action', (): void => {
    for (const selector of [
      '.this-tab-button',
      '.this-tab-button:hover:enabled',
      '.this-tab-button:focus-visible',
    ]) {
      expect(block(selector)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
    expect(block('.this-tab-button')).toMatch(/background:\s*var\(--primary-bg\)/);
    expect(block('.this-tab-button')).toMatch(/color:\s*var\(--primary-text\)/);
    expect(block('.this-tab-button:hover:enabled')).toMatch(/var\(--primary-bg-hover\)/);
    expect(block('.this-tab-button:focus-visible')).toMatch(/var\(--focus-color\)/);
  });
});
