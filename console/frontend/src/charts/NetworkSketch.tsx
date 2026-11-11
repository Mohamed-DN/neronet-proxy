import { useId } from 'react';

import { useMeasuredWidth } from './useMeasuredWidth';

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

const FALLBACK_WIDTH = 480;
const HEIGHT = 280;
const CY = 140;
const RY = 82;
const LABEL_CHARS = 12;
// Body-sized text, fixed in pixels: the viewBox is the drawn width (see useMeasuredWidth).
const TEXT_PX = 13;
// Room each side for the longest label, about 12 characters at 13 px.
const LABEL_ROOM = 92;
const MIN_RX = 56;

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
  const [frameRef, width] = useMeasuredWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const CX = width / 2;
  const RX = Math.max(MIN_RX, width / 2 - LABEL_ROOM);
  const ordered = [...sites].sort((a, b) => b.total - a.total);
  const shown = ordered.slice(0, maxSites);
  const hidden = ordered.length - shown.length;
  const placed = shown.map((site, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / shown.length;
    return {
      site,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
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

      <div ref={frameRef} className="mt-3 w-full">
        <svg
          role="img"
          aria-labelledby={captionId}
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block max-w-full"
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
            data-center-label
            x={CX}
            y={CY + 24}
            textAnchor="middle"
            style={{
              fill: 'rgb(var(--color-content))',
              fontSize: TEXT_PX,
              // A halo in the page colour keeps the spokes from running through the words.
              stroke: 'rgb(var(--color-surface))',
              strokeWidth: 5,
              paintOrder: 'stroke',
              strokeLinejoin: 'round'
            }}
          >
            {centerLabel}
          </text>

          {placed.map(({ site, x, y, r, cos, sin }) => {
            const live = site.live > 0;
            // The label sits outside its circle, on the side facing away from the centre.
            const anchor = cos > 0.35 ? 'start' : cos < -0.35 ? 'end' : 'middle';
            const labelX = anchor === 'middle' ? x : x + (r + 6) * Math.sign(cos);
            const labelY = anchor === 'middle' ? (sin < 0 ? y - r - 7 : y + r + 16) : y + 4;
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
                  data-site-label={site.id}
                  x={labelX}
                  y={labelY}
                  textAnchor={anchor}
                  style={{ fill: 'rgb(var(--color-content-muted))', fontSize: TEXT_PX }}
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
              style={{ fill: 'rgb(var(--color-content-muted))', fontSize: TEXT_PX }}
            >
              {moreLabel(hidden)}
            </text>
          ) : null}
        </svg>
      </div>

      <p className="mt-2 text-caption text-muted">{hollowLegend}</p>
    </figure>
  );
}
