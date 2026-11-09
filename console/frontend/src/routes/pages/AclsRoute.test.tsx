import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AclsRoute from './AclsRoute';
import { ShellProvider } from '../shell';
import { createQueryClient } from '../../services/queries/client';
import type {
  AclRule,
  AclRulesResponse,
  AclDefaultPolicyResponse,
  CompiledPolicy,
  MeshNode
} from '../../services/types';
import '../../i18n';

const mockRules: AclRule[] = [
  {
    id: 'acl-rule-1',
    priority: 50,
    source_cidr: '100.64.10.0/24',
    destination_cidr: '100.64.0.0/16',
    protocol: 'TCP',
    port_start: 443,
    port_end: 443,
    action: 'ACCEPT',
    description: 'Allow HTTPS traffic between branches',
    enabled: true
  },
  {
    id: 'acl-rule-2',
    priority: 90,
    source_cidr: '100.64.20.0/24',
    destination_cidr: '0.0.0.0/0',
    protocol: 'UDP',
    port_start: 53,
    port_end: 53,
    action: 'DROP',
    description: 'Block external plaintext DNS egress',
    enabled: true
  }
];

const mockNodes: MeshNode[] = [
  {
    id: 'node-core-1',
    name: 'HQ Core Gateway',
    overlay_ipv4: '100.64.10.1',
    role: 'RELAY',
    is_healthy: true,
    is_quarantined: false
  },
  {
    id: 'node-edge-2',
    name: 'Branch Edge 2',
    overlay_ipv4: '100.64.10.2',
    role: 'CLIENT_ORIGIN',
    is_healthy: true,
    is_quarantined: false
  }
];

const mockCompiledPolicy: CompiledPolicy = {
  node_id: 'node-core-1',
  overlay_ipv4: '100.64.10.1',
  epoch: 3,
  inbound_rules: [
    {
      allowed_peer_vip: '100.64.10.2',
      protocol: 'TCP',
      port_ranges: [{ start: 443, end: 443 }],
      action: 'ACCEPT',
      is_directional: true
    }
  ],
  outbound_rules: [
    {
      allowed_peer_vip: '100.64.10.2',
      protocol: 'TCP',
      port_ranges: [{ start: 443, end: 443 }],
      action: 'ACCEPT',
      is_directional: true
    }
  ]
};

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function renderAcls(initialEntries = ['/acls']) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false }
  });

  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route path="/acls" element={<AclsRoute />} />
          </Routes>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>
  );
}

describe('WP-407: AclsRoute (Visual ACL Rule Editor, Policy Routing & Organization Default Policy)', () => {
  let rulesState: AclRule[] = [];
  let defaultPolicyState = 'deny';
  let policyTestsState: Array<Record<string, unknown>> = [];
  let refuseRuleSaves = false;
  const failure = {
    test_id: 'apt-1',
    organization_id: 'org-test',
    description: 'ops SSH',
    source_ip: '100.64.10.1',
    destination_ip: '100.64.10.2',
    protocol: 'TCP',
    port: 22,
    expect: 'ACCEPT',
    got: 'DROP',
    reason: 'Matched rule #5'
  };

  beforeEach(() => {
    rulesState = [...mockRules];
    defaultPolicyState = 'deny';
    policyTestsState = [];
    refuseRuleSaves = false;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupFetchMock() {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      const method = init?.method || 'GET';

      // 1. GET /api/acl/rules
      if (urlStr.includes('/api/acl/rules') && method === 'GET') {
        const payload: AclRulesResponse = {
          rules: rulesState,
          epoch: 3,
          policy_is_open: rulesState.length === 0,
          count: rulesState.length
        };
        return jsonResponse(payload);
      }

      // ADR 0028: policy tests
      if (urlStr.includes('/api/acl/tests/run') && method === 'POST') {
        return jsonResponse({ total: policyTestsState.length, failures: [] });
      }
      if (urlStr.includes('/api/acl/tests') && method === 'GET') {
        return jsonResponse({ tests: policyTestsState });
      }
      if (urlStr.includes('/api/acl/tests') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        const test = { id: `apt-${policyTestsState.length + 1}`, ...body };
        policyTestsState.push(test);
        return jsonResponse({ test }, 201);
      }
      if (urlStr.includes('/api/acl/tests/') && method === 'DELETE') {
        const id = urlStr.split('/api/acl/tests/')[1];
        policyTestsState = policyTestsState.filter((t) => t.id !== id);
        return jsonResponse({ deleted: id });
      }
      if (refuseRuleSaves && urlStr.includes('/api/acl/rules') && method !== 'GET') {
        return jsonResponse({ error: 'policy_tests_failed', failures: [failure] }, 409);
      }

      // 2. POST /api/acl/rules
      if (urlStr.includes('/api/acl/rules') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        const newRule: AclRule = {
          id: `acl-${Date.now()}`,
          priority: body.priority || 100,
          source_cidr: body.source_cidr || '0.0.0.0/0',
          destination_cidr: body.destination_cidr || '0.0.0.0/0',
          protocol: body.protocol || 'ALL',
          port_start: body.port_start || 0,
          port_end: body.port_end || 65535,
          action: body.action || 'ACCEPT',
          description: body.description || '',
          enabled: body.enabled ?? true
        };
        rulesState.push(newRule);
        return jsonResponse({ rule: newRule, epoch: 4 }, 201);
      }

      // 3. PUT /api/acl/rules/:id
      if (urlStr.includes('/api/acl/rules/') && method === 'PUT') {
        const id = urlStr.split('/api/acl/rules/')[1];
        const body = JSON.parse(String(init?.body || '{}'));
        const idx = rulesState.findIndex((r) => r.id === id);
        if (idx >= 0) {
          rulesState[idx] = { ...rulesState[idx], ...body };
          return jsonResponse({ rule: rulesState[idx], epoch: 4 });
        }
        return jsonResponse({ error: 'not found' }, 404);
      }

      // 4. DELETE /api/acl/rules/:id
      if (urlStr.includes('/api/acl/rules/') && method === 'DELETE') {
        const id = urlStr.split('/api/acl/rules/')[1];
        rulesState = rulesState.filter((r) => r.id !== id);
        return jsonResponse({ deleted: id, epoch: 4, policy_is_open: rulesState.length === 0 });
      }

      // 5. GET /api/acl/default-policy
      if (urlStr.includes('/api/acl/default-policy') && method === 'GET') {
        const payload: AclDefaultPolicyResponse = {
          organization_id: 'org-test',
          organization_name: 'Test Org',
          default_policy: defaultPolicyState as any
        };
        return jsonResponse(payload);
      }

      // 6. PUT /api/acl/default-policy
      if (urlStr.includes('/api/acl/default-policy') && method === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}'));
        defaultPolicyState = body.default_policy || 'deny';
        return jsonResponse({
          organization_id: 'org-test',
          default_policy: defaultPolicyState,
          epoch: 5
        });
      }

      // 7. GET /api/nodes
      if (urlStr.includes('/api/nodes')) {
        return jsonResponse({ nodes: mockNodes, total: mockNodes.length });
      }

      // 8. GET /api/acl/compiled/
      if (urlStr.includes('/api/acl/compiled/')) {
        return jsonResponse(mockCompiledPolicy);
      }

      // 9. POST /api/acl/simulate
      if (urlStr.includes('/api/acl/simulate') && method === 'POST') {
        return jsonResponse({
          verdict: 'DROP',
          matched_rule: rulesState[1],
          reason: 'Matched rule #90: DROP UDP',
          packet: { source_ip: '100.64.20.1', destination_ip: '8.8.8.8', protocol: 'UDP', port: 53 }
        });
      }

      return jsonResponse({ error: 'unhandled test endpoint' }, 404);
    });
  }

  it('1. Renders ACL rules matrix, stats, zero-trust enforcement status and passes axe a11y', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const { container } = renderAcls();

    await waitFor(() => {
      expect(screen.getByText('100.64.10.0/24')).toBeInTheDocument();
      expect(screen.getByText('100.64.20.0/24')).toBeInTheDocument();
    });

    // Check stats and badges
    expect(screen.getByText('#50')).toBeInTheDocument();
    expect(screen.getByText('#90')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /Zero-Trust/i })).toBeInTheDocument();
    expect(screen.getAllByText(/Zero-Trust/i).length).toBeGreaterThan(0);

    // Verify zero axe violations
    await expectNoAxeViolations(container);
  });

  it('2. Filters rules list via search input and action filter', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    renderAcls();

    await waitFor(() => {
      expect(screen.getByText('100.64.10.0/24')).toBeInTheDocument();
      expect(screen.getByText('100.64.20.0/24')).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText(/filter rules search/i);
    await user.type(searchInput, 'external');

    // Rule 1 should be filtered out, Rule 2 remains
    expect(screen.queryByText('100.64.10.0/24')).not.toBeInTheDocument();
    expect(screen.getByText('100.64.20.0/24')).toBeInTheDocument();
  });

  it('3. Opens Add Rule Dialog, creates a new zero-trust rule, and passes axe-core', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    const { container } = renderAcls();

    await waitFor(() => {
      expect(screen.getByText('100.64.10.0/24')).toBeInTheDocument();
    });

    const addBtn = screen.getByTestId('add-rule-button');
    await user.click(addBtn);

    // Modal should be open
    await waitFor(() => {
      expect(screen.getByTestId('save-rule-button')).toBeInTheDocument();
    });

    // Check modal accessibility
    await expectNoAxeViolations(container);

    // Submit rule
    await user.click(screen.getByTestId('save-rule-button'));

    // Modal should close
    await waitFor(() => {
      expect(screen.queryByTestId('save-rule-button')).not.toBeInTheDocument();
    });
  });

  it('4. Toggles Organization Default Policy via confirmation dialog', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    renderAcls();

    await waitFor(() => {
      expect(screen.getByTestId('toggle-default-policy-button')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('toggle-default-policy-button'));

    // Confirm dialog should open
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /confirm policy change/i })).toBeInTheDocument();
    });

    // Confirm change
    await user.click(screen.getByRole('button', { name: /confirm policy change/i }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /confirm policy change/i })).not.toBeInTheDocument();
    });
  });

  it('5. Opens Policy Preview & Packet Simulator, evaluates packet, and checks axe-core', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    const { container } = renderAcls();

    await waitFor(() => {
      expect(screen.getByTestId('preview-simulator-button')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('preview-simulator-button'));

    // Preview modal opens
    await waitFor(() => {
      expect(screen.getByText(/Node Compiled Policy/i)).toBeInTheDocument();
    });

    // Switch to simulator tab
    await user.click(screen.getByText(/Live Packet Simulator/i));

    await waitFor(() => {
      expect(screen.getByTestId('simulate-packet-submit')).toBeInTheDocument();
    });

    // Check accessibility with dialog open
    await expectNoAxeViolations(container);

    // Run simulation
    await user.click(screen.getByTestId('simulate-packet-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('simulation-result-card')).toBeInTheDocument();
      expect(screen.getByText(/TRAFFIC BLOCKED/i)).toBeInTheDocument();
    });
  });

  it('6. Deletes rule with confirmation dialog and handles empty permissive mesh state', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    renderAcls();

    await waitFor(() => {
      expect(screen.getByText('100.64.10.0/24')).toBeInTheDocument();
    });

    // Click delete on rule 1
    const deleteBtn = screen.getByRole('button', { name: /delete rule acl-rule-1/i });
    await user.click(deleteBtn);

    // Confirm dialog opens
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delete rule/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /delete rule/i }));

    await waitFor(() => {
      expect(screen.queryByText('100.64.10.0/24')).not.toBeInTheDocument();
    });
  });
  it('7. Lists the policy tests and runs them on demand', async () => {
    policyTestsState = [{ ...failure, id: 'apt-1', expect: 'ACCEPT' }];
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    const { container } = renderAcls();

    const card = await screen.findByTestId('policy-tests-card');
    await waitFor(() => expect(card).toHaveTextContent('100.64.10.1'));
    expect(card).toHaveTextContent('100.64.10.2');
    expect(card).toHaveTextContent('ops SSH');

    await user.click(screen.getByTestId('run-policy-tests'));
    expect(await screen.findByTestId('policy-tests-run-result')).toHaveTextContent('1/1');
    await expectNoAxeViolations(container);
  });

  it('8. A rule save refused by the policy tests lists the failing tests and keeps the dialog open', async () => {
    refuseRuleSaves = true;
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    renderAcls();

    await waitFor(() => expect(screen.getByText('100.64.10.0/24')).toBeInTheDocument());
    await user.click(screen.getByTestId('add-rule-button'));
    await user.click(await screen.findByTestId('save-rule-button'));

    const list = await screen.findByTestId('policy-test-failures');
    expect(list).toHaveTextContent('100.64.10.1');
    expect(list).toHaveTextContent('100.64.10.2');
    expect(list).toHaveTextContent('DROP');
    expect(screen.getByTestId('save-rule-button')).toBeInTheDocument();
  });

  it('9. Saves the simulated packet as a policy test expecting the verdict seen', async () => {
    const fetchMock = setupFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAcls();

    await waitFor(() => expect(screen.getByText('100.64.10.0/24')).toBeInTheDocument());
    await user.click(screen.getByTestId('preview-simulator-button'));
    await user.click(await screen.findByText(/Live Packet Simulator/i));
    await user.click(await screen.findByTestId('simulate-packet-submit'));
    await screen.findByTestId('simulation-result-card');

    await user.click(screen.getByTestId('save-as-policy-test'));
    await waitFor(() => expect(policyTestsState.length).toBe(1));
    // The packet the server says it evaluated, with the verdict it gave: the mock answers for
    // 100.64.20.1 -> 8.8.8.8 UDP 53, not for what the form held.
    expect(policyTestsState[0]).toMatchObject({
      source_ip: '100.64.20.1',
      destination_ip: '8.8.8.8',
      protocol: 'UDP',
      port: 53,
      expect: 'DROP'
    });
  });
});
