import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import {
  Users,
  UserPlus,
  Shield,
  Activity,
  Key,
  Trash2,
  Lock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Plus,
  X,
  QrCode,
  Sliders,
  Copy,
  Check,
  Download,
  Smartphone,
  Layers,
  Radio,
  FileText
} from 'lucide-react';

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [isProvisionModalOpen, setIsProvisionModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // QR Code Modal State
  const [selectedUserForQr, setSelectedUserForQr] = useState(null);
  const [qrModalData, setQrModalData] = useState(null);
  const [isGeneratingQr, setIsGeneratingQr] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);

  // Split Tunneling Modal State
  const [selectedUserForSplit, setSelectedUserForSplit] = useState(null);
  const [splitBypassApps, setSplitBypassApps] = useState([]);
  const [newAppInput, setNewAppInput] = useState('');
  const [isSavingSplit, setIsSavingSplit] = useState(false);

  // Provision Form State
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('user');

  const loadUsers = async () => {
    try {
      const list = await api.users.list();
      setUsers(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleCreateUser = async (e) => {
    e.preventDefault();
    try {
      await api.users.create({
        username,
        email,
        role,
        bypass_apps: ["com.apple.Music", "com.spotify.client"]
      });
      setIsProvisionModalOpen(false);
      setUsername('');
      setEmail('');
      loadUsers();
    } catch (err) {
      console.error('Failed to create user:', err);
    }
  };

  const handleRevokeSessions = async (userId) => {
    if (window.confirm('Revoke all active JWT sessions and refresh tokens for this user?')) {
      await api.users.revokeSessions(userId);
      alert('All active user sessions revoked.');
    }
  };

  const handleDeleteUser = async (userId) => {
    if (window.confirm('Are you sure you want to delete this user and disconnect all their devices?')) {
      await api.users.delete(userId);
      loadUsers();
    }
  };

  // Open QR Code Onboarding Modal
  const handleOpenQrModal = async (user) => {
    setSelectedUserForQr(user);
    setIsGeneratingQr(true);
    try {
      const qrData = await api.users.generateQrOnboarding(user.id);
      setQrModalData(qrData);
    } catch (err) {
      console.error('Failed to generate QR onboarding profile:', err);
    } finally {
      setIsGeneratingQr(false);
    }
  };

  const handleDownloadConf = () => {
    if (!qrModalData || !qrModalData.config_text) return;
    const blob = new Blob([qrModalData.config_text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `neronet-${selectedUserForQr?.username || 'onboarding'}.conf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCopyConfigText = () => {
    if (!qrModalData?.config_text) return;
    navigator.clipboard.writeText(qrModalData.config_text);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  // Open Split Tunneling Editor Modal
  const handleOpenSplitModal = (user) => {
    setSelectedUserForSplit(user);
    setSplitBypassApps(Array.isArray(user.bypass_apps) ? [...user.bypass_apps] : []);
    setNewAppInput('');
  };

  const handleAddBypassApp = () => {
    const trimmed = newAppInput.trim();
    if (trimmed && !splitBypassApps.includes(trimmed)) {
      setSplitBypassApps([...splitBypassApps, trimmed]);
      setNewAppInput('');
    }
  };

  const handleRemoveBypassApp = (appToRemove) => {
    setSplitBypassApps(splitBypassApps.filter((a) => a !== appToRemove));
  };

  const handleAddPreset = (presetApp) => {
    if (!splitBypassApps.includes(presetApp)) {
      setSplitBypassApps([...splitBypassApps, presetApp]);
    }
  };

  const handleSaveSplitTunneling = async () => {
    if (!selectedUserForSplit) return;
    setIsSavingSplit(true);
    try {
      await api.users.updateSplitTunneling(selectedUserForSplit.id, splitBypassApps);
      setSelectedUserForSplit(null);
      loadUsers();
    } catch (err) {
      console.error('Failed to update split tunneling config:', err);
    } finally {
      setIsSavingSplit(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center space-x-2">
            <Users className="w-5 h-5 text-accent-primary" />
            <span>Dual-Tier User Directory & Quotas</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-accent-primary/20 text-accent-primary border border-accent-primary/40">
              {users.length} Active Tenants
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Enterprise RBAC managing Hybrid BYOS ($0 self-hosted) vs Managed Cloud ($12/mo) tenancy with instant QR onboarding.
          </p>
        </div>

        <button
          onClick={() => setIsProvisionModalOpen(true)}
          className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-gradient-to-r from-accent-primary to-accent-alert text-slate-950 font-bold font-mono text-xs hover:brightness-110 transition-all shadow-lg"
        >
          <UserPlus className="w-4 h-4" />
          <span>Provision User</span>
        </button>
      </div>

      {/* Users Table */}
      <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden shadow-xl">
        <div className="p-4 border-b border-dark-border flex items-center justify-between bg-dark-canvas/50">
          <span className="text-xs font-bold font-mono text-slate-300 uppercase tracking-wider">
            Registered Tenant Accounts
          </span>
          <span className="text-xs font-mono text-slate-500">{users.length} Total</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-dark-canvas/80 text-slate-400 border-b border-dark-border">
              <tr>
                <th className="p-3.5">User / Identity</th>
                <th className="p-3.5">Role</th>
                <th className="p-3.5">Split Tunneling</th>
                <th className="p-3.5">Status</th>
                <th className="p-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-border">
              {users.map((u) => {
                const bypassCount = Array.isArray(u.bypass_apps) ? u.bypass_apps.length : 0;

                return (
                  <tr key={u.id} className="hover:bg-dark-card-hover/50 transition-colors">
                    <td className="p-3.5">
                      <div className="font-bold text-slate-100">{u.username}</div>
                      <div className="text-[11px] text-slate-400">{u.email}</div>
                      <div className="text-[10px] text-slate-500">{u.id}</div>
                    </td>

                    <td className="p-3.5">
                      <span
                        className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wide ${
                          u.role === 'super-admin'
                            ? 'bg-accent-primary/20 text-accent-primary border-accent-primary/40'
                            : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                        }`}
                      >
                        {u.role === 'super-admin' ? 'Super admin' : 'User'}
                      </span>
                    </td>

                    <td className="p-3.5">
                      <button
                        onClick={() => handleOpenSplitModal(u)}
                        className="flex items-center space-x-1.5 px-2.5 py-1 rounded bg-dark-canvas border border-dark-border text-slate-300 hover:text-accent-primary hover:border-accent-primary/40 transition-colors"
                        title="Configure bypass_apps JSONB array"
                      >
                        <Sliders className="w-3.5 h-3.5 text-accent-primary" />
                        <span>{bypassCount} Apps Bypassed</span>
                      </button>
                    </td>

                    <td className="p-3.5">
                      <span
                        className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold border ${
                          u.status === 'active'
                            ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                            : 'bg-red-500/20 text-red-400 border-red-500/40'
                        }`}
                      >
                        {u.status === 'active' ? (
                          <CheckCircle2 className="w-3 h-3" />
                        ) : (
                          <XCircle className="w-3 h-3" />
                        )}
                        <span className="uppercase">{u.status}</span>
                      </span>
                    </td>

                    <td className="p-3.5 text-right">
                      <div className="flex items-center justify-end space-x-1.5">
                        {/* Instant Mobile QR Onboarding Button */}
                        <button
                          onClick={() => handleOpenQrModal(u)}
                          className="px-2.5 py-1.5 rounded bg-accent-primary/10 border border-accent-primary/40 text-accent-primary hover:bg-accent-primary/20 text-xs flex items-center space-x-1 transition-colors"
                          title="Generate instant mobile QR onboarding config"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                          <span>QR Onboard</span>
                        </button>

                        <button
                          onClick={() => handleRevokeSessions(u.id)}
                          className="p-1.5 rounded bg-dark-canvas border border-dark-border text-slate-400 hover:text-amber-400 hover:border-amber-400/40 transition-colors"
                          title="Revoke active JWT sessions"
                        >
                          <Key className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => handleDeleteUser(u.id)}
                          className="p-1.5 rounded bg-dark-canvas border border-dark-border text-slate-400 hover:text-red-400 hover:border-red-400/40 transition-colors"
                          title="Delete user"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* QR Code Onboarding Modal (R7) */}
      {selectedUserForQr && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-lg bg-dark-card border border-dark-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-dark-border flex items-center justify-between bg-dark-canvas/70">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-xl bg-accent-primary/20 border border-accent-primary/40 flex items-center justify-center text-accent-primary">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100">
                    Mobile Instant QR Onboarding
                  </h3>
                  <div className="text-xs font-mono text-slate-400">
                    User: <strong className="text-accent-primary">{selectedUserForQr.username}</strong> ({selectedUserForQr.email})
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedUserForQr(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              {isGeneratingQr ? (
                <div className="py-12 text-center text-xs font-mono text-slate-400 space-y-2">
                  <RefreshCw className="w-6 h-6 text-accent-primary animate-spin mx-auto" />
                  <div>Generating Noise/WireGuard clamped keypair & QR profile...</div>
                </div>
              ) : qrModalData ? (
                <div className="space-y-4">
                  {/* QR Code Display */}
                  <div className="flex flex-col sm:flex-row items-center gap-5 p-4 rounded-xl bg-dark-canvas border border-dark-border">
                    <div className="p-2 bg-slate-950 rounded-xl border border-accent-primary/40 shadow-xl shrink-0">
                      <img
                        src={qrModalData.qr_code_data_url}
                        alt="WireGuard Onboarding QR Code"
                        className="w-36 h-36 rounded"
                      />
                    </div>
                    <div className="space-y-2 text-xs font-mono">
                      <div className="text-slate-200 font-bold flex items-center space-x-1.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span>Ready to Scan on Mobile</span>
                      </div>
                      <p className="text-slate-400 text-[11px]">
                        Open WireGuard or NeroNet Client on iOS/Android, tap <strong>"+"</strong> and select <strong>"Create from QR code"</strong>.
                      </p>
                      <div className="text-[10px] text-slate-500 pt-1">
                        <div>Assigned VIP: <strong className="text-accent-primary">{qrModalData.overlay_ip}</strong></div>
                        <div>Protocol: <strong className="text-slate-300">Noise_IKpsk2_25519</strong></div>
                      </div>
                    </div>
                  </div>

                  {/* WireGuard Text Config */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-slate-300 font-bold">Client Profile (.conf)</span>
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={handleCopyConfigText}
                          className="flex items-center space-x-1 px-2 py-1 rounded bg-dark-card border border-dark-border text-slate-300 hover:text-white"
                        >
                          {copiedConfig ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedConfig ? 'Copied' : 'Copy'}</span>
                        </button>
                        <button
                          onClick={handleDownloadConf}
                          className="flex items-center space-x-1 px-2 py-1 rounded bg-accent-primary/20 text-accent-primary border border-accent-primary/40 hover:bg-accent-primary/30"
                        >
                          <Download className="w-3 h-3" />
                          <span>Download .conf</span>
                        </button>
                      </div>
                    </div>
                    <pre className="p-3 bg-slate-950 rounded-xl border border-dark-border text-[10px] font-mono text-slate-300 overflow-x-auto max-h-36">
                      {qrModalData.config_text}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="p-4 border-t border-dark-border bg-dark-canvas/80 flex justify-end">
              <button
                onClick={() => setSelectedUserForQr(null)}
                className="px-4 py-1.5 rounded-lg bg-dark-border text-slate-300 hover:text-white text-xs font-mono font-bold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Split Tunneling Editor Modal (R7) */}
      {selectedUserForSplit && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-lg bg-dark-card border border-dark-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-dark-border flex items-center justify-between bg-dark-canvas/70">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-xl bg-violet-500/20 border border-violet-500/40 flex items-center justify-center text-violet-400">
                  <Sliders className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100">
                    Split Tunneling Policy Editor (`bypass_apps`)
                  </h3>
                  <div className="text-xs font-mono text-slate-400">
                    User: <strong className="text-violet-400">{selectedUserForSplit.username}</strong>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedUserForSplit(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              <p className="text-xs text-slate-400">
                Define application bundle identifiers, domain wildcards, or LAN CIDR subnets that bypass the WireGuard encrypted overlay and egress directly over local WAN.
              </p>

              {/* Input for new bypass entry */}
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  placeholder="e.g. com.spotify.client, 192.168.1.0/24"
                  value={newAppInput}
                  onChange={(e) => setNewAppInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddBypassApp()}
                  className="flex-1 px-3 py-2 text-xs bg-dark-canvas border border-dark-border rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-violet-400 font-mono"
                />
                <button
                  type="button"
                  onClick={handleAddBypassApp}
                  className="px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-mono font-bold transition-colors flex items-center space-x-1"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add</span>
                </button>
              </div>

              {/* Preset Shortcuts */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-mono text-slate-400 font-semibold">
                  Quick Presets:
                </div>
                <div className="flex flex-wrap gap-1.5 text-xs font-mono">
                  {[
                    'com.apple.Music',
                    'com.spotify.client',
                    'com.netflix.Netflix',
                    'com.steam.client',
                    '192.168.1.0/24',
                    '10.0.0.0/8'
                  ].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => handleAddPreset(preset)}
                      className="px-2 py-1 rounded bg-dark-canvas border border-dark-border text-slate-400 hover:text-violet-300 hover:border-violet-500/40 text-[10px] transition-colors"
                    >
                      + {preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* Active Bypass Apps List */}
              <div className="space-y-2">
                <div className="text-xs font-mono text-slate-300 font-bold flex justify-between">
                  <span>Active Bypass Rules ({splitBypassApps.length})</span>
                  <span className="text-[10px] text-slate-500">Stored in JSONB</span>
                </div>

                <div className="p-3 bg-dark-canvas rounded-xl border border-dark-border min-h-[100px] max-h-48 overflow-y-auto space-y-1.5">
                  {splitBypassApps.length === 0 ? (
                    <div className="text-xs text-slate-500 font-mono italic text-center py-6">
                      No bypass rules defined. All user traffic routes strictly through NeroNet overlay.
                    </div>
                  ) : (
                    splitBypassApps.map((app) => (
                      <div
                        key={app}
                        className="flex items-center justify-between p-2 rounded bg-dark-card border border-dark-border text-xs font-mono"
                      >
                        <span className="text-slate-200">{app}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveBypassApp(app)}
                          className="text-slate-500 hover:text-red-400 p-0.5"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-dark-border bg-dark-canvas/80 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setSelectedUserForSplit(null)}
                className="px-4 py-1.5 rounded-lg bg-dark-border text-slate-300 hover:text-white text-xs font-mono"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveSplitTunneling}
                disabled={isSavingSplit}
                className="px-4 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-mono font-bold transition-all shadow-lg disabled:opacity-50"
              >
                {isSavingSplit ? 'Saving JSONB...' : 'Save Policy'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Provision User Modal */}
      {isProvisionModalOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-dark-border flex items-center justify-between bg-dark-canvas/70">
              <div className="flex items-center space-x-2">
                <UserPlus className="w-5 h-5 text-accent-primary" />
                <h3 className="text-sm font-bold text-slate-100">Provision Tenant Account</h3>
              </div>
              <button
                onClick={() => setIsProvisionModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="p-6 space-y-4 text-xs font-mono">
              <div>
                <label className="block text-slate-400 mb-1">Username</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. dev_engineer"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-accent-primary"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  placeholder="e.g. dev@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-accent-primary"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">RBAC Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-accent-primary"
                >
                  <option value="user">Standard User</option>
                  <option value="super-admin">Super Admin</option>
                </select>
              </div>

              <div className="pt-4 border-t border-dark-border flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setIsProvisionModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-dark-border text-slate-300 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-accent-primary text-slate-950 font-bold hover:brightness-110 shadow-lg"
                >
                  Create User
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
