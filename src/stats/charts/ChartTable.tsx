import type { JSX, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { t } from '../../shared/i18n';
import type { ChartDatum } from './BarChart';

export interface ChartTableProps {
  className: string;
  data: ChartDatum[];
  format: (value: number) => string;
  autoOpenBelow?: number;
}

export function ChartTable(props: ChartTableProps): JSX.Element {
  const detailsRef: RefObject<HTMLDetailsElement> = useRef<HTMLDetailsElement>(null);
  useEffect((): (() => void) | undefined => {
    const details: HTMLDetailsElement | null = detailsRef.current;
    const container: HTMLElement | null = details?.parentElement ?? null;
    if (
      details === null ||
      container === null ||
      props.autoOpenBelow === undefined ||
      typeof ResizeObserver === 'undefined'
    ) {
      return undefined;
    }
    let belowThreshold: boolean | null = null;
    const update: (width: number) => void = (width: number): void => {
      const below: boolean = width <= (props.autoOpenBelow ?? 0);
      if (below) {
        if (belowThreshold !== true && !details.open) {
          details.open = true;
          details.dataset.autoOpened = 'true';
        }
        belowThreshold = true;
        return;
      }
      if (belowThreshold === true && details.dataset.autoOpened === 'true') {
        details.open = false;
        delete details.dataset.autoOpened;
      }
      belowThreshold = false;
    };
    const observer: ResizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]): void => {
      const entry: ResizeObserverEntry | undefined = entries[0];
      if (entry !== undefined) update(entry.contentRect.width);
    });
    observer.observe(container);
    update(container.getBoundingClientRect().width);
    return (): void => observer.disconnect();
  }, [props.autoOpenBelow]);

  return (
    <details class={props.className} ref={detailsRef}>
      <summary>{t('stats_chart_table_summary')}</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">{t('stats_chart_table_category')}</th>
            <th scope="col">{t('stats_chart_table_value')}</th>
          </tr>
        </thead>
        <tbody>
          {props.data.map(
            (datum: ChartDatum): JSX.Element => (
              <tr key={datum.label}>
                <th scope="row">{datum.label}</th>
                <td>{props.format(datum.value)}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </details>
  );
}
