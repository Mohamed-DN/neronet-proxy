import { render, screen } from '@testing-library/react';
import { Link, RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import pkg from '../../package.json';

// The sources, as text. Vite resolves the glob at build time.
const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

describe('React Router 7', () => {
  it('is the only router package and a 7.x release that carries the open-redirect and hydration fixes', () => {
    const deps = pkg.dependencies as Record<string, string>;
    expect(deps).not.toHaveProperty('react-router-dom');
    const range = deps['react-router'] ?? '';
    const [major, minor] = range
      .replace(/^[^\d]*/, '')
      .split('.')
      .map(Number);
    expect(major).toBe(7);
    // 7.18.0 is the first release that patches GHSA-wrjc-x8rr-h8h6 and GHSA-337j-9hxr-rhxg.
    expect(minor).toBeGreaterThanOrEqual(18);
  });

  it('no source file imports the react-router-dom shim', () => {
    const offenders = Object.entries(sources)
      .filter(([file, text]) => !file.endsWith('reactRouter7.test.tsx') && /from\s+['"]react-router-dom['"]/.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('keeps the matched splat when a child link is relative and lets .. leave the route (relativeSplatPath)', () => {
    const router = createMemoryRouter(
      [
        {
          path: '/files/*',
          element: (
            <>
              <Link to="child">down</Link>
              <Link to="..">up</Link>
            </>
          )
        }
      ],
      { initialEntries: ['/files/a/b'] }
    );
    render(<RouterProvider router={router} />);
    expect(screen.getByText('down')).toHaveAttribute('href', '/files/a/b/child');
    expect(screen.getByText('up')).toHaveAttribute('href', '/');
  });
});
