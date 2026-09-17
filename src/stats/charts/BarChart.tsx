import type { JSX } from 'preact';
import { type Dispatch, type StateUpdater, useId, useState } from 'preact/hooks';
import { t } from '../../shared/i18n';
import { ChartTable } from './ChartTable';

export interface ChartDatum {
  label: string;
  value: number;
}

export interface BarChartProps {
  data: ChartDatum[];
  format: (v: number) => string;
  /** accessible chart name, normally matching the surrounding heading */
  label?: string;
  /** CSS color for the marks, one entity per chart */
  color?: string;
  /** quiet first-run line shown when there is nothing to plot */
  emptyLine?: string;
  /** short axis-tick formatter, defaults to the plain number */
  tickFormat?: (v: number) => string;
}

/* Fixed internal geometry, scaled responsively via the viewBox. */
const W: number = 560;
const H: number = 236;
const PAD_LEFT: number = 94;
const PAD_RIGHT: number = 90;
const PAD_TOP: number = 32;
const LABEL_BAND: number = 28;
const BASELINE_Y: number = H - LABEL_BAND;
const PLOT_H: number = BASELINE_Y - PAD_TOP;
const PLOT_W: number = W - PAD_LEFT - PAD_RIGHT;
const CHART_DESCRIPTION: string = t('stats_chart_description_bar');

/** Smallest clean number at or above the max, for a calm axis. */
export function niceMax(maxValue: number): number {
  if (maxValue <= 0) return 1;
  const exp: number = Math.floor(Math.log10(maxValue));
  const base: number = 10 ** exp;
  for (const m of [1, 2, 4, 5, 6, 8]) {
    if (m * base >= maxValue) return m * base;
  }
  return 10 * base;
}

/** Rounded data-end, square baseline: 4px cap radius, clamped on short bars. */
function barPath(x: number, w: number, h: number): string {
  if (h <= 0) return `M ${x} ${BASELINE_Y} h ${w}`;
  const r: number = Math.min(4, w / 2, h);
  const top: number = BASELINE_Y - h;
  return [
    `M ${x} ${BASELINE_Y}`,
    `V ${top + r}`,
    `Q ${x} ${top} ${x + r} ${top}`,
    `H ${x + w - r}`,
    `Q ${x + w} ${top} ${x + w} ${top + r}`,
    `V ${BASELINE_Y}`,
    'Z',
  ].join(' ');
}

export function BarChart(props: BarChartProps): JSX.Element {
  const [hovered, setHovered]: [number | null, Dispatch<StateUpdater<number | null>>] = useState<
    number | null
  >(null);
  const titleId: string = useId();
  const descriptionId: string = useId();
  const data: ChartDatum[] = props.data;
  const emptyLine: string = props.emptyLine ?? t('stats_chart_empty_default');
  if (data.length === 0 || data.every((d: ChartDatum): boolean => d.value <= 0)) {
    return <p class="empty-line">{emptyLine}</p>;
  }
  const color: string = props.color ?? 'var(--attempts-series)';
  const tickFormat: (v: number) => string = props.tickFormat ?? ((v: number): string => String(v));
  const max: number = niceMax(Math.max(...data.map((d: ChartDatum): number => d.value)));
  const ticks: number[] = max >= 2 ? [max / 2, max] : [max];
  const band: number = PLOT_W / data.length;
  const barW: number = Math.min(24, Math.max(2, band - 2));
  const maxIndex: number = data.reduce(
    (best: number, d: ChartDatum, i: number): number =>
      d.value > (data[best]?.value ?? 0) ? i : best,
    0,
  );
  const labelStep: number = Math.ceil(data.length / 5);
  const barX: (i: number) => number = (i: number): number =>
    PAD_LEFT + band * i + (band - barW) / 2;
  const barH: (value: number) => number = (value: number): number => (value / max) * PLOT_H;
  const directLabelAnchor: 'start' | 'middle' | 'end' =
    maxIndex === 0 ? 'start' : maxIndex === data.length - 1 ? 'end' : 'middle';
  const hoveredDatum: ChartDatum | null =
    hovered === null ? (null as ChartDatum | null) : (data[hovered] ?? null);
  return (
    <div class="chart-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        class="chart"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <title id={titleId}>{props.label ?? t('stats_chart_name_bar')}</title>
        <desc id={descriptionId}>{CHART_DESCRIPTION}</desc>
        {ticks.map(
          (t: number): JSX.Element => (
            <g key={t}>
              <line
                class="gridline"
                x1={PAD_LEFT}
                x2={W - PAD_RIGHT}
                y1={BASELINE_Y - (t / max) * PLOT_H}
                y2={BASELINE_Y - (t / max) * PLOT_H}
              />
              <text
                class="axis-text"
                x={PAD_LEFT - 6}
                y={BASELINE_Y - (t / max) * PLOT_H + 3}
                text-anchor="end"
              >
                {tickFormat(t)}
              </text>
            </g>
          ),
        )}
        <line class="baseline" x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={BASELINE_Y} y2={BASELINE_Y} />
        {data.map(
          (d: ChartDatum, i: number): JSX.Element => (
            <path
              key={d.label}
              class={hovered === i ? 'bar-mark hover' : 'bar-mark'}
              d={barPath(barX(i), barW, barH(d.value))}
              data-h={String(barH(d.value))}
              data-label={d.label}
              fill={color}
            />
          ),
        )}
        {data.map((d: ChartDatum, i: number): JSX.Element | null =>
          (data.length - 1 - i) % labelStep === 0 ? (
            <text
              key={d.label}
              class="axis-text"
              x={PAD_LEFT + band * i + band / 2}
              y={H - 8}
              text-anchor="middle"
            >
              {d.label}
            </text>
          ) : null,
        )}
        <text
          class="direct-label"
          x={PAD_LEFT + band * maxIndex + band / 2}
          y={BASELINE_Y - barH(data[maxIndex]?.value ?? 0) - 5}
          text-anchor={directLabelAnchor}
        >
          {props.format(data[maxIndex]?.value ?? 0)}
        </text>
        {data.map(
          (d: ChartDatum, i: number): JSX.Element => (
            // biome-ignore lint/a11y/noStaticElementInteractions: focusable SVG hit target, labeled via aria-label, tooltip mirrors on focus
            <rect
              key={d.label}
              class="bar-hit"
              x={PAD_LEFT + band * i}
              y={PAD_TOP}
              width={band}
              height={PLOT_H}
              fill="transparent"
              tabindex={0}
              aria-label={t('stats_chart_point', { LABEL: d.label, VALUE: props.format(d.value) })}
              onMouseEnter={(): void => setHovered(i)}
              onMouseLeave={(): void => setHovered(null)}
              onFocus={(): void => setHovered(i)}
              onBlur={(): void => setHovered(null)}
            />
          ),
        )}
      </svg>
      {hovered !== null && hoveredDatum !== null ? (
        <div
          class="chart-tooltip"
          style={{
            left: `${((PAD_LEFT + band * hovered + band / 2) / W) * 100}%`,
            top: `${((BASELINE_Y - barH(hoveredDatum.value)) / H) * 100}%`,
          }}
        >
          <strong>{props.format(hoveredDatum.value)}</strong>
          <span>{hoveredDatum.label}</span>
        </div>
      ) : null}
      <ChartTable autoOpenBelow={560} className="chart-table" data={data} format={props.format} />
    </div>
  );
}
