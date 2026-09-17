import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';

type IconSource = {
  name: string;
  sizes: readonly number[];
};

const fixtures: string[] = [];
const SCRIPT_PATH: string = resolve('scripts/gen-icons.mjs');
const ICON_SOURCES: readonly IconSource[] = [
  { name: 'padlock.svg', sizes: [16, 32] },
  { name: 'brand.svg', sizes: [48, 128] },
];
const SOURCE_NAMES: readonly string[] = ICON_SOURCES.map(
  (source: IconSource): string => source.name,
);

function fixture(): string {
  const path: string = mkdtempSync(join(tmpdir(), 'focus-lock-icons-'));
  fixtures.push(path);
  return path;
}

function copySources(iconDirectory: string, names: readonly string[]): void {
  mkdirSync(iconDirectory, { recursive: true });
  for (const name of names) cpSync(join('assets', 'icons', name), join(iconDirectory, name));
}

function generate(cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT_PATH], { cwd, encoding: 'utf8' });
}

type VisibleBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function visibleBounds(png: PNG): VisibleBounds {
  const bounds: VisibleBounds = {
    minX: png.width,
    minY: png.height,
    maxX: -1,
    maxY: -1,
  };

  for (let y: number = 0; y < png.height; y += 1) {
    for (let x: number = 0; x < png.width; x += 1) {
      const alpha: number = png.data.at((y * png.width + x) * 4 + 3) ?? 0;
      if (alpha === 0) continue;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }

  return bounds;
}

afterEach((): void => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('icon generation', () => {
  it('runs generation through build and check', (): void => {
    const packageJson: { engines: { node: string }; scripts: Record<string, string> } = JSON.parse(
      readFileSync('package.json', 'utf8'),
    ) as {
      engines: { node: string };
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['gen-icons']).toBe('node scripts/gen-icons.mjs');
    expect(packageJson.scripts.build).toBe('npm run gen-icons && npm run gen-locales && vite build');
    expect(packageJson.scripts.check).toContain('npm run build');
    expect(packageJson.engines.node).toBe('^22.22.2 || ^24.15.0 || >=26.0.0');
  });

  it('restores stale static icons before build can consume them', (): void => {
    const path: string = fixture();
    const iconDirectory: string = join(path, 'assets', 'icons');
    copySources(iconDirectory, SOURCE_NAMES);
    expect(generate(path).status).toBe(0);
    const iconPaths: string[] = ['idle-16.png', 'idle-128.png'].map((name: string): string =>
      join(iconDirectory, name),
    );
    const expected: Buffer[] = iconPaths.map((iconPath: string): Buffer => readFileSync(iconPath));
    for (const iconPath of iconPaths) writeFileSync(iconPath, Buffer.from('stale'));
    expect(generate(path).status).toBe(0);
    expect(iconPaths.map((iconPath: string): Buffer => readFileSync(iconPath))).toEqual(expected);
  });

  it.each(ICON_SOURCES)('renders $name at its manifest sizes', (source: IconSource): void => {
    const path: string = fixture();
    const iconDirectory: string = join(path, 'assets', 'icons');
    copySources(iconDirectory, SOURCE_NAMES);
    expect(generate(path).status).toBe(0);

    const svg: Buffer = readFileSync(join('assets', 'icons', source.name));
    for (const size of source.sizes) {
      const expected: Buffer = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
        .render()
        .asPng();
      const actual: Buffer = readFileSync(join(iconDirectory, `idle-${size}.png`));
      expect(actual.equals(expected), `idle-${size}.png must render ${source.name}`).toBe(true);
    }
  });

  it('keeps the 128 px visible mark inside the centered 96 px store safe area', (): void => {
    const path: string = fixture();
    const iconDirectory: string = join(path, 'assets', 'icons');
    copySources(iconDirectory, SOURCE_NAMES);

    expect(generate(path).status).toBe(0);

    const icon: Buffer = readFileSync(join(iconDirectory, 'idle-128.png'));
    const png: PNG = PNG.sync.read(icon);
    const bounds: VisibleBounds = visibleBounds(png);
    const safeAreaInset: number = (png.width - 96) / 2;
    const measurements: string = JSON.stringify({
      ...bounds,
      width: bounds.maxX - bounds.minX + 1,
      height: bounds.maxY - bounds.minY + 1,
    });

    expect({ width: png.width, height: png.height, colorType: icon.at(25) }).toEqual({
      width: 128,
      height: 128,
      colorType: 6,
    });
    expect(bounds.maxX, `no visible pixels found: ${measurements}`).toBeGreaterThanOrEqual(0);
    expect(
      bounds.minX >= safeAreaInset &&
        bounds.minY >= safeAreaInset &&
        bounds.maxX < png.width - safeAreaInset &&
        bounds.maxY < png.height - safeAreaInset,
      `visible bounds must fit x/y ${safeAreaInset}..${png.width - safeAreaInset - 1}: ${measurements}`,
    ).toBe(true);
  });

  it.each(SOURCE_NAMES)(
    'exits nonzero before writing any icon when %s is absent',
    (missing: string): void => {
      const path: string = fixture();
      const iconDirectory: string = join(path, 'assets', 'icons');
      copySources(
        iconDirectory,
        SOURCE_NAMES.filter((name: string): boolean => name !== missing),
      );

      expect(generate(path).status).not.toBe(0);
      expect(
        readdirSync(iconDirectory).filter((name: string): boolean => name.endsWith('.png')),
      ).toEqual([]);
    },
  );
});
