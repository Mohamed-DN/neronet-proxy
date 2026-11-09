/*
 * A line chart drawn as plain SVG, with no charting library. Every word and
 * number comes in as a prop, so the caller decides the copy and the chart only
 * draws. The picture is hidden from assistive technology; the same numbers
 * sit in a visually hidden table with the title as its caption.
 */

export interface LineSeries {
  id: string;
  label: string;
  /** One value per label. null is a gap: the line breaks there, it does not drop to zero. */
  values: Array<number | null>;
  tone: 'chart-1' | 'chart-2';
}

export interface LineChartProps {
  title: string;
  labels: string[];
  series: LineSeries[];
  unit: string;
  height?: number;
}

const WIDTH = 600;
const PAD_X = 40;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function yMax(series: LineSeries[]): number {
  let max = 0;
  for (const s of series) {
    for (const v of s.values) if (v !== null && Number.isFinite(v) && v > max) max = v;
  }
  return max > 0 ? max * 1.1 : 1;
}

function pathFor(values: Array<number | null>, x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

export function LineChart({ title, labels, series, unit, height = 200 }: LineChartProps) {
  const max = yMax(series);
  const innerH = height - PAD_TOP - PAD_BOTTOM;
  const innerW = WIDTH - PAD_X * 2;
  const x = (i: number) => (labels.length <= 1 ? WIDTH / 2 : PAD_X + (i * innerW) / (labels.length - 1));
  const y = (v: number) => PAD_TOP + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const xLabelIndexes = [...new Set([0, Math.floor((labels.length - 1) / 2), labels.length - 1])].filter(
    (i) => i >= 0 && i < labels.length
  );

  return (
    <figure className="m-0">
      <svg aria-hidden="true" viewBox={`0 0 ${WIDTH} ${height}`} className="block h-auto w-full" focusable="false">
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_X}
              x2={WIDTH - PAD_X}
              y1={y(t)}
              y2={y(t)}
              style={{ stroke: 'rgb(var(--color-border-subtle))' }}
              strokeWidth={1}
            />
            <text
              x={PAD_X - 6}
              y={y(t) + 4}
              textAnchor="end"
              className="text-micro tabular-nums"
              style={{ fill: 'rgb(var(--color-content-muted))' }}
            >
              {`${formatValue(t)} ${unit}`}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <path
            key={s.id}
            data-series={s.id}
            d={pathFor(s.values, x, y)}
            fill="none"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ stroke: `rgb(var(--color-${s.tone}))` }}
          />
        ))}
        {xLabelIndexes.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={height - 6}
            textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}
            className="text-micro"
            style={{ fill: 'rgb(var(--color-content-muted))' }}
          >
            {labels[i]}
          </text>
        ))}
      </svg>

      <figcaption>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted">
          {series.map((s) => {
            const last = [...s.values].reverse().find((v): v is number => v !== null);
            return (
              <li key={s.id} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-0.5 w-4"
                  style={{ backgroundColor: `rgb(var(--color-${s.tone}))` }}
                />
                <span>{s.label}</span>
                <span className="tabular-nums">{last === undefined ? '—' : `${formatValue(last)} ${unit}`}</span>
              </li>
            );
          })}
        </ul>
      </figcaption>

      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{unit}</th>
            {series.map((s) => (
              <th key={s.id} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {series.map((s) => {
                const v = s.values[i];
                return <td key={s.id}>{v === null || v === undefined ? '—' : formatValue(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
