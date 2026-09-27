/**
 * The session length, session type and blocking mode the popup opened with last time.
 *
 * The popup is rebuilt every time it opens, so without this every start began at the middle preset
 * and the Settings default type and mode, whatever was chosen the time before. What is kept is what the
 * person picked, and it is kept on this device only: a choice made for this machine's work is not
 * a default another machine should inherit.
 */
import { isRelativeMinuteDuration } from '../shared/numeric-validation';
import { LOCAL_POPUP_CHOICES } from '../shared/storage-keys';
import type { SessionMode, Strictness } from '../shared/types';
import type { DraftDuration, StartDraft, TimedDurationDraft } from './start-draft';

/** Each half is null when there is nothing usable to restore, and the Settings default stands. */
export interface RememberedChoices {
  duration: DraftDuration | null;
  strictness: Strictness | null;
  mode: SessionMode | null;
}

/** `mode` arrived after the first version was written, so a value without it is still read. */
interface StoredChoicesV1 {
  version: 1;
  duration: DraftDuration;
  strictness: Strictness;
  mode: SessionMode;
}

const STRICTNESSES: readonly Strictness[] = ['flexible', 'friction', 'hard'];
const MODES: readonly SessionMode[] = ['blacklist', 'whitelist'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A timed choice is either one of the presets Settings still offers, or a typed number of
 * minutes. A preset that Settings has since changed is not restored as a stray number: the person
 * picked "the long one", and that button now means something else.
 */
function parseTimed(value: unknown, presets: readonly number[]): TimedDurationDraft | null {
  if (!isRecord(value)) return null;
  const { presetMin, customMin } = value;
  if (typeof customMin !== 'string') return null;
  if (presetMin === null) {
    const minutes: number = Number(customMin);
    return customMin.trim() !== '' && isRelativeMinuteDuration(minutes)
      ? { presetMin: null, customMin }
      : null;
  }
  if (typeof presetMin !== 'number' || customMin !== '') return null;
  return presets.includes(presetMin) ? { presetMin, customMin: '' } : null;
}

function parseDuration(value: unknown, presets: readonly number[]): DraftDuration | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'until-stopped') {
    const timed: TimedDurationDraft | null = parseTimed(value.timed, presets);
    // The timed choice behind Until stopped is only what comes back when it is switched off, so
    // an unusable one falls back to the middle preset rather than dropping Until stopped itself.
    return {
      kind: 'until-stopped',
      timed: timed ?? { presetMin: presets[1] ?? null, customMin: '' },
    };
  }
  if (value.kind !== 'timed') return null;
  const timed: TimedDurationDraft | null = parseTimed(value, presets);
  return timed === null ? null : { kind: 'timed', ...timed };
}

/** Reads a stored value back, keeping each half that is still valid and nothing it cannot read. */
export function parseRememberedChoices(
  raw: unknown,
  presets: readonly number[],
): RememberedChoices | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  return {
    duration: parseDuration(raw.duration, presets),
    strictness: STRICTNESSES.includes(raw.strictness as Strictness)
      ? (raw.strictness as Strictness)
      : null,
    mode: MODES.includes(raw.mode as SessionMode) ? (raw.mode as SessionMode) : null,
  };
}

/** Puts the remembered halves on a draft that was built from the Settings defaults. */
export function applyRememberedChoices(draft: StartDraft, choices: RememberedChoices): StartDraft {
  return {
    ...draft,
    duration: choices.duration ?? draft.duration,
    timedStrictness: choices.strictness ?? draft.timedStrictness,
    mode: choices.mode ?? draft.mode,
  };
}

/** What a draft would be remembered as. */
export function choicesOf(draft: StartDraft): StoredChoicesV1 {
  return {
    version: 1,
    duration: structuredClone(draft.duration),
    strictness: draft.timedStrictness,
    mode: draft.mode,
  };
}

/**
 * Remembering is a convenience, so a storage that cannot be read or written costs the person
 * their last choice and nothing more: neither call throws.
 */
export async function loadRememberedChoices(
  presets: readonly number[],
): Promise<RememberedChoices | null> {
  try {
    const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_POPUP_CHOICES);
    return parseRememberedChoices(stored[LOCAL_POPUP_CHOICES], presets);
  } catch {
    return null;
  }
}

export async function saveRememberedChoices(draft: StartDraft): Promise<void> {
  try {
    await chrome.storage.local.set({ [LOCAL_POPUP_CHOICES]: choicesOf(draft) });
  } catch {
    // Nothing to do: the next choice is written the same way.
  }
}
