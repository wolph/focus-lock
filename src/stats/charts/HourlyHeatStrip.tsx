import type { JSX } from 'preact';
import { t, tPlural } from '../../shared/i18n';
import type { ChartDatum } from './BarChart';
import { ChartTable } from './ChartTable';

export interface HourlyHeatStripProps {
  values: number[];
}

const HOURS_PER_DAY: number = 24;
const ACCESSIBLE_NAME: string = t('stats_heat_strip_label');
/** The width the bar charts open their tables at, so every chart agrees. */
const AUTO_OPEN_BELOW_PX: number = 560;

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export function HourlyHeatStrip(props: HourlyHeatStripProps): JSX.Element {
  const values: number[] = Array.from(
    { length: HOURS_PER_DAY },
    (_unused: unknown, hour: number): number => Math.max(0, props.values[hour] ?? 0),
  );
  const maximum: number = Math.max(1, ...values);

  return (
    <div class="chart-wrap hourly-heat-wrap">
      <div class="heat-strip" role="img" aria-label={ACCESSIBLE_NAME}>
        {values.map((value: number, hour: number): JSX.Element => {
          const label: string = hourLabel(hour);
          return (
            <span
              class="heat-cell"
              data-hour={label}
              style={`--intensity: ${value / maximum}`}
              key={label}
            >
              <span class="heat-cell-label">{String(hour).padStart(2, '0')}</span>
            </span>
          );
        })}
      </div>
      {/*
       * The same table the bar charts use, including its narrow-width opening. This is the one
       * chart that prints no values at all, so it is the one whose table matters most: the strip
       * carries everything through `--intensity` and an `aria-label` with no data in it.
       */}
      <ChartTable
        autoOpenBelow={AUTO_OPEN_BELOW_PX}
        className="chart-table"
        data={values.map(
          (value: number, hour: number): ChartDatum => ({ label: hourLabel(hour), value }),
        )}
        format={(value: number): string => tPlural('stats_blocked_count', value)}
      />
    </div>
  );
}
