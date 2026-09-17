import type { SessionSnapshot } from '../shared/types';
import { badgeForV2, iconSpecV2 } from './badge-v2';

/**
 * The toolbar icon says one thing: are sites locked right now.
 *
 * It carries no phase colour and no progress ring. Both were legible on the store tile and neither
 * survived the trip down to 16 pixels, where the glyph has about a dozen usable rows and every
 * extra mark costs the shackle the contrast that makes a padlock read as a padlock. The phase and
 * the countdown are the badge's job, and the badge has real estate the icon does not.
 */
export interface IconSpec {
  open: boolean;
}

const LOCK_GREEN = '#2ebf58';
const KEYHOLE_GREEN = '#116331';

/**
 * Geometry in sixteenths of the icon, so the numbers read the same at 16 and at 32.
 *
 * The lock is drawn as large as the canvas allows: the shackle's outer edge sits one sixteenth from
 * the top and the body's foot one sixteenth off the bottom, which is as far as antialiasing lets a
 * shape go before Chrome's own padding starts clipping it.
 */
const BODY = { x: 1.5, y: 6.3, width: 13, height: 9, radius: 2 };
const SHACKLE = { centreY: 6.3, radius: 4.3, width: 2 };
const KEYHOLE = { centreY: 10, radius: 1.15, stemWidth: 0.95, stemHeight: 2.7 };
/**
 * Degrees the shackle swings about its right foot when the lock is open.
 *
 * Positive turns clockwise on a canvas, and the free leg starts to the left of the hinge, so a
 * positive angle is what lifts it clear of the body. A negative one swings it down into the body
 * and the lock reads as shut.
 */
const OPEN_SWING = 30;
/**
 * Sixteenths the open shackle drops before it swings.
 *
 * Swinging the free leg up also lifts the crown of the arc, and at this radius the crown leaves
 * the canvas and Chrome clips it flat. Dropping the whole shackle first buys back exactly that
 * overshoot. The hinge foot ends deeper inside the body, where it is hidden anyway.
 */
const OPEN_DROP = 1.4;

export function drawIcon(size: number, spec: IconSpec): ImageData {
  const canvas: OffscreenCanvas = new OffscreenCanvas(size, size);
  // biome-ignore lint/style/noNonNullAssertion: 2d context always exists on a fresh OffscreenCanvas
  const ctx: OffscreenCanvasRenderingContext2D = canvas.getContext('2d')!;
  const u: number = size / 16;
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = 'round';

  drawShackle(ctx, u, spec);
  drawBody(ctx, u);
  drawKeyhole(ctx, u);

  return ctx.getImageData(0, 0, size, size);
}

/**
 * The shackle hinges on its right foot when open, the same way `padlock.svg` renders the idle PNG
 * and `docs/site/brand-icon.ts` draws the site's mark. All three open the same way on purpose.
 */
function drawShackle(ctx: OffscreenCanvasRenderingContext2D, u: number, spec: IconSpec): void {
  ctx.save();
  if (spec.open) {
    const footX: number = (8 + SHACKLE.radius) * u;
    const footY: number = SHACKLE.centreY * u;
    ctx.translate(0, OPEN_DROP * u);
    ctx.translate(footX, footY);
    ctx.rotate((OPEN_SWING * Math.PI) / 180);
    ctx.translate(-footX, -footY);
  }
  ctx.strokeStyle = LOCK_GREEN;
  ctx.lineWidth = SHACKLE.width * u;
  ctx.beginPath();
  ctx.arc(8 * u, SHACKLE.centreY * u, SHACKLE.radius * u, Math.PI, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

function drawBody(ctx: OffscreenCanvasRenderingContext2D, u: number): void {
  ctx.fillStyle = LOCK_GREEN;
  ctx.beginPath();
  ctx.roundRect(BODY.x * u, BODY.y * u, BODY.width * u, BODY.height * u, BODY.radius * u);
  ctx.fill();
}

/** Cut in the darker brand green rather than punched through, so the lock reads on any toolbar. */
function drawKeyhole(ctx: OffscreenCanvasRenderingContext2D, u: number): void {
  ctx.fillStyle = KEYHOLE_GREEN;
  ctx.beginPath();
  ctx.arc(8 * u, KEYHOLE.centreY * u, KEYHOLE.radius * u, 0, 2 * Math.PI);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(
    (8 - KEYHOLE.stemWidth / 2) * u,
    KEYHOLE.centreY * u,
    KEYHOLE.stemWidth * u,
    KEYHOLE.stemHeight * u,
    (KEYHOLE.stemWidth / 2) * u,
  );
  ctx.fill();
}

/**
 * The toolbar for one snapshot. The drawing and the badge are guarded apart on purpose: drawing
 * needs a canvas and the badge needs nothing, so a worker whose canvas is unavailable still says
 * what the session is doing rather than going silent on both.
 */
export function updateIcon(snapshot: SessionSnapshot, badgeCountdown: boolean): void {
  try {
    const spec: IconSpec = iconSpecV2(snapshot);
    const imageData: Record<number, ImageData> = {
      16: drawIcon(16, spec),
      32: drawIcon(32, spec),
    };
    void chrome.action.setIcon({ imageData }).catch((): undefined => undefined);
  } catch {
    // OffscreenCanvas or action API hiccups must not break the engine, or the badge.
  }
  try {
    const badge: { text: string; color: string } = badgeForV2(snapshot, badgeCountdown);
    void chrome.action.setBadgeText({ text: badge.text }).catch((): undefined => undefined);
    void chrome.action
      .setBadgeBackgroundColor({ color: badge.color })
      .catch((): undefined => undefined);
  } catch {
    // An action API hiccup is not worth a thrown engine commit either.
  }
}
