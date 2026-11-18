import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations, renderUI } from '../test/harness';
import AddDeviceRoute from './AddDeviceRoute';
import { POLL_MS, SLOW_AFTER_MS } from './AddResult';

const flags = vi.hoisted(() => ({ noCrypto: false }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'anna', role: 'user' }, role: null, isAuthenticated: true })
}));

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

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
};

const DEVICE = {
  device_id: 'dev-1',
  name: 'Work phone',
  overlay_ipv4: '100.64.0.9',
  overlay_ipv6: null,
  gateway: { public_key: 'GATEWAYPUBLICKEY0000000000000000000000000=', endpoint: 'gw.example.net:51820' },
  allowed_ips: ['100.64.0.0/10'],
  dns: ['100.100.100.100'],
  search_domain: 'acme.example.com',
  console_url: 'https://console.example.net',
  dns_name: 'work-phone.acme.example.com'
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

interface Api {
  registerStatus: number;
  registerBody: unknown;
  exits: unknown;
  nodes: unknown[];
  manifest: unknown;
  methods: unknown[] | null;
}

const api: Api = {
  registerStatus: 201,
  registerBody: DEVICE,
  exits: NO_EXITS,
  nodes: [],
  manifest: null,
  methods: null
};

/** Answers the exits, the registration, the device list and the app manifest; anything else is not found. */
function stubApi(overrides: Partial<Api> = {}) {
  Object.assign(
    api,
    { registerStatus: 201, registerBody: DEVICE, exits: NO_EXITS, nodes: [], manifest: null, methods: null },
    overrides
  );
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (/\/devices\/exits$/.test(url)) return json(200, api.exits);
    if (/\/devices\/profile\/methods$/.test(url) && api.methods)
      return json(200, { default: 'wireguard', methods: api.methods });
    if (/\/devices\/profile$/.test(url) && init?.method === 'POST') return json(api.registerStatus, api.registerBody);
    if (/\/nodes$/.test(url)) return json(200, { nodes: api.nodes });
    if (url.endsWith('/downloads/manifest.json') && api.manifest) return json(200, api.manifest);
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The requests that write: the registration. */
function writes(fetchMock: ReturnType<typeof stubApi>) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
}

function setUserAgent(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
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

/** The live region that says waiting, slow or connected (the toast region is a status too). */
function waitStatus(): HTMLElement {
  const found = screen.getAllByRole('status').find((el) => el.hasAttribute('data-state'));
  expect(found).toBeDefined();
  return found as HTMLElement;
}

/** Picks a device and creates the access, as a person would. */
async function createFor(platform: RegExp | null, user = userEvent.setup()) {
  if (platform) await user.click(screen.getByRole('radio', { name: platform }));
  await user.click(screen.getByRole('button', { name: 'Create the access' }));
  return user;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  flags.noCrypto = false;
});

describe('AddDeviceRoute, step 1', () => {
  it('asks which device first, with a big choice for each, and pre-selects the one in use', async () => {
    setUserAgent(UA.iphone);
    stubApi();
    renderAdd();

    expect(screen.getByText('Which device?')).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual([
      'ios',
      'android',
      'windows',
      'macos',
      'linux'
    ]);
    expect(screen.getByRole('radio', { name: /iPhone or iPad/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Windows/ })).not.toBeChecked();
    // One primary button, and the name is filled in but secondary and editable.
    expect(screen.getAllByRole('button', { name: 'Create the access' })).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Device name' })).toHaveValue("anna's iPhone");
  });

  it('follows the chosen device with the suggested name until the person writes their own', async () => {
    setUserAgent(UA.windows);
    stubApi();
    renderAdd();
    const user = userEvent.setup();
    const name = screen.getByRole('textbox', { name: 'Device name' });
    expect(name).toHaveValue("anna's PC");

    await user.click(screen.getByRole('radio', { name: /Android/ }));
    expect(name).toHaveValue("anna's Android");

    await user.clear(name);
    await user.type(name, 'Mum phone');
    await user.click(screen.getByRole('radio', { name: /Mac/ }));
    expect(name).toHaveValue('Mum phone');
  });

  it('asks instead of guessing when the browser says nothing useful', async () => {
    setUserAgent('SomethingElse/1.0');
    const fetchMock = stubApi();
    renderAdd();

    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
    await createFor(null);

    expect(await screen.findByText('Choose the device.')).toBeInTheDocument();
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it('shows no jargon before anything is created', async () => {
    setUserAgent(UA.iphone);
    stubApi({ exits: EXITS });
    const { container } = renderAdd();
    await screen.findByRole('switch');

    expect(container.textContent ?? '').not.toMatch(
      /\b(key|exit|gateway|endpoint|handshake|CIDR|port|wstunnel|PowerShell|access code|private IPs)\b/i
    );
  });
});

describe('AddDeviceRoute, the access', () => {
  it('no request contains the private key and nothing is stored', async () => {
    setUserAgent(UA.windows);
    const fetchMock = stubApi();
    const qrcode = (await import('qrcode')).default;
    renderAdd();

    await createFor(/Android/);
    await screen.findByRole('img', { name: "QR code for anna's Android" });

    const config = String(vi.mocked(qrcode.toDataURL).mock.calls.at(-1)?.[0]);
    const privateKey = /PrivateKey = (\S+)/.exec(config)?.[1];
    expect(privateKey).toBeTruthy();
    expect(
      config.startsWith(
        '# NeroNet-Profile: 1\n# NeroNet-Console: https://console.example.net\n# NeroNet-Device: dev-1\n'
      )
    ).toBe(true);
    expect(config).toContain('# NeroNet-DNS-Name: work-phone.acme.example.com\n[Interface]');

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

  it('on the same phone it offers the file and the exact steps, not a QR code it cannot scan', async () => {
    setUserAgent(UA.android);
    stubApi();
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:config'), revokeObjectURL: vi.fn() }));
    renderAdd();

    const user = await createFor(null);

    expect(await screen.findByRole('heading', { level: 2, name: 'Connect Android' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/choose "Import from file or archive"/)).toBeInTheDocument();
    expect(screen.getByText(/Turn on the switch next to the connection/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Get WireGuard/ })).toHaveAttribute(
      'href',
      'https://play.google.com/store/apps/details?id=com.wireguard.android'
    );

    await user.click(screen.getByRole('button', { name: 'Download the profile' }));
    expect(downloads).toContain('anna-s-android.conf');
  });

  it('on a computer, adding a phone shows a large QR code with the scan instruction', async () => {
    setUserAgent(UA.windows);
    stubApi();
    renderAdd();

    await createFor(/iPhone or iPad/);

    expect(await screen.findByRole('img', { name: "QR code for anna's iPhone" })).toBeInTheDocument();
    expect(screen.getByText('Scan with the WireGuard app on your phone.')).toBeInTheDocument();
    expect(screen.getByText(/choose "Create from QR code"/)).toBeInTheDocument();
    expect(screen.getByText(/confirm when iPhone asks/)).toBeInTheDocument();
  });

  it('adding a computer from a phone gives a file to carry over, since a computer app cannot scan a screen', async () => {
    setUserAgent(UA.android);
    stubApi();
    renderAdd();

    await createFor(/Windows/);

    await screen.findByRole('heading', { level: 2, name: 'Connect Windows' });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/pass it to the computer privately/)).toBeInTheDocument();
    expect(screen.getByText(/click "Add Tunnel"/)).toBeInTheDocument();
    expect(screen.getByText(/click "Activate"/)).toBeInTheDocument();
  });

  it.each([
    ['Windows', UA.windows, /Windows/, /click "Add Tunnel"/],
    ['Mac', UA.mac, /Mac/, /choose "Manage tunnels"/],
    ['iPhone or iPad', UA.iphone, /iPhone or iPad/, /"Create from file or archive"/]
  ])("on the same %s it gives that app's own import steps", async (_name, ua, radio, step) => {
    setUserAgent(ua);
    stubApi();
    renderAdd();

    await createFor(radio);

    expect(await screen.findByText(step)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download the profile' })).toBeInTheDocument();
  });

  it('on Linux it hides the commands behind "Show the steps for Linux" and offers the published app', async () => {
    setUserAgent(UA.linux);
    stubApi({
      manifest: {
        apps: [{ platform: 'linux', version: '1.2.3', file: 'neronet_1.2.3_amd64.deb', size_bytes: 1024, sha256: 'ab' }]
      }
    });
    renderAdd();

    await createFor(null);

    const summary = await screen.findByText('Show the steps for Linux');
    const details = summary.closest('details') as HTMLElement;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('sudo wg-quick up neronet');
    expect(details).toHaveTextContent('/etc/wireguard/neronet.conf');
    expect(await screen.findByRole('link', { name: 'Download NeroNet for Linux 1.2.3' })).toHaveAttribute(
      'href',
      '/downloads/neronet_1.2.3_amd64.deb'
    );
  });
});

describe('AddDeviceRoute, waiting and connected', () => {
  it('waits for the device, then says it is connected and offers Done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setUserAgent(UA.android);
    stubApi();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    renderAdd();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await createFor(null, user);

    expect(await screen.findByText('Waiting for your device…')).toBeInTheDocument();
    expect(waitStatus()).toHaveAttribute('data-state', 'waiting');
    expect(screen.queryByRole('link', { name: 'Done' })).toBeNull();

    // While the one-time code is on screen, leaving the page asks first.
    const handler = add.mock.calls.find(([type]) => type === 'beforeunload')?.[1] as (e: Event) => void;
    const event = new Event('beforeunload', { cancelable: true });
    handler(event);
    expect(event.defaultPrevented).toBe(true);

    // The gateway reports the first handshake.
    api.nodes = [{ ...DEVICE_NODE, last_handshake_at: new Date().toISOString() }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 500);
    });

    await waitFor(() => expect(waitStatus()).toHaveAttribute('data-state', 'connected'));
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText("anna's Android is now on your network.")).toBeInTheDocument();
    expect(screen.queryByText('Waiting for your device…')).toBeNull();
    expect(remove.mock.calls.some(([type, fn]) => type === 'beforeunload' && fn === handler)).toBe(true);

    await user.click(screen.getByRole('link', { name: 'Done' }));
    expect(await screen.findByText('My devices page')).toBeInTheDocument();
  });

  it('after about three minutes says so quietly, keeps waiting and keeps the way out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setUserAgent(UA.android);
    stubApi();
    renderAdd();

    await createFor(null, userEvent.setup({ advanceTimers: vi.advanceTimersByTime }));
    await screen.findByText('Waiting for your device…');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS + 500);
    });

    expect(await screen.findByText(/We do not see it yet/)).toBeInTheDocument();
    expect(waitStatus()).toHaveAttribute('data-state', 'slow');
    expect(screen.getByRole('link', { name: "I'll do it later" })).toHaveAttribute('href', '/me');
  });

  it('keeps the trouble section closed, with the copy button and the blocked-network help inside it', async () => {
    setUserAgent(UA.windows);
    stubApi({
      registerBody: {
        ...DEVICE,
        strict_network: {
          url: 'wss://console.example.net',
          path_prefix: '0123456789abcdef',
          remote: 'gateway:51820',
          local_endpoint: '127.0.0.1:51820',
          mtu: 1380,
          persistent_keepalive: 20
        }
      }
    });
    const files: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      files.push(this.download);
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:config'), revokeObjectURL: vi.fn() }));
    const view = renderAdd();

    const user = await createFor(null);
    const summary = await screen.findByText('Trouble connecting?');
    const trouble = summary.closest('details') as HTMLElement;
    expect(trouble).not.toHaveAttribute('open');
    const heading = within(trouble).getByRole('heading', { level: 3, name: 'Networks that block VPNs (port 443)' });
    expect(heading.closest('section')).toHaveTextContent('wstunnel client --tls-verify-certificate');

    await user.click(summary);
    await user.click(screen.getByRole('button', { name: 'Download the file for blocked networks' }));
    expect(files).toEqual(['anna-s-pc-443.conf']);
    await expectNoAxeViolations(view.container, 'light');
  });

  it('has no help for blocked networks when the installation does not offer it', async () => {
    setUserAgent(UA.windows);
    stubApi({ registerBody: { ...DEVICE, strict_network: null } });
    renderAdd();

    await createFor(null);
    await screen.findByText('Trouble connecting?');

    expect(screen.queryByRole('heading', { name: /Networks that block VPNs/ })).toBeNull();
  });
});

describe('AddDeviceRoute, sending all traffic through the network', () => {
  it('is not mentioned when the server offers no exit or no right to choose one', async () => {
    setUserAgent(UA.iphone);
    stubApi({ exits: NO_EXITS });
    const first = renderAdd();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create the access' })).toBeInTheDocument());
    expect(screen.queryByRole('switch')).toBeNull();
    first.unmount();

    stubApi({ exits: { ...EXITS, can_choose: false } });
    renderAdd();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('is one switch, off by default, with a one-line plain explanation', async () => {
    setUserAgent(UA.iphone);
    const fetchMock = stubApi({ exits: EXITS });
    renderAdd();

    const toggle = await screen.findByRole('switch', { name: 'Send all traffic through the network' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/also go through your organisation's network/);
    await createFor(null);
    await screen.findByText('Waiting for your device…');
    expect(JSON.parse(String((writes(fetchMock)[0]?.[1] as RequestInit).body)).exit_node_id).toBeUndefined();
  });

  it('sends every packet through the exit when switched on, and says how to keep the local network', async () => {
    setUserAgent(UA.windows);
    const fetchMock = stubApi({
      exits: EXITS,
      registerBody: {
        ...DEVICE,
        allowed_ips: ['0.0.0.0/0', '::/0'],
        dns: ['100.100.100.100'],
        exit: { node_id: 'node-home', name: 'Home', kind: 'gateway' }
      }
    });
    const qrcode = (await import('qrcode')).default;
    renderAdd();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('switch', { name: 'Send all traffic through the network' }));
    expect(screen.getByText(/Whoever runs the network can see which sites/)).toBeInTheDocument();
    await createFor(/Android/, user);

    await screen.findByText("All of anna's Android's traffic goes through Home.");
    expect(screen.getByText(/leaves out private addresses|Exclude private IPs/)).toBeInTheDocument();
    const sent = JSON.parse(String((writes(fetchMock)[0]?.[1] as RequestInit).body));
    expect(sent.exit_node_id).toBe('node-home');
    expect(Object.keys(sent).sort()).toEqual(['exit_node_id', 'name', 'preshared_key', 'public_key']);
    const config = String(vi.mocked(qrcode.toDataURL).mock.calls.at(-1)?.[0]);
    expect(config).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    expect(config).toContain('DNS = 100.100.100.100, acme.example.com');
  });

  it('403 exit_not_permitted says only an administrator can do it', async () => {
    setUserAgent(UA.iphone);
    stubApi({
      exits: EXITS,
      registerStatus: 403,
      registerBody: { error: 'exit_not_permitted', code: 'exit_not_permitted' }
    });
    renderAdd();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Send all traffic through the network' }));
    await createFor(null, user);
    expect(await alertWith(/create the access without this option/)).toHaveFocus();
  });
});

describe('AddDeviceRoute, failures', () => {
  it('shows a plain message when keys cannot be made, and sends nothing', async () => {
    setUserAgent(UA.iphone);
    flags.noCrypto = true;
    const fetchMock = stubApi();
    renderAdd();

    await createFor(null);

    const alert = await alertWith(/This browser cannot protect the access/);
    expect(alert).toHaveFocus();
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it('409 no_profile_gateway tells the person to ask an administrator and takes focus', async () => {
    setUserAgent(UA.iphone);
    stubApi({ registerStatus: 409, registerBody: { error: 'no gateway', code: 'no_profile_gateway' } });
    renderAdd();

    await createFor(null);

    const alert = await alertWith(/Ask an administrator to finish the setup/);
    expect(alert).toHaveFocus();
  });

  it('the server body for a missing gateway (error field only) still gets that message', async () => {
    setUserAgent(UA.iphone);
    stubApi({ registerStatus: 409, registerBody: { error: 'no_profile_gateway', message: 'none yet' } });
    renderAdd();

    await createFor(null);

    expect(await alertWith(/Ask an administrator to finish the setup/)).toBeInTheDocument();
  });

  it('409 owner_has_blocked_device tells the person an administrator must unblock their device', async () => {
    setUserAgent(UA.iphone);
    stubApi({
      registerStatus: 409,
      registerBody: { error: 'owner_has_blocked_device', code: 'owner_has_blocked_device' }
    });
    renderAdd();

    await createFor(null);

    const alert = await alertWith(/You have a blocked device: an administrator must unblock it before you add another/);
    expect(alert).toHaveFocus();
  });

  it('a 409 with another reason is a generic retry, not "already in use"', async () => {
    setUserAgent(UA.iphone);
    stubApi({ registerStatus: 409, registerBody: { error: 'conflict', code: 'device_limit_reached' } });
    renderAdd();

    await createFor(null);

    expect(await alertWith(/We could not create the access/)).toBeInTheDocument();
    expect(screen.queryByText(/already in use/)).toBeNull();
  });

  it('409 public_key_in_use says the access was already in use', async () => {
    setUserAgent(UA.iphone);
    stubApi({ registerStatus: 409, registerBody: { error: 'taken', code: 'public_key_in_use' } });
    renderAdd();

    await createFor(null);

    expect(await alertWith(/already in use/)).toBeInTheDocument();
  });

  it('400 marks the name field', async () => {
    setUserAgent(UA.iphone);
    stubApi({ registerStatus: 400, registerBody: { error: 'name' } });
    renderAdd();

    await createFor(null);

    const field = await screen.findByRole('textbox', { name: 'Device name' });
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(field).toHaveAccessibleDescription(/Enter a name of 1 to 64 characters\./);
  });

  it('any other failure says the access was not created', async () => {
    setUserAgent(UA.iphone);
    stubApi({ registerStatus: 500, registerBody: { error: 'boom' } });
    renderAdd();

    await createFor(null);

    expect(await alertWith(/We could not create the access/)).toBeInTheDocument();
  });

  it('an empty name is refused without a request', async () => {
    setUserAgent(UA.iphone);
    const fetchMock = stubApi();
    renderAdd();
    const user = userEvent.setup();

    await user.clear(screen.getByRole('textbox', { name: 'Device name' }));
    await createFor(null, user);

    expect(await screen.findByText('Enter a name of 1 to 64 characters.')).toBeInTheDocument();
    expect(writes(fetchMock)).toHaveLength(0);
  });
});

describe('AddDeviceRoute, accessibility', () => {
  it('step 1 is accessible in both themes', async () => {
    setUserAgent(UA.iphone);
    stubApi({ exits: EXITS });
    const light = renderAdd('light');
    await screen.findByRole('switch');
    await expectNoAxeViolations(light.container, 'light');
    light.unmount();

    const dark = renderAdd('dark');
    await screen.findByRole('switch');
    await expectNoAxeViolations(dark.container, 'dark');
    dark.unmount();
  });

  it('the result moves focus to its heading and is accessible with the QR code', async () => {
    setUserAgent(UA.windows);
    stubApi();
    const view = renderAdd('dark');

    await createFor(/Android/);

    const heading = await screen.findByRole('heading', { level: 2, name: 'Connect Android' });
    await waitFor(() => expect(heading).toHaveFocus());
    await expectNoAxeViolations(view.container, 'dark');
  });
});

/** The device as the device list reports it once its gateway has seen it. */
const DEVICE_NODE = { id: 'dev-1', name: 'Work phone', user_id: 'u1', device_kind: 'profile' };

// ADR 0036: a choice among access methods, only when there is more than one.
const M = (id: string) => ({ id, label: id });
const ALL_METHODS = [M('wireguard'), M('wireguard-wss'), M('amneziawg')];
const WSS = {
  url: 'wss://console.example.net',
  path_prefix: '0123456789abcdef',
  remote: 'gateway:51820',
  local_endpoint: '127.0.0.1:51820',
  mtu: 1380,
  persistent_keepalive: 20
};
const AWG_PARAMS = {
  jc: 7,
  jmin: 40,
  jmax: 90,
  s1: 21,
  s2: 22,
  s3: 23,
  s4: 24,
  h1: '100000-100999',
  h2: '200000-200999',
  h3: '300000-300999',
  h4: '400000-400999'
};

function registrations(fetchMock: ReturnType<typeof stubApi>) {
  return fetchMock.mock.calls
    .filter(([url, init]) => /\/devices\/profile$/.test(String(url)) && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

describe('AddDeviceRoute, access methods', () => {
  it('shows no choice when the server offers only the normal way, or does not answer', async () => {
    setUserAgent(UA.windows);
    stubApi({ methods: [M('wireguard')] });
    const view = renderAdd();
    await screen.findByRole('radio', { name: /Windows/ });
    expect(screen.queryByText('How do you connect?')).toBeNull();
    view.unmount();

    vi.unstubAllGlobals();
    stubApi({ methods: null });
    renderAdd();
    await screen.findByRole('radio', { name: /Windows/ });
    expect(screen.queryByText('How do you connect?')).toBeNull();
  });

  it('offers the three ways after the device, in words about the situation, with the protocol muted', async () => {
    setUserAgent(UA.windows);
    stubApi({ methods: ALL_METHODS });
    renderAdd();

    expect(await screen.findByText('How do you connect?')).toBeInTheDocument();
    const radios = screen.getAllByRole('radio', { name: /Normal|VPN/ });
    expect(radios.map((r) => r.getAttribute('value'))).toEqual(['wireguard', 'wireguard-wss', 'amneziawg']);
    expect(screen.getByRole('radio', { name: /^Normal/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Network that blocks VPNs \(port 443\)/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Network that recognises VPNs.*AmneziaWG/ })).toBeInTheDocument();
    expect(screen.getByText(/Fine almost everywhere/)).toBeInTheDocument();
  });

  it('does not offer the port 443 way on a phone, which cannot run its program', async () => {
    setUserAgent(UA.iphone);
    stubApi({ methods: ALL_METHODS });
    renderAdd();

    await screen.findByText('How do you connect?');
    expect(screen.queryByRole('radio', { name: /blocks VPNs/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /recognises VPNs/ })).toBeInTheDocument();
  });

  it('sends the chosen method and builds the AmneziaWG profile and steps from the answer', async () => {
    setUserAgent(UA.android);
    const fetchMock = stubApi({
      methods: ALL_METHODS,
      registerBody: {
        ...DEVICE,
        access_method: 'amneziawg',
        amneziawg: { endpoint: 'gw.example.net:51821', params: AWG_PARAMS }
      }
    });
    const downloads: string[] = [];
    const texts: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn((blob: Blob) => {
          const reader = new FileReader();
          reader.onload = () => texts.push(String(reader.result));
          reader.readAsText(blob);
          return 'blob:config';
        }),
        revokeObjectURL: vi.fn()
      })
    );
    renderAdd();

    await screen.findByText('How do you connect?');
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /recognises VPNs/ }));
    await user.click(screen.getByRole('button', { name: 'Create the access' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Connect Android' })).toBeInTheDocument();
    expect(registrations(fetchMock)[0]).toMatchObject({ access_method: 'amneziawg' });
    expect(screen.getByRole('link', { name: /Get AmneziaWG/ })).toHaveAttribute(
      'href',
      'https://play.google.com/store/apps/details?id=org.amnezia.awg'
    );
    expect(screen.getByText(/Open AmneziaWG, tap \+ and choose "Import from file or archive"/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Get WireGuard/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Download the profile' }));
    expect(downloads).toContain('anna-s-android-awg.conf');
    await waitFor(() => expect(texts.length).toBe(1));
    expect(texts[0]).toContain('Jc = 7');
    expect(texts[0]).toContain('H4 = 400000-400999');
    expect(texts[0]).toContain('Endpoint = gw.example.net:51821');
  });

  it('makes the port 443 way the main steps, with its own file', async () => {
    setUserAgent(UA.windows);
    const fetchMock = stubApi({
      methods: ALL_METHODS,
      registerBody: { ...DEVICE, access_method: 'wireguard-wss', strict_network: WSS }
    });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:config'), revokeObjectURL: vi.fn() }));
    renderAdd();

    await screen.findByText('How do you connect?');
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /blocks VPNs/ }));
    await user.click(screen.getByRole('button', { name: 'Create the access' }));

    await screen.findByRole('heading', { level: 2, name: 'Connect Windows' });
    expect(registrations(fetchMock)[0]).toMatchObject({ access_method: 'wireguard-wss' });
    // The steps are in the main list, not behind "Trouble connecting?".
    const trouble = screen.getByText('Trouble connecting?').closest('details') as HTMLElement;
    expect(within(trouble).queryByRole('heading', { level: 3 })).toBeNull();
    expect(screen.getAllByText(/wstunnel client --tls-verify-certificate/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Download the file for blocked networks' }));
    expect(downloads).toEqual(['anna-s-pc-443.conf']);
  });

  it('409 method_not_available says the way is no longer available', async () => {
    setUserAgent(UA.windows);
    stubApi({
      methods: ALL_METHODS,
      registerStatus: 409,
      registerBody: { error: 'method_not_available', code: 'method_not_available' }
    });
    renderAdd();

    await screen.findByText('How do you connect?');
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /recognises VPNs/ }));
    await user.click(screen.getByRole('button', { name: 'Create the access' }));

    expect(await alertWith(/no longer available/)).toBeInTheDocument();
  });

  it('the choice is accessible in both themes', async () => {
    setUserAgent(UA.windows);
    stubApi({ methods: ALL_METHODS });
    const light = renderAdd('light');
    await screen.findByText('How do you connect?');
    await expectNoAxeViolations(light.container, 'light');
    light.unmount();
    const dark = renderAdd('dark');
    await screen.findByText('How do you connect?');
    await expectNoAxeViolations(dark.container, 'dark');
  });
});
