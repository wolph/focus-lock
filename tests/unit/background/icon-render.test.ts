import { afterEach, describe, expect, it, vi } from 'vitest';
import { iconSpecV2 } from '../../../src/background/badge-v2';
import type { IconSpec } from '../../../src/background/icon';
import { drawIcon, updateIcon } from '../../../src/background/icon';
import { emptySnapshot } from '../../../src/shared/constants';

const LOCK_GREEN: string = '#2ebf58';
const KEYHOLE_GREEN: string = '#116331';

const LOCKED: IconSpec = { open: false };
const UNLOCKED: IconSpec = { open: true };

interface DrawCall {
  name: string;
  args: number[];
  /** The paint and pen in force when the call ran, so a test can say how a shape was drawn. */
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
}

class RecordingContext {
  public readonly calls: DrawCall[] = [];
  public strokeStyle: string = '';
  public fillStyle: string = '';
  public lineWidth: number = 0;
  public lineCap: CanvasLineCap = 'butt';

  private record(name: string, args: number[]): void {
    this.calls.push({
      name,
      args,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
    });
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
  RecordingCanvas.contexts = [];
  vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
  drawIcon(size, spec);
  return RecordingCanvas.contexts.at(-1)?.calls ?? [];
}

/** The shape a paint call closes: the entry drawn immediately before the stroke or fill. */
function painted(
  calls: DrawCall[],
  shape: 'arc' | 'roundRect',
  paint: 'fill' | 'stroke',
): DrawCall[] {
  return calls.filter((call: DrawCall, index: number): boolean => {
    if (call.name !== shape) return false;
    return calls[index + 1]?.name === paint;
  });
}

function colourOf(calls: DrawCall[], call: DrawCall, paint: 'fill' | 'stroke'): string {
  const closing: DrawCall | undefined = calls[calls.indexOf(call) + 1];
  return paint === 'fill' ? (closing?.fillStyle ?? '') : (closing?.strokeStyle ?? '');
}

afterEach((): void => {
  RecordingCanvas.contexts = [];
  vi.unstubAllGlobals();
});

describe('the lock', (): void => {
  it.each([16, 32])(
    'draws a green shackle, body and keyhole at %i pixels',
    (size: number): void => {
      const calls: DrawCall[] = render(size, LOCKED);
      const shackle: DrawCall | undefined = painted(calls, 'arc', 'stroke')[0];
      const body: DrawCall | undefined = painted(calls, 'roundRect', 'fill')[0];
      const bore: DrawCall | undefined = painted(calls, 'arc', 'fill')[0];

      expect(calls[0]?.name).toBe('clearRect');
      expect(colourOf(calls, shackle as DrawCall, 'stroke')).toBe(LOCK_GREEN);
      expect(colourOf(calls, body as DrawCall, 'fill')).toBe(LOCK_GREEN);
      expect(colourOf(calls, bore as DrawCall, 'fill')).toBe(KEYHOLE_GREEN);
    },
  );

  it('fills most of the canvas, which is the whole point of the shape', (): void => {
    const calls: DrawCall[] = render(16, LOCKED);
    const body: DrawCall | undefined = painted(calls, 'roundRect', 'fill')[0];
    const shackle: DrawCall | undefined = painted(calls, 'arc', 'stroke')[0];
    const bodyWidth: number = body?.args[2] ?? 0;
    const bodyBottom: number = (body?.args[1] ?? 0) + (body?.args[3] ?? 0);
    const shackleTop: number =
      (shackle?.args[1] ?? 0) - (shackle?.args[2] ?? 0) - (shackle?.lineWidth ?? 0) / 2;

    expect(bodyWidth).toBeGreaterThanOrEqual(12);
    expect(bodyBottom).toBeGreaterThanOrEqual(15);
    expect(shackleTop).toBeLessThanOrEqual(1.2);
    expect(shackleTop).toBeGreaterThanOrEqual(0);
  });

  it('scales with the icon so 32 is twice 16', (): void => {
    const small: DrawCall[] = render(16, LOCKED);
    const large: DrawCall[] = render(32, LOCKED);
    const smallBody: DrawCall | undefined = painted(small, 'roundRect', 'fill')[0];
    const largeBody: DrawCall | undefined = painted(large, 'roundRect', 'fill')[0];

    expect((largeBody?.args[2] ?? 0) / (smallBody?.args[2] ?? 1)).toBeCloseTo(2, 6);
  });
});

describe('locked and unlocked', (): void => {
  it('swings the shackle only when open', (): void => {
    const locked: DrawCall[] = render(32, LOCKED);
    const unlocked: DrawCall[] = render(32, UNLOCKED);

    expect(locked.some((call: DrawCall): boolean => call.name === 'rotate')).toBe(false);
    expect(unlocked.some((call: DrawCall): boolean => call.name === 'rotate')).toBe(true);
  });

  it('swings the free leg upward rather than down into the body', (): void => {
    const unlocked: DrawCall[] = render(32, UNLOCKED);
    const turn: DrawCall | undefined = unlocked.find(
      (call: DrawCall): boolean => call.name === 'rotate',
    );

    // Canvas y grows downward, so a positive angle turns clockwise and lifts a leg that starts on
    // the left of the hinge. A negative one buried it in the body and the lock read as shut.
    expect(turn?.args[0]).toBeGreaterThan(0);
  });

  it('drops the shackle before swinging so the crown is not clipped away', (): void => {
    const unlocked: DrawCall[] = render(32, UNLOCKED);
    const rotateAt: number = unlocked.findIndex(
      (call: DrawCall): boolean => call.name === 'rotate',
    );
    const drop: DrawCall | undefined = unlocked
      .slice(0, rotateAt)
      .filter((call: DrawCall): boolean => call.name === 'translate')
      .find((call: DrawCall): boolean => call.args[0] === 0 && (call.args[1] ?? 0) > 0);

    expect(drop).toBeDefined();
  });

  it('leaves the body and keyhole alone when the lock opens', (): void => {
    const locked: DrawCall[] = render(32, LOCKED);
    const unlocked: DrawCall[] = render(32, UNLOCKED);

    expect(painted(unlocked, 'roundRect', 'fill')[0]?.args).toEqual(
      painted(locked, 'roundRect', 'fill')[0]?.args,
    );
    expect(painted(unlocked, 'arc', 'fill')[0]?.args).toEqual(
      painted(locked, 'arc', 'fill')[0]?.args,
    );
  });

  it('reports the requested size back to the caller', (): void => {
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const image: ImageData = drawIcon(32, LOCKED);

    expect(image.width).toBe(32);
    expect(image.height).toBe(32);
  });
});

describe('what the shackle follows', (): void => {
  function snapshotFor(phase: 'focus' | 'break' | 'paused'): Parameters<typeof iconSpecV2>[0] {
    return {
      ...emptySnapshot(30_000),
      lifecycle: {
        kind: 'active',
        endAuthority: { kind: 'immediate', actionLabel: 'End session' },
      },
      phase,
      phaseStartedAt: 0,
      phaseEndsAt: 60_000,
    };
  }

  it('shuts the lock only while a focus phase is blocking sites', (): void => {
    expect(iconSpecV2(snapshotFor('focus')).open).toBe(false);
    expect(iconSpecV2(snapshotFor('break')).open).toBe(true);
    expect(iconSpecV2(snapshotFor('paused')).open).toBe(true);
    expect(iconSpecV2(emptySnapshot(0)).open).toBe(true);
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
