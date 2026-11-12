import React, { useContext, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AuthContext from '../../context/AuthContext';
import { effectiveRole, invitableRoles } from '../../services/roles';
import { InvitationsPanel } from './invitations/InvitationsPanel';
import { Building2, Lock, Mail, Plus, RefreshCw, Search, Shield, Sliders, Trash2, UserPlus, Users } from 'lucide-react';

import {
  useCreateOrganization,
  useCreateUser,
  useDeleteUser,
  useOrganizations,
  useRevokeUserSessions,
  useUpdateSplitTunneling,
  useUsers
} from '../../services/queries';
import type { CreateOrgPayload, CreateUserPayload, Organization, UserAccount } from '../../services/types';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CodeText,
  ConfirmDialog,
  Dialog,
  FormField,
  IconButton,
  Input,
  NotMeasured,
  PageHeader,
  Select,
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
  const { t } = useTranslation(['users', 'ui', 'glossary', 'invitations']);

  // Queries
  const { data: users = [], isLoading: isLoadingUsers, isError: isUsersError, refetch: refetchUsers } = useUsers();
  const { data: orgs = [], isLoading: isLoadingOrgs, refetch: refetchOrgs } = useOrganizations();

  // Mutations
  const createUserMutation = useCreateUser();
  const deleteUserMutation = useDeleteUser();
  const revokeSessionsMutation = useRevokeUserSessions();
  const updateSplitMutation = useUpdateSplitTunneling();
  const createOrgMutation = useCreateOrganization();

  // Local State
  const [activeTab, setActiveTab] = useState<'directory' | 'invitations' | 'organizations' | 'sso'>('directory');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Modals state
  const [isProvisionOpen, setIsProvisionOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'super-admin' | 'user'>('user');
  const [newOrgId, setNewOrgId] = useState('');

  // Which roles the server accepts for these actions (routes/users.js: create and delete are super-admin only).
  const auth = useContext(AuthContext);
  const canAddUsers = effectiveRole(auth?.user ?? null) === 'super-admin';
  // Owners and admins cannot create accounts, but they can invite people, who then choose their own password.
  const canInvite = invitableRoles(effectiveRole(auth?.user ?? null)).length > 0;
  const [actionError, setActionError] = useState<string | null>(null);

  // Split Tunneling Modal
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
  const newAppInputId = useId();

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
      password: newPassword,
      role: newRole,
      organization_id: newOrgId || undefined,
      bypass_apps: ['com.apple.Music', 'com.spotify.client']
    };

    await createUserMutation.mutateAsync(payload);
    setIsProvisionOpen(false);
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
    setActionError(null);
    try {
      await revokeSessionsMutation.mutateAsync(selectedUserForRevoke.id);
      setSelectedUserForRevoke(null);
    } catch {
      setSelectedUserForRevoke(null);
      setActionError(t('revokeDialog.failed', 'The user was not signed out. Try again.'));
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedUserForDelete) return;
    setActionError(null);
    try {
      await deleteUserMutation.mutateAsync(selectedUserForDelete.id);
      setSelectedUserForDelete(null);
    } catch {
      setSelectedUserForDelete(null);
      setActionError(t('deleteDialog.failed', 'The account was not deleted. Try again.'));
    }
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
      case 'auditor':
        return 'accent';
      default:
        return 'neutral';
    }
  };

  // The role's name, from the shared glossary. An unknown role shows as it was sent.
  const roleLabel = (role: string) => t(`roles.${role}.term`, { ns: 'glossary', defaultValue: role });

  // User Columns for Table
  const userColumns: TableColumn<UserAccount>[] = useMemo(
    () => [
      {
        id: 'username',
        header: t('colUsername', 'Username'),
        cell: (u) => (
          <div className="flex items-center gap-2">
            <CodeText>{u.username}</CodeText>
            <span className="text-[11px] text-muted font-mono">({u.id})</span>
          </div>
        )
      },
      {
        id: 'email',
        header: t('colEmail', 'Email'),
        cell: (u) => <span className="text-muted">{u.email || '—'}</span>
      },
      {
        id: 'role',
        header: t('colRole', 'Role'),
        cell: (u) => <Badge tone={getRoleBadgeTone(u.role)}>{roleLabel(u.role)}</Badge>
      },
      {
        id: 'status',
        header: t('colStatus', 'Status'),
        cell: (u) => <StatusBadge status={u.status === 'active' ? 'ok' : 'warning'} label={u.status} />
      },
      {
        id: 'bypass',
        header: t('colBypass', 'Split Tunneling'),
        cell: (u) => (
          <span className="text-xs font-mono text-muted">
            {Array.isArray(u.bypass_apps) && u.bypass_apps.length > 0
              ? t('bypassCount', { count: u.bypass_apps.length })
              : t('bypassNone', 'All traffic goes through the VPN')}
          </span>
        )
      },
      {
        id: 'actions',
        header: t('colActions', 'Actions'),
        cell: (u) => (
          <div className="flex items-center gap-1">
            <IconButton icon={Sliders} label={t('actionSplit', 'Split Tunnel')} onClick={() => handleOpenSplit(u)} />
            <IconButton
              icon={Lock}
              label={t('actionRevoke', 'Revoke Sessions')}
              onClick={() => setSelectedUserForRevoke(u)}
            />
            {canAddUsers && (
              <IconButton
                icon={Trash2}
                variant="danger"
                label={t('actionDelete', 'Delete User')}
                onClick={() => setSelectedUserForDelete(u)}
              />
            )}
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
          <span>{t('tabDirectory', 'Directory & RBAC')}</span>
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
                placeholder={t('searchPlaceholder', 'Filter by username, email, or role...')}
                className="pl-9"
                aria-label={t('searchPlaceholder', 'Filter by username, email, or role...')}
              />
            </div>
            <div className="text-xs text-muted font-mono">
              {filteredUsers.length} / {users.length} {t('tableTitle', 'Tenants')}
            </div>
          </div>

          <Table<UserAccount>
            caption={t('tableTitle', 'Registered Tenants')}
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
      value: 'invitations',
      label: (
        <span className="flex items-center gap-2">
          <Mail className="h-4 w-4" />
          <span>{t('panel.title', { ns: 'invitations' })}</span>
        </span>
      ),
      content: <InvitationsPanel inviteOpen={inviteOpen} onInviteOpenChange={setInviteOpen} />
    },
    {
      value: 'organizations',
      label: (
        <span className="flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          <span>{t('tabOrganizations', 'Organizations')}</span>
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
          <span>{t('tabSso', 'SSO & Identity')}</span>
        </span>
      ),
      content: (
        <Card className="space-y-4">
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-accent" />
            <div>
              <h3 className="text-base font-bold text-content">{t('sso.title', 'Company single sign-on (SSO)')}</h3>
              <p className="text-xs text-muted">
                {t('sso.body', 'Company login systems check the password and pass the groups to the console.')}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div className="p-4 rounded-xl bg-surface border border-border space-y-2">
              <div className="text-xs font-bold text-muted">{t('sso.status', 'Connection status')}</div>
              <NotMeasured />
            </div>
            <div className="p-4 rounded-xl bg-surface border border-border space-y-2">
              <div className="text-xs font-bold text-muted">
                {t('sso.groupsTitle', 'How company groups become roles')}
              </div>
              <p className="text-xs text-muted">
                {t('sso.groupsBody', 'Each organisation maps its groups to roles in its own settings.')}
              </p>
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
        title={t('title', 'User Directory & Access Control')}
        description={t('description')}
        actions={
          <div className="flex items-center gap-3">
            <IconButton
              icon={RefreshCw}
              label={t('common.refresh')}
              onClick={() => {
                refetchUsers();
                refetchOrgs();
              }}
            />
            {canInvite && activeTab !== 'invitations' && (
              <Button
                variant="primary"
                size="md"
                icon={Mail}
                onClick={() => {
                  setActiveTab('invitations');
                  setInviteOpen(true);
                }}
              >
                {t('panel.invite', { ns: 'invitations' })}
              </Button>
            )}
            {canAddUsers ? (
              <Button variant="secondary" size="md" icon={UserPlus} onClick={handleOpenProvision}>
                {t('btnProvision', 'Add user')}
              </Button>
            ) : (
              <p className="max-w-xs text-right text-xs text-muted">
                {t('addOnlySuperAdmin', 'Only a platform administrator can add users.')}
              </p>
            )}
          </div>
        }
      />

      {actionError && (
        <p role="alert" className="text-xs text-danger">
          {actionError}
        </p>
      )}

      {/* Top Stats Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t('statTotalUsers')}
          value={isLoadingUsers ? '...' : String(users.length)}
          hint={t('statTotalUsersHint')}
        />
        <Stat
          label={t('statPrivileged')}
          value={isLoadingUsers ? '...' : String(privilegedCount)}
          hint={t('statPrivilegedHint')}
        />
        <Stat
          label={t('statOrgs')}
          value={isLoadingOrgs ? '...' : String(Math.max(orgs.length, 1))}
          hint={t('statOrgsHint')}
        />
        <Stat label={t('statSecurity')} value="RFC 6238" hint={t('statSecurityHint')} />
      </div>

      {/* Tabs */}
      <Tabs
        items={tabItems}
        value={activeTab}
        onValueChange={(val) => setActiveTab(val as any)}
        label={t('tabsLabel')}
      />

      {/* MODAL 1: Provision User Dialog */}
      <Dialog
        open={isProvisionOpen}
        onOpenChange={setIsProvisionOpen}
        title={t('provisionDialog.title', 'Provision New Tenant Account')}
        description={t(
          'provisionDialog.desc',
          'Create a new user account with role-based permissions and initial WireGuard profile credentials.'
        )}
      >
        <form onSubmit={handleCreateUserSubmit} className="space-y-4 pt-2">
          <FormField label={t('provisionDialog.username', 'Username')} required>
            <Input
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder={t('provisionDialog.usernamePlaceholder', 'E.g. operator_alpha')}
              required
            />
          </FormField>

          <FormField label={t('provisionDialog.email', 'Email Address')}>
            <Input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder={t('provisionDialog.emailPlaceholder', 'E.g. name@example.org')}
            />
          </FormField>

          <FormField label={t('provisionDialog.password', 'Starting password')} required>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t('provisionDialog.passwordPlaceholder', 'Choose a starting password')}
            />
          </FormField>

          <FormField
            label={t('provisionDialog.role', 'Role')}
            hint={t('provisionDialog.roleHint', 'Organisation roles are set in the member list of the organisation.')}
          >
            <Select
              value={newRole}
              onValueChange={(val) => setNewRole(val as any)}
              options={[
                { value: 'user', label: t('roleUser', 'User') },
                { value: 'super-admin', label: t('roleSuperAdmin', 'Platform administrator') }
              ]}
            />
          </FormField>

          {orgs.length > 0 && (
            <FormField label={t('provisionDialog.org', 'Organization')}>
              <Select
                value={newOrgId}
                onValueChange={setNewOrgId}
                options={orgs.map((o) => ({ value: o.id, label: o.name }))}
              />
            </FormField>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <Button type="button" variant="secondary" onClick={() => setIsProvisionOpen(false)}>
              {t('provisionDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={createUserMutation.isPending || !newUsername.trim() || !newPassword}
            >
              {createUserMutation.isPending
                ? t('loading.label', 'Creating...')
                : t('provisionDialog.submit', 'Create User')}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* MODAL 3: Split Tunneling Dialog */}
      <Dialog
        open={Boolean(selectedUserForSplit)}
        onOpenChange={(open) => {
          if (!open) setSelectedUserForSplit(null);
        }}
        title={t('splitDialog.title', 'Split Tunneling App Bypass')}
        description={t(
          'splitDialog.desc',
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
                placeholder={t('splitDialog.newAppPlaceholder', 'e.g. com.spotify.client')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddApp();
                  }
                }}
                aria-label={t('splitDialog.newApp', 'Add Application Identifier')}
              />
            </div>
            <Button type="button" variant="secondary" size="md" onClick={handleAddApp}>
              {t('splitDialog.btnAdd', 'Add App')}
            </Button>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-bold text-muted">{t('splitDialog.presets', 'Common Presets')}</div>
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
            <div className="text-xs font-bold text-muted">
              {t('splitDialog.activeApps', 'Bypassed Applications')} ({bypassApps.length})
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
              {t('splitDialog.cancel', 'Cancel')}
            </Button>
            <Button type="button" variant="primary" onClick={handleSaveSplit} disabled={updateSplitMutation.isPending}>
              {updateSplitMutation.isPending
                ? t('splitDialog.saving', 'Saving...')
                : t('splitDialog.save', 'Save Changes')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* MODAL 4: Revoke sessions */}
      <ConfirmDialog
        open={Boolean(selectedUserForRevoke)}
        onOpenChange={(open) => !open && setSelectedUserForRevoke(null)}
        title={t('revokeDialog.title', 'Sign the user out of all devices?')}
        description={t(
          'revokeDialog.desc',
          'The user is signed out everywhere and must sign in again on each device. The account is not deleted.'
        )}
        confirmLabel={t('revokeDialog.confirm', 'Sign out of all devices')}
        tone="danger"
        busy={revokeSessionsMutation.isPending}
        onConfirm={handleConfirmRevoke}
      />

      {/* MODAL 5: Delete user */}
      <ConfirmDialog
        open={Boolean(selectedUserForDelete)}
        onOpenChange={(open) => !open && setSelectedUserForDelete(null)}
        title={t('deleteDialog.title', 'Delete the account of {{name}}?', {
          name: selectedUserForDelete?.username ?? ''
        })}
        description={t(
          'deleteDialog.desc',
          "The account and the keys of all its devices are erased. This cannot be undone: the user's devices will stop working."
        )}
        confirmLabel={t('deleteDialog.confirm', 'Permanently delete the account')}
        tone="danger"
        busy={deleteUserMutation.isPending}
        onConfirm={handleConfirmDelete}
      />

      {/* MODAL 6: Create Organization Dialog */}
      <Dialog
        open={isCreateOrgOpen}
        onOpenChange={setIsCreateOrgOpen}
        title={t('organizations.createDialog.title', 'Create Multi-Tenant Organization')}
        description={t(
          'organizations.createDialog.desc',
          'Create a separate organisation with its own devices and default rule.'
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
