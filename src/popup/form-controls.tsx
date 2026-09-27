import type { VNode } from 'preact';

/** Toggle chip: preset lengths and category pills share this control. */
export function Chip({
  label,
  accessibleLabel,
  hint,
  selected,
  onClick,
}: {
  label: string;
  /** Replaces the visible label as the accessible name, and doubles as the hover title. */
  accessibleLabel?: string;
  /** A hover explanation only. The visible label stays the accessible name. */
  hint?: string;
  selected: boolean;
  onClick: () => void;
}): VNode {
  return (
    <button
      type="button"
      class={selected ? 'chip chip-selected' : 'chip'}
      aria-pressed={selected}
      aria-label={accessibleLabel}
      title={accessibleLabel ?? hint}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * Radio rendered as a chip. The input keeps the radio semantics, the label carries the look, and
 * the hint is a hover explanation: the draft summary beside Start already spells the choice out.
 */
export function RadioChip({
  name,
  label,
  hint,
  checked,
  onSelect,
}: {
  name: string;
  label: string;
  hint: string;
  checked: boolean;
  onSelect: () => void;
}): VNode {
  return (
    <label class={checked ? 'chip chip-selected radio-chip' : 'chip radio-chip'} title={hint}>
      <input
        type="radio"
        class="radio-chip__input"
        name={name}
        checked={checked}
        onChange={onSelect}
      />
      {label}
    </label>
  );
}
