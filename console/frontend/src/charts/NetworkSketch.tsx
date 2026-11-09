import { useId } from 'react';

/*
 * A small picture of sub-networks around one centre: one circle per
 * sub-network, sized by how many devices it holds, filled when at least one
 * device is live and hollow with a dashed line when none is. It is a sketch,
 * not a map: positions are even around an ellipse and carry no meaning beyond
 * order. All words come in as props.
 */

export interface SketchSite {
  id: string;
  label: string;
  /** Devices in the site. Sizes the circle. */
  total: number;
  /** Devices in the site that are live. Zero draws the site hollow. */
  live: number;
}

export interface NetworkSketchProps {
  title: string;
  description: string;
  centerLabel: string;
  sites: SketchSite[];
  maxSites?: number;
  moreLabel: (hidden: number) => string;
  hollowLegend: string;
}

const WIDTH = 320;
const HEIGHT = 200;
const CX = WIDTH / 2;
const CY = HEIGHT / 2 - 6;
const RX = 120;
const RY = 70;
const LABEL_CHARS = 12;

function shortLabel(label: string): string {
  return label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label;
}

export function NetworkSketch({
  title,
  description,
  centerLabel,
  sites,
  maxSites = 12,
  moreLabel,
  hollowLegend
}: NetworkSketchProps) {
  const captionId = useId();
  const ordered = [...sites].sort((a, b) => b.total - a.total);
  const shown = ordered.slice(0, maxSites);
  const hidden = ordered.length - shown.length;
  const placed = shown.map((site, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / shown.length;
    return {
      site,
      x: CX + RX * Math.cos(angle),
      y: CY + RY * Math.sin(angle),
      r: 3 + Math.min(5, Math.sqrt(Math.max(0, site.total)))
    };
  });

  return (
    <figure className="m-0">
      <figcaption id={captionId}>
        <h2 className="text-heading font-medium text-content">{title}</h2>
        <p className="mt-1 text-caption text-muted">{description}</p>
      </figcaption>

      <svg
        role="img"
        aria-labelledby={captionId}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-3 block h-auto w-full"
        focusable="false"
      >
        {placed.map(({ site, x, y }) => (
          <line
            key={`line-${site.id}`}
            data-site-line={site.id}
            x1={CX}
            y1={CY}
            x2={x}
            y2={y}
            strokeWidth={1}
            strokeDasharray={site.live === 0 ? '4 3' : undefined}
            style={{ stroke: 'rgb(var(--color-border-strong))' }}
          />
        ))}

        <circle cx={CX} cy={CY} r={6} style={{ fill: 'rgb(var(--color-content))' }} />
        <text
          x={CX}
          y={CY + 20}
          textAnchor="middle"
          className="text-micro"
          style={{ fill: 'rgb(var(--color-content-muted))' }}
        >
          {centerLabel}
        </text>

        {placed.map(({ site, x, y, r }) => {
          const live = site.live > 0;
          return (
            <g key={site.id} data-site={site.id} data-live={String(live)}>
              <circle
                cx={x}
                cy={y}
                r={r}
                strokeWidth={live ? 0 : 1.5}
                style={
                  live
                    ? { fill: 'rgb(var(--color-content))' }
                    : { fill: 'rgb(var(--color-surface-raised))', stroke: 'rgb(var(--color-border-strong))' }
                }
              />
              <text
                x={x}
                y={y + r + 11}
                textAnchor="middle"
                className="text-micro"
                style={{ fill: 'rgb(var(--color-content-muted))' }}
              >
                <title>{site.label}</title>
                {shortLabel(site.label)}
              </text>
            </g>
          );
        })}

        {hidden > 0 ? (
          <text
            x={CX}
            y={HEIGHT - 4}
            textAnchor="middle"
            className="text-micro"
            style={{ fill: 'rgb(var(--color-content-muted))' }}
          >
            {moreLabel(hidden)}
          </text>
        ) : null}
      </svg>

      <p className="mt-2 text-caption text-muted">{hollowLegend}</p>
    </figure>
  );
}
