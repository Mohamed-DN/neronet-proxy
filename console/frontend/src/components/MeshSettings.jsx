import React from 'react';
import { Shield, Cpu } from 'lucide-react';

/*
 * Moved out of App.jsx unchanged when the console gained a router, so that the
 * settings page is a page like every other one and loads in its own chunk.
 *
 * Its contents are not this work package's to correct and are left exactly as
 * they were, with one exception: the password state and its submit handler were
 * dead - nothing in the markup ever rendered a form or called the handler, and
 * the handler called api.auth.setupPasswords, which does not exist. Both are
 * recorded in the WP-402 report, together with the MTU, keepalive and
 * ciphersuite figures below, which are written into the markup rather than read
 * from anything.
 */
export default function MeshSettings() {
  const [onionRouting, setOnionRouting] = React.useState(true);
  const [obfuscation, setObfuscation] = React.useState('shadow-tls');

  return (
    <div className="space-y-6 font-mono">
      <div>
        <h1 className="text-xl font-bold text-content flex items-center space-x-2">
          <span>Sovereign Mesh Global Configuration</span>
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-accent/20 text-accent border border-accent/40">
            System Parameters
          </span>
        </h1>
        <p className="text-xs text-muted mt-1 font-sans">
          Low-level cryptographic primitives, MTU sizing, and advanced traffic routing rules.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Advanced Traffic & Onion Routing */}
        <div className="p-5 rounded-2xl bg-surface-raised border border-border space-y-4 shadow-xl">
          <div className="flex items-center space-x-2 font-bold text-content text-sm">
            <Shield className="w-4 h-4 text-success" />
            <span>Onion Routing &amp; Obfuscation</span>
          </div>
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between p-3 rounded-lg bg-surface border border-border">
              <div>
                <div className="font-semibold text-content">Tor-Grade 3-Hop Circuits</div>
                <div className="text-[11px] text-muted">Layered Noise encryption across relays</div>
              </div>
              <input
                type="checkbox"
                checked={onionRouting}
                onChange={(e) => setOnionRouting(e.target.checked)}
                className="w-4 h-4 rounded text-accent accent-accent bg-surface-raised border-border"
              />
            </div>

            <div className="p-3 rounded-lg bg-surface border border-border space-y-2">
              <label className="block text-muted font-semibold">Obfuscation Protocol</label>
              <select
                value={obfuscation}
                onChange={(e) => setObfuscation(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-surface-raised border border-border text-content text-xs focus:outline-none focus:border-accent"
              >
                <option value="shadow-tls">ShadowTLS v3 (Mimic TLS 1.3 Handshake)</option>
                <option value="vless-reality">VLESS Reality (Zero-RTT Server Name Indication)</option>
                <option value="quic-masque">QUIC MASQUE (HTTP/3 Datagram Tunneling)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Global MTU & WireGuard Engine */}
        <div className="p-5 rounded-2xl bg-surface-raised border border-border space-y-4 shadow-xl">
          <div className="flex items-center space-x-2 font-bold text-content text-sm">
            <Cpu className="w-4 h-4 text-info" />
            <span>Kernel &amp; Interface Parameters</span>
          </div>
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-surface border border-border flex justify-between items-center">
              <div>
                <span className="text-muted block">Default Interface MTU</span>
                <span className="text-content font-bold">1360 Bytes (DirectFrame Clamped)</span>
              </div>
              <span className="text-success text-xs px-2 py-0.5 rounded bg-success/10 border border-success/30">
                Optimized
              </span>
            </div>

            <div className="p-3 rounded-lg bg-surface border border-border flex justify-between items-center">
              <div>
                <span className="text-muted block">Keepalive Interval</span>
                <span className="text-content font-bold">25 Seconds (Persistent NAT Hole-Punch)</span>
              </div>
              <span className="text-success text-xs px-2 py-0.5 rounded bg-success/10 border border-success/30">
                Active
              </span>
            </div>
          </div>
        </div>

        {/* Existing Crypto */}
        <div className="p-5 rounded-2xl bg-surface-raised border border-border space-y-4 shadow-xl">
          <div className="flex items-center space-x-2 font-bold text-content text-sm">
            <Shield className="w-4 h-4 text-accent" />
            <span>Cryptographic Ciphersuites</span>
          </div>
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-surface border border-border flex justify-between">
              <span className="text-muted">Tunnel Protocol:</span>
              <span className="text-accent font-bold">Noise_IKpsk2_25519_ChaChaPoly</span>
            </div>
            <div className="p-3 rounded-lg bg-surface border border-border flex justify-between">
              <span className="text-muted">Key Exchange:</span>
              <span className="text-content">Curve25519 (Clamped Scalar)</span>
            </div>
            <div className="p-3 rounded-lg bg-surface border border-border flex justify-between">
              <span className="text-muted">Symmetric Cipher:</span>
              <span className="text-content">ChaCha20-Poly1305 (256-bit AEAD)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
