import { afterEach, describe, expect, it, vi } from 'vitest';
import { iconSpecV2 } from '../../../src/background/badge-v2';
import type { IconSpec } from '../../../src/background/icon';
import { drawIcon, updateIcon } from '../../../src/background/icon';
import { emptySnapshot } from '../../../src/shared/constants';

const TILE_GREEN: string = '#2ebf58';
const RING_TRACK: string = '#116331';
const GLYPH_WHITE: string = '#ffffff';

interface DrawCall {
  name: string;
  args: number[];
  /** The paint in force when the call ran, so a test can say which colour drew which shape. */
  fillStyle: string;
  strokeStyle: string;
}

class RecordingContext {
  public readonly calls: DrawCall[] = [];
  public strokeStyle: string = '';
  public fillStyle: string = '';
  public lineWidth: number = 0;
  public lineCap: CanvasLineCap = 'butt';

  private record(name: string, args: number[]): void {
    this.calls.push({ name, args, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle });
  }

  public clearRect(...args: number[]): void {
    this.record('clearRect', args);
  }

  public save(): void {
    this.record('save', []);
  }

  public restore(): void {
    this.record('restore', []);
  }

  public translate(...args: number[]): void {
    this.record('translate', args);
  }

  public rotate(...args: number[]): void {
    this.record('rotate', args);
  }

  public beginPath(): void {
    this.record('beginPath', []);
  }

  public arc(...args: number[]): void {
    this.record('arc', args);
  }

  public roundRect(...args: number[]): void {
    this.record('roundRect', args);
  }

  public stroke(): void {
    this.record('stroke', []);
  }

  public fill(): void {
    this.record('fill', []);
  }

  public getImageData(_x: number, _y: number, width: number, height: number): ImageData {
    const data: Uint8ClampedArray = new Uint8ClampedArray(width * height * 4);
    return { data, width, height } as unknown as ImageData;
  }
}

class RecordingCanvas {
  public static contexts: RecordingContext[] = [];
  private readonly context: RecordingContext = new RecordingContext();

  public constructor(_width: number, _height: number) {
    RecordingCanvas.contexts.push(this.context);
  }

  public getContext(_kind: '2d'): RecordingContext {
    return this.context;
  }
}

function render(size: number, spec: IconSpec): DrawCall[] {
  vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
  drawIcon(size, spec);
  return RecordingCanvas.contexts.at(-1)?.calls ?? [];
}

/** The shape that a paint call closes: the entry drawn immediately before the stroke or fill. */
function painted(
  calls: DrawCall[],
  shape: 'arc' | 'roundRect',
  paint: 'fill' | 'stroke',
): DrawCall[] {
  return calls.filter((call: DrawCall, index: number): boolean => {
    if (call.name !== shape) return false;
    const next: DrawCall | undefined = calls[index + 1];
    return next?.name === paint;
  });
}

function colourOf(calls: DrawCall[], call: DrawCall, paint: 'fill' | 'stroke'): string {
  const index: number = calls.indexOf(call);
  const closing: DrawCall | undefined = calls[index + 1];
  return paint === 'fill' ? (closing?.fillStyle ?? '') : (closing?.strokeStyle ?? '');
}

function activeSpec(phase: 'focus' | 'break'): IconSpec {
  // The projection only draws a ring for an active lifecycle, so the fixture carries one. The v1
  // projection this used to call read the phase fields without that guard and is gone.
  return iconSpecV2({
    ...emptySnapshot(30_000),
    lifecycle: { kind: 'active', endAuthority: { kind: 'immediate', actionLabel: 'End session' } },
    phase,
    phaseStartedAt: 0,
    phaseEndsAt: 60_000,
  });
}

const IDLE_SPEC: IconSpec = {
  color: '#e5e7eb',
  open: true,
  progress: 0,
  glyph: 'lock',
  ring: false,
};

afterEach((): void => {
  RecordingCanvas.contexts = [];
  vi.unstubAllGlobals();
});

describe('brand tile', (): void => {
  it.each([16, 32])(
    'fills a green tile before anything else at %i pixels',
    (size: number): void => {
      const calls: DrawCall[] = render(size, activeSpec('focus'));
      const unit: number = size / 16;
      const tile: DrawCall | undefined = painted(calls, 'roundRect', 'fill')[0];

      expect(calls[0]?.name).toBe('clearRect');
      expect(tile).toBeDefined();
      expect(tile?.args[0]).toBeCloseTo(0.75 * unit, 6);
      expect(tile?.args[2]).toBeCloseTo(14.5 * unit, 6);
      expect(tile?.args[3]).toBeCloseTo(14.5 * unit, 6);
      expect(colourOf(calls, tile as DrawCall, 'fill')).toBe(TILE_GREEN);
    },
  );

  it('paints the tile in every phase, which is what "green everywhere" means', (): void => {
    for (const spec of [IDLE_SPEC, activeSpec('focus'), activeSpec('break')]) {
      const calls: DrawCall[] = render(32, spec);
      const tile: DrawCall | undefined = painted(calls, 'roundRect', 'fill')[0];

      expect(colourOf(calls, tile as DrawCall, 'fill')).toBe(TILE_GREEN);
      RecordingCanvas.contexts = [];
    }
  });

  it('draws the padlock body in white on top of the tile', (): void => {
    const calls: DrawCall[] = render(32, activeSpec('focus'));
    const body: DrawCall | undefined = painted(calls, 'roundRect', 'fill')[1];

    expect(body).toBeDefined();
    expect(colourOf(calls, body as DrawCall, 'fill')).toBe(GLYPH_WHITE);
  });
});

describe('progress ring', (): void => {
  it('draws a full track and a sweep proportional to progress', (): void => {
    const spec: IconSpec = { ...activeSpec('focus'), progress: 0.25 };
    const calls: DrawCall[] = render(32, spec);
    const arcs: DrawCall[] = painted(calls, 'arc', 'stroke');
    const track: DrawCall | undefined = arcs[0];
    const sweep: DrawCall | undefined = arcs[1];

    expect(colourOf(calls, track as DrawCall, 'stroke')).toBe(RING_TRACK);
    expect(track?.args[4]).toBeCloseTo(2 * Math.PI, 6);
    expect(colourOf(calls, sweep as DrawCall, 'stroke')).toBe(spec.color);
    expect((sweep?.args[4] ?? 0) - (sweep?.args[3] ?? 0)).toBeCloseTo(0.25 * 2 * Math.PI, 6);
    expect(sweep?.args[3]).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('omits the ring entirely when idle', (): void => {
    const calls: DrawCall[] = render(32, IDLE_SPEC);
    const strokedArcs: DrawCall[] = painted(calls, 'arc', 'stroke');

    // Only the shackle remains, and it is white rather than a ring colour.
    expect(strokedArcs).toHaveLength(1);
    expect(colourOf(calls, strokedArcs[0] as DrawCall, 'stroke')).toBe(GLYPH_WHITE);
  });

  it('scales the ring with the icon so 32 is twice 16', (): void => {
    const small: DrawCall[] = render(16, activeSpec('focus'));
    RecordingCanvas.contexts = [];
    const large: DrawCall[] = render(32, activeSpec('focus'));
    const smallTrack: DrawCall | undefined = painted(small, 'arc', 'stroke')[0];
    const largeTrack: DrawCall | undefined = painted(large, 'arc', 'stroke')[0];

    expect((largeTrack?.args[2] ?? 0) / (smallTrack?.args[2] ?? 1)).toBeCloseTo(2, 6);
  });
});

describe('phase glyphs', (): void => {
  it('opens the shackle only when idle', (): void => {
    const idle: DrawCall[] = render(32, IDLE_SPEC);
    RecordingCanvas.contexts = [];
    const running: DrawCall[] = render(32, activeSpec('focus'));

    expect(idle.some((call: DrawCall): boolean => call.name === 'rotate')).toBe(true);
    expect(running.some((call: DrawCall): boolean => call.name === 'rotate')).toBe(false);
  });

  it('draws the cup only for breaks while both phases keep the lock body', (): void => {
    const focus: DrawCall[] = render(16, activeSpec('focus'));
    RecordingCanvas.contexts = [];
    const rest: DrawCall[] = render(16, activeSpec('break'));
    // Both glyphs are cut in the tile colour, so what separates them is how the circle is painted:
    // the keyhole is a filled bore, and the cup's handle is a stroked loop on its side.
    const bore = (calls: DrawCall[]): DrawCall[] =>
      painted(calls, 'arc', 'fill').filter(
        (call: DrawCall): boolean => colourOf(calls, call, 'fill') === TILE_GREEN,
      );
    const handle = (calls: DrawCall[]): DrawCall[] =>
      painted(calls, 'arc', 'stroke').filter(
        (call: DrawCall): boolean => colourOf(calls, call, 'stroke') === TILE_GREEN,
      );

    expect(bore(focus)).toHaveLength(1);
    expect(handle(focus)).toHaveLength(0);
    expect(bore(rest)).toHaveLength(0);
    expect(handle(rest)).toHaveLength(1);
    expect(painted(focus, 'roundRect', 'fill').length).toBeGreaterThanOrEqual(2);
    expect(painted(rest, 'roundRect', 'fill').length).toBeGreaterThanOrEqual(2);
  });

  it('cuts the glyph out of the lock face in the tile colour', (): void => {
    const rest: DrawCall[] = render(32, activeSpec('break'));
    const cup: DrawCall | undefined = painted(rest, 'roundRect', 'fill')[2];

    expect(colourOf(rest, cup as DrawCall, 'fill')).toBe(TILE_GREEN);
  });

  it('reports the requested size back to the caller', (): void => {
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const image: ImageData = drawIcon(32, activeSpec('focus'));

    expect(image.width).toBe(32);
    expect(image.height).toBe(32);
  });
});

describe('action updates', (): void => {
  it('attaches rejection handlers to every action update', async (): Promise<void> => {
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const rejections: Promise<void>[] = [
      Promise.reject(new Error('icon unavailable')),
      Promise.reject(new Error('badge text unavailable')),
      Promise.reject(new Error('badge color unavailable')),
    ];
    const catches: Array<ReturnType<typeof vi.spyOn>> = rejections.map(
      (rejection: Promise<void>): ReturnType<typeof vi.spyOn> => vi.spyOn(rejection, 'catch'),
    );
    vi.stubGlobal('chrome', {
      action: {
        setIcon: vi.fn((): Promise<void> => rejections[0] as Promise<void>),
        setBadgeText: vi.fn((): Promise<void> => rejections[1] as Promise<void>),
        setBadgeBackgroundColor: vi.fn((): Promise<void> => rejections[2] as Promise<void>),
      },
    });

    try {
      updateIcon(emptySnapshot(0), true);
      expect(
        catches.every(
          (catchHandler: ReturnType<typeof vi.spyOn>): boolean =>
            catchHandler.mock.calls.length === 1,
        ),
      ).toBe(true);
      await Promise.resolve();
    } finally {
      await Promise.all(
        rejections.map(
          (rejection: Promise<void>): Promise<void> => rejection.catch((): undefined => undefined),
        ),
      );
    }
  });
});
