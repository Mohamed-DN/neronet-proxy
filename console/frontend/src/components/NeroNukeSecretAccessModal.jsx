import React, { useState } from 'react';
import { api } from '../services/api';
import {
  Skull,
  Lock,
  Unlock,
  Key,
  Shield,
  Smartphone,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  EyeOff,
  Radio,
  X
} from 'lucide-react';

export default function NeroNukeSecretAccessModal({ isOpen, onClose, onAuthenticated }) {
  const [method, setMethod] = useState('reverse_password');
  const [credential, setCredential] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [secretDmsState, setSecretDmsState] = useState(null);
  const [passphraseToReset, setPassphraseToReset] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [resetSuccessMessage, setResetSuccessMessage] = useState(null);

  if (!isOpen) return null;

  const handleAuthenticate = async (e) => {
    e.preventDefault();
    setIsVerifying(true);
    setAuthError(null);
    try {
      const res = await api.nuke.verifyPersonalDmsSecret(method, credential);
      if (res && res.authenticated) {
        setSecretDmsState(
          res.dms_state || {
            armed: true,
            heartbeat_interval_seconds: 2592000,
            last_heartbeat_at: new Date().toISOString()
          }
        );
        if (onAuthenticated) onAuthenticated();
      } else {
        setAuthError('Authentication rejected. Zero indicator logged.');
      }
    } catch (err) {
      setAuthError('Steganographic verification failed.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResetHeartbeat = async (e) => {
    e.preventDefault();
    setIsResetting(true);
    setResetSuccessMessage(null);
    try {
      const res = await api.nuke.resetPersonalDmsHeartbeat(passphraseToReset);
      setResetSuccessMessage('Silent DMS Heartbeat confirmed. Clock reset successfully.');
      setPassphraseToReset('');
    } catch (err) {
      alert('Failed to reset DMS heartbeat.');
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-lg bg-dark-card border border-dark-border rounded-2xl shadow-2xl overflow-hidden">
        {/* Stealth Header */}
        <div className="p-5 border-b border-dark-border flex items-center justify-between bg-dark-canvas/70">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400">
              <EyeOff className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100 font-mono">Steganographic Access Gateway (Tier 1b)</h3>
              <div className="text-[11px] text-slate-500 font-mono">Zero-Knowledge Hidden Dead Man's Switch Panel</div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {!secretDmsState ? (
            <form onSubmit={handleAuthenticate} className="space-y-4 text-xs font-mono">
              <p className="text-slate-400 text-[11px]">
                Enter secret steganographic authenticator configured during DMS setup. Failed attempts emit zero logs.
              </p>

              <div>
                <label className="block text-slate-400 mb-1">Authentication Method</label>
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-accent-primary"
                >
                  <option value="reverse_password">1. Reverse Password (Password backwards)</option>
                  <option value="split_reverse">2. Split Reverse (Dual half reverse)</option>
                  <option value="shadow_password">3. Shadow DMS Passphrase</option>
                  <option value="hardware_key">4. Hardware Key Tap (FIDO2 / YubiKey)</option>
                  <option value="mobile_otp">5. Mobile TOTP Authenticator</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">
                  {method === 'hardware_key'
                    ? 'Security Key Confirmation'
                    : method === 'mobile_otp'
                      ? '6-Digit TOTP Token'
                      : 'Secret Passphrase / Input'}
                </label>
                <input
                  type="password"
                  required
                  placeholder={
                    method === 'hardware_key'
                      ? 'Tap hardware key or type "yubikey_tap_ok"'
                      : method === 'mobile_otp'
                        ? '6-digit OTP'
                        : 'Enter secret...'
                  }
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-accent-primary"
                />
              </div>

              {authError && (
                <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-500/40 text-red-400 text-[11px]">
                  {authError}
                </div>
              )}

              <div className="pt-2 flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg bg-dark-border text-slate-300 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isVerifying}
                  className="px-4 py-2 rounded-lg bg-accent-primary text-slate-950 font-bold hover:brightness-110 shadow-lg disabled:opacity-50"
                >
                  {isVerifying ? 'Verifying...' : 'Unlock Hidden Panel'}
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4 text-xs font-mono">
              <div className="p-4 rounded-xl bg-slate-950 border border-emerald-500/40 space-y-2">
                <div className="flex items-center justify-between text-emerald-400 font-bold">
                  <span className="flex items-center space-x-1.5">
                    <Shield className="w-4 h-4" />
                    <span>Personal Hidden DMS Active</span>
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                    ARMED
                  </span>
                </div>
                <div className="text-[11px] text-slate-300 space-y-1 pt-1">
                  <div className="flex justify-between">
                    <span>Heartbeat Interval:</span>
                    <strong className="text-white">
                      {Math.round((secretDmsState.heartbeat_interval_seconds || 2592000) / 86400)} Days
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span>Last Confirmation:</span>
                    <span className="text-slate-400">
                      {new Date(secretDmsState.last_heartbeat_at || Date.now()).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Scope:</span>
                    <span className="text-emerald-400">Self Account & Devices Only</span>
                  </div>
                </div>
              </div>

              {/* Reset Clock Form */}
              <form
                onSubmit={handleResetHeartbeat}
                className="p-4 rounded-xl bg-dark-canvas border border-dark-border space-y-3"
              >
                <div className="font-bold text-slate-200 flex items-center space-x-1.5">
                  <RefreshCw className="w-3.5 h-3.5 text-accent-primary" />
                  <span>Confirm Heartbeat & Reset Clock</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  Re-enter passphrase to push back the Dead Man's Switch expiration timer.
                </p>

                <input
                  type="password"
                  required
                  placeholder="Enter passphrase to confirm alive..."
                  value={passphraseToReset}
                  onChange={(e) => setPassphraseToReset(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-card border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-accent-primary"
                />

                {resetSuccessMessage && (
                  <div className="p-2 rounded bg-emerald-950/40 border border-emerald-500/40 text-emerald-400 text-[11px]">
                    {resetSuccessMessage}
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isResetting}
                    className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition-all shadow-md disabled:opacity-50"
                  >
                    {isResetting ? 'Confirming...' : 'I Am Alive (Reset Clock)'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-dark-border bg-dark-canvas/80 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-dark-border text-slate-300 hover:text-white text-xs font-mono font-bold"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
