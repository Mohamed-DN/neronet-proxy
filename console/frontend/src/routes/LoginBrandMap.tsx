import './LoginRoute.css';
import '../charts/TransitMap.css';

/*
 * Three lines meeting at an interchange, drawn with the map's own geometry
 * (0, 45 and 90 degrees, round joins, rings for stations). It is decoration for
 * the sign-in screen, not data: hidden from assistive technology.
 */

const LINES = [
  { colour: 'stroke-line-red', delay: 0, d: 'M20 300H120L240 180H440L500 120' },
  { colour: 'stroke-line-blue', delay: 150, d: 'M300 10V230L350 280V350' },
  { colour: 'stroke-line-green', delay: 300, d: 'M30 40H160L380 260H500' }
] as const;

const STATIONS: ReadonlyArray<readonly [number, number]> = [
  [70, 300],
  [440, 180],
  [300, 80],
  [350, 315],
  [100, 40],
  [380, 260]
];

export function LoginBrandMap({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 360" className={className} aria-hidden="true" focusable="false" data-testid="login-map">
      <g fill="none" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">
        {LINES.map((line) => (
          <path
            key={line.d}
            d={line.d}
            pathLength={1}
            className={`${line.colour} transit-line-draw`}
            style={{ animationDelay: `${line.delay}ms` }}
          />
        ))}
      </g>
      <g className="login-map-stations" strokeWidth="3">
        {STATIONS.map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="6" className="fill-sheet stroke-ink" />
        ))}
        <circle cx="300" cy="180" r="13" strokeWidth="4" className="fill-sheet stroke-ink" />
      </g>
    </svg>
  );
}
