import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { ThemeMode } from '../../src/shared/types';
import type { Task7ThemeCase, Task7ThemeSurface } from './task7-evidence';

export interface Task7EvidenceAssertions {
  visibleResponsiveCopies?: number;
}

export interface Task7EvidenceRecord {
  assertions?: Task7EvidenceAssertions;
  buildSource: 'production';
  bytes: number;
  colorScheme: 'dark' | 'light';
  file: string;
  scope: 'focused' | 'full';
  sha256: string;
  state: string;
  surface: Task7ThemeSurface;
  theme: ThemeMode;
  themeCase: Task7ThemeCase['id'];
  viewport: { height: number; width: number };
}

export interface Task7CaptureContext {
  capture(
    target: Locator | Page,
    surface: Task7EvidenceRecord['surface'],
    state: string,
    themeCase: Task7ThemeCase,
    viewport: { height: number; width: number },
    scope: Task7EvidenceRecord['scope'],
    fullPage?: boolean,
    assertions?: Task7EvidenceAssertions,
  ): Promise<void>;
  evidenceDir: string;
  records: Task7EvidenceRecord[];
}

export interface Task7Rectangle {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface Task7ContentIntersection {
  bounds: Task7Rectangle;
  label: string;
  selector: string;
}

export const TASK7_THEME_CASES: readonly Task7ThemeCase[] = [
  { colorScheme: 'light', id: 'auto-light', theme: 'auto' },
  { colorScheme: 'dark', id: 'auto-dark', theme: 'auto' },
  { colorScheme: 'dark', id: 'light-dark-media', theme: 'light' },
  { colorScheme: 'light', id: 'dark-light-media', theme: 'dark' },
];

export const TASK7_PAGE_VIEWPORTS: readonly { height: number; width: number }[] = [
  { height: 667, width: 375 },
  { height: 800, width: 768 },
  { height: 800, width: 1280 },
];

export function task7Metadata(
  themeCase: Task7ThemeCase,
  viewport: { height: number; width: number },
  surface: Task7EvidenceRecord['surface'],
  state: string,
  scope: Task7EvidenceRecord['scope'],
): Omit<Task7EvidenceRecord, 'bytes' | 'file' | 'sha256'> {
  return {
    buildSource: 'production',
    colorScheme: themeCase.colorScheme,
    scope,
    state,
    surface,
    theme: themeCase.theme,
    themeCase: themeCase.id,
    viewport,
  };
}

async function task7FileRecord(
  absolutePath: string,
  metadata: Omit<Task7EvidenceRecord, 'bytes' | 'file' | 'sha256'>,
): Promise<Task7EvidenceRecord> {
  const payload: Buffer = await readFile(absolutePath);
  return {
    ...metadata,
    bytes: (await stat(absolutePath)).size,
    file: path.basename(absolutePath),
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
}

async function captureTask7MatrixEvidence(
  evidenceDir: string,
  target: Locator | Page,
  stem: string,
  metadata: Omit<Task7EvidenceRecord, 'bytes' | 'file' | 'sha256'>,
  fullPage: boolean = false,
): Promise<Task7EvidenceRecord> {
  const absolutePath: string = path.join(path.resolve(evidenceDir), `${stem}.png`);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  if ('page' in target) {
    await target.screenshot({ path: absolutePath, animations: 'disabled' });
  } else {
    await target.screenshot({ path: absolutePath, animations: 'disabled', fullPage });
  }
  return await task7FileRecord(absolutePath, metadata);
}

export async function captureTask7ClipEvidence(
  evidenceDir: string,
  page: Page,
  stem: string,
  metadata: Omit<Task7EvidenceRecord, 'bytes' | 'file' | 'sha256'>,
  clip: { height: number; width: number; x: number; y: number },
): Promise<Task7EvidenceRecord> {
  const absolutePath: string = path.join(path.resolve(evidenceDir), `${stem}.png`);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await page.screenshot({ path: absolutePath, animations: 'disabled', clip });
  return await task7FileRecord(absolutePath, metadata);
}

export function appendTask7Record(
  records: Task7EvidenceRecord[],
  record: Task7EvidenceRecord,
): void {
  records.push(record);
}

export function createTask7CaptureContext(evidenceDir: string): Task7CaptureContext {
  const records: Task7EvidenceRecord[] = [];
  return {
    evidenceDir,
    records,
    capture: async (
      target: Locator | Page,
      surface: Task7EvidenceRecord['surface'],
      state: string,
      themeCase: Task7ThemeCase,
      viewport: { height: number; width: number },
      scope: Task7EvidenceRecord['scope'],
      fullPage: boolean = false,
      assertions?: Task7EvidenceAssertions,
    ): Promise<void> => {
      records.push(
        await captureTask7MatrixEvidence(
          evidenceDir,
          target,
          `task7-production-${surface}-${themeCase.id}-${String(viewport.width)}-${state}-${scope}`,
          { ...task7Metadata(themeCase, viewport, surface, state, scope), assertions },
          fullPage,
        ),
      );
    },
  };
}

export function task7RectanglesIntersect(left: Task7Rectangle, right: Task7Rectangle): boolean {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
}

/**
 * What the element named by `selector` covers up. It was written for the sticky save bar, which
 * floated over the page; it now serves the autosave status and the refusal that took its place,
 * which sit in the flow and must still never land on top of a control.
 */
export async function task7VisibleContentIntersections(
  page: Page,
  selector: string = '.autosave-status',
): Promise<{
  bar: Task7Rectangle;
  targets: Task7ContentIntersection[];
}> {
  return await page.evaluate(
    (
      barSelector: string,
    ): {
      bar: Task7Rectangle;
      targets: Task7ContentIntersection[];
    } => {
      const bar: HTMLElement | null = document.querySelector(barSelector);
      if (bar === null) throw new Error(`No element matches ${barSelector}.`);
      const toBounds = (element: Element): Task7Rectangle => {
        const rect: DOMRect = element.getBoundingClientRect();
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      };
      const intersects = (left: Task7Rectangle, right: Task7Rectangle): boolean =>
        left.left < right.right &&
        left.right > right.left &&
        left.top < right.bottom &&
        left.bottom > right.top;
      const barBounds: Task7Rectangle = toBounds(bar);
      const selectors: readonly string[] = [
        'h1',
        'h2',
        'h3',
        'p',
        '[role="alert"]',
        '[role="status"]',
        'button',
        'input',
        'select',
        'textarea',
        '.cat-row',
        '.category-state',
      ];
      const elements: Set<Element> = new Set(
        selectors.flatMap((selector: string): Element[] => [
          ...document.querySelectorAll(`main ${selector}`),
        ]),
      );
      const targets: Task7ContentIntersection[] = [];
      for (const element of elements) {
        if (bar.contains(element)) continue;
        const style: CSSStyleDeclaration = getComputedStyle(element);
        const bounds: Task7Rectangle = toBounds(element);
        const visibleBounds: Task7Rectangle = {
          bottom: Math.min(bounds.bottom, innerHeight),
          left: Math.max(bounds.left, 0),
          right: Math.min(bounds.right, innerWidth),
          top: Math.max(bounds.top, 0),
        };
        let ancestor: Element | null = element.parentElement;
        while (ancestor !== null && ancestor !== document.documentElement) {
          const ancestorStyle: CSSStyleDeclaration = getComputedStyle(ancestor);
          const clipsX: boolean = ['auto', 'clip', 'hidden', 'scroll'].includes(
            ancestorStyle.overflowX,
          );
          const clipsY: boolean = ['auto', 'clip', 'hidden', 'scroll'].includes(
            ancestorStyle.overflowY,
          );
          if (clipsX || clipsY) {
            const ancestorBounds: Task7Rectangle = toBounds(ancestor);
            if (clipsX) {
              visibleBounds.left = Math.max(visibleBounds.left, ancestorBounds.left);
              visibleBounds.right = Math.min(visibleBounds.right, ancestorBounds.right);
            }
            if (clipsY) {
              visibleBounds.top = Math.max(visibleBounds.top, ancestorBounds.top);
              visibleBounds.bottom = Math.min(visibleBounds.bottom, ancestorBounds.bottom);
            }
          }
          ancestor = ancestor.parentElement;
        }
        const visible: boolean =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          visibleBounds.right > visibleBounds.left &&
          visibleBounds.bottom > visibleBounds.top;
        if (!visible || !intersects(visibleBounds, barBounds)) continue;
        const selector: string =
          element.className === ''
            ? element.tagName.toLowerCase()
            : `${element.tagName.toLowerCase()}.${String(element.className).trim().split(/\s+/).join('.')}`;
        targets.push({
          bounds: visibleBounds,
          label:
            element.getAttribute('aria-label') ??
            (element.classList.contains('category-state')
              ? `${element.previousElementSibling?.textContent?.trim().replace(/\s+/g, ' ') ?? 'Unknown category'} state: ${element.textContent?.trim().replace(/\s+/g, ' ') ?? ''}`
              : element.textContent?.trim().replace(/\s+/g, ' ')) ??
            '',
          selector,
        });
      }
      return { bar: barBounds, targets };
    },
    selector,
  );
}

export async function installTask7DeferredSaveFailure(page: Page): Promise<void> {
  await page.evaluate((): void => {
    const task7Global = globalThis as typeof globalThis & {
      task7FinishSave?: () => void;
      task7OriginalSendMessage?: typeof chrome.runtime.sendMessage;
    };
    const original: typeof chrome.runtime.sendMessage = chrome.runtime.sendMessage.bind(
      chrome.runtime,
    );
    task7Global.task7OriginalSendMessage = original;
    chrome.runtime.sendMessage = (async (...args: unknown[]): Promise<unknown> => {
      const request: unknown = args[0];
      if (
        typeof request !== 'object' ||
        request === null ||
        !('type' in request) ||
        request.type !== 'updateLists'
      ) {
        return await Reflect.apply(original, chrome.runtime, args);
      }
      return await new Promise((resolve: (value: unknown) => void): void => {
        task7Global.task7FinishSave = (): void => {
          resolve({ ok: false, error: 'Task 7 synthetic save rejection.' });
        };
      });
    }) as typeof chrome.runtime.sendMessage;
  });
}

export async function finishTask7DeferredSaveFailure(page: Page): Promise<void> {
  await page.evaluate((): void => {
    const task7Global = globalThis as typeof globalThis & {
      task7FinishSave?: () => void;
      task7OriginalSendMessage?: typeof chrome.runtime.sendMessage;
    };
    if (task7Global.task7FinishSave === undefined) {
      throw new Error('Task 7 deferred save resolver is unavailable.');
    }
    task7Global.task7FinishSave();
    if (task7Global.task7OriginalSendMessage !== undefined) {
      chrome.runtime.sendMessage = task7Global.task7OriginalSendMessage;
    }
    delete task7Global.task7FinishSave;
    delete task7Global.task7OriginalSendMessage;
  });
}
