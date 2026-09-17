import { expect, test } from './fixtures';
import { type OverflowFinding, overflowFindings } from './overflow-probe';

/**
 * The locale layout spec passes when it finds nothing, which is also what a broken probe reports.
 * This scenario gives the probe one box whose text cannot fit and one that fits comfortably, so a
 * probe that has stopped seeing overflow fails here rather than passing every locale in silence.
 */
test('the overflow probe reports a box its text cannot fit', async ({ context }) => {
  const page = await context.newPage();
  await page.setContent(`
    <div id="fits" style="width:300px">short</div>
    <div id="clips" style="width:60px;overflow:hidden;white-space:nowrap">
      a very long sentence that cannot possibly fit inside sixty pixels
    </div>
  `);
  const findings: OverflowFinding[] = await overflowFindings(page);
  const selectors: string[] = findings.map((finding: OverflowFinding): string => finding.selector);
  expect(selectors).toContain('div#clips');
  expect(selectors).not.toContain('div#fits');
});
