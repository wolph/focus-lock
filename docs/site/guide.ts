/** Three prompts beside the pretend browser. Each lights up when the engine reports its beat. */
import type { DemoEvent } from './engine';

interface Beat {
  id: 'start' | 'back' | 'end';
  text: string;
}

const BEATS: readonly Beat[] = [
  {
    id: 'start',
    text: 'Open your Proposal draft, click the Focus Lock icon, name your task, and press Start. The draft becomes your work tab and Headlines locks.',
  },
  {
    id: 'back',
    text: 'Open Headlines and press Back to work. Your draft is right where you left it.',
  },
  { id: 'end', text: 'Open Focus Lock again and end the session when you are done.' },
];

export interface Guide {
  advance(event: DemoEvent): void;
}

export function createGuide(root: HTMLOListElement): Guide {
  const items: Map<Beat['id'], HTMLLIElement> = new Map<Beat['id'], HTMLLIElement>();
  root.innerHTML = '';
  for (const beat of BEATS) {
    const item: HTMLLIElement = document.createElement('li');
    item.className = 'guide-step';
    item.dataset.beat = beat.id;
    item.textContent = beat.text;
    items.set(beat.id, item);
    root.append(item);
  }
  items.get('start')?.classList.add('guide-current');
  // A beat that has already finished stays finished: the engine can emit the same event more than
  // once, and a replay must never hand guide-current back to a beat that is already done.
  const doneBeats: Set<Beat['id']> = new Set<Beat['id']>();
  const done = (id: Beat['id'], next: Beat['id'] | null): void => {
    if (doneBeats.has(id)) return;
    doneBeats.add(id);
    const item: HTMLLIElement | undefined = items.get(id);
    if (item === undefined) return;
    item.classList.remove('guide-current');
    item.classList.add('guide-done');
    if (next !== null && !doneBeats.has(next)) items.get(next)?.classList.add('guide-current');
  };
  return {
    advance: (event: DemoEvent): void => {
      if (event.type === 'sessionStarted') done('start', 'back');
      if (event.type === 'returnedToWork' && doneBeats.has('start')) done('back', 'end');
      if (event.type === 'sessionEnded' && doneBeats.has('back')) done('end', null);
    },
  };
}
