import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, Outlet, createMemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRouter } from './AppRouter';

// A layout that waits for something the first time it renders, the way a layout
// that reads a lazily loaded translation namespace does. It has no Suspense
// boundary of its own and none of its parents do either: that was the portal
// frame (owner report, React error #426 on the first /me/add, 12 November 2026).
let resolveWait: (() => void) | null = null;
let ready = false;
const wait = new Promise<void>((resolve) => {
  resolveWait = () => {
    ready = true;
    resolve();
  };
});

function WaitingLayout() {
  if (!ready) throw wait;
  return (
    <div>
      <p>portal frame</p>
      <Outlet />
    </div>
  );
}

function Crash() {
  return <p>route error shown</p>;
}

function makeRouter() {
  return createMemoryRouter(
    [
      { path: '/', element: <Link to="/me/add">add a device</Link>, errorElement: <Crash /> },
      {
        element: <WaitingLayout />,
        errorElement: <Crash />,
        children: [{ path: '/me/add', element: <p>add device page</p> }]
      }
    ],
    { initialEntries: ['/'] }
  );
}

describe('a layout that suspends during a click navigation', () => {
  it('waits instead of showing the error page, then shows the page', async () => {
    const user = userEvent.setup();
    render(<AppRouter router={makeRouter()} />);

    await user.click(screen.getByText('add a device'));

    expect(screen.queryByText('route error shown')).not.toBeInTheDocument();
    await act(async () => {
      resolveWait?.();
      await wait;
    });
    expect(await screen.findByText('add device page')).toBeInTheDocument();
    expect(screen.queryByText('route error shown')).not.toBeInTheDocument();
  });
});
