import { describe, expect, it } from 'vitest';
import {
  applyRememberedChoices,
  parseRememberedChoices,
  type RememberedChoices,
} from '../../../src/popup/remembered-choices';
import { createStartDraft, type StartDraft } from '../../../src/popup/start-draft';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';

const PRESETS: readonly number[] = DEFAULT_SETTINGS.presetsMin;

function draft(): StartDraft {
  return createStartDraft(DEFAULT_SETTINGS, DEFAULT_LISTS);
}

describe('parseRememberedChoices', () => {
  it('reads back a preset length and a session type', () => {
    const stored: unknown = {
      version: 1,
      duration: { kind: 'timed', presetMin: 50, customMin: '' },
      strictness: 'hard',
    };

    expect(parseRememberedChoices(stored, PRESETS)).toEqual({
      duration: { kind: 'timed', presetMin: 50, customMin: '' },
      strictness: 'hard',
    });
  });

  it('reads back a typed length and Until stopped with the timed choice behind it', () => {
    expect(
      parseRememberedChoices(
        {
          version: 1,
          duration: { kind: 'until-stopped', timed: { presetMin: null, customMin: '40' } },
          strictness: 'friction',
        },
        PRESETS,
      ),
    ).toEqual({
      duration: { kind: 'until-stopped', timed: { presetMin: null, customMin: '40' } },
      strictness: 'friction',
    });
  });

  it('keeps the session type when the remembered preset is no longer offered', () => {
    // Settings changed the presets since: the length is dropped, the type still counts.
    expect(
      parseRememberedChoices(
        {
          version: 1,
          duration: { kind: 'timed', presetMin: 45, customMin: '' },
          strictness: 'hard',
        },
        PRESETS,
      ),
    ).toEqual({ duration: null, strictness: 'hard' });
  });

  it('forgets anything it cannot read rather than guessing', () => {
    expect(parseRememberedChoices(undefined, PRESETS)).toBeNull();
    expect(parseRememberedChoices({ version: 2 }, PRESETS)).toBeNull();
    expect(
      parseRememberedChoices({ version: 1, duration: 'long', strictness: 'nope' }, PRESETS),
    ).toEqual({ duration: null, strictness: null });
    expect(
      parseRememberedChoices(
        {
          version: 1,
          duration: { kind: 'timed', presetMin: null, customMin: 'abc' },
          strictness: null,
        },
        PRESETS,
      ),
    ).toEqual({ duration: null, strictness: null });
  });
});

describe('applyRememberedChoices', () => {
  it('puts the remembered length and session type on a fresh draft', () => {
    const choices: RememberedChoices = {
      duration: { kind: 'timed', presetMin: 50, customMin: '' },
      strictness: 'hard',
    };

    const applied: StartDraft = applyRememberedChoices(draft(), choices);

    expect(applied.duration).toEqual({ kind: 'timed', presetMin: 50, customMin: '' });
    expect(applied.timedStrictness).toBe('hard');
    expect(applied.rules).toEqual(draft().rules);
  });

  it('leaves whatever it has nothing for at the Settings default', () => {
    const applied: StartDraft = applyRememberedChoices(draft(), {
      duration: null,
      strictness: 'flexible',
    });

    expect(applied.duration).toEqual(draft().duration);
    expect(applied.timedStrictness).toBe('flexible');
  });
});
