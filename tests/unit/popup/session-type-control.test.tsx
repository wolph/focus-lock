/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import type { VNode } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionTypeControl } from '../../../src/popup/SessionTypeControl';
import type { Strictness } from '../../../src/shared/types';

const EXPLANATIONS: Record<Strictness, string> = {
  flexible: 'End the session immediately whenever you choose.',
  friction: 'Ending early requires a 10-second wait. No typing is required.',
  hard: 'The session cannot end early. Site access credit still works.',
};

function SessionTypes({
  delayMs = 10_000,
  requireTypedPhrase = false,
}: {
  delayMs?: number;
  requireTypedPhrase?: boolean;
}): VNode {
  return (
    <SessionTypeControl
      value="flexible"
      frictionDelayMs={delayMs}
      requireTypedPhrase={requireTypedPhrase}
      onChange={vi.fn<(value: Strictness) => void>()}
    />
  );
}

afterEach((): void => {
  cleanup();
});

describe('SessionTypeControl', (): void => {
  it.each([
    ['Flexible', 'Changes to your rules apply at once.'],
    ['Friction', 'Changes to your rules apply at once. Only ending early costs.'],
    ['Hard lock', 'You can add blocks while it runs. Removals wait until it ends.'],
  ] as const)(
    'says what %s does to a change made while it runs',
    (label: string, edits: string): void => {
      const view = render(<SessionTypes />);
      const choice: HTMLElement = view.getByRole('button', { name: label });

      expect(choice.textContent).toContain(edits);
    },
  );

  it.each([
    ['focus', 'Flexible'],
    ['pointer', 'Friction'],
    ['click', 'Hard lock'],
  ] as const)(
    'uses the %s on the choice itself to reveal its shared explanation',
    async (interaction: 'focus' | 'pointer' | 'click', label: string): Promise<void> => {
      const view = render(<SessionTypes />);
      const button: HTMLButtonElement = view.getByRole('button', {
        name: label,
      }) as HTMLButtonElement;

      if (interaction === 'focus') {
        button.focus();
        fireEvent.focus(button);
      }
      if (interaction === 'pointer') {
        fireEvent.pointerEnter(button.closest('.help-popover') as HTMLElement);
      }
      if (interaction === 'click') fireEvent.click(button);

      const strictness: Strictness =
        label === 'Flexible' ? 'flexible' : label === 'Friction' ? 'friction' : 'hard';
      const tooltip: HTMLElement = await view.findByRole('tooltip');
      expect(tooltip.textContent).toContain(EXPLANATIONS[strictness]);
      expect(button.getAttribute('aria-controls')).toBe(tooltip.id);
    },
  );

  it('makes each choice the selection and disclosure control without extra help buttons', (): void => {
    const onChange = vi.fn<(value: Strictness) => void>();
    const view = render(
      <SessionTypeControl
        value="friction"
        frictionDelayMs={10_000}
        requireTypedPhrase={false}
        onChange={onChange}
      />,
    );
    const hard: HTMLButtonElement = view.getByRole('button', {
      name: 'Hard lock',
    }) as HTMLButtonElement;

    expect(view.getAllByRole('button')).toHaveLength(3);
    expect(view.queryByRole('button', { name: /help/i })).toBeNull();
    expect(view.getByRole('button', { name: 'Friction' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(hard);
    expect(onChange).toHaveBeenCalledWith('hard');
  });

  it('renders Hard lock disabled with a visible reason while it is unavailable', async (): Promise<void> => {
    const onChange = vi.fn<(value: Strictness) => void>();
    const reason: string = 'Hard lock is not available for Until stopped.';
    const view = render(
      <SessionTypeControl
        value="friction"
        frictionDelayMs={10_000}
        requireTypedPhrase={false}
        hardUnavailableReason={reason}
        onChange={onChange}
      />,
    );
    const hard: HTMLButtonElement = view.getByRole('button', {
      name: 'Hard lock',
    }) as HTMLButtonElement;

    expect(view.getAllByRole('button')).toHaveLength(3);
    expect(hard.getAttribute('aria-disabled')).toBe('true');
    expect(hard.textContent).toContain(reason);
    expect(hard.textContent).not.toContain(EXPLANATIONS.hard);

    fireEvent.click(hard);

    expect(onChange).not.toHaveBeenCalled();
    expect((await view.findByRole('tooltip')).textContent).toContain(reason);

    fireEvent.click(view.getByRole('button', { name: 'Flexible' }));

    expect(onChange).toHaveBeenCalledWith('flexible');
    expect(view.getByRole('button', { name: 'Flexible' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('describes the default ten-second gate without claiming typing is required', async (): Promise<void> => {
    const view = render(<SessionTypes />);

    fireEvent.click(view.getByRole('button', { name: 'Friction' }));

    expect((await view.findByRole('tooltip')).textContent).toContain(
      'Ending early requires a 10-second wait. No typing is required.',
    );
  });

  it('derives a configured delay and names the typed-confirmation requirement', async (): Promise<void> => {
    const view = render(<SessionTypes delayMs={30_000} requireTypedPhrase={true} />);

    fireEvent.click(view.getByRole('button', { name: 'Friction' }));

    const text: string = (await view.findByRole('tooltip')).textContent ?? '';
    expect(text).toContain('Ending early requires a 30-second wait and typed confirmation.');
  });
});
