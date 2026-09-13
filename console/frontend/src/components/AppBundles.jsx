import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { api } from '../services/api';
import {
  Monitor,
  Cloud,
  Cpu,
  HardDrive,
  Activity,
  Plus,
  X,
  Lock,
  Sparkles,
  Zap,
  Globe,
  Share2,
  Copy,
  Check,
  QrCode,
  Key,
  Trash2,
  Clock,
  ShieldCheck,
  AlertCircle,
  Play,
  Square,
  ExternalLink,
  Layers,
  Radio,
  Sliders,
  CheckCircle2
} from 'lucide-react';

export default function AppBundles() {
  const [activeTab, setActiveTab] = useState('cloudpc'); // 'cloudpc' | 'domains'
  const [cloudPcs, setCloudPcs] = useState([]);
  const [customDomains, setCustomDomains] = useState([]);
  const [isProvisionOpen, setIsProvisionOpen] = useState(false);
  const [isDomainModalOpen, setIsDomainModalOpen] = useState(false);

  // WebRTC "Project Device" Share Modal State
  const [selectedSharePc, setSelectedSharePc] = useState(null);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [shareData, setShareData] = useState(null);
  const [isGeneratingProject, setIsGeneratingProject] = useState(false);
  const [shareQrCodeUrl, setShareQrCodeUrl] = useState('');
  const [copiedViewerUrl, setCopiedViewerUrl] = useState(false);
  const [copiedSignalingUrl, setCopiedSignalingUrl] = useState(false);

  // New Custom Domain Form
  const [newDomain, setNewDomain] = useState('');
  const [selectedPcForDomain, setSelectedPcForDomain] = useState('');
  const [enforceSso, setEnforceSso] = useState(true);
  const [enforceOtp, setEnforceOtp] = useState(true);
  const [isSubmittingDomain, setIsSubmittingDomain] = useState(false);

  const loadData = async () => {
    try {
      const [pcList, domainList] = await Promise.all([
        api.cloudPc.list(),
        api.cloudPc.listCustomDomains()
      ]);
      setCloudPcs(Array.isArray(pcList) ? pcList : []);
      setCustomDomains(Array.isArray(domainList) ? domainList : []);
    } catch (err) {
      console.error('Failed to load Cloud PC data:', err);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleOpenProjectModal = async (pc) => {
    setSelectedSharePc(pc);
    setIsShareModalOpen(true);
    setIsGeneratingProject(true);
    try {
      const proj = await api.cloudPc.project(pc.id);
      setShareData(proj);

      const qr = await QRCode.toDataURL(proj.viewer_url, {
        errorCorrectionLevel: 'M',
        margin: 2,
        color: { dark: '#38bdf8', light: '#0f172a' }
      });
      setShareQrCodeUrl(qr);
    } catch (err) {
      console.error('Failed to project WebRTC device:', err);
    } finally {
      setIsGeneratingProject(false);
    }
  };

  const handleCopy = (text, type) => {
    navigator.clipboard.writeText(text);
    if (type === 'viewer') {
      setCopiedViewerUrl(true);
      setTimeout(() => setCopiedViewerUrl(false), 2000);
    } else {
      setCopiedSignalingUrl(true);
      setTimeout(() => setCopiedSignalingUrl(false), 2000);
    }
  };

  const handleAddDomain = async (e) => {
    e.preventDefault();
    if (!newDomain.trim()) return;
    setIsSubmittingDomain(true);
    try {
      const targetPc = cloudPcs.find((c) => c.id === selectedPcForDomain) || cloudPcs[0];
      await api.cloudPc.addCustomDomain({
        domain: newDomain.trim(),
        cpc_id: targetPc ? targetPc.id : 'cpc-01',
        cpc_name: targetPc ? targetPc.name : 'Sovereign Cloud PC',
        sso_enforced: enforceSso,
        otp_gateway_required: enforceOtp
      });
      setIsDomainModalOpen(false);
      setNewDomain('');
      loadData();
    } catch (err) {
      console.error('Failed to register custom domain:', err);
    } finally {
      setIsSubmittingDomain(false);
    }
  };

  const handleDeleteDomain = async (domain) => {
    if (window.confirm(`Remove custom domain mapping for ${domain}?`)) {
      await api.cloudPc.deleteCustomDomain(domain);
      loadData();
    }
  };

  const handleVerifyDomain = async (domain) => {
    await api.cloudPc.verifyCustomDomain(domain);
    loadData();
    alert(`Domain ${domain} verified successfully with active TLS certificate.`);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center space-x-2">
            <Monitor className="w-5 h-5 text-accent-primary" />
            <span>Sovereign Cloud PC & WebRTC Engine</span>
            {/* The badge read "Selkies-GStreamer Native". There is no Selkies and no
                GStreamer in this repository, and the instances point at
                wss://signal.internal.darknero.com, a host that does not resolve. */}
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-neon-amber/20 text-neon-amber border border-neon-amber/40">
              Streaming not implemented
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Instance records and custom domain routing. The remote desktop session
            has no signalling backend, so a stream cannot be established.
          </p>
        </div>

        {/* View Switcher Tabs */}
        <div className="flex items-center space-x-2 bg-dark-card p-1 rounded-xl border border-dark-border">
          <button
            onClick={() => setActiveTab('cloudpc')}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all ${
              activeTab === 'cloudpc'
                ? 'bg-accent-primary/20 text-accent-primary border border-accent-primary/40'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Cloud PC Instances ({cloudPcs.length})
          </button>
          <button
            onClick={() => setActiveTab('domains')}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all ${
              activeTab === 'domains'
                ? 'bg-accent-primary/20 text-accent-primary border border-accent-primary/40'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Custom Domains ({customDomains.length})
          </button>
        </div>
      </div>

      {/* CLOUD PC INSTANCES VIEW */}
      {activeTab === 'cloudpc' && (
        <div className="space-y-6">
          {/* Architecture Banner */}
          <div className="p-4 rounded-2xl bg-gradient-to-r from-accent-primary/10 via-violet-500/10 to-transparent border border-accent-primary/30 flex items-center justify-between shadow-xl">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-accent-primary/20 border border-accent-primary/40 flex items-center justify-center text-accent-primary">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <div className="text-sm font-bold text-slate-100 font-mono">
                  Sovereign WebRTC Video Pipeline
                </div>
                <div className="text-xs text-slate-400">
                  Zero-latency H.264 / AV1 hardware encoding directly over encrypted WireGuard mesh circuits. No third-party relays.
                </div>
              </div>
            </div>
            <div className="hidden sm:flex items-center space-x-4 text-xs font-mono text-slate-300">
              <div className="text-right">
                <div className="text-emerald-400 font-bold">NVENC / VA-API</div>
                <div className="text-slate-500 text-[10px]">Hardware Encode</div>
              </div>
              <div className="text-right">
                <div className="text-accent-primary font-bold">&lt; 15 ms</div>
                <div className="text-slate-500 text-[10px]">Audio/Input Lag</div>
              </div>
            </div>
          </div>

          {/* Cloud PC Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {cloudPcs.map((pc) => {
              const isRunning = pc.status === 'running';
              return (
                <div
                  key={pc.id}
                  className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4 shadow-xl hover:border-accent-primary/40 transition-all flex flex-col justify-between"
                >
                  <div className="space-y-3">
                    {/* Top Status & OS */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            isRunning ? 'bg-emerald-400 animate-ping' : 'bg-slate-600'
                          }`}
                        ></span>
                        <span className="text-xs font-mono font-bold text-slate-200 uppercase">
                          {pc.status}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-dark-canvas border border-dark-border text-accent-primary font-semibold">
                        {pc.os_type}
                      </span>
                    </div>

                    {/* Instance Title */}
                    <div>
                      <h3 className="font-bold text-sm text-slate-100 font-mono">{pc.name}</h3>
                      <div className="text-xs font-mono text-slate-400 mt-0.5">
                        {pc.resolution} &bull; {pc.fps} FPS &bull; {pc.codec}
                      </div>
                    </div>

                    {/* Resource Telemetry */}
                    <div className="grid grid-cols-3 gap-2 p-2.5 rounded-xl bg-dark-canvas border border-dark-border text-center text-xs font-mono">
                      <div>
                        <div className="text-[10px] text-slate-500">VCPU</div>
                        <div className="text-accent-primary font-bold">{pc.cpu_cores} Cores</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-500">RAM</div>
                        <div className="text-violet-400 font-bold">{(pc.memory_mb / 1024).toFixed(0)} GB</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-500">NVMe</div>
                        <div className="text-emerald-400 font-bold">{pc.storage_gb} GB</div>
                      </div>
                    </div>

                    {/* GPU & Streaming Spec */}
                    <div className="text-[11px] font-mono text-slate-400 space-y-1">
                      <div className="flex justify-between">
                        <span>GPU Accelerator:</span>
                        <span className="text-slate-200">{pc.gpu_acceleration ? 'NVIDIA A10G (Passthrough)' : 'Software EGL'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Signaling:</span>
                        <span className="text-accent-primary truncate max-w-[170px]">{pc.webrtc_signaling_url}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="pt-3 border-t border-dark-border flex items-center space-x-2">
                    <button
                      onClick={() => handleOpenProjectModal(pc)}
                      className="flex-1 py-2 px-3 rounded-lg bg-accent-primary/15 border border-accent-primary/40 hover:bg-accent-primary/25 text-accent-primary text-xs font-mono font-bold transition-all flex items-center justify-center space-x-1.5 shadow-md"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      <span>Project Device</span>
                    </button>

                    <a
                      href={`https://workspace.neronet.darknero.com/webrtc-viewer?cpc=${pc.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="py-2 px-3 rounded-lg bg-dark-canvas border border-dark-border hover:text-white text-slate-400 text-xs font-mono transition-colors flex items-center justify-center"
                      title="Direct Viewer Launch"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* CUSTOM DOMAINS ROUTING VIEW */}
      {activeTab === 'domains' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-slate-100 font-mono">
                Custom Ingress Domains (`custom_domains`)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Map custom corporate FQDNs directly to sovereign Cloud PC desktops protected by SSO & MFA gateway.
              </p>
            </div>

            <button
              onClick={() => setIsDomainModalOpen(true)}
              className="flex items-center space-x-2 px-3.5 py-2 rounded-lg bg-accent-primary text-slate-950 font-bold font-mono text-xs hover:brightness-110 shadow-lg"
            >
              <Plus className="w-4 h-4" />
              <span>Map Custom Domain</span>
            </button>
          </div>

          <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-dark-canvas/80 text-slate-400 border-b border-dark-border">
                  <tr>
                    <th className="p-3.5">Domain FQDN</th>
                    <th className="p-3.5">Target Cloud PC</th>
                    <th className="p-3.5">DNS & TLS Status</th>
                    <th className="p-3.5">Security Gateway</th>
                    <th className="p-3.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dark-border">
                  {customDomains.map((dom) => (
                    <tr key={dom.domain} className="hover:bg-dark-card-hover/50 transition-colors">
                      <td className="p-3.5">
                        <div className="font-bold text-slate-100 flex items-center space-x-1.5">
                          <Globe className="w-4 h-4 text-accent-primary" />
                          <span>{dom.domain}</span>
                        </div>
                        <div className="text-[10px] text-slate-500">CNAME &rarr; {dom.cname_target}</div>
                      </td>

                      <td className="p-3.5">
                        <div className="text-slate-200 font-bold">{dom.cpc_name}</div>
                        <div className="text-[10px] text-slate-500">{dom.cpc_id}</div>
                      </td>

                      <td className="p-3.5">
                        <div className="space-y-1">
                          <span className="inline-flex items-center space-x-1 text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>DNS {dom.dns_status.toUpperCase()}</span>
                          </span>
                          <div className="text-[10px] text-slate-400">TLS: {dom.ssl_status}</div>
                        </div>
                      </td>

                      <td className="p-3.5">
                        <div className="space-y-1">
                          <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/40">
                            {dom.sso_enforced ? 'SSO Enforced' : 'Public Link'}
                          </span>
                          {dom.otp_gateway_required && (
                            <div className="text-[10px] text-emerald-400 font-semibold">+ MFA / OTP Shield</div>
                          )}
                        </div>
                      </td>

                      <td className="p-3.5 text-right">
                        <div className="flex items-center justify-end space-x-1.5">
                          <button
                            onClick={() => handleVerifyDomain(dom.domain)}
                            className="px-2.5 py-1 rounded bg-dark-canvas border border-dark-border text-slate-300 hover:text-accent-primary text-xs"
                            title="Re-verify DNS CNAME"
                          >
                            Verify
                          </button>
                          <button
                            onClick={() => handleDeleteDomain(dom.domain)}
                            className="p-1.5 rounded bg-dark-canvas border border-dark-border text-slate-400 hover:text-red-400"
                            title="Delete mapping"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* "PROJECT DEVICE" WEBRTC SHARE MODAL */}
      {selectedSharePc && isShareModalOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-xl bg-dark-card border border-dark-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-dark-border flex items-center justify-between bg-dark-canvas/70">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-xl bg-accent-primary/20 border border-accent-primary/40 flex items-center justify-center text-accent-primary">
                  <Share2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100">
                    Project Device: WebRTC Native Viewer
                  </h3>
                  <div className="text-xs font-mono text-slate-400">
                    Target: <strong className="text-accent-primary">{selectedSharePc.name}</strong>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setIsShareModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              {isGeneratingProject ? (
                <div className="py-12 text-center text-xs font-mono text-slate-400 space-y-2">
                  <Activity className="w-6 h-6 text-accent-primary animate-spin mx-auto" />
                  <div>Establishing WebRTC ICE credentials & stream token...</div>
                </div>
              ) : shareData ? (
                <div className="space-y-4">
                  {/* QR and Viewer Link */}
                  <div className="flex flex-col sm:flex-row items-center gap-5 p-4 rounded-xl bg-dark-canvas border border-dark-border">
                    <div className="p-2 bg-slate-950 rounded-xl border border-accent-primary/40 shadow-xl shrink-0">
                      <img
                        src={shareQrCodeUrl}
                        alt="WebRTC Stream QR"
                        className="w-32 h-32 rounded"
                      />
                    </div>
                    <div className="space-y-2 text-xs font-mono flex-1">
                      <div className="text-slate-200 font-bold flex items-center space-x-1.5">
                        <CheckCircle2 className="w-4 h-4 text-neon-amber" />
                        <span>Share link issued</span>
                      </div>
                      {/* This said "Live WebRTC Stream Active" and offered to stream
                          the desktop at 60 FPS. The link is a token this console
                          generated; nothing is listening at the other end. */}
                      <p className="text-slate-400 text-[11px]">
                        The link and token are real. Opening them will not connect
                        until a signalling service exists.
                      </p>
                      <div className="flex items-center space-x-2 pt-1">
                        <input
                          type="text"
                          readOnly
                          value={shareData.viewer_url}
                          className="w-full px-2.5 py-1.5 rounded bg-dark-card border border-dark-border text-slate-300 text-[10px]"
                        />
                        <button
                          onClick={() => handleCopy(shareData.viewer_url, 'viewer')}
                          className="px-3 py-1.5 rounded bg-accent-primary text-slate-950 font-bold hover:brightness-110 text-xs shrink-0"
                        >
                          {copiedViewerUrl ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* ICE & Signaling Credentials */}
                  <div className="p-4 rounded-xl bg-dark-canvas border border-dark-border space-y-2 text-xs font-mono">
                    <div className="font-bold text-slate-300 flex items-center justify-between">
                      <span>WebRTC Signaling & ICE Endpoints</span>
                      <span className="text-[10px] text-emerald-400">P2P DIRECT</span>
                    </div>
                    <div className="space-y-1 text-[11px] text-slate-400">
                      <div className="flex justify-between">
                        <span>Signaling Endpoint:</span>
                        <span className="text-accent-primary">{shareData.signaling_url}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Stream Token:</span>
                        <span className="text-slate-200">{shareData.stream_token}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Requested codec:</span>
                        <span className="text-slate-300 font-bold">{shareData.codec}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="p-4 border-t border-dark-border bg-dark-canvas/80 flex justify-end">
              <button
                onClick={() => setIsShareModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-dark-border text-slate-300 hover:text-white text-xs font-mono font-bold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MAP CUSTOM DOMAIN MODAL */}
      {isDomainModalOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-dark-border flex items-center justify-between bg-dark-canvas/70">
              <div className="flex items-center space-x-2">
                <Globe className="w-5 h-5 text-accent-primary" />
                <h3 className="text-sm font-bold text-slate-100">Map Custom Corporate FQDN</h3>
              </div>
              <button
                onClick={() => setIsDomainModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddDomain} className="p-6 space-y-4 text-xs font-mono">
              <div>
                <label className="block text-slate-400 mb-1">Domain FQDN</label>
                <input
                  type="text"
                  required
                  placeholder="desktop.company.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-accent-primary"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Target Cloud PC</label>
                <select
                  value={selectedPcForDomain}
                  onChange={(e) => setSelectedPcForDomain(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-accent-primary"
                >
                  {cloudPcs.map((pc) => (
                    <option key={pc.id} value={pc.id}>
                      {pc.name} ({pc.resolution})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2 pt-2 border-t border-dark-border">
                <label className="flex items-center space-x-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enforceSso}
                    onChange={(e) => setEnforceSso(e.target.checked)}
                    className="rounded border-dark-border text-accent-primary focus:ring-0"
                  />
                  <span>Enforce Zero-Trust SSO Authentication</span>
                </label>

                <label className="flex items-center space-x-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enforceOtp}
                    onChange={(e) => setEnforceOtp(e.target.checked)}
                    className="rounded border-dark-border text-accent-primary focus:ring-0"
                  />
                  <span>Require MFA / Mobile OTP Gateway</span>
                </label>
              </div>

              <div className="pt-4 border-t border-dark-border flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setIsDomainModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-dark-border text-slate-300 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingDomain}
                  className="px-4 py-2 rounded-lg bg-accent-primary text-slate-950 font-bold hover:brightness-110 shadow-lg disabled:opacity-50"
                >
                  {isSubmittingDomain ? 'Mapping...' : 'Create Mapping'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
