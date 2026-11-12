import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
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

const NO_EXITS = { can_choose: false, self_service: false, exits: [] };
const EXITS = {
  can_choose: true,
  self_service: false,
  exits: [
    { node_id: 'node-home', name: 'Home', kind: 'gateway', online: true },
    { node_id: 'node-fr', name: 'Paris', kind: 'node', online: false }
  ]
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GET /devices/exits answers `exits`; every other request answers the registration. */
function stubRegister(status: number, body: unknown, exits: unknown = NO_EXITS) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    /\/devices\/exits$/.test(String(input)) ? json(200, exits) : json(status, body)
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The requests that are not the read of the exits list. */
function writes(fetchMock: ReturnType<typeof stubRegister>) {
  return fetchMock.mock.calls.filter(([input]) => !/\/devices\/exits$/.test(String(input)));
}

function renderAdd(theme: 'light' | 'dark' = 'light') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderUI(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/me/add']}>
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

    // Exactly one write, with exactly the three fields the server may see.
    expect(writes(fetchMock)).toHaveLength(1);
    expect(String(writes(fetchMock)[0]?.[0])).toMatch(/\/devices\/profile$/);
    const sent = String((writes(fetchMock)[0]?.[1] as RequestInit).body);
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

  it('shows nothing about blocked networks when the installation does not offer it', async () => {
    stubRegister(201, { ...DEVICE, strict_network: null });
    renderAdd();

    await fillAndSubmit();
    await screen.findByRole('img', { name: 'Access code for Work phone' });

    expect(screen.queryByRole('heading', { name: 'Networks that block VPNs (port 443)' })).toBeNull();
  });

  it('offers the port 443 command and a second file with the same keys pointing at the local client', async () => {
    const secret = '0123456789abcdef0123456789abcdef0123456789abcdef';
    stubRegister(201, {
      ...DEVICE,
      strict_network: {
        url: 'wss://console.example.net',
        path_prefix: secret,
        remote: 'gateway:51820',
        local_endpoint: '127.0.0.1:51820',
        mtu: 1380,
        persistent_keepalive: 20
      }
    });
    const files: Array<{ name: string; blob: Blob }> = [];
    let lastBlob: Blob | null = null;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn((blob: Blob) => {
          lastBlob = blob;
          return 'blob:config';
        }),
        revokeObjectURL: vi.fn()
      })
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      if (lastBlob) files.push({ name: this.download, blob: lastBlob });
    });
    const qrcode = (await import('qrcode')).default;
    const view = renderAdd();

    const user = await fillAndSubmit();
    const heading = await screen.findByRole('heading', { level: 3, name: 'Networks that block VPNs (port 443)' });
    const section = heading.closest('section') as HTMLElement;

    expect(section).toHaveTextContent(
      `wstunnel client --tls-verify-certificate -P ${secret} -L 'udp://127.0.0.1:51820:gateway:51820?timeout_sec=0' wss://console.example.net`
    );
    expect(section).toHaveTextContent('.\\wstunnel.exe client --tls-verify-certificate');
    expect(screen.getByRole('button', { name: 'Copy the command for Linux and macOS (Terminal)' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Download the file for blocked networks' }));
    expect(files.map((f) => f.name)).toEqual(['work-phone-443.conf']);
    const alt = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(files[0]?.blob as Blob);
    });
    const main = String(vi.mocked(qrcode.toDataURL).mock.calls.at(-1)?.[0]);
    expect(alt).toContain('Endpoint = 127.0.0.1:51820');
    expect(alt).toContain('MTU = 1380');
    expect(alt).toContain('PersistentKeepalive = 20');
    expect(alt).toContain(/PrivateKey = \S+/.exec(main)?.[0] as string);
    expect(main).toContain('Endpoint = gw.example.net:51820');
    expect(main).not.toContain(secret);

    await expectNoAxeViolations(view.container, 'light');
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
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it('409 no_profile_gateway shows the Settings message and takes focus', async () => {
    stubRegister(409, { error: 'no gateway', code: 'no_profile_gateway' });
    renderAdd();

    await fillAndSubmit();

    const alert = await alertWith(/An administrator has to choose the gateway in Settings/);
    expect(alert).toHaveTextContent('An administrator has to choose the gateway in Settings.');
    expect(alert).toHaveFocus();
  });

  it('the server body for a missing gateway (error field only) still shows the Settings message', async () => {
    // What routes/devices.js sent before it carried `code`: the page must not call this a used key.
    stubRegister(409, { error: 'no_profile_gateway', message: 'This organisation has no gateway yet.' });
    renderAdd();

    await fillAndSubmit();

    expect(await alertWith(/An administrator has to choose the gateway in Settings/)).toBeInTheDocument();
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
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it('a full-tunnel profile sends every packet to the chosen exit and resolves names there', async () => {
    const fetchMock = stubRegister(
      201,
      {
        ...DEVICE,
        allowed_ips: ['0.0.0.0/0', '::/0'],
        dns: ['100.100.100.100'],
        exit: { node_id: 'node-home', name: 'Home', kind: 'gateway' }
      },
      EXITS
    );
    const qrcode = (await import('qrcode')).default;
    renderAdd();

    const user = userEvent.setup();
    const toggle = await screen.findByRole('checkbox', { name: 'All traffic through an exit' });
    expect(toggle).toHaveAccessibleDescription(/Websites see the exit's address/);
    await user.click(toggle);
    expect(screen.getByText(/Whoever runs the exit can see which sites/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing goes around the tunnel/)).toBeInTheDocument();
    expect(screen.getByText(/Exclude private IPs/)).toBeInTheDocument();
    await fillAndSubmit();

    await screen.findByText("All of Work phone's traffic leaves through Home.");
    const sent = JSON.parse(String((writes(fetchMock)[0]?.[1] as RequestInit).body));
    expect(sent.exit_node_id).toBe('node-home');
    expect(Object.keys(sent).sort()).toEqual(['exit_node_id', 'name', 'preshared_key', 'public_key']);
    const config = String(vi.mocked(qrcode.toDataURL).mock.calls.at(-1)?.[0]);
    expect(config).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    expect(config).toContain('DNS = 100.100.100.100');
  });

  it('leaves the option off unless it is ticked', async () => {
    const fetchMock = stubRegister(201, DEVICE, EXITS);
    renderAdd();
    expect(await screen.findByRole('checkbox', { name: 'All traffic through an exit' })).not.toBeChecked();
    await fillAndSubmit();
    await screen.findByRole('img', { name: 'Access code for Work phone' });
    expect(JSON.parse(String((writes(fetchMock)[0]?.[1] as RequestInit).body)).exit_node_id).toBeUndefined();
  });

  it('says who to ask when the person may not choose an exit', async () => {
    stubRegister(201, DEVICE, { ...EXITS, can_choose: false });
    renderAdd();
    const toggle = await screen.findByRole('checkbox', { name: 'All traffic through an exit' });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription(/Only an administrator can send a device through an exit/);
  });

  it('says there is no exit yet when none exists', async () => {
    stubRegister(201, DEVICE, NO_EXITS);
    renderAdd();
    const toggle = await screen.findByRole('checkbox', { name: 'All traffic through an exit' });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription(/No exit is available yet/);
  });

  it('403 exit_not_permitted says only an administrator can do it', async () => {
    stubRegister(403, { error: 'exit_not_permitted', code: 'exit_not_permitted' }, EXITS);
    renderAdd();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'All traffic through an exit' }));
    await fillAndSubmit();
    expect(await alertWith(/create the code without this option/)).toHaveFocus();
  });

  it('is accessible with the exit option open', async () => {
    stubRegister(201, DEVICE, EXITS);
    const view = renderAdd('dark');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'All traffic through an exit' }));
    await expectNoAxeViolations(view.container, 'dark');
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
