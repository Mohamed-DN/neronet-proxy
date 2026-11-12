import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NukeRoute from './NukeRoute';
import { ShellProvider } from '../shell';
import { createQueryClient } from '../../services/queries/client';
import type { DualAuthRequest, LegalHold, NukeGovernanceOverview } from '../../services/types';
import type { ThemeName } from '../../ui/tokens';
import i18n from '../../i18n';

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

function renderNuke(initialEntries = ['/nuke'], theme: ThemeName = 'light') {
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
    </QueryClientProvider>,
    { theme }
  );
}

/** Each text node on its own, so adjacent labels are not glued into one word. */
function expectNoUpperCaseStatusWords(container: HTMLElement) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  while (walker.nextNode()) texts.push((walker.currentNode.textContent ?? '').trim());
  expect(texts.filter((text) => /^(ORGANIZATION|GLOBAL|PENDING|EXECUTED|REJECTED|EXPIRED|ACTIVE)$/.test(text))).toEqual(
    []
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
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Permanent data erasure/i);
    });

    // Check Stat cards
    expect(screen.getByText(/Data status/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Active Legal Holds/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Pending requests/i)).toBeInTheDocument();

    // Check dual-auth rows in table
    await waitFor(() => {
      expect(screen.getByText('org-shred-target')).toBeInTheDocument();
      expect(screen.getByText('Compliance GDPR Art. 17 Right to be Forgotten')).toBeInTheDocument();
    });

    // Status words are sentence case, never upper-cased copy
    expectNoUpperCaseStatusWords(container);

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
    const reqBtn = screen.getByRole('button', { name: /request erasure/i });
    await user.click(reqBtn);

    // Fill form
    const targetInput = screen.getByPlaceholderText('For example org-123');
    await user.type(targetInput, 'org-finance-corrupted');

    const commentInput = screen.getByPlaceholderText(/Reason or ticket number/i);
    await user.type(commentInput, 'Ransomware threat mitigation');

    const confirmInput = screen.getByPlaceholderText('CONFIRM DESTRUCTION');
    await user.type(confirmInput, 'CONFIRM DESTRUCTION');

    // Submit
    const submitBtn = screen.getByRole('button', { name: /Send the erasure request/i });
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
    const approveBtn = screen.getByRole('button', { name: /Approve and erase the data/i });
    await user.click(approveBtn);

    // Modal opens
    expect(screen.getByRole('heading', { name: /Approve and erase the data for good/i })).toBeInTheDocument();

    // Check confirmation certification checkbox
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    // Execute button
    const executeBtn = screen.getByRole('button', { name: /Erase the data for good/i });
    await user.click(executeBtn);

    // Modal closes and status changes to Executed
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Erase the data for good/i })).not.toBeInTheDocument();
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
    const rejectBtn = screen.getByRole('button', { name: /reject the request/i });
    await user.click(rejectBtn);
    await user.click(await screen.findByRole('button', { name: /reject the request/i }));

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
    const holdsTab = screen.getByRole('tab', { name: /Legal holds/i });
    await user.click(holdsTab);

    // Verify existing hold row
    await waitFor(() => {
      expect(screen.getByText('org-litigation-alpha')).toBeInTheDocument();
    });

    // Click Impose Legal Hold
    const imposeBtn = screen.getByRole('button', { name: /Apply a legal hold/i });
    await user.click(imposeBtn);

    // Fill form
    const orgInput = screen.getByPlaceholderText('For example org-123');
    await user.type(orgInput, 'org-preservation-bank');

    const reasonInput = screen.getByPlaceholderText(/court order no. 2026-CV-9824/i);
    await user.type(reasonInput, 'Bank of Italy Preservation Directive #882');

    const submitBtn = screen.getByRole('button', { name: /Apply the legal hold/i });
    await user.click(submitBtn);

    // Verify new hold added
    await waitFor(() => {
      expect(screen.getByText('org-preservation-bank')).toBeInTheDocument();
    });

    // Release existing hold hold-201
    const releaseBtn = screen.getAllByRole('button', { name: /remove the legal hold/i })[0];
    if (!releaseBtn) throw new Error('expected at least one Release Hold button');
    await user.click(releaseBtn);

    // Confirm release modal
    const confirmReleaseBtn = within(await screen.findByRole('dialog')).getByRole('button', {
      name: /remove the legal hold/i
    });
    await user.click(confirmReleaseBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
    const dmsTab = screen.getByRole('tab', { name: /Presence check and signals/i });
    await user.click(dmsTab);

    // Verify Canary text and DMS form
    expect(screen.getByText(/Transparency signal/i)).toBeInTheDocument();
    expect(screen.getByText(/Valid signature/i)).toBeInTheDocument();

    // Fill passphrase and submit heartbeat
    const passInput = screen.getByPlaceholderText(/Owner's main password/i);
    await user.type(passInput, 'owner-secret-passphrase-2026');

    const resetBtn = screen.getByRole('button', { name: /Restart the countdown/i });
    await user.click(resetBtn);

    await waitFor(() => {
      expect(screen.getByText(/Heartbeat confirmed. The countdown has restarted./i)).toBeInTheDocument();
    });
  });

  it('12. Rejecting a request asks first in a dialog, and window.confirm is never called', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url.includes('/nuke/status')) return jsonResponse(mockOverview);
      if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
      if (url.includes('/nuke/dual-auth/reject/') && method === 'POST') return jsonResponse({ success: true });
      if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
      return jsonResponse({});
    });

    renderNuke();
    await waitFor(() => expect(screen.getByText('org-shred-target')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /reject the request/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reject this erasure request?')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('13. A legal hold that is not removed says so inline, and window.alert is never called', async () => {
    const user = userEvent.setup();
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (method !== 'GET') return jsonResponse({ error: 'database unavailable' }, 500);
      if (url.includes('/nuke/status')) return jsonResponse(mockOverview);
      if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
      if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
      return jsonResponse({});
    });

    renderNuke();
    await user.click(await screen.findByRole('tab', { name: /Legal holds/i }));
    const releaseButton = (await screen.findAllByRole('button', { name: /remove the legal hold/i }))[0];
    if (!releaseButton) throw new Error('expected a release button');
    await user.click(releaseButton);
    const releaseDialog = await screen.findByRole('dialog');
    await user.click(within(releaseDialog).getByRole('button', { name: /remove the legal hold/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The legal hold was not removed. Try again.');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('14. Italian keeps CONFIRM DESTRUCTION in English inside the request dialog', async () => {
    const user = userEvent.setup();
    await i18n.changeLanguage('it');
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = String(input);
        if (url.includes('/nuke/status')) return jsonResponse(mockOverview);
        if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
        if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
        return jsonResponse({});
      });
      renderNuke();
      await user.click(await screen.findByRole('button', { name: /richiedi la cancellazione/i }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getAllByText(/CONFIRM DESTRUCTION/).length).toBeGreaterThan(0);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
  it('15. A started global erasure is a toast, and window.alert is never called', async () => {
    const user = userEvent.setup();
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url.includes('/nuke/owner-dms/trigger') && method === 'POST') return jsonResponse({ success: true });
      if (url.includes('/nuke/status')) return jsonResponse(mockOverview);
      if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
      if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
      return jsonResponse({});
    });

    renderNuke();
    await user.click(await screen.findByRole('tab', { name: /Presence check and signals/i }));
    await user.click(screen.getByRole('button', { name: /Erase all data now/i }));

    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByPlaceholderText('DESTROY EVERYTHING PERMANENTLY'),
      'DESTROY EVERYTHING PERMANENTLY'
    );
    await user.type(within(dialog).getByPlaceholderText('Super-admin password...'), 'super-secret-2026');
    await user.click(within(dialog).getByRole('button', { name: /Erase everything now/i }));

    expect(await screen.findByText('Global erasure started.')).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('16. A missing key status reads Not measured, never ACTIVE', async () => {
    const withoutKeys: Record<string, unknown> = { ...mockOverview };
    delete withoutKeys.keys_status;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/nuke/status')) return jsonResponse(withoutKeys);
      if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
      if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
      return jsonResponse({});
    });

    const { container } = renderNuke();
    await waitFor(() => expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0));
    expectNoUpperCaseStatusWords(container);
  });

  it('17. The page passes axe-core in dark theme with no upper-cased status words', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/nuke/status')) return jsonResponse(mockOverview);
      if (url.includes('/nuke/legal-hold')) return jsonResponse({ legal_holds: holdsState });
      if (url.includes('/nuke/dual-auth')) return jsonResponse({ authorizations: authState });
      return jsonResponse({});
    });

    const { container } = renderNuke(['/nuke'], 'dark');
    await waitFor(() => expect(screen.getByText('org-shred-target')).toBeInTheDocument());
    expectNoUpperCaseStatusWords(container);
    await expectNoAxeViolations(container, 'dark');
  });
});
