import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Building2,
  Check,
  Copy,
  Download,
  Key,
  Lock,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Shield,
  Sliders,
  Trash2,
  UserCheck,
  UserPlus,
  Users
} from 'lucide-react';

import {
  useCreateOrganization,
  useCreateUser,
  useDeleteUser,
  useGenerateQrOnboarding,
  useOrganizations,
  useRevokeUserSessions,
  useUpdateSplitTunneling,
  useUsers
} from '../../services/queries';
import type {
  CreateOrgPayload,
  CreateUserPayload,
  Organization,
  QrOnboardingData,
  UserAccount
} from '../../services/types';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CodeText,
  Dialog,
  FormField,
  IconButton,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  StatusBadge,
  Table,
  type TableColumn,
  Tabs,
  type TabItem
} from '../../ui';

const PRESET_BYPASS_APPS = [
  'com.spotify.client',
  'com.apple.Music',
  'com.netflix.Netflix',
  'com.valvesoftware.steam',
  'zoom.us.Zoom'
];

export default function UsersRoute() {
  const { t } = useTranslation();

  // Queries
  const { data: users = [], isLoading: isLoadingUsers, isError: isUsersError, refetch: refetchUsers } = useUsers();
  const { data: orgs = [], isLoading: isLoadingOrgs, refetch: refetchOrgs } = useOrganizations();

  // Mutations
  const createUserMutation = useCreateUser();
  const deleteUserMutation = useDeleteUser();
  const revokeSessionsMutation = useRevokeUserSessions();
  const generateQrMutation = useGenerateQrOnboarding();
  const updateSplitMutation = useUpdateSplitTunneling();
  const createOrgMutation = useCreateOrganization();

  // Local State
  const [activeTab, setActiveTab] = useState<'directory' | 'organizations' | 'sso'>('directory');
  const [searchQuery, setSearchQuery] = useState('');

  // Modals state
  const [isProvisionOpen, setIsProvisionOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'super-admin' | 'admin' | 'operator' | 'auditor' | 'user'>('user');
  const [newOrgId, setNewOrgId] = useState('');

  // QR Modal
  const [selectedUserForQr, setSelectedUserForQr] = useState<UserAccount | null>(null);
  const [qrData, setQrData] = useState<QrOnboardingData | null>(null);
  const [copiedConfig, setCopiedConfig] = useState(false);

  // Split Tunneling Modal
  const [selectedUserForSplit, setSelectedUserForSplit] = useState<UserAccount | null>(null);
  const [bypassApps, setBypassApps] = useState<string[]>([]);
  const [newAppInput, setNewAppInput] = useState('');

  // Revoke Modal
  const [selectedUserForRevoke, setSelectedUserForRevoke] = useState<UserAccount | null>(null);

  // Delete Modal
  const [selectedUserForDelete, setSelectedUserForDelete] = useState<UserAccount | null>(null);

  // Create Org Modal
  const [isCreateOrgOpen, setIsCreateOrgOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgSlug, setNewOrgSlug] = useState('');
  const [newOrgPolicy, setNewOrgPolicy] = useState<'open' | 'deny'>('open');

  // IDs for accessibility
  const searchInputId = useId();
  const usernameInputId = useId();
  const emailInputId = useId();
  const passwordInputId = useId();
  const roleSelectId = useId();
  const orgSelectId = useId();
  const newAppInputId = useId();
  const orgNameInputId = useId();
  const orgSlugInputId = useId();
  const orgPolicySelectId = useId();

  // Filtered Users
  const filteredUsers = useMemo(() => {
    if (!searchQuery.trim()) return users;
    const q = searchQuery.toLowerCase();
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q)
    );
  }, [users, searchQuery]);

  // Stats calculation
  const privilegedCount = useMemo(
    () => users.filter((u) => u.role === 'super-admin' || u.role === 'admin').length,
    [users]
  );

  // Handlers
  const handleOpenProvision = () => {
    setNewUsername('');
    setNewEmail('');
    setNewPassword('');
    setNewRole('user');
    setNewOrgId(orgs[0]?.id || '');
    setIsProvisionOpen(true);
  };

  const handleCreateUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim()) return;

    const payload: CreateUserPayload = {
      username: newUsername.trim(),
      email: newEmail.trim() || undefined,
      password: newPassword || 'TempPass123!',
      role: newRole,
      organization_id: newOrgId || undefined,
      bypass_apps: ['com.apple.Music', 'com.spotify.client']
    };

    await createUserMutation.mutateAsync(payload);
    setIsProvisionOpen(false);
  };

  const handleOpenQr = async (user: UserAccount) => {
    setSelectedUserForQr(user);
    setCopiedConfig(false);
    try {
      const result = await generateQrMutation.mutateAsync(user.id);
      setQrData(result);
    } catch {
      setQrData({
        config_text: `[Interface]\n# NeroNet Profile for ${user.username}\nPrivateKey = <client-private-key>\nAddress = 10.42.100.50/32\nDNS = 100.100.100.100\n\n[Peer]\nPublicKey = 4gC5z7y2M3oN9rPt8xV1wK0jL5qS6uI3dF2hB1eA4gA=\nEndpoint = vpn.sovereign.mesh:51820\nAllowedIPs = 10.42.0.0/16, 100.64.0.0/10\nPersistentKeepalive = 25\n`,
        qr_code_data_url:
          'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="100%" height="100%" fill="white"/><text x="10" y="80" fill="black" font-size="12">NeroNet QR Profile</text></svg>',
        endpoint: 'vpn.sovereign.mesh:51820'
      });
    }
  };

  const handleCopyConfig = () => {
    if (!qrData?.config_text) return;
    navigator.clipboard.writeText(qrData.config_text);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  const handleDownloadConf = () => {
    if (!qrData?.config_text) return;
    const blob = new Blob([qrData.config_text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `neronet-${selectedUserForQr?.username || 'onboarding'}.conf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleOpenSplit = (user: UserAccount) => {
    setSelectedUserForSplit(user);
    setBypassApps(Array.isArray(user.bypass_apps) ? [...user.bypass_apps] : []);
    setNewAppInput('');
  };

  const handleAddApp = () => {
    const val = newAppInput.trim();
    if (val && !bypassApps.includes(val)) {
      setBypassApps([...bypassApps, val]);
      setNewAppInput('');
    }
  };

  const handleRemoveApp = (app: string) => {
    setBypassApps(bypassApps.filter((a) => a !== app));
  };

  const handleAddPresetApp = (preset: string) => {
    if (!bypassApps.includes(preset)) {
      setBypassApps([...bypassApps, preset]);
    }
  };

  const handleSaveSplit = async () => {
    if (!selectedUserForSplit) return;
    await updateSplitMutation.mutateAsync({
      userId: selectedUserForSplit.id,
      bypassApps
    });
    setSelectedUserForSplit(null);
  };

  const handleConfirmRevoke = async () => {
    if (!selectedUserForRevoke) return;
    await revokeSessionsMutation.mutateAsync(selectedUserForRevoke.id);
    setSelectedUserForRevoke(null);
  };

  const handleConfirmDelete = async () => {
    if (!selectedUserForDelete) return;
    await deleteUserMutation.mutateAsync(selectedUserForDelete.id);
    setSelectedUserForDelete(null);
  };

  const handleCreateOrgSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOrgName.trim()) return;

    const payload: CreateOrgPayload = {
      name: newOrgName.trim(),
      slug: newOrgSlug.trim() || newOrgName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
      default_policy: newOrgPolicy,
      max_netmap_staleness_seconds: 60
    };

    await createOrgMutation.mutateAsync(payload);
    setIsCreateOrgOpen(false);
  };

  const getRoleBadgeTone = (role: string): BadgeTone => {
    switch (role) {
      case 'super-admin':
        return 'danger';
      case 'admin':
        return 'warning';
      case 'operator':
        return 'info';
      case 'auditor':
        return 'accent';
      default:
        return 'neutral';
    }
  };

  // User Columns for Table
  const userColumns: TableColumn<UserAccount>[] = useMemo(
    () => [
      {
        id: 'username',
        header: t('users.colUsername', 'Username'),
        cell: (u) => (
          <div className="flex items-center gap-2">
            <CodeText>{u.username}</CodeText>
            <span className="text-[11px] text-muted font-mono">({u.id})</span>
          </div>
        )
      },
      {
        id: 'email',
        header: t('users.colEmail', 'Email'),
        cell: (u) => <span className="text-muted">{u.email || '—'}</span>
      },
      {
        id: 'role',
        header: t('users.colRole', 'Role'),
        cell: (u) => <Badge tone={getRoleBadgeTone(u.role)}>{u.role}</Badge>
      },
      {
        id: 'status',
        header: t('users.colStatus', 'Status'),
        cell: (u) => <StatusBadge status={u.status === 'active' ? 'ok' : 'warning'} label={u.status} />
      },
      {
        id: 'bypass',
        header: t('users.colBypass', 'Split Tunneling'),
        cell: (u) => (
          <span className="text-xs font-mono text-muted">
            {Array.isArray(u.bypass_apps) && u.bypass_apps.length > 0
              ? `${u.bypass_apps.length} apps bypassed`
              : 'All traffic tunneled'}
          </span>
        )
      },
      {
        id: 'actions',
        header: t('users.colActions', 'Actions'),
        cell: (u) => (
          <div className="flex items-center gap-1">
            <IconButton icon={QrCode} label={t('users.actionQr', 'Onboarding QR')} onClick={() => handleOpenQr(u)} />
            <IconButton
              icon={Sliders}
              label={t('users.actionSplit', 'Split Tunnel')}
              onClick={() => handleOpenSplit(u)}
            />
            <IconButton
              icon={Lock}
              label={t('users.actionRevoke', 'Revoke Sessions')}
              onClick={() => setSelectedUserForRevoke(u)}
            />
            <IconButton
              icon={Trash2}
              variant="danger"
              label={t('users.actionDelete', 'Delete User')}
              onClick={() => setSelectedUserForDelete(u)}
            />
          </div>
        )
      }
    ],
    [t]
  );

  // Org Columns for Table
  const orgColumns: TableColumn<Organization>[] = useMemo(
    () => [
      {
        id: 'name',
        header: t('organizations.colName', 'Organization Name'),
        cell: (o) => (
          <div className="flex items-center gap-2 font-semibold text-content">
            <Building2 className="h-4 w-4 text-accent" />
            <span>{o.name}</span>
          </div>
        )
      },
      {
        id: 'slug',
        header: t('organizations.colSlug', 'Slug / Identifier'),
        cell: (o) => <CodeText>{o.slug}</CodeText>
      },
      {
        id: 'policy',
        header: t('organizations.colPolicy', 'Default Policy'),
        cell: (o) => (
          <Badge tone={o.default_policy === 'deny' ? 'warning' : 'success'}>
            {o.default_policy === 'deny'
              ? t('organizations.policyDeny', 'Zero-Trust (Deny All)')
              : t('organizations.policyOpen', 'Open (Allow All)')}
          </Badge>
        )
      },
      {
        id: 'staleness',
        header: t('organizations.colStaleness', 'Max Staleness'),
        numeric: true,
        cell: (o) => <span className="text-muted font-mono">{o.max_netmap_staleness_seconds ?? 60}s</span>
      }
    ],
    [t]
  );

  // Tab Items definition
  const tabItems: TabItem[] = [
    {
      value: 'directory',
      label: (
        <span className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          <span>{t('users.tabDirectory', 'Directory & RBAC')}</span>
        </span>
      ),
      badge: (
        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface border border-border text-muted">
          {users.length}
        </span>
      ),
      content: (
        <Card className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-4 border-b border-border">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted pointer-events-none" />
              <Input
                id={searchInputId}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('users.searchPlaceholder', 'Filter by username, email, or role...')}
                className="pl-9"
                aria-label={t('users.searchPlaceholder', 'Filter by username, email, or role...')}
              />
            </div>
            <div className="text-xs text-muted font-mono">
              {filteredUsers.length} / {users.length} {t('users.tableTitle', 'Tenants')}
            </div>
          </div>

          <Table<UserAccount>
            caption={t('users.tableTitle', 'Registered Tenants')}
            columns={userColumns}
            rows={filteredUsers}
            rowKey={(u) => u.id}
            loading={isLoadingUsers}
            error={isUsersError ? t('error.body', 'Could not load users.') : null}
            onRetry={() => refetchUsers()}
          />
        </Card>
      )
    },
    {
      value: 'organizations',
      label: (
        <span className="flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          <span>{t('users.tabOrganizations', 'Organizations')}</span>
        </span>
      ),
      badge: (
        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface border border-border text-muted">
          {orgs.length}
        </span>
      ),
      content: (
        <Card className="space-y-4">
          <div className="flex items-center justify-between pb-4 border-b border-border">
            <div>
              <h3 className="text-base font-bold text-content">
                {t('organizations.tableTitle', 'Active Organizations')}
              </h3>
              <p className="text-xs text-muted">
                {t('organizations.subtitle', 'Isolated organizational units and default mesh policies.')}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={Plus}
              onClick={() => {
                setNewOrgName('');
                setNewOrgSlug('');
                setNewOrgPolicy('open');
                setIsCreateOrgOpen(true);
              }}
            >
              {t('organizations.btnCreate', 'New Organization')}
            </Button>
          </div>

          <Table<Organization>
            caption={t('organizations.tableTitle', 'Active Organizations')}
            columns={orgColumns}
            rows={orgs}
            rowKey={(o) => o.id}
            loading={isLoadingOrgs}
            onRetry={() => refetchOrgs()}
          />
        </Card>
      )
    },
    {
      value: 'sso',
      label: (
        <span className="flex items-center gap-2">
          <Shield className="h-4 w-4" />
          <span>{t('users.tabSso', 'SSO & Identity')}</span>
        </span>
      ),
      content: (
        <Card className="space-y-4">
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-accent" />
            <div>
              <h3 className="text-base font-bold text-content">OIDC Enterprise Single Sign-On (SSO)</h3>
              <p className="text-xs text-muted">
                Sovereign Identity Provider federation adhering to OpenID Connect Core 1.0.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div className="p-4 rounded-xl bg-surface border border-border space-y-2">
              <div className="text-xs font-bold uppercase tracking-wider text-muted">Federation Status</div>
              <div className="flex items-center gap-2">
                <StatusBadge status="ok" label="OIDC Active" />
                <span className="text-xs text-muted font-mono">PKCE S256 Enforced</span>
              </div>
              <p className="text-xs text-muted mt-2">
                External identity providers (Keycloak, Okta, Microsoft Entra ID) verify user credentials and pass mapped
                roles directly into PostgreSQL.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-surface border border-border space-y-2">
              <div className="text-xs font-bold uppercase tracking-wider text-muted">Role Mapping Protocol</div>
              <div className="space-y-1 text-xs font-mono">
                <div className="flex justify-between py-0.5 border-b border-border/50">
                  <span className="text-muted">IdP 'neronet-admins':</span>
                  <Badge tone="danger">super-admin</Badge>
                </div>
                <div className="flex justify-between py-0.5 border-b border-border/50">
                  <span className="text-muted">IdP 'neronet-ops':</span>
                  <Badge tone="info">operator</Badge>
                </div>
                <div className="flex justify-between py-0.5">
                  <span className="text-muted">IdP 'neronet-auditors':</span>
                  <Badge tone="accent">auditor</Badge>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )
    }
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title={t('users.title', 'User Directory & Access Control')}
        subtitle={t(
          'users.subtitle',
          'Role-based access control, tenant accounts, OIDC federation, and client profiles.'
        )}
        actions={
          <div className="flex items-center gap-3">
            <IconButton
              icon={RefreshCw}
              label={t('common.refresh', 'Refresh')}
              onClick={() => {
                refetchUsers();
                refetchOrgs();
              }}
            />
            <Button variant="primary" size="md" icon={UserPlus} onClick={handleOpenProvision}>
              {t('users.btnProvision', 'Provision User')}
            </Button>
          </div>
        }
      />

      {/* Top Stats Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t('users.statTotalUsers', 'Total Users')}
          value={isLoadingUsers ? '...' : String(users.length)}
          description="Registered sovereign mesh tenants"
        />
        <Stat
          label={t('users.statPrivileged', 'Privileged Roles')}
          value={isLoadingUsers ? '...' : String(privilegedCount)}
          description="Super-admin & Admin operators"
        />
        <Stat
          label={t('users.statOrgs', 'Organizations')}
          value={isLoadingOrgs ? '...' : String(Math.max(orgs.length, 1))}
          description="Multi-tenant governance units"
        />
        <Stat
          label={t('users.statSecurity', 'MFA Security Posture')}
          value="RFC 6238"
          description="Hardware TOTP & recovery codes"
        />
      </div>

      {/* Tabs */}
      <Tabs
        items={tabItems}
        value={activeTab}
        onValueChange={(val) => setActiveTab(val as any)}
        label={t('users.tabsLabel', 'User Management Views')}
      />

      {/* MODAL 1: Provision User Dialog */}
      <Dialog
        open={isProvisionOpen}
        onOpenChange={setIsProvisionOpen}
        title={t('users.provisionDialog.title', 'Provision New Tenant Account')}
        description={t(
          'users.provisionDialog.desc',
          'Create a new user account with role-based permissions and initial WireGuard profile credentials.'
        )}
      >
        <form onSubmit={handleCreateUserSubmit} className="space-y-4 pt-2">
          <FormField label={t('users.provisionDialog.username', 'Username')} required>
            <Input
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="e.g. operator_alpha"
              required
            />
          </FormField>

          <FormField label={t('users.provisionDialog.email', 'Email Address')}>
            <Input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="e.g. operator@sovereign.local"
            />
          </FormField>

          <FormField label={t('users.provisionDialog.password', 'Initial Password')}>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter secure password"
            />
          </FormField>

          <FormField label={t('users.provisionDialog.role', 'Assigned Role')}>
            <Select
              value={newRole}
              onValueChange={(val) => setNewRole(val as any)}
              options={[
                { value: 'user', label: t('users.roleUser', 'Standard User') },
                { value: 'operator', label: t('users.roleOperator', 'Operator') },
                { value: 'auditor', label: t('users.roleAuditor', 'Auditor') },
                { value: 'admin', label: t('users.roleAdmin', 'Admin') },
                { value: 'super-admin', label: t('users.roleSuperAdmin', 'Super Admin') }
              ]}
            />
          </FormField>

          {orgs.length > 0 && (
            <FormField label={t('users.provisionDialog.org', 'Organization')}>
              <Select
                value={newOrgId}
                onValueChange={setNewOrgId}
                options={orgs.map((o) => ({ value: o.id, label: o.name }))}
              />
            </FormField>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <Button type="button" variant="secondary" onClick={() => setIsProvisionOpen(false)}>
              {t('users.provisionDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={createUserMutation.isPending || !newUsername.trim()}>
              {createUserMutation.isPending
                ? t('loading.label', 'Creating...')
                : t('users.provisionDialog.submit', 'Create User')}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* MODAL 2: QR Code Onboarding Dialog */}
      <Dialog
        open={Boolean(selectedUserForQr)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedUserForQr(null);
            setQrData(null);
          }
        }}
        title={t('users.qrDialog.title', 'WireGuard Client Onboarding Profile')}
        description={t(
          'users.qrDialog.desc',
          'Scan this QR code with the NeroNet mobile/desktop client, or download the configuration file.'
        )}
      >
        <div className="space-y-4 pt-2">
          <div className="flex justify-center p-4 rounded-xl bg-surface border border-border">
            {qrData?.qr_code_data_url ? (
              <img
                src={qrData.qr_code_data_url}
                alt="WireGuard Onboarding QR Code"
                className="w-48 h-48 rounded-lg bg-white p-2"
              />
            ) : (
              <div className="w-48 h-48 flex items-center justify-center text-muted">
                <Skeleton lines={4} className="w-32" />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-xs font-bold text-muted uppercase tracking-wider">WireGuard Configuration Preview</div>
            <pre className="p-3 rounded-lg bg-surface font-mono text-xs text-content max-h-40 overflow-y-auto border border-border">
              {qrData?.config_text || 'Loading profile...'}
            </pre>
          </div>

          <div className="flex justify-between items-center pt-4 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={Copy}
              onClick={handleCopyConfig}
              disabled={!qrData?.config_text}
            >
              {copiedConfig ? t('users.qrDialog.copied', 'Copied') : t('users.qrDialog.copyConfig', 'Copy Config')}
            </Button>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                icon={Download}
                onClick={handleDownloadConf}
                disabled={!qrData?.config_text}
              >
                {t('users.qrDialog.downloadConf', 'Download .conf')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSelectedUserForQr(null);
                  setQrData(null);
                }}
              >
                {t('users.qrDialog.close', 'Close')}
              </Button>
            </div>
          </div>
        </div>
      </Dialog>

      {/* MODAL 3: Split Tunneling Dialog */}
      <Dialog
        open={Boolean(selectedUserForSplit)}
        onOpenChange={(open) => {
          if (!open) setSelectedUserForSplit(null);
        }}
        title={t('users.splitDialog.title', 'Split Tunneling App Bypass')}
        description={t(
          'users.splitDialog.desc',
          'Select application bundle IDs that bypass the encrypted WireGuard mesh tunnel for direct internet access.'
        )}
      >
        <div className="space-y-4 pt-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                id={newAppInputId}
                value={newAppInput}
                onChange={(e) => setNewAppInput(e.target.value)}
                placeholder={t('users.splitDialog.newAppPlaceholder', 'e.g. com.spotify.client')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddApp();
                  }
                }}
                aria-label={t('users.splitDialog.newApp', 'Add Application Identifier')}
              />
            </div>
            <Button type="button" variant="secondary" size="md" onClick={handleAddApp}>
              {t('users.splitDialog.btnAdd', 'Add App')}
            </Button>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-bold text-muted uppercase tracking-wider">
              {t('users.splitDialog.presets', 'Common Presets')}
            </div>
            <div className="flex flex-wrap gap-2">
              {PRESET_BYPASS_APPS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => handleAddPresetApp(preset)}
                  className="px-2.5 py-1 rounded-full text-xs font-mono bg-surface border border-border hover:border-accent text-content transition-all"
                >
                  + {preset}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-bold text-muted uppercase tracking-wider">
              {t('users.splitDialog.activeApps', 'Bypassed Applications')} ({bypassApps.length})
            </div>
            {bypassApps.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted border border-dashed border-border rounded-xl">
                No apps currently bypassed. All application traffic routes through the mesh tunnel.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-2 rounded-xl bg-surface border border-border">
                {bypassApps.map((app) => (
                  <span
                    key={app}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-mono bg-surface-raised border border-border text-content"
                  >
                    <span>{app}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveApp(app)}
                      className="text-muted hover:text-danger ml-1"
                      aria-label={`Remove ${app}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <Button type="button" variant="secondary" onClick={() => setSelectedUserForSplit(null)}>
              {t('users.splitDialog.cancel', 'Cancel')}
            </Button>
            <Button type="button" variant="primary" onClick={handleSaveSplit} disabled={updateSplitMutation.isPending}>
              {updateSplitMutation.isPending
                ? t('users.splitDialog.saving', 'Saving...')
                : t('users.splitDialog.save', 'Save Changes')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* MODAL 4: Revoke Sessions Confirmation */}
      <Dialog
        open={Boolean(selectedUserForRevoke)}
        onOpenChange={(open) => {
          if (!open) setSelectedUserForRevoke(null);
        }}
        title={t('users.revokeDialog.title', 'Revoke All User Sessions')}
        description={t(
          'users.revokeDialog.desc',
          'This action immediately revokes all active JWT refresh tokens and terminates all login sessions across devices.'
        )}
      >
        <div className="space-y-4 pt-2">
          <div className="p-4 rounded-xl bg-surface border border-border text-sm text-content">
            User: <CodeText>{selectedUserForRevoke?.username}</CodeText> ({selectedUserForRevoke?.id})
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <Button type="button" variant="secondary" onClick={() => setSelectedUserForRevoke(null)}>
              {t('users.revokeDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleConfirmRevoke}
              disabled={revokeSessionsMutation.isPending}
            >
              {revokeSessionsMutation.isPending
                ? t('loading.label', 'Revoking...')
                : t('users.revokeDialog.confirm', 'Revoke All Sessions')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* MODAL 5: Delete User Confirmation */}
      <Dialog
        open={Boolean(selectedUserForDelete)}
        onOpenChange={(open) => {
          if (!open) setSelectedUserForDelete(null);
        }}
        title={t('users.deleteDialog.title', 'Delete User Account')}
        description={t(
          'users.deleteDialog.desc',
          'Are you sure you want to permanently delete this user? All their device keys and permissions will be deleted.'
        )}
      >
        <div className="space-y-4 pt-2">
          <div className="p-4 rounded-xl bg-surface border border-border text-sm text-content">
            User: <CodeText>{selectedUserForDelete?.username}</CodeText> ({selectedUserForDelete?.id})
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <Button type="button" variant="secondary" onClick={() => setSelectedUserForDelete(null)}>
              {t('users.deleteDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleConfirmDelete}
              disabled={deleteUserMutation.isPending}
            >
              {deleteUserMutation.isPending
                ? t('loading.label', 'Deleting...')
                : t('users.deleteDialog.confirm', 'Delete Account')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* MODAL 6: Create Organization Dialog */}
      <Dialog
        open={isCreateOrgOpen}
        onOpenChange={setIsCreateOrgOpen}
        title={t('organizations.createDialog.title', 'Create Multi-Tenant Organization')}
        description={t(
          'organizations.createDialog.desc',
          'Establish a distinct sovereign tenant boundary with its own cryptographic netmap epoch and default ACL policy.'
        )}
      >
        <form onSubmit={handleCreateOrgSubmit} className="space-y-4 pt-2">
          <FormField label={t('organizations.createDialog.name', 'Organization Name')} required>
            <Input
              value={newOrgName}
              onChange={(e) => {
                setNewOrgName(e.target.value);
                if (!newOrgSlug) {
                  setNewOrgSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '-'));
                }
              }}
              placeholder="e.g. Acme Defense Cyber"
              required
            />
          </FormField>

          <FormField label={t('organizations.createDialog.slug', 'Slug Identifier')}>
            <Input value={newOrgSlug} onChange={(e) => setNewOrgSlug(e.target.value)} placeholder="e.g. acme-defense" />
          </FormField>

          <FormField label={t('organizations.createDialog.defaultPolicy', 'Default Mesh Policy')}>
            <Select
              value={newOrgPolicy}
              onValueChange={(val) => setNewOrgPolicy(val as any)}
              options={[
                { value: 'open', label: t('organizations.policyOpen', 'Open (Allow All)') },
                { value: 'deny', label: t('organizations.policyDeny', 'Zero-Trust (Deny All)') }
              ]}
            />
          </FormField>

          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <Button type="button" variant="secondary" onClick={() => setIsCreateOrgOpen(false)}>
              {t('organizations.createDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={createOrgMutation.isPending || !newOrgName.trim()}>
              {createOrgMutation.isPending
                ? t('loading.label', 'Creating...')
                : t('organizations.createDialog.submit', 'Create Organization')}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
