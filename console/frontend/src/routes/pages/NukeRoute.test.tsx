import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NukeRoute from './NukeRoute';
import { ShellProvider } from '../shell';
import { createQueryClient } from '../../services/queries/client';
import type { DualAuthRequest, LegalHold, NukeGovernanceOverview } from '../../services/types';
import '../../i18n';

const mockOverview: NukeGovernanceOverview = {
  armed: true,
  legal_hold_active: true,
  active_legal_holds: 1,
  pending_authorizations: 1,
  keys_status: 'active',
  owner_dms_armed: true
};

const mockAuthorizations: DualAuthRequest[] = [
  {
    id: 'auth-101',
    target_type: 'organization',
    target_id: 'org-shred-target',
    initiator_user_id: 'usr-admin-1',
    initiator_comment: 'Compliance GDPR Art. 17 Right to be Forgotten',
    status: 'pending',
    expires_at: '2026-09-25T12:00:00.000Z',
    created_at: '2026-09-24T09:00:00.000Z'
  },
  {
    id: 'auth-102',
    target_type: 'organization',
    target_id: 'org-old-client',
    initiator_user_id: 'usr-admin-secops',
    initiator_comment: 'Tenant decommission complete',
    approver_user_id: 'usr-admin-approver',
    approver_comment: 'Verified zero active subscriptions',
    status: 'executed',
    expires_at: '2026-09-23T10:00:00.000Z',
    created_at: '2026-09-22T08:00:00.000Z',
    executed_at: '2026-09-22T09:30:00.000Z'
  }
];

const mockLegalHolds: LegalHold[] = [
  {
    id: 'hold-201',
    organization_id: 'org-litigation-alpha',
    reason: 'Department of Justice Subpoena #2026-DOC-4481',
    imposed_by_user_id: 'usr-compliance-officer',
    active: true,
    created_at: '2026-09-20T14:00:00.000Z'
  },
  {
    id: 'hold-202',
    organization_id: 'org-audit-beta',
    reason: 'Internal SEC inspection order',
    imposed_by_user_id: 'usr-compliance-officer',
    active: false,
    created_at: '2026-09-10T11:00:00.000Z',
    released_at: '2026-09-18T16:00:00.000Z'
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

function renderNuke(initialEntries = ['/nuke']) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false }
  });

  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route path="/nuke" element={<NukeRoute />} />
          </Routes>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>
  );
}

describe('WP-409: NukeRoute (NeroNuke v2 Dual-Auth & Legal Hold UI)', () => {
  let authState: DualAuthRequest[] = [];
  let holdsState: LegalHold[] = [];

  beforeEach(() => {
    authState = JSON.parse(JSON.stringify(mockAuthorizations));
    holdsState = JSON.parse(JSON.stringify(mockLegalHolds));
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Renders stat cards, dual-auth table, and passes axe-core accessibility with 0 violations', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/nuke/status')) {
        return jsonResponse(mockOverview);
      }
      if (url.includes('/nuke/legal-hold')) {
        return jsonResponse({ legal_holds: holdsState });
      }
      if (url.includes('/nuke/dual-auth')) {
        return jsonResponse({ authorizations: authState });
      }
      if (url.includes('/nuke/owner-dms/status')) {
        return jsonResponse({ armed: true, interval_days: 30 });
      }
      return jsonResponse({});
    });

    const { container } = renderNuke();

    // Verify Title & Stats
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        /Cryptographic Shredding & NeroNuke Governance/i
      );
    });

    // Check Stat cards
    expect(screen.getByText(/Encryption Keys Status/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Active Legal Holds/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Dual-Auth Requests/i)).toBeInTheDocument();

    // Check dual-auth rows in table
    await waitFor(() => {
      expect(screen.getByText('org-shred-target')).toBeInTheDocument();
      expect(screen.getByText('Compliance GDPR Art. 17 Right to be Forgotten')).toBeInTheDocument();
    });

    // Verify 0 accessibility violations in axe-core
    await expectNoAxeViolations(container);
  });

  it('2. Proposes a new dual-authorization destruction request via modal', async () => {
    const user = userEvent.setup();

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.includes('/nuke/status')) return jsonResponse(mockOverview);
      if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
      if (url.includes('/nuke/dual-auth/request') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        const newReq: DualAuthRequest = {
          id: 'auth-new-999',
          target_type: body.target_type,
          target_id: body.target_id,
          initiator_user_id: 'usr-admin-current',
          initiator_comment: body.comment,
          status: 'pending',
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          created_at: new Date().toISOString()
        };
        authState.unshift(newReq);
        return jsonResponse({ authorization: newReq }, 201);
      }
      if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
      return jsonResponse({});
    });

    renderNuke();

    await waitFor(() => {
      expect(screen.getByText('org-shred-target')).toBeInTheDocument();
    });

    // Open Request Destruction modal
    const reqBtn = screen.getByRole('button', { name: /Request Destruction/i });
    await user.click(reqBtn);

    // Fill form
    const targetInput = screen.getByPlaceholderText('e.g. org-target-1');
    await user.type(targetInput, 'org-finance-corrupted');

    const commentInput = screen.getByPlaceholderText(/Administrative reason or ticket reference/i);
    await user.type(commentInput, 'Ransomware threat mitigation');

    const confirmInput = screen.getByPlaceholderText('CONFIRM DESTRUCTION');
    await user.type(confirmInput, 'CONFIRM DESTRUCTION');

    // Submit
    const submitBtn = screen.getByRole('button', { name: /Submit Destruction Request/i });
    await user.click(submitBtn);

    // Modal closes and new request appears in table
    await waitFor(() => {
      expect(screen.getByText('org-finance-corrupted')).toBeInTheDocument();
    });
  });

  it('3. Approves and executes dual-auth destruction as second administrator', async () => {
    const user = userEvent.setup();

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.includes('/nuke/status')) return jsonResponse(mockOverview);
      if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
      if (url.includes('/nuke/dual-auth/approve/auth-101') && method === 'POST') {
        const item = authState.find((r) => r.id === 'auth-101');
        if (item) {
          item.status = 'executed';
          item.approver_user_id = 'usr-admin-approver-2';
        }
        return jsonResponse({ success: true, authorization_id: 'auth-101' });
      }
      if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
      return jsonResponse({});
    });

    renderNuke();

    await waitFor(() => {
      expect(screen.getByText('org-shred-target')).toBeInTheDocument();
    });

    // Click Approve & Shred on the pending request
    const approveBtn = screen.getByRole('button', { name: /Approve & Shred/i });
    await user.click(approveBtn);

    // Modal opens
    expect(screen.getByRole('heading', { name: /Approve & Execute Irreversible Destruction/i })).toBeInTheDocument();

    // Check confirmation certification checkbox
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    // Execute button
    const executeBtn = screen.getByRole('button', { name: /Permanently Execute Shredding/i });
    await user.click(executeBtn);

    // Modal closes and status changes to Executed
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Permanently Execute Shredding/i })).not.toBeInTheDocument();
    });
  });

  it('4. Rejects a pending dual-authorization destruction request', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.includes('/nuke/status')) return jsonResponse(mockOverview);
      if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
      if (url.includes('/nuke/dual-auth/reject/auth-101') && method === 'POST') {
        const item = authState.find((r) => r.id === 'auth-101');
        if (item) {
          item.status = 'rejected';
        }
        return jsonResponse({ success: true, authorization: item });
      }
      if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
      return jsonResponse({});
    });

    renderNuke();

    await waitFor(() => {
      expect(screen.getByText('org-shred-target')).toBeInTheDocument();
    });

    // Click Reject Request
    const rejectBtn = screen.getByRole('button', { name: /Reject Request/i });
    await user.click(rejectBtn);

    await waitFor(() => {
      expect(screen.getByText(/Rejected/i)).toBeInTheDocument();
    });
  });

  it('5. Manages legal holds (imposing and releasing preservation orders)', async () => {
    const user = userEvent.setup();

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.includes('/nuke/status')) return jsonResponse(mockOverview);
      if (url.includes('/nuke/legal-hold') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        const newHold: LegalHold = {
          id: 'hold-new-303',
          organization_id: body.organization_id,
          reason: body.reason,
          imposed_by_user_id: 'usr-compliance',
          active: true,
          created_at: new Date().toISOString()
        };
        holdsState.unshift(newHold);
        return jsonResponse({ hold: newHold }, 201);
      }
      if (url.includes('/nuke/legal-hold/hold-201') && method === 'DELETE') {
        const item = holdsState.find((h) => h.id === 'hold-201');
        if (item) item.active = false;
        return jsonResponse({ success: true, released: item });
      }
      if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
      if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
      return jsonResponse({});
    });

    renderNuke();

    // Switch to Legal Holds tab
    const holdsTab = screen.getByRole('tab', { name: /Legal Holds & Preservation/i });
    await user.click(holdsTab);

    // Verify existing hold row
    await waitFor(() => {
      expect(screen.getByText('org-litigation-alpha')).toBeInTheDocument();
    });

    // Click Impose Legal Hold
    const imposeBtn = screen.getByRole('button', { name: /Impose Legal Hold/i });
    await user.click(imposeBtn);

    // Fill form
    const orgInput = screen.getByPlaceholderText('e.g. org-enterprise-target');
    await user.type(orgInput, 'org-preservation-bank');

    const reasonInput = screen.getByPlaceholderText(/Court Order #2026-CV-9824 Preservation Order/i);
    await user.type(reasonInput, 'Bank of Italy Preservation Directive #882');

    const submitBtn = screen.getByRole('button', { name: /Enforce Legal Hold/i });
    await user.click(submitBtn);

    // Verify new hold added
    await waitFor(() => {
      expect(screen.getByText('org-preservation-bank')).toBeInTheDocument();
    });

    // Release existing hold hold-201
    const releaseBtn = screen.getAllByRole('button', { name: /Release Hold/i })[0];
    if (!releaseBtn) throw new Error('expected at least one Release Hold button');
    await user.click(releaseBtn);

    // Confirm release modal
    const confirmReleaseBtn = screen.getByRole('button', { name: /Confirm Release/i });
    await user.click(confirmReleaseBtn);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Confirm Release/i })).not.toBeInTheDocument();
    });
  });

  it("6. Dead Man's Switch & Warrant Canary tab interactions and DMS heartbeat reset", async () => {
    const user = userEvent.setup();

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.includes('/nuke/status')) return jsonResponse(mockOverview);
      if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
      if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
      if (url.includes('/nuke/owner-dms/heartbeat') && method === 'POST') {
        return jsonResponse({ success: true, message: 'Heartbeat acknowledged' });
      }
      if (url.includes('/nuke/owner-dms/status')) {
        return jsonResponse({ armed: true, interval_days: 30 });
      }
      return jsonResponse({});
    });

    renderNuke();

    // Switch to DMS & Canary tab
    const dmsTab = screen.getByRole('tab', { name: /Dead Man's Switch & Canary/i });
    await user.click(dmsTab);

    // Verify Canary text and DMS form
    expect(screen.getByText(/Warrant Canary Signed Signal/i)).toBeInTheDocument();
    expect(screen.getByText(/VALID ED25519 SIGNATURE/i)).toBeInTheDocument();

    // Fill passphrase and submit heartbeat
    const passInput = screen.getByPlaceholderText(/Owner passphrase/i);
    await user.type(passInput, 'owner-secret-passphrase-2026');

    const resetBtn = screen.getByRole('button', { name: /Reset Global Wipe Timer/i });
    await user.click(resetBtn);

    await waitFor(() => {
      expect(screen.getByText(/Heartbeat confirmed. Global wipe timer reset successfully./i)).toBeInTheDocument();
    });
  });
});
