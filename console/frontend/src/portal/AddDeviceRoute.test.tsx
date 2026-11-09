import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations, renderUI } from '../test/harness';
import AddDeviceRoute from './AddDeviceRoute';

const flags = vi.hoisted(() => ({ noCrypto: false }));

// Real key generation everywhere except where a test asks for a browser that cannot make keys.
vi.mock('../devices/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../devices/keys')>();
  return {
    ...actual,
    generateDeviceKeys: async (...args: Parameters<typeof actual.generateDeviceKeys>) => {
      if (flags.noCrypto) throw new actual.KeyGenerationUnavailable();
      return actual.generateDeviceKeys(...args);
    }
  };
});

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async (_value: string, _options: unknown) => 'data:image/png;base64,AAA') }
}));

const DEVICE = {
  device_id: 'dev-1',
  name: 'Work phone',
  overlay_ipv4: '100.64.0.9',
  overlay_ipv6: null,
  gateway: { public_key: 'GATEWAYPUBLICKEY0000000000000000000000000=', endpoint: 'gw.example.net:51820' },
  allowed_ips: ['100.64.0.0/10'],
  dns: ['100.64.0.1'],
  console_url: 'https://console.example.net'
};

function stubRegister(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAdd(theme: 'light' | 'dark' = 'light') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderUI(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/me/add']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/me/add" element={<AddDeviceRoute />} />
          <Route path="/me" element={<p>My devices page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
    { theme }
  );
}

/** The page's own failure message, found by its words: FormField also renders an empty role="alert" beside the name. */
async function alertWith(text: RegExp): Promise<HTMLElement> {
  const message = await screen.findByText(text);
  const alert = message.closest<HTMLElement>('[role="alert"]');
  expect(alert).not.toBeNull();
  return alert as HTMLElement;
}

async function fillAndSubmit(name = 'Work phone') {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Device name' }), name);
  await user.click(screen.getByRole('button', { name: 'Create the code' }));
  return user;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  flags.noCrypto = false;
});

describe('AddDeviceRoute', () => {
  it('no request contains the private key and nothing is stored', async () => {
    const fetchMock = stubRegister(201, DEVICE);
    const qrcode = (await import('qrcode')).default;
    renderAdd();

    await fillAndSubmit();
    await screen.findByRole('heading', { level: 2, name: 'Scan this code with the WireGuard app' });

    const config = String(vi.mocked(qrcode.toDataURL).mock.calls.at(-1)?.[0]);
    const privateKey = /PrivateKey = (\S+)/.exec(config)?.[1];
    expect(privateKey).toBeTruthy();

    // Exactly one request, with exactly the three fields the server may see.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/devices\/profile$/);
    const sent = String((fetchMock.mock.calls[0]?.[1] as RequestInit).body);
    expect(Object.keys(JSON.parse(sent)).sort()).toEqual(['name', 'preshared_key', 'public_key']);
    expect(sent).not.toContain(privateKey as string);

    const stored = [
      ...Object.keys(localStorage),
      ...Object.values(localStorage),
      ...Object.keys(sessionStorage),
      ...Object.values(sessionStorage)
    ].join(' ');
    expect(stored).not.toContain(privateKey as string);
    expect(window.location.href).not.toContain(privateKey as string);
  });

  it('shows QR, download and copy after success, and says the device was added', async () => {
    stubRegister(201, DEVICE);
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:config'), revokeObjectURL: vi.fn() }));
    renderAdd();

    const user = await fillAndSubmit();

    expect(await screen.findByRole('img', { name: 'Access code for Work phone' })).toBeInTheDocument();
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy the text' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to my devices' })).toBeInTheDocument();
    expect(await screen.findByText('Work phone added.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Download the file' }));
    expect(click).toHaveBeenCalled();
    expect(downloads).toContain('work-phone.conf');
  });

  it('registers beforeunload while the result is shown and removes it on Back', async () => {
    stubRegister(201, DEVICE);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    renderAdd();

    const user = await fillAndSubmit();
    await screen.findByRole('img', { name: 'Access code for Work phone' });

    const handler = add.mock.calls.find(([type]) => type === 'beforeunload')?.[1] as (e: Event) => void;
    expect(handler).toBeTypeOf('function');
    const event = new Event('beforeunload', { cancelable: true });
    handler(event);
    expect(event.defaultPrevented).toBe(true);

    await user.click(screen.getByRole('link', { name: 'Back to my devices' }));

    expect(remove.mock.calls.some(([type, fn]) => type === 'beforeunload' && fn === handler)).toBe(true);
    expect(await screen.findByText('My devices page')).toBeInTheDocument();
  });

  it('shows noCrypto copy when keys cannot be made, and sends nothing', async () => {
    flags.noCrypto = true;
    const fetchMock = stubRegister(201, DEVICE);
    renderAdd();

    await fillAndSubmit();

    const alert = await alertWith(/This browser cannot create the keys/);
    expect(alert).toHaveTextContent('This browser cannot create the keys.');
    expect(alert).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409 no_profile_gateway shows the Settings message and takes focus', async () => {
    stubRegister(409, { error: 'no gateway', code: 'no_profile_gateway' });
    renderAdd();

    await fillAndSubmit();

    const alert = await alertWith(/An administrator has to choose the gateway in Settings/);
    expect(alert).toHaveTextContent('An administrator has to choose the gateway in Settings.');
    expect(alert).toHaveFocus();
  });

  it('409 without the gateway code says the key was already in use', async () => {
    stubRegister(409, { error: 'taken' });
    renderAdd();

    await fillAndSubmit();

    expect(await alertWith(/already in use/)).toHaveTextContent(
      'The new key was already in use. Create the code again.'
    );
  });

  it('400 marks the name field', async () => {
    stubRegister(400, { error: 'name' });
    renderAdd();

    await fillAndSubmit();

    const field = await screen.findByRole('textbox', { name: 'Device name' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/Enter a name of 1 to 64 characters\./);
  });

  it('any other failure says the device was not added', async () => {
    stubRegister(500, { error: 'boom' });
    renderAdd();

    await fillAndSubmit();

    expect(await alertWith(/was not added/)).toHaveTextContent('The device was not added. Try again.');
  });

  it('an empty name is refused without a request', async () => {
    const fetchMock = stubRegister(201, DEVICE);
    renderAdd();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create the code' }));

    expect(await screen.findByText('Enter a name of 1 to 64 characters.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is accessible in both themes', async () => {
    const light = renderAdd('light');
    await expectNoAxeViolations(light.container, 'light');
    light.unmount();

    const dark = renderAdd('dark');
    await expectNoAxeViolations(dark.container, 'dark');
    dark.unmount();
  });
});
