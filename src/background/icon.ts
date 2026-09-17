import type { SessionSnapshot } from '../shared/types';
import { badgeForV2, iconSpecV2 } from './badge-v2';

export interface IconSpec {
  /** The progress arc's colour, already lightened for the green tile by the phase palette. */
  color: string;
  open: boolean;
  progress: number;
  glyph: 'lock' | 'cup';
  ring: boolean;
}

/**
 * The brand tile, drawn at every phase so the toolbar matches the store and install icon.
 *
 * Only the ring carries the phase colour. The tile stays green because that is what people
 * recognise the product by, and the phase still reads without it: the shackle opens when idle, the
 * glyph becomes a cup on a break, and the ring sweeps while a session runs. The badge keeps the
 * phase colour too, so nothing is lost by holding the tile steady.
 */
const TILE_GREEN = '#2ebf58';
const RING_TRACK = '#116331';
const GLYPH_WHITE = '#ffffff';

/** Geometry in sixteenths of the icon, so the numbers read the same at 16 and at 32. */
const TILE = { inset: 0.75, size: 14.5, radius: 3.25 };
const RING = { radius: 6.35, width: 1.05 };
const LOCK = { scale: 1.12, bodyX: 5.75, bodyY: 7.3125, bodyW: 4.5, bodyH: 3.625, bodyR: 0.5625 };
const SHACKLE = { centreY: 6.7, radius: 1.3125, width: 0.82 };
const KEYHOLE = { centreY: 8.6875, radius: 0.425, stemW: 0.4, stemH: 1.15 };

/** Scales a sixteenth-space coordinate about the icon centre, which is where the lock is anchored. */
function about(value: number, scale: number): number {
  return 8 + (value - 8) * scale;
}

export function drawIcon(size: number, spec: IconSpec): ImageData {
  const canvas: OffscreenCanvas = new OffscreenCanvas(size, size);
  // biome-ignore lint/style/noNonNullAssertion: 2d context always exists on a fresh OffscreenCanvas
  const ctx: OffscreenCanvasRenderingContext2D = canvas.getContext('2d')!;
  const u: number = size / 16;
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = 'round';

  drawTile(ctx, u);
  if (spec.ring && spec.progress > 0) drawRing(ctx, u, spec);
  drawShackle(ctx, u, spec);
  drawBody(ctx, u);
  if (spec.glyph === 'cup') drawCup(ctx, u);
  else drawKeyhole(ctx, u);

  return ctx.getImageData(0, 0, size, size);
}

function drawTile(ctx: OffscreenCanvasRenderingContext2D, u: number): void {
  ctx.fillStyle = TILE_GREEN;
  ctx.beginPath();
  ctx.roundRect(TILE.inset * u, TILE.inset * u, TILE.size * u, TILE.size * u, TILE.radius * u);
  ctx.fill();
}

/**
 * The track is a full circle so a short sweep still reads as progress around something, rather than
 * as a stray arc floating on the tile.
 */
function drawRing(ctx: OffscreenCanvasRenderingContext2D, u: number, spec: IconSpec): void {
  ctx.lineWidth = RING.width * u;
  ctx.strokeStyle = RING_TRACK;
  ctx.beginPath();
  ctx.arc(8 * u, 8 * u, RING.radius * u, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.strokeStyle = spec.color;
  ctx.beginPath();
  ctx.arc(8 * u, 8 * u, RING.radius * u, -Math.PI / 2, -Math.PI / 2 + spec.progress * 2 * Math.PI);
  ctx.stroke();
}

/**
 * The shackle hinges on its right foot when open and lifts clear of the body, which is the geometry
 * `padlock.svg` renders for the idle PNG and `docs/site/brand-icon.ts` draws on the site. All three
 * open the same way on purpose, so the icon reads as one thing wherever it appears.
 */
function drawShackle(ctx: OffscreenCanvasRenderingContext2D, u: number, spec: IconSpec): void {
  const centreY: number = about(SHACKLE.centreY, LOCK.scale);
  const radius: number = SHACKLE.radius * LOCK.scale;
  ctx.save();
  if (spec.open) {
    const footX: number = 8 * u + radius * u;
    const footY: number = centreY * u;
    ctx.translate(footX, footY);
    ctx.rotate((-24 * Math.PI) / 180);
    ctx.translate(-footX, -footY);
    ctx.translate(0, -0.75 * LOCK.scale * u);
  }
  ctx.strokeStyle = GLYPH_WHITE;
  ctx.lineWidth = SHACKLE.width * LOCK.scale * u;
  ctx.beginPath();
  ctx.arc(8 * u, centreY * u, radius * u, Math.PI, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

function drawBody(ctx: OffscreenCanvasRenderingContext2D, u: number): void {
  ctx.fillStyle = GLYPH_WHITE;
  ctx.beginPath();
  ctx.roundRect(
    about(LOCK.bodyX, LOCK.scale) * u,
    about(LOCK.bodyY, LOCK.scale) * u,
    LOCK.bodyW * LOCK.scale * u,
    LOCK.bodyH * LOCK.scale * u,
    LOCK.bodyR * LOCK.scale * u,
  );
  ctx.fill();
}

function drawKeyhole(ctx: OffscreenCanvasRenderingContext2D, u: number): void {
  const centreY: number = about(KEYHOLE.centreY, LOCK.scale);
  const radius: number = KEYHOLE.radius * LOCK.scale;
  ctx.fillStyle = TILE_GREEN;
  ctx.beginPath();
  ctx.arc(8 * u, centreY * u, radius * u, 0, 2 * Math.PI);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(
    (8 - (KEYHOLE.stemW * LOCK.scale) / 2) * u,
    centreY * u,
    KEYHOLE.stemW * LOCK.scale * u,
    KEYHOLE.stemH * LOCK.scale * u,
    ((KEYHOLE.stemW * LOCK.scale) / 2) * u,
  );
  ctx.fill();
}

/** A break shows a cup cut out of the lock face, which reads at 16 px where a steam curl does not. */
function drawCup(ctx: OffscreenCanvasRenderingContext2D, u: number): void {
  const top: number = about(KEYHOLE.centreY - 0.45, LOCK.scale);
  ctx.fillStyle = TILE_GREEN;
  ctx.beginPath();
  ctx.roundRect(6.85 * u, top * u, 2.0 * u, 1.55 * u, 0.42 * u);
  ctx.fill();
  ctx.strokeStyle = TILE_GREEN;
  ctx.lineWidth = 0.34 * u;
  ctx.beginPath();
  ctx.arc(8.95 * u, (top + 0.62) * u, 0.52 * u, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
}

/** Renders and applies icon plus badge. Never throws: an icon render must not kill a tick. */
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
