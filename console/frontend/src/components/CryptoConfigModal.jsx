import React, { useState } from 'react';
import { api } from '../services/api';
import {
  X,
  Key,
  Shield,
  Copy,
  Check,
  Download,
  QrCode,
  FileCode,
  Cpu,
  Globe,
  Sparkles,
  Smartphone
} from 'lucide-react';

export default function CryptoConfigModal({ isOpen, onClose, onNodeEnrolled }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('CLIENT_ORIGIN');
  const [countryCode, setCountryCode] = useState('US');
  const [osType, setOsType] = useState('macos');
  const [onionEnabled, setOnionEnabled] = useState(false);
  const [activeTab, setActiveTab] = useState('conf'); // 'conf' | 'json' | 'qr'
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedConfig, setGeneratedConfig] = useState(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleGenerate = async (e) => {
    e.preventDefault();
    setIsGenerating(true);
    try {
      const result = await api.configs.generate({
        name: name.trim() || 'sovereign-client',
        role,
        country_code: countryCode,
        os_type: osType,
        onion_routing_enabled: onionEnabled,
        onion_hops: onionEnabled ? 3 : 0
      });
      setGeneratedConfig(result);
      if (onNodeEnrolled) onNodeEnrolled(result.node);
    } catch (err) {
      console.error('Failed to generate config:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = (filename, content) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-dark-card border border-dark-border rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Modal Header */}
        <div className="p-5 border-b border-dark-border flex items-center justify-between bg-dark-canvas/50">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-neon-cyan/10 border border-neon-cyan/30 flex items-center justify-center glow-cyan">
              <Key className="w-5 h-5 text-neon-cyan" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                <span>Cryptographic Identity Generator</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/40">
                  Curve25519 Clamped
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Generate Zero-Trust WireGuard & Noise DirectFrame v4.0 profiles for sovereign clients.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-dark-card-hover transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* Form */}
          <form
            onSubmit={handleGenerate}
            className="p-4 rounded-xl bg-dark-canvas/80 border border-dark-border space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-mono text-slate-400 mb-1.5">Device Hostname</label>
                <input
                  type="text"
                  placeholder="e.g. mbp-m3-alice"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-dark-card border border-dark-border rounded-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:border-neon-cyan font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-400 mb-1.5">Mesh Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-dark-card border border-dark-border rounded-lg text-slate-100 focus:outline-none focus:border-neon-cyan font-mono"
                >
                  <option value="CLIENT_ORIGIN">Client Origin (Default)</option>
                  <option value="EXIT_BRIDGE">Exit Bridge (Egress)</option>
                  <option value="HYBRID">Hybrid (Storage/P2P)</option>
                  <option value="RELAY">Regional Relay</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-400 mb-1.5">Country Region</label>
                <select
                  value={countryCode}
                  onChange={(e) => setCountryCode(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-dark-card border border-dark-border rounded-lg text-slate-100 focus:outline-none focus:border-neon-cyan font-mono"
                >
                  <option value="US">United States (US)</option>
                  <option value="DE">Germany (DE)</option>
                  <option value="JP">Japan (JP)</option>
                  <option value="CH">Switzerland (CH)</option>
                  <option value="NL">Netherlands (NL)</option>
                  <option value="SG">Singapore (SG)</option>
                </select>
              </div>
            </div>

            {/* 3-Hop Onion Obfuscation Toggle */}
            <div className="pt-2 border-t border-dark-border/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={() => setOnionEnabled(!onionEnabled)}
                  className={`w-10 h-5 rounded-full transition-colors relative p-0.5 border ${
                    onionEnabled ? 'bg-neon-cyan/20 border-neon-cyan' : 'bg-dark-card border-dark-border'
                  }`}
                >
                  <div
                    className={`w-3.5 h-3.5 rounded-full transition-transform ${
                      onionEnabled
                        ? 'translate-x-5 bg-neon-cyan shadow-[0_0_8px_#06b6d4]'
                        : 'translate-x-0 bg-slate-500'
                    }`}
                  />
                </button>
                <div>
                  <div className="text-xs font-mono font-semibold text-slate-200 flex items-center space-x-2">
                    <span>3-Hop Onion Obfuscation</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded font-mono ${
                        onionEnabled
                          ? 'bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/30'
                          : 'bg-dark-card text-slate-500 border border-dark-border'
                      }`}
                    >
                      {onionEnabled ? '3 Hops Active' : 'Direct Egress'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono">
                    Tor-grade multi-hop circuit obfuscation across 3 regional relays (+35ms latency trade-off)
                  </div>
                </div>
              </div>

              <div>
                <button
                  type="submit"
                  disabled={isGenerating}
                  className="w-full sm:w-auto py-2 px-5 rounded-lg bg-gradient-to-r from-neon-cyan to-neon-indigo text-dark-canvas font-bold text-xs hover:brightness-110 disabled:opacity-50 transition-all flex items-center justify-center space-x-2 shadow-lg"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{isGenerating ? 'Generating...' : 'Generate Profile'}</span>
                </button>
              </div>
            </div>
          </form>

          {/* Result Tabs & Viewer */}
          {generatedConfig ? (
            <div className="space-y-4">
              {/* Generated VIP Badges */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border">
                  <div className="text-[10px] font-mono text-slate-500 uppercase">Overlay IPv4</div>
                  <div className="text-xs font-mono font-bold text-neon-cyan mt-0.5">
                    {generatedConfig.overlay_ipv4}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border">
                  <div className="text-[10px] font-mono text-slate-500 uppercase">Overlay IPv6</div>
                  <div className="text-xs font-mono font-bold text-neon-indigo mt-0.5 truncate">
                    {generatedConfig.overlay_ipv6}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border">
                  <div className="text-[10px] font-mono text-slate-500 uppercase">Curve25519 Public Key</div>
                  <div className="text-xs font-mono font-bold text-neon-emerald mt-0.5 truncate">
                    {generatedConfig.public_key}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border">
                  <div className="text-[10px] font-mono text-slate-500 uppercase">Routing Circuit</div>
                  <div
                    className={`text-xs font-mono font-bold mt-0.5 ${generatedConfig.onion_routing_enabled || generatedConfig.onion_hops > 0 ? 'text-neon-cyan' : 'text-slate-400'}`}
                  >
                    {generatedConfig.onion_routing_enabled || generatedConfig.onion_hops > 0
                      ? '3-Hop Onion'
                      : 'Direct (0-Hop)'}
                  </div>
                </div>
              </div>

              {/* View Switcher */}
              <div className="flex items-center justify-between border-b border-dark-border pb-2">
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => setActiveTab('conf')}
                    className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                      activeTab === 'conf'
                        ? 'bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/40'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <FileCode className="w-3.5 h-3.5" />
                    <span>WireGuard (.conf)</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('json')}
                    className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                      activeTab === 'json'
                        ? 'bg-neon-indigo/20 text-neon-indigo border border-neon-indigo/40'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    <span>Noise JSON (DirectFrame)</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('qr')}
                    className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                      activeTab === 'qr'
                        ? 'bg-neon-emerald/20 text-neon-emerald border border-neon-emerald/40'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <QrCode className="w-3.5 h-3.5" />
                    <span>Mobile QR Code</span>
                  </button>
                </div>

                <div className="flex items-center space-x-2">
                  {activeTab === 'conf' && (
                    <>
                      <button
                        onClick={() => handleCopy(generatedConfig.wireguard_conf)}
                        className="flex items-center space-x-1 px-2.5 py-1 rounded bg-dark-canvas border border-dark-border text-slate-300 hover:text-white text-xs font-mono"
                      >
                        {copied ? (
                          <Check className="w-3.5 h-3.5 text-neon-emerald" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>{copied ? 'Copied' : 'Copy'}</span>
                      </button>
                      <button
                        onClick={() => handleDownload(`${name || 'wireguard'}.conf`, generatedConfig.wireguard_conf)}
                        className="flex items-center space-x-1 px-2.5 py-1 rounded bg-dark-canvas border border-dark-border text-neon-cyan hover:text-white text-xs font-mono"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download</span>
                      </button>
                    </>
                  )}

                  {activeTab === 'json' && (
                    <>
                      <button
                        onClick={() => handleCopy(JSON.stringify(generatedConfig.json_profile, null, 2))}
                        className="flex items-center space-x-1 px-2.5 py-1 rounded bg-dark-canvas border border-dark-border text-slate-300 hover:text-white text-xs font-mono"
                      >
                        {copied ? (
                          <Check className="w-3.5 h-3.5 text-neon-emerald" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>{copied ? 'Copied' : 'Copy'}</span>
                      </button>
                      <button
                        onClick={() =>
                          handleDownload(
                            `${name || 'neronet'}.json`,
                            JSON.stringify(generatedConfig.json_profile, null, 2)
                          )
                        }
                        className="flex items-center space-x-1 px-2.5 py-1 rounded bg-dark-canvas border border-dark-border text-neon-indigo hover:text-white text-xs font-mono"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Code Previews */}
              {activeTab === 'conf' && (
                <pre className="p-4 rounded-xl bg-dark-canvas border border-dark-border text-neon-cyan font-mono text-xs overflow-x-auto max-h-72 leading-relaxed selection:bg-neon-cyan/30">
                  {generatedConfig.wireguard_conf}
                </pre>
              )}

              {activeTab === 'json' && (
                <pre className="p-4 rounded-xl bg-dark-canvas border border-dark-border text-slate-300 font-mono text-xs overflow-x-auto max-h-72 leading-relaxed selection:bg-neon-indigo/30">
                  {JSON.stringify(generatedConfig.json_profile, null, 2)}
                </pre>
              )}

              {activeTab === 'qr' && (
                <div className="p-6 rounded-xl bg-dark-canvas border border-dark-border flex flex-col items-center justify-center space-y-4">
                  <div className="p-3 bg-dark-card border border-neon-cyan/40 rounded-xl glow-cyan">
                    <img
                      src={generatedConfig.qrcode_data_url}
                      alt="WireGuard QR Code"
                      className="w-56 h-56 rounded-lg object-contain"
                    />
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center space-x-2 text-xs font-mono text-slate-300">
                      <Smartphone className="w-4 h-4 text-neon-cyan" />
                      <span>Scan with WireGuard iOS / Android or NeroNet Mobile app</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Direct Zero-Trust handshake will be initiated automatically upon tunnel activation.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-12 border border-dashed border-dark-border rounded-xl flex flex-col items-center justify-center text-center space-y-3">
              <Shield className="w-10 h-10 text-slate-600" />
              <div className="text-xs font-mono text-slate-400">
                Click <span className="text-neon-cyan">"Generate Profile"</span> to construct a sovereign cryptographic
                keypair.
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-dark-border bg-dark-canvas/50 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-dark-border text-slate-300 hover:text-white text-xs font-mono transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
