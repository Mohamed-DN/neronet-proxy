import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuditRoute from './AuditRoute';
import { ShellProvider } from '../shell';
import { createQueryClient } from '../../services/queries/client';
import type { AuditCheckpoint, AuditEvent, AuditVerificationResult, SiemDestination } from '../../services/types';
import '../../i18n';

const mockEvents: AuditEvent[] = [
  {
    id: 'audit-1',
    sequence_num: 1,
    prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    entry_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    event_type: 'NODE_ENROLLED',
    severity: 'info',
    actor_username: 'admin',
    target_id: 'node-rome-1',
    message: 'Sovereign node enrolled successfully',
    ip_address: '10.0.0.1',
    user_agent: 'NeroNet-CLI/4.0',
    metadata_json: { node_id: 'node-rome-1', country: 'IT' },
    created_at: '2026-09-24T08:00:00.000Z'
  },
  {
    id: 'audit-2',
    sequence_num: 2,
    prev_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    entry_hash: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    event_type: 'ACL_RULE_CREATED',
    severity: 'warn',
    actor_username: 'secops',
    target_id: 'acl-rule-100',
    message: 'Zero-Trust default deny rule created',
    ip_address: '10.0.0.2',
    user_agent: 'NeroNet-Console/4.0',
    metadata_json: { rule_id: 'acl-rule-100', action: 'DROP' },
    created_at: '2026-09-24T08:05:00.000Z'
  }
];

const mockVerification: AuditVerificationResult = {
  valid: true,
  events_count: 2,
  first_sequence: 1,
  last_sequence: 2,
  timestamp: '2026-09-24T08:10:00.000Z'
};

const mockCheckpoints: AuditCheckpoint[] = [
  {
    id: 'cp-1',
    sequence_num: 2,
    event_hash: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    signature: '3045022100abcd...ed25519sig',
    public_key: 'base64pubkey...',
    created_at: '2026-09-24T08:15:00.000Z'
  }
];

const mockSiemTargets: SiemDestination[] = [
  {
    id: 'siem-1',
    name: 'Corporate Splunk Collector',
    protocol: 'udp',
    endpoint: '10.10.0.50:514',
    format: 'rfc5424',
    enabled: true
  }
];

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function renderAudit(initialEntries = ['/audit']) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false }
  });

  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route path="/audit" element={<AuditRoute />} />
          </Routes>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>
  );
}

describe('WP-408: AuditRoute (Tamper-Evident HMAC Ledger & SIEM Exporter UI)', () => {
  let eventsState: AuditEvent[] = [];
  let siemState: SiemDestination[] = [];
  let checkpointsState: AuditCheckpoint[] = [];

  beforeEach(() => {
    eventsState = [...mockEvents];
    siemState = [...mockSiemTargets];
    checkpointsState = [...mockCheckpoints];
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupFetchMock() {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      const method = init?.method || 'GET';

      // 1. GET /api/audit/events or /api/audit/logs
      if (urlStr.includes('/api/audit/events') || urlStr.includes('/api/audit/logs')) {
        return jsonResponse({ audit_logs: eventsState, total: eventsState.length });
      }

      // 2. GET /api/audit/verify
      if (urlStr.includes('/api/audit/verify')) {
        return jsonResponse({ verification: mockVerification });
      }

      // 3. GET /api/audit/checkpoints
      if (urlStr.includes('/api/audit/checkpoints') && method === 'GET') {
        return jsonResponse({ checkpoints: checkpointsState, public_key: 'testpubkey' });
      }

      // 4. POST /api/audit/checkpoints
      if (urlStr.includes('/api/audit/checkpoints') && method === 'POST') {
        const newCp: AuditCheckpoint = {
          id: `cp-${Date.now()}`,
          sequence_num: 2,
          event_hash: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
          signature: 'newsigned25519',
          created_at: new Date().toISOString()
        };
        checkpointsState.push(newCp);
        return jsonResponse({ checkpoint: newCp }, 201);
      }

      // 5. GET /api/audit/siem
      if (urlStr.includes('/api/audit/siem') && method === 'GET') {
        return jsonResponse({ destinations: siemState });
      }

      // 6. POST /api/audit/siem
      if (urlStr.includes('/api/audit/siem') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        const newDest: SiemDestination = {
          id: `siem-${Date.now()}`,
          name: body.name,
          protocol: body.protocol,
          endpoint: body.endpoint,
          format: body.format || 'rfc5424',
          enabled: true
        };
        siemState.push(newDest);
        return jsonResponse({ destination: newDest }, 201);
      }

      // 7. DELETE /api/audit/siem/:id
      if (urlStr.includes('/api/audit/siem/') && method === 'DELETE') {
        const id = urlStr.split('/api/audit/siem/')[1];
        siemState = siemState.filter((d) => d.id !== id);
        return jsonResponse({ success: true, deleted: id });
      }

      return jsonResponse({ error: 'unhandled test endpoint' }, 404);
    });
  }

  it('1. Renders audit events table, cryptographic stats, and passes axe-core accessibility', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const { container } = renderAudit();

    await waitFor(() => {
      expect(screen.getByText('Sovereign node enrolled successfully')).toBeInTheDocument();
      expect(screen.getByText('Zero-Trust default deny rule created')).toBeInTheDocument();
    });

    // Check sequences and badges
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(screen.getByText('NODE_ENROLLED')).toBeInTheDocument();

    // Verify zero axe violations
    await expectNoAxeViolations(container);
  });

  it('2. Filters audit logs via search term and severity selector', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    renderAudit();

    await waitFor(() => {
      expect(screen.getByText('Sovereign node enrolled successfully')).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText(/filter audit events search/i);
    await user.type(searchInput, 'enrolled');

    expect(screen.getByText('Sovereign node enrolled successfully')).toBeInTheDocument();
    expect(screen.queryByText('Zero-Trust default deny rule created')).not.toBeInTheDocument();
  });

  it('3. Opens Cryptographic Chain Verification modal and passes axe-core', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    const { container } = renderAudit();

    await waitFor(() => {
      expect(screen.getByTestId('verify-chain-button')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('verify-chain-button'));

    // Modal should be open
    await waitFor(() => {
      expect(screen.getByTestId('verification-pass-card')).toBeInTheDocument();
      expect(screen.getByText(/CHAIN INTEGRITY VERIFIED/i)).toBeInTheDocument();
    });

    // Check accessibility with modal open
    await expectNoAxeViolations(container);
  });

  it('4. Opens Checkpoints Dialog and creates signed Ed25519 checkpoint', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    const { container } = renderAudit();

    await waitFor(() => {
      expect(screen.getByTestId('checkpoints-button')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('checkpoints-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-checkpoint-submit')).toBeInTheDocument();
    });

    await expectNoAxeViolations(container);

    await user.click(screen.getByTestId('create-checkpoint-submit'));

    await waitFor(() => {
      expect(screen.queryByTestId('create-checkpoint-submit')).not.toBeInTheDocument();
    });
  });

  it('5. Manages SIEM forwarding targets (add and delete) with zero axe violations', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    const { container } = renderAudit();

    await waitFor(() => {
      expect(screen.getByTestId('siem-button')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('siem-button'));

    await waitFor(() => {
      expect(screen.getByText('Corporate Splunk Collector')).toBeInTheDocument();
    });

    await expectNoAxeViolations(container);

    // Add new SIEM forwarder
    const nameInput = screen.getByLabelText(/destination name/i);
    const endpointInput = screen.getByLabelText(/collector endpoint/i);
    await user.type(nameInput, 'Elastic SOC');
    await user.type(endpointInput, '10.20.0.100:5044');

    await user.click(screen.getByTestId('add-siem-submit'));

    await waitFor(() => {
      expect(screen.getByText('Elastic SOC')).toBeInTheDocument();
    });

    // Delete existing target
    const deleteBtn = screen.getByRole('button', { name: /delete siem target corporate splunk collector/i });
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.queryByText('Corporate Splunk Collector')).not.toBeInTheDocument();
    });
  });

  it('6. Inspects individual audit event details including full HMAC hashes and metadata', async () => {
    vi.stubGlobal('fetch', setupFetchMock());
    const user = userEvent.setup();
    const { container } = renderAudit();

    await waitFor(() => {
      expect(screen.getByTestId('inspect-event-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('inspect-event-1'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Sequence #1/i })).toBeInTheDocument();
      expect(screen.getByText('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBeInTheDocument();
    });

    await expectNoAxeViolations(container);
  });
});
