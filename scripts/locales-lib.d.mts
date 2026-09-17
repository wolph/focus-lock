export interface PlaceholderSpec {
  content: string;
  example?: string;
}
export interface MessageEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, PlaceholderSpec>;
}
export type Catalogue = Record<string, MessageEntry>;
export interface CheckResult {
  errors: string[];
  warnings: string[];
}
export const LOCALES: readonly string[];
export const DEFAULT_LOCALE: string;
export function toBcp47(locale: string): string;
export function readSurfaceFiles(
  root: string,
  locale: string,
): Array<{ surface: string; messages: Catalogue }> | null;
export function mergeSurfaces(surfaces: Array<{ surface: string; messages: Catalogue }>): Catalogue;
export function readCatalogue(root: string, locale: string): Catalogue | null;
export function checkDefault(en: Catalogue): string[];
export function checkTranslation(locale: string, en: Catalogue, catalogue: Catalogue): CheckResult;
export function repairPlaceholders(source: MessageEntry, text: string): string;
export function isPadding(
  locale: string,
  sourceMessage: string,
  translatedMessage: string,
): boolean;
export function unusedKeys(en: Catalogue, roots: readonly string[]): string[];
export interface MergeResult {
  fresh: number;
  carried: number;
  untranslated: number;
  missing: number;
  unknown: string[];
}
export function mergeTranslation(
  root: string,
  locale: string,
  flat: Record<string, string>,
  write: (surface: string, messages: Catalogue) => void,
): MergeResult;
export interface ProgressRow {
  surface: string;
  translated: string;
  missing: number;
  sameAsEnglish: number;
}
export interface Progress {
  rows: ProgressRow[];
  done: number;
  total: number;
}
export function translationProgress(root: string, locale: string): Progress | null;
export function checkLocales(root: string, options?: { complete?: boolean }): CheckResult;
export function generateLocales(root: string, out: string): string[];
