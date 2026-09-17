import { t } from '../shared/i18n';
import type { WorkTab } from '../shared/work-target';
import { WorkTabIcons } from './work-tab-icons';
import { WORK_TARGET_COPY } from './work-tab-picker-view';

const ROW_HEIGHT: number = 80;
const OVERSCAN: number = 3;
interface RenderedRow {
  tab: WorkTab;
  button: HTMLButtonElement;
  badge: HTMLElement;
}

export class WorkTabList {
  readonly element: HTMLElement = document.createElement('div');
  private readonly space: HTMLElement = document.createElement('div');
  private readonly icons: WorkTabIcons;
  private rows: WorkTab[] = [];
  private rendered: Map<number, RenderedRow> = new Map();
  private disabled: boolean = false;
  private frame: number | null = null;
  private observer: ResizeObserver | null = null;
  private closed: boolean = false;
  private readonly schedule: () => void = (): void => {
    if (this.frame !== null || this.closed) return;
    this.frame = window.requestAnimationFrame((): void => {
      this.frame = null;
      this.render();
    });
  };

  constructor(
    sessionId: string,
    private readonly search: HTMLInputElement,
    private readonly select: (tabId: number, row: HTMLButtonElement) => void,
  ) {
    this.icons = new WorkTabIcons(sessionId);
    this.element.className = 'work-picker-list';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', WORK_TARGET_COPY.availableTabs);
    this.space.className = 'work-picker-space';
    this.element.append(this.space);
    this.element.addEventListener('scroll', this.schedule);
    window.addEventListener('resize', this.schedule);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.schedule);
      this.observer.observe(this.element);
    }
  }

  invalidateIcons(): void {
    this.icons.invalidate();
  }

  replace(rows: WorkTab[]): void {
    this.clearRendered();
    this.rows = rows;
    this.element.scrollTop = 0;
    this.space.style.height = `${rows.length * ROW_HEIGHT + 16}px`;
    this.render();
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    for (const row of this.rendered.values()) row.button.disabled = disabled;
  }

  navigate(event: KeyboardEvent): void {
    if (this.disabled || this.rows.length === 0) return;
    if (event.target === this.search) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.focus(0);
      }
      return;
    }
    const target: EventTarget | null = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.rowIndex === undefined) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index: number = Number(target.dataset.rowIndex);
    this.focus(
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? this.rows.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + this.rows.length) % this.rows.length,
    );
  }

  close(): void {
    this.closed = true;
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.element.removeEventListener('scroll', this.schedule);
    window.removeEventListener('resize', this.schedule);
    this.icons.close();
  }

  private height(): number {
    return this.element.clientHeight || Math.min(640, Math.max(160, window.innerHeight - 260));
  }

  private focus(index: number): void {
    const top: number = index * ROW_HEIGHT;
    if (top < this.element.scrollTop || top + ROW_HEIGHT > this.element.scrollTop + this.height())
      this.element.scrollTop = top;
    this.render();
    this.rendered.get(index)?.button.focus({ preventScroll: true });
  }

  private clearRendered(): void {
    const root: Node = this.element.getRootNode();
    if (root instanceof ShadowRoot && this.space.contains(root.activeElement))
      this.search.focus({ preventScroll: true });
    this.rendered.clear();
    this.space.replaceChildren();
    this.icons.show([]);
  }

  private render(): void {
    if (this.closed) return;
    const start: number = Math.max(0, Math.floor(this.element.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end: number = Math.min(
      this.rows.length,
      Math.ceil((this.element.scrollTop + this.height()) / ROW_HEIGHT) + OVERSCAN,
    );
    const root: Node = this.element.getRootNode();
    for (const [index, row] of this.rendered) {
      if (index >= start && index < end) continue;
      if (root instanceof ShadowRoot && root.activeElement === row.button)
        this.search.focus({ preventScroll: true });
      row.button.remove();
      this.rendered.delete(index);
    }
    for (let index: number = start; index < end; index += 1) {
      if (this.rendered.has(index)) continue;
      const tab: WorkTab = this.rows[index] as WorkTab;
      const row: RenderedRow = tabRow(tab, index);
      row.button.disabled = this.disabled;
      row.button.addEventListener('click', (): void => {
        if (!this.disabled) this.select(tab.tabId, row.button);
      });
      this.rendered.set(index, row);
      this.space.append(row.button);
    }
    const visible: RenderedRow[] = Array.from(this.rendered.entries())
      .sort(([a]: [number, RenderedRow], [b]: [number, RenderedRow]): number => a - b)
      .map(([, row]: [number, RenderedRow]): RenderedRow => row);
    let next: ChildNode | null = this.space.firstChild;
    for (const row of visible) {
      if (next === row.button) next = next.nextSibling;
      else this.space.insertBefore(row.button, next);
    }
    this.icons.show(
      visible.map((row: RenderedRow): { tab: WorkTab; badge: HTMLElement } => ({
        tab: row.tab,
        badge: row.badge,
      })),
    );
  }
}

function tabRow(tab: WorkTab, index: number): RenderedRow {
  const button: HTMLButtonElement = document.createElement('button');
  button.type = 'button';
  button.className = 'work-tab-option';
  button.dataset.rowIndex = String(index);
  button.style.top = `${index * ROW_HEIGHT + 8}px`;
  const label: string =
    tab.hostname === undefined
      ? tab.title
      : t('overlay_picker_tab_label', { TITLE: tab.title, HOSTNAME: tab.hostname });
  button.setAttribute('aria-label', label);
  button.title = label;
  button.style.setProperty('--tab-colour', domainColour(tab.hostname ?? ''));
  const badge: HTMLElement = document.createElement('span');
  badge.className = 'work-tab-icon';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = (tab.hostname?.replace(/^www\./, '')[0] ?? tab.title[0] ?? '?').toUpperCase();
  const text: HTMLElement = document.createElement('span');
  text.className = 'work-tab-text';
  const title: HTMLElement = document.createElement('span');
  title.className = 'work-tab-title';
  title.textContent = tab.title;
  const hostname: HTMLElement = document.createElement('span');
  hostname.className = 'work-tab-hostname';
  hostname.textContent = tab.hostname ?? '';
  text.append(title, hostname);
  button.append(badge, text);
  return { tab, button, badge };
}

function domainColour(hostname: string): string {
  let hash: number = 2166136261;
  for (const character of hostname.toLowerCase())
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `hsl(${(hash >>> 0) % 360} 65% 58%)`;
}
