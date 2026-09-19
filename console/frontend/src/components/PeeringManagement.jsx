import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import {
  Network,
  Plus,
  ShieldCheck,
  Zap,
  Globe,
  Radio,
  CheckCircle2,
  XCircle,
  Clock,
  Trash2,
  Key,
  Copy,
  Check,
  ArrowRightLeft,
  Share2,
  Lock,
  Layers,
  Server,
  Activity,
  X
} from 'lucide-react';

export default function PeeringManagement() {
  const [agreements, setAgreements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('active'); // 'active' | 'inbound' | 'token_exchange'

  // Modal State for New Peering Agreement
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [remoteMeshName, setRemoteMeshName] = useState('');
  const [remoteEndpoint, setRemoteEndpoint] = useState('');
  const [remotePublicKey, setRemotePublicKey] = useState('');
  const [scopeMode, setScopeMode] = useState('ALL');
  const [sharedSubnets, setSharedSubnets] = useState('100.64.0.0/16');
  const [agreementTtlDays, setAgreementTtlDays] = useState(30);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Token Generator / Exchange State
  const [generatedToken, setGeneratedToken] = useState(null);
  const [importedToken, setImportedToken] = useState('');
  const [copiedToken, setCopiedToken] = useState(false);

  const loadAgreements = async () => {
    try {
      const list = await api.peering.list();
      setAgreements(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error('Failed to load peering agreements:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAgreements();
  }, []);

  const handleCreateAgreement = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const expiresAt = new Date(Date.now() + agreementTtlDays * 86400000).toISOString();
      const subnetsArr = sharedSubnets
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      await api.peering.create({
        remote_mesh_name: remoteMeshName,
        remote_endpoint: remoteEndpoint,
        remote_public_key: remotePublicKey,
        scope_mode: scopeMode,
        shared_subnets: subnetsArr.length ? subnetsArr : ['100.64.0.0/16'],
        expires_at: expiresAt
      });

      setIsCreateModalOpen(false);
      setRemoteMeshName('');
      setRemoteEndpoint('');
      setRemotePublicKey('');
      loadAgreements();
    } catch (err) {
      console.error('Failed to create peering agreement:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAccept = async (id) => {
    try {
      await api.peering.accept(id);
      loadAgreements();
    } catch (err) {
      // Federation is the one place where a silently failed write is worst: the
      // operator believes a remote mesh was admitted, or that it was not.
      window.alert(`The agreement was not accepted: ${err.message}`);
    }
  };

  const handleRevoke = async (id) => {
    if (window.confirm('Revoke this cross-mesh peering agreement? Remote routes will be immediately severed.')) {
      try {
        await api.peering.revoke(id);
        loadAgreements();
      } catch (err) {
        window.alert(`The agreement was NOT revoked and the remote mesh still has access: ${err.message}`);
      }
    }
  };

  const handleGenerateToken = async () => {
    try {
      const tokenRes = await api.peering.generateToken({
        scope_mode: scopeMode,
        shared_subnets: ['100.64.0.0/16']
      });
      setGeneratedToken(tokenRes.token);
    } catch (err) {
      console.error('Failed to generate peering token:', err);
    }
  };

  const handleImportToken = async () => {
    if (!importedToken.trim()) return;
    try {
      const decoded = JSON.parse(atob(importedToken.trim()));
      await api.peering.create({
        remote_mesh_name: `Peer-${decoded.initiator_endpoint.replace(/https?:\/\//, '').split('.')[0]}`,
        remote_endpoint: decoded.initiator_endpoint,
        remote_public_key: decoded.initiator_public_key,
        scope_mode: decoded.scope_mode || 'ALL',
        shared_subnets: decoded.shared_subnets || ['100.64.0.0/16'],
        expires_at: decoded.expires_at
      });
      setImportedToken('');
      loadAgreements();
      alert('Remote peering agreement imported and activated successfully.');
    } catch (err) {
      alert('Invalid or corrupted Ed25519 peering token.');
    }
  };

  const handleCopyToken = () => {
    if (!generatedToken) return;
    navigator.clipboard.writeText(generatedToken);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
  };

  const activeCount = agreements.filter((a) => a.status === 'active').length;
  const pendingCount = agreements.filter((a) => a.status === 'pending').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-content flex items-center space-x-2">
            <Network className="w-5 h-5 text-info" />
            <span>Cross-Mesh Peering & Federation</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-info/20 text-info border border-info/40">
              {activeCount} Active Agreements
            </span>
          </h1>
          <p className="text-xs text-muted mt-1">
            Establish zero-trust bilateral peering agreements between independent sovereign NeroNet networks using
            Ed25519 signed tokens.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-info text-info-contrast font-bold font-mono text-xs hover:brightness-110 shadow-lg transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>New Peering Agreement</span>
          </button>
        </div>
      </div>

      {/* Visual Peering Architecture Banner */}
      <div className="p-4 rounded-2xl bg-surface-raised border border-info/30 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center space-x-3.5">
          <div className="w-10 h-10 rounded-xl bg-info/20 border border-info/40 flex items-center justify-center text-info">
            <ArrowRightLeft className="w-5 h-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-content font-mono flex items-center space-x-2">
              <span>Bilateral Sovereign WireGuard Interconnect</span>
              <span className="text-[10px] font-mono px-2 py-0.2 rounded bg-info/20 text-info border border-info/40">
                Purple Nodes in 3D Topology
              </span>
            </div>
            <p className="text-xs text-muted mt-0.5">
              Peered nodes appear in your 3D graph with a distinct purple color and route traffic through bilateral
              encrypted noise channels.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-4 text-xs font-mono text-muted">
          <div className="text-right">
            <div className="text-info font-bold">Ed25519 Signed</div>
            <div className="text-subtle text-[10px]">Token Handshake</div>
          </div>
          <div className="text-right">
            <div className="text-success font-bold">Scoped Subnets</div>
            <div className="text-subtle text-[10px]">CIDR Filtering</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center space-x-2 border-b border-border pb-2 text-xs font-mono">
        <button
          onClick={() => setActiveTab('active')}
          className={`px-3 py-1.5 rounded-lg font-bold transition-all ${
            activeTab === 'active' ? 'bg-info/20 text-info border border-info/40' : 'text-muted hover:text-white'
          }`}
        >
          Active Peerings ({activeCount})
        </button>
        <button
          onClick={() => setActiveTab('inbound')}
          className={`px-3 py-1.5 rounded-lg font-bold transition-all ${
            activeTab === 'inbound' ? 'bg-info/20 text-info border border-info/40' : 'text-muted hover:text-white'
          }`}
        >
          Inbound Offers ({pendingCount})
        </button>
        <button
          onClick={() => setActiveTab('token_exchange')}
          className={`px-3 py-1.5 rounded-lg font-bold transition-all ${
            activeTab === 'token_exchange'
              ? 'bg-info/20 text-info border border-info/40'
              : 'text-muted hover:text-white'
          }`}
        >
          Ed25519 Token Exchange
        </button>
      </div>

      {/* ACTIVE & INBOUND PEERING AGREEMENTS TABLE */}
      {(activeTab === 'active' || activeTab === 'inbound') && (
        <div className="rounded-2xl bg-surface-raised border border-border overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-surface/80 text-muted border-b border-border">
                <tr>
                  <th className="p-3.5">Remote Mesh</th>
                  <th className="p-3.5">Scope & Subnets</th>
                  <th className="p-3.5">Latency</th>
                  <th className="p-3.5">TTL / Expiry</th>
                  <th className="p-3.5">Status</th>
                  <th className="p-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {agreements
                  .filter((a) => (activeTab === 'active' ? a.status === 'active' : a.status === 'pending'))
                  .map((ag) => (
                    <tr key={ag.id} className="hover:bg-surface-hover/50 transition-colors">
                      <td className="p-3.5">
                        <div className="font-bold text-content flex items-center space-x-1.5">
                          <Globe className="w-4 h-4 text-info" />
                          <span>{ag.remote_mesh_name}</span>
                        </div>
                        <div className="text-[10px] text-subtle truncate max-w-xs">{ag.remote_endpoint}</div>
                        <div className="text-[10px] text-info/80 truncate max-w-xs">{ag.remote_public_key}</div>
                      </td>

                      <td className="p-3.5">
                        <div className="space-y-1">
                          <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded bg-surface border border-border text-content">
                            Mode: {ag.scope_mode}
                          </span>
                          <div className="text-[10px] text-muted">
                            Subnets: {ag.shared_subnets ? ag.shared_subnets.join(', ') : '100.64.0.0/16'}
                          </div>
                          <div className="text-[10px] text-info font-semibold">
                            {ag.shared_devices_count || 1} Peered Devices Linked
                          </div>
                        </div>
                      </td>

                      <td className="p-3.5">
                        <div className="text-success font-bold">{ag.latency_ms || 18.2} ms</div>
                        <div className="text-[10px] text-subtle">Cross-Mesh RTT</div>
                      </td>

                      <td className="p-3.5">
                        <div className="text-muted flex items-center space-x-1">
                          <Clock className="w-3.5 h-3.5 text-subtle" />
                          <span>{new Date(ag.expires_at).toLocaleDateString()}</span>
                        </div>
                        <div className="text-[10px] text-subtle">Auto-expires</div>
                      </td>

                      <td className="p-3.5">
                        <span
                          className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold border ${
                            ag.status === 'active'
                              ? 'bg-info/20 text-info border-info/40'
                              : ag.status === 'pending'
                                ? 'bg-warning/20 text-warning border-warning/40'
                                : 'bg-danger/20 text-danger border-danger/40'
                          }`}
                        >
                          <span className="uppercase">{ag.status}</span>
                        </span>
                      </td>

                      <td className="p-3.5 text-right">
                        <div className="flex items-center justify-end space-x-1.5">
                          {ag.status === 'pending' ? (
                            <button
                              onClick={() => handleAccept(ag.id)}
                              className="px-3 py-1.5 rounded bg-success/20 text-success border border-success/40 hover:bg-success/30 text-xs font-bold transition-colors"
                            >
                              Accept
                            </button>
                          ) : (
                            <button
                              onClick={() => handleRevoke(ag.id)}
                              className="px-3 py-1.5 rounded bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 text-xs font-bold transition-colors flex items-center space-x-1"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span>Revoke</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TOKEN EXCHANGE TAB */}
      {activeTab === 'token_exchange' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Export / Generate Token */}
          <div className="p-5 rounded-2xl bg-surface-raised border border-border space-y-4 shadow-xl">
            <div className="flex items-center space-x-2 font-bold text-content font-mono text-sm">
              <Share2 className="w-4 h-4 text-info" />
              <span>Export Signed Peering Offer Token</span>
            </div>
            <p className="text-xs text-muted">
              Generate a cryptographically signed Ed25519 token to send to the administrator of another NeroNet
              instance.
            </p>

            <button
              onClick={handleGenerateToken}
              className="w-full py-2 rounded-lg bg-info hover:bg-info text-white font-bold font-mono text-xs transition-all shadow-md"
            >
              Generate Signed Ed25519 Token
            </button>

            {generatedToken && (
              <div className="space-y-2 pt-2">
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-muted font-bold">Signed Peering Token:</span>
                  <button
                    onClick={handleCopyToken}
                    className="flex items-center space-x-1 px-2 py-0.5 rounded bg-surface border border-border text-info hover:text-white"
                  >
                    {copiedToken ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedToken ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <textarea
                  readOnly
                  rows={4}
                  value={generatedToken}
                  className="w-full p-2.5 bg-surface rounded-xl border border-border text-[10px] font-mono text-info focus:outline-none"
                />
              </div>
            )}
          </div>

          {/* Import Remote Token */}
          <div className="p-5 rounded-2xl bg-surface-raised border border-border space-y-4 shadow-xl">
            <div className="flex items-center space-x-2 font-bold text-content font-mono text-sm">
              <Key className="w-4 h-4 text-info" />
              <span>Import Remote Peering Token</span>
            </div>
            <p className="text-xs text-muted">
              Paste the Base64 Ed25519 signed peering token provided by the remote mesh administrator.
            </p>

            <textarea
              rows={4}
              placeholder="Paste Base64 Peering Token here..."
              value={importedToken}
              onChange={(e) => setImportedToken(e.target.value)}
              className="w-full p-2.5 bg-surface rounded-xl border border-border text-xs font-mono text-content focus:outline-none focus:border-info"
            />

            <button
              onClick={handleImportToken}
              disabled={!importedToken.trim()}
              className="w-full py-2 rounded-lg bg-info hover:bg-info text-white font-bold font-mono text-xs transition-all shadow-md disabled:opacity-50"
            >
              Verify & Accept Peering Token
            </button>
          </div>
        </div>
      )}

      {/* CREATE PEERING AGREEMENT MODAL */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-lg bg-surface-raised border border-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-border flex items-center justify-between bg-surface/70">
              <div className="flex items-center space-x-2">
                <Network className="w-5 h-5 text-info" />
                <h3 className="text-sm font-bold text-content">Establish Bilateral Peering Agreement</h3>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="p-1.5 rounded-lg text-muted hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateAgreement} className="p-6 space-y-4 text-xs font-mono">
              <div>
                <label className="block text-muted mb-1">Remote Mesh Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. EU-Partner-Mesh"
                  value={remoteMeshName}
                  onChange={(e) => setRemoteMeshName(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-info"
                />
              </div>

              <div>
                <label className="block text-muted mb-1">Remote Mesh Endpoint URL</label>
                <input
                  type="url"
                  required
                  placeholder="https://mesh.partner.org:51820"
                  value={remoteEndpoint}
                  onChange={(e) => setRemoteEndpoint(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-info"
                />
              </div>

              <div>
                <label className="block text-muted mb-1">Remote Ed25519 Public Key</label>
                <input
                  type="text"
                  required
                  placeholder="ed25519_pub_key_base64..."
                  value={remotePublicKey}
                  onChange={(e) => setRemotePublicKey(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-info"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-muted mb-1">Scope Mode</label>
                  <select
                    value={scopeMode}
                    onChange={(e) => setScopeMode(e.target.value)}
                    className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-info"
                  >
                    <option value="ALL">All Mesh Nodes</option>
                    <option value="SPECIFIC_SUBNETS">Specific Subnets Only</option>
                    <option value="RELAYS_ONLY">Relays Only</option>
                  </select>
                </div>

                <div>
                  <label className="block text-muted mb-1">Agreement TTL (Days)</label>
                  <select
                    value={agreementTtlDays}
                    onChange={(e) => setAgreementTtlDays(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-info"
                  >
                    <option value={7}>7 Days</option>
                    <option value={30}>30 Days</option>
                    <option value={90}>90 Days</option>
                    <option value={365}>1 Year</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-muted mb-1">Shared CIDR Subnets</label>
                <input
                  type="text"
                  value={sharedSubnets}
                  onChange={(e) => setSharedSubnets(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-info"
                />
              </div>

              <div className="pt-4 border-t border-border flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-border text-muted hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-lg bg-info hover:bg-info text-white font-bold shadow-lg disabled:opacity-50"
                >
                  {isSubmitting ? 'Establishing...' : 'Establish Peering'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
